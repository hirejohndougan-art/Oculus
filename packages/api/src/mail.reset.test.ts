// Password reset and set-up codes by email end to end (T-040, D-085): the
// sign-in routes with the real mailer sending to a fake SMTP server in this
// process. An account and an unknown address get the same reply at once,
// even while the mail server is slow; only the account gets a message; its
// link works; the logs hold no token or address; and an admin's reset of
// two-step sign-in emails a set-up code the set-up screen accepts. Every
// person and address is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeSecondStep, resetSecondFactor, sql } from "@oculus/db";
import type { UserId } from "@oculus/core";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { giveTestFactor, testKeyring } from "../../db/src/second-factor.fixtures.js";
import { TEST_PASSWORD } from "../../service/src/people.fixtures.js";
import { OCULUS_COOKIES } from "./cookies.js";
import { createMailer, smtpConfigFromEnv, smtpTransport, type Mailer } from "./mail.js";
import { buildServer } from "./server.js";
import { signInRoutes } from "./sign-in-api.js";
import { parseMail, startFakeSmtp, type FakeSmtp } from "./smtp-server.fixtures.js";
import { makeWorld, pendingSession, type World } from "./staff-api.fixtures.js";
import type { ApiLogRecord } from "./staff-api.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const keys = testKeyring();
const ORIGIN = "http://localhost";
let w: World;
let app: FastifyInstance;
let smtp: FakeSmtp;
let mailer: Mailer;
const logged: ApiLogRecord[] = [];
let nextAddress = 0;

function address(): string {
  nextAddress += 1;
  return `198.51.100.${String(1 + (nextAddress % 250))}`;
}

async function emailOf(userId: UserId): Promise<string> {
  const rows = await w.db.rows<{ email: string }>(
    sql`SELECT email FROM public.users WHERE id = ${userId}::uuid`,
  );
  const email = rows[0]?.email;
  if (email === undefined) throw new Error("no such user");
  return email;
}

function post(path: string, body: unknown, cookie?: string, csrf?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: SAME_ORIGIN.origin,
  };
  if (cookie !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${cookie}`;
  if (csrf !== undefined) headers["x-oculus-csrf"] = csrf;
  return app.inject({
    method: "POST",
    url: path,
    headers,
    payload: JSON.stringify(body),
    remoteAddress: address(),
  });
}

function cookieOf(response: LightMyRequestResponse): string | undefined {
  const header = response.headers["set-cookie"];
  const text = Array.isArray(header) ? header[0] : header;
  return /^__Host-oculus_session=([A-Za-z0-9_-]+);/.exec(text ?? "")?.[1];
}

async function settled(count: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (logged.filter((r) => r.event === "reset_settled").length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the reset work didn't settle");
}

beforeAll(async () => {
  w = await makeWorld();
  smtp = await startFakeSmtp();
  const config = smtpConfigFromEnv({
    OCULUS_SMTP_HOST: "127.0.0.1",
    OCULUS_SMTP_PORT: String(smtp.port),
    OCULUS_SMTP_TLS: "none",
    OCULUS_MAIL_FROM: "oculus@invented.example",
  });
  mailer = createMailer({
    transport: smtpTransport(config, { timeoutsMs: 5_000 }),
    adminOrigin: ORIGIN,
    production: false,
    log: (record) => logged.push(record),
    outbox: { baseDelayMs: 10, maxDelayMs: 40 },
  });
  app = await buildServer({
    env: TEST_ENV,
    routes: signInRoutes({
      db: w.db,
      keys,
      service: w.service,
      deliverReset: mailer.deliverReset,
      log: (record) => logged.push(record),
      resetOptions: { backgroundDelayMs: { min: 0, max: 0 } },
    }),
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await mailer.close();
  await smtp.close();
  await w.db.close();
  await w.testDb.drop();
});

describe("a reset request with the real mailer", () => {
  it("answers an account and an unknown address alike and at once, and mails only the account", async () => {
    await giveTestFactor(w.db, keys, w.other, 5);
    const email = await emailOf(w.other);
    // The mail server takes its time; the replies must not wait for it.
    smtp.delayGreeting(1_500);
    const before = logged.filter((r) => r.event === "reset_settled").length;
    const t0 = performance.now();
    const known = await post("/api/password-reset", { email });
    const t1 = performance.now();
    const unknown = await post("/api/password-reset", { email: "nobody.invented@example.org" });
    const t2 = performance.now();
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    expect(known.headers["content-length"]).toBe(unknown.headers["content-length"]);
    expect(t1 - t0).toBeLessThan(1_000);
    expect(t2 - t1).toBeLessThan(1_000);
    expect(smtp.messages).toHaveLength(0);
    await settled(before + 2);
    // Handing over to the outbox is quick even while the server is slow.
    expect(logged.filter((r) => r.event === "reset_settled").slice(-2)).toEqual(
      expect.arrayContaining([
        { event: "reset_settled", code: "sent" },
        { event: "reset_settled", code: "not_sent" },
      ]),
    );
    await mailer.outbox.idle();
    smtp.delayGreeting(0);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]?.to).toEqual([email]);

    const mail = parseMail(smtp.messages[0]?.data ?? "");
    const token = new RegExp(`${ORIGIN}/reset#([A-Za-z0-9_-]{43})`).exec(mail.text)?.[1];
    expect(token).toBeDefined();
    expect(mail.headerText).not.toContain(token);
    expect(mail.html).toContain(`href="${ORIGIN}/reset#${String(token)}"`);
    // The logs never hold the token or the address.
    const text = JSON.stringify(logged);
    expect(text).not.toContain(String(token));
    expect(text).not.toContain(email);
    expect(text).not.toContain("example.org");

    const done = await post("/api/password-reset/complete", {
      token,
      password: `${TEST_PASSWORD}-and-new`,
    });
    expect(done.statusCode).toBe(200);
  });
});

describe("the set-up code after an admin's reset of two-step sign-in", () => {
  it("is emailed, and the set-up screen's request accepts it", async () => {
    const target = w.donor;
    await giveTestFactor(w.db, keys, target, 5);
    const rootFactor = await giveTestFactor(w.db, keys, w.root, 5);
    const rootWaiting = await pendingSession(w.db, w.root, w.a);
    const rootFull = await completeSecondStep(w.db, keys, rootWaiting.token, {
      recoveryCode: rootFactor.codes.pop() ?? "",
      source: address(),
    });
    if (!rootFull.ok) throw new Error(JSON.stringify(rootFull));
    smtp.reset();
    const done = await resetSecondFactor(
      w.db,
      keys,
      rootFull.token,
      target,
      { recoveryCode: rootFactor.codes.pop() ?? "", source: address() },
      mailer.deliverEnrolment,
    );
    expect(done.ok && done.value.delivered).toBe(true);
    await mailer.outbox.idle();
    expect(smtp.messages).toHaveLength(1);
    const mail = parseMail(smtp.messages[0]?.data ?? "");
    expect(mail.headers.get("subject")).toBe("Your Oculus set-up code");
    const code = /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(mail.text.replace(/\r\n/g, "\n"))?.[1];
    expect(code).toBeDefined();
    expect(JSON.stringify(logged)).not.toContain(String(code));

    const signIn = await post("/api/sign-in", {
      email: await emailOf(target),
      password: TEST_PASSWORD,
    });
    expect(signIn.statusCode).toBe(200);
    const body = signIn.json<{ csrfToken: string; setUpLinkRequired: boolean }>();
    expect(body.setUpLinkRequired).toBe(true);
    const started = await post(
      "/api/sign-in/set-up",
      { setUpLink: code },
      cookieOf(signIn),
      body.csrfToken,
    );
    expect(started.statusCode).toBe(200);
  });
});
