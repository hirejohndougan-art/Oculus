// The mail senders (T-040, D-085), against a fake SMTP server in this
// process: the messages' content and escaping, CR/LF refusal, the outbox's
// retries with backoff and a cap, time limits and closing, the per-recipient
// limit, logs that never hold a token or an address, the configuration's
// refusals, and the development sender refused in production. Every
// address, name and token is invented.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMailer,
  devTransport,
  mailerFromEnv,
  MailConfigError,
  smtpConfigFromEnv,
  smtpTransport,
  type Mailer,
} from "./mail.js";
import {
  checkAdminOrigin,
  escapeHtml,
  MailContentError,
  renderInvitation,
  renderPasswordChanged,
  renderPasswordReset,
  renderSecondStepAlert,
  renderTwoStepSetup,
} from "./mail-messages.js";
import { classifyMailError, createOutbox, MailRefusedError } from "./mail-outbox.js";
import { parseMail, startFakeSmtp, type FakeSmtp } from "./smtp-server.fixtures.js";
import type { ApiLogRecord } from "./staff-api.js";

const ORIGIN = "https://admin.invented.example";
const TOKEN = "Inv3nted-T0ken_" + "a".repeat(28);
const TOKEN_2 = "Second-Inv3nted_" + "b".repeat(27);
const TO = "ada.invented@example.org";
const LATER = new Date(Date.now() + 30 * 60_000).toISOString();
const abort = new AbortController();
const SIGNAL = abort.signal;

let smtp: FakeSmtp;
const mailers: Mailer[] = [];
const logs: ApiLogRecord[] = [];

function log(record: ApiLogRecord): void {
  logs.push(record);
}

const ENV = {
  NODE_ENV: "test",
  OCULUS_SMTP_HOST: "127.0.0.1",
  OCULUS_SMTP_TLS: "none",
  OCULUS_MAIL_FROM: "oculus@invented.example",
  OCULUS_ADMIN_ORIGIN: ORIGIN,
};

/** A mailer to the fake server with quick retries. */
function mailer(
  outbox: Parameters<typeof createMailer>[0]["outbox"] = {},
  env: Record<string, string> = {},
): Mailer {
  const config = smtpConfigFromEnv({ ...ENV, OCULUS_SMTP_PORT: String(smtp.port), ...env });
  const made = createMailer({
    transport: smtpTransport(config, { timeoutsMs: 2_000 }),
    adminOrigin: ORIGIN,
    production: false,
    log,
    outbox: { baseDelayMs: 10, maxDelayMs: 40, sendTimeoutMs: 5_000, ...outbox },
  });
  mailers.push(made);
  return made;
}

function reset(email = TO, token = TOKEN) {
  return { email, token, expiresAt: LATER, requestedBy: "self" as const };
}

beforeAll(async () => {
  smtp = await startFakeSmtp();
});

afterEach(async () => {
  await Promise.all(mailers.splice(0).map((m) => m.close()));
  smtp.reset();
  logs.length = 0;
});

afterAll(async () => {
  await smtp.close();
});

describe("the messages", () => {
  it("builds the reset link from the configured origin only, with the token in the fragment", () => {
    const mail = renderPasswordReset(reset(), ORIGIN);
    expect(mail.text).toContain(`${ORIGIN}/reset#${TOKEN}`);
    expect(mail.html).toContain(`<a href="${ORIGIN}/reset#${TOKEN}">`);
    expect(mail.subject).toBe("Reset your Oculus password");
    expect(mail.subject).not.toContain(TOKEN);
    // Every link in the HTML is on the admin's origin, and nothing is loaded.
    for (const [, url] of mail.html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      expect(url?.startsWith(`${ORIGIN}/`)).toBe(true);
    }
    expect(mail.html).not.toMatch(/<img|<link|<style|<script|src=|url\(/i);
    expect(mail.secrets).toEqual([TOKEN]);
    expect(mail.notAfter).toBe(Date.parse(LATER));
  });

  it("words a system admin's link differently, and says when it stops working", () => {
    const mail = renderPasswordReset(
      { ...reset(), requestedBy: "system_admin", expiresAt: "2026-11-24T17:35:00.000Z" },
      ORIGIN,
    );
    expect(mail.text).toContain("system administrator sent you this link");
    expect(mail.text).toContain("17:35 UTC on 24 November 2026");
  });

  it("shows the set-up code as text, never in a URL, and links to the sign-in page", () => {
    const mail = renderTwoStepSetup({ email: TO, token: TOKEN, expiresAt: LATER }, ORIGIN);
    expect(mail.subject).toBe("Your Oculus set-up code");
    expect(mail.text).toContain(`\n\n${TOKEN}\n\n`);
    expect(mail.text).toContain(`${ORIGIN}/sign-in`);
    for (const [, url] of mail.html.matchAll(/href="([^"]*)"/g)) {
      expect(url).not.toContain(TOKEN);
    }
  });

  it("tells the person their password was changed, with no token and only the sign-in link", () => {
    const mail = renderPasswordChanged(
      { email: TO, changedAt: "2026-11-24T17:35:00.000Z" },
      ORIGIN,
    );
    expect(mail.subject).toBe("Your Oculus password was changed");
    expect(mail.text).toContain("17:35 UTC on 24 November 2026");
    expect(mail.secrets).toEqual([]);
    expect([...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([
      `${ORIGIN}/sign-in`,
    ]);
    expect(mail.text).not.toContain("#");
  });

  it("warns the person and the admins that someone is guessing codes, escaping the name", () => {
    const at = "2026-11-24T17:35:00.000Z";
    const own = renderSecondStepAlert({ to: "person", email: TO, failures: 15, at }, ORIGIN);
    expect(own.subject).toBe("Someone may know your Oculus password");
    expect(own.text).toContain("15 wrong codes by 17:35 UTC on 24 November 2026");
    expect(own.text).toContain(`${ORIGIN}/sign-in`);
    const name = `Ada <b>"Invented"</b>`;
    const admin = renderSecondStepAlert(
      {
        to: "system_admin",
        email: "admin.invented@example.org",
        person: { displayName: name, email: TO },
        failures: 1,
        at,
      },
      ORIGIN,
    );
    expect(admin.to).toBe("admin.invented@example.org");
    expect(admin.subject).not.toContain(TO);
    expect(admin.text).toContain(`${name} (${TO}): 1 wrong code by`);
    expect(admin.html).toContain("Ada &lt;b&gt;&quot;Invented&quot;&lt;/b&gt;");
    expect(admin.html).not.toContain("<b>");
    for (const mail of [own, admin]) {
      expect([...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([
        `${ORIGIN}/sign-in`,
      ]);
      expect(mail.html).not.toMatch(/<img|src=/i);
    }
    expect(() =>
      renderSecondStepAlert(
        {
          to: "system_admin",
          email: "admin.invented@example.org",
          person: { displayName: "Ada\r\nBcc: spy@example.net", email: TO },
          failures: 1,
          at,
        },
        ORIGIN,
      ),
    ).toThrow(MailContentError);
    expect(() =>
      renderSecondStepAlert({ to: "person", email: TO, failures: 0, at }, ORIGIN),
    ).toThrow(MailContentError);
  });

  it("escapes every value in the HTML", () => {
    const name = `<script>alert("x")</script> & 'Friends'`;
    const mail = renderInvitation(
      { email: TO, organizationName: name, token: TOKEN, expiresAt: LATER },
      ORIGIN,
    );
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Friends&#39;",
    );
    expect(mail.text).toContain(name);
    expect(mail.text).toContain(`${ORIGIN}/invitation#${TOKEN}`);
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("refuses CR, LF and other controls in any value, a malformed address, token or expiry", () => {
    const bad: [() => unknown, string][] = [
      [() => renderPasswordReset(reset(`${TO}\r\nBcc: spy@example.net`), ORIGIN), "bad_address"],
      [() => renderPasswordReset(reset(`${TO}\n`), ORIGIN), "bad_address"],
      [() => renderPasswordReset(reset("Ada <ada@example.org>"), ORIGIN), "bad_address"],
      [() => renderPasswordReset(reset("ADA@example.org"), ORIGIN), "bad_address"],
      [() => renderPasswordReset(reset(TO, `${TOKEN.slice(1)}\n`), ORIGIN), "bad_token"],
      [() => renderPasswordReset(reset(TO, "short"), ORIGIN), "bad_token"],
      [() => renderPasswordReset({ ...reset(), expiresAt: "tomorrow" }, ORIGIN), "bad_expiry"],
      [
        () => renderPasswordReset({ ...reset(), expiresAt: "2026-02-30T10:00:00.000Z" }, ORIGIN),
        "bad_expiry",
      ],
      [
        () =>
          renderInvitation(
            {
              email: TO,
              organizationName: "Archive\r\nBcc: x@example.net",
              token: TOKEN,
              expiresAt: LATER,
            },
            ORIGIN,
          ),
        "bad_value",
      ],
      [
        () =>
          renderInvitation(
            { email: TO, organizationName: "Archive‮", token: TOKEN, expiresAt: LATER },
            ORIGIN,
          ),
        "bad_value",
      ],
    ];
    for (const [make, code] of bad) {
      let caught: unknown;
      try {
        make();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MailContentError);
      expect((caught as MailContentError).code).toBe(code);
      // The error names the rule, never the value.
      expect(String(caught)).not.toContain("example");
      expect(String(caught)).not.toContain(TOKEN.slice(1));
    }
  });

  it("takes only a bare https origin (http only for localhost outside production)", () => {
    expect(checkAdminOrigin(ORIGIN, true)).toBe(ORIGIN);
    expect(checkAdminOrigin("http://localhost:3000", false)).toBe("http://localhost:3000");
    for (const bad of [
      "http://localhost:3000",
      "http://admin.invented.example",
      `${ORIGIN}/`,
      `${ORIGIN}/x`,
      "https://user:pw@admin.invented.example",
      "https://admin.invented.example\r\n",
      "javascript:alert(1)",
      "",
    ]) {
      expect(() => checkAdminOrigin(bad, true), bad).toThrow(MailContentError);
    }
    expect(() => checkAdminOrigin("http://evil.example", false)).toThrow(MailContentError);
  });
});

describe("sending over SMTP", () => {
  it("sends plain text plus HTML, with no token in any header", async () => {
    const m = mailer();
    await m.deliverReset(reset(), SIGNAL);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(1);
    const received = smtp.messages[0];
    expect(received?.to).toEqual([TO]);
    expect(received?.from).toBe("oculus@invented.example");
    const mail = parseMail(received?.data ?? "");
    expect(mail.headers.get("subject")).toBe("Reset your Oculus password");
    expect(mail.headers.get("to")).toBe(TO);
    expect(mail.headers.get("from")).toBe("Oculus <oculus@invented.example>");
    expect(mail.headers.get("content-type")).toMatch(/^multipart\/alternative/);
    expect(mail.headerText).not.toContain(TOKEN);
    const expected = renderPasswordReset(reset(), ORIGIN);
    expect(mail.text.replace(/\r\n/g, "\n")).toBe(expected.text);
    expect(mail.html.replace(/\r\n/g, "\n")).toBe(expected.html);
    expect(logs).toEqual([{ event: "mail_sent", operation: "password_reset" }]);
  });

  it("delivers the set-up code and invitations the same way", async () => {
    const m = mailer();
    await m.deliverEnrolment({ email: TO, token: TOKEN, expiresAt: LATER });
    await m.deliverInvitation(
      {
        email: TO,
        organizationId: "00000000-0000-4000-8000-000000000001" as never,
        organizationName: "Invented Archive",
        token: TOKEN_2,
        expiresAt: LATER,
      },
      SIGNAL,
    );
    await m.outbox.idle();
    const subjects = smtp.messages.map((r) => parseMail(r.data).headers.get("subject"));
    expect(subjects.sort()).toEqual(["You're invited to Oculus", "Your Oculus set-up code"]);
  });

  it("delivers the alert and the password-changed notice", async () => {
    const m = mailer();
    await m.deliverAlert({ to: "person", email: TO, failures: 5, at: LATER });
    await m.deliverPasswordChanged({ email: TO, changedAt: LATER });
    await m.outbox.idle();
    const subjects = smtp.messages.map((r) => parseMail(r.data).headers.get("subject"));
    expect(subjects.sort()).toEqual([
      "Someone may know your Oculus password",
      "Your Oculus password was changed",
    ]);
  });

  it("refuses a message with CR or LF before anything reaches the server", async () => {
    const m = mailer();
    await expect(
      m.deliverReset(reset(`${TO}\r\nBcc: spy@example.net`), SIGNAL),
    ).rejects.toBeInstanceOf(MailContentError);
    await expect(
      m.deliverInvitation(
        {
          email: TO,
          organizationId: "00000000-0000-4000-8000-000000000001" as never,
          organizationName: "A\nB",
          token: TOKEN,
          expiresAt: LATER,
        },
        SIGNAL,
      ),
    ).rejects.toBeInstanceOf(MailContentError);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.commands.join("\n")).not.toContain("spy@");
    expect(logs.map((r) => r.code)).toEqual(["bad_address", "bad_value"]);
  });

  it("returns before the mail server answers: the send is off the caller's path", async () => {
    smtp.delayGreeting(800);
    const m = mailer();
    const started = performance.now();
    await m.deliverReset(reset(), SIGNAL);
    expect(performance.now() - started).toBeLessThan(100);
    expect(smtp.messages).toHaveLength(0);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(1);
  });

  it("retries a temporary refusal with backoff, then sends", async () => {
    smtp.refuseNext(2, "451 4.3.0 try again later");
    const m = mailer();
    await m.deliverReset(reset(), SIGNAL);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(1);
    expect(logs).toEqual([
      { event: "mail_retry", operation: "password_reset", code: "rejected_temporary" },
      { event: "mail_retry", operation: "password_reset", code: "rejected_temporary" },
      { event: "mail_sent", operation: "password_reset" },
    ]);
  });

  it("stops after the cap", async () => {
    smtp.refuseNext(10, "451 4.3.0 try again later");
    const m = mailer({ maxAttempts: 3 });
    await m.deliverReset(reset(), SIGNAL);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.commands.filter((c) => c === "DATA")).toHaveLength(3);
    expect(logs.at(-1)).toEqual({
      event: "mail_failed",
      operation: "password_reset",
      code: "rejected_temporary",
    });
  });

  it("doesn't retry a permanent refusal, and logs no address the server quoted", async () => {
    smtp.refuseNext(1, `550 5.1.1 <${TO}>: Recipient address rejected: ${TOKEN}`);
    const m = mailer();
    await m.deliverReset(reset(), SIGNAL);
    await m.outbox.idle();
    expect(smtp.commands.filter((c) => c === "DATA")).toHaveLength(1);
    expect(logs).toEqual([
      { event: "mail_failed", operation: "password_reset", code: "rejected_permanent" },
    ]);
  });

  it("doesn't retry once the link would have expired", async () => {
    smtp.refuseNext(1, "451 4.3.0 try again later");
    const m = mailer({ baseDelayMs: 60_000, maxDelayMs: 60_000 });
    await m.deliverReset(
      { ...reset(), expiresAt: new Date(Date.now() + 90_000).toISOString() },
      SIGNAL,
    );
    await m.outbox.idle();
    expect(logs).toEqual([
      { event: "mail_failed", operation: "password_reset", code: "rejected_temporary" },
    ]);
  });

  it("gives a stalled server a time limit, and retries it", async () => {
    smtp.stallNext(1);
    const m = mailer({ sendTimeoutMs: 300 });
    await m.deliverReset(reset(), SIGNAL);
    await m.outbox.idle();
    expect(logs[0]).toEqual({ event: "mail_retry", operation: "password_reset", code: "timeout" });
    expect(smtp.messages).toHaveLength(1);
  });

  it("requires STARTTLS by default: a server without it gets no message", async () => {
    const config = smtpConfigFromEnv({
      ...ENV,
      OCULUS_SMTP_TLS: undefined,
      OCULUS_SMTP_HOST: "localhost",
      OCULUS_SMTP_PORT: String(smtp.port),
    });
    expect(config.tls).toBe("starttls");
    const m = createMailer({
      transport: smtpTransport(config, { timeoutsMs: 2_000 }),
      adminOrigin: ORIGIN,
      production: false,
      log,
      outbox: { baseDelayMs: 10 },
    });
    mailers.push(m);
    await m.deliverReset(reset(), SIGNAL);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.commands.some((c) => c.startsWith("MAIL"))).toBe(false);
    expect(logs).toEqual([{ event: "mail_failed", operation: "password_reset", code: "tls" }]);
  });

  it("signs in to the mail server when configured, and fails closed on bad credentials", async () => {
    const authed = await startFakeSmtp({
      auth: { user: "oculus-sender", pass: "invented-smtp-pw" },
    });
    try {
      const make = (pass: string) => {
        const config = smtpConfigFromEnv({
          ...ENV,
          OCULUS_SMTP_PORT: String(authed.port),
          OCULUS_SMTP_USER: "oculus-sender",
          OCULUS_SMTP_PASSWORD: pass,
        });
        const m = createMailer({
          transport: smtpTransport(config, { timeoutsMs: 2_000 }),
          adminOrigin: ORIGIN,
          production: false,
          log,
          outbox: { baseDelayMs: 10 },
        });
        mailers.push(m);
        return m;
      };
      const wrong = make("not-the-pw");
      await wrong.deliverReset(reset(), SIGNAL);
      await wrong.outbox.idle();
      expect(authed.messages).toHaveLength(0);
      expect(logs).toEqual([{ event: "mail_failed", operation: "password_reset", code: "auth" }]);
      const right = make("invented-smtp-pw");
      await right.deliverReset(reset(), SIGNAL);
      await right.outbox.idle();
      expect(authed.messages).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("invented-smtp-pw");
    } finally {
      await authed.close();
    }
  });

  it("limits messages per recipient", async () => {
    const m = mailer({ perRecipientPerHour: 2 });
    await m.deliverReset(reset(), SIGNAL);
    await m.deliverReset(reset(), SIGNAL);
    await expect(m.deliverReset(reset(), SIGNAL)).rejects.toBeInstanceOf(MailRefusedError);
    // Another recipient isn't held back.
    await m.deliverReset(reset("grace.invented@example.org"), SIGNAL);
    await m.outbox.idle();
    expect(smtp.messages).toHaveLength(3);
    expect(logs).toContainEqual({
      event: "mail_refused",
      operation: "password_reset",
      code: "recipient_limit",
    });
  });

  it("refuses when full or closed, and an aborted hand-over", async () => {
    smtp.delayGreeting(300);
    const m = mailer({ maxQueued: 1 });
    const before = smtp.connections();
    await m.deliverReset(reset(), SIGNAL);
    await expect(m.deliverReset(reset("grace.invented@example.org"), SIGNAL)).rejects.toThrow(
      /queue_full/,
    );
    const gone = new AbortController();
    gone.abort();
    await expect(m.deliverReset(reset(), gone.signal)).rejects.toThrow(/aborted/);
    // Closed while the first is being sent (connected, waiting for the greeting).
    while (smtp.connections() === before) await new Promise((r) => setTimeout(r, 5));
    await m.close();
    await expect(m.deliverReset(reset(), SIGNAL)).rejects.toThrow(/closed/);
    // The send in progress was stopped.
    expect(smtp.messages).toHaveLength(0);
    expect(logs).toContainEqual({
      event: "mail_dropped",
      operation: "password_reset",
      code: "aborted",
    });
  });

  it("never logs a token or an address", async () => {
    smtp.refuseNext(1, `451 4.2.0 <${TO}> mailbox busy ${TOKEN}`);
    const m = mailer();
    await m.deliverReset(reset(), SIGNAL);
    await m.deliverEnrolment({ email: TO, token: TOKEN_2, expiresAt: LATER });
    await m.outbox.idle();
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(2);
    for (const secret of [TOKEN, TOKEN_2, TO, "example.org", "invented.example"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("classifyMailError", () => {
  it("reads only the error's own code and responseCode, never a getter", () => {
    expect(classifyMailError({ code: "ECONNECTION" })).toBe("network");
    expect(classifyMailError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyMailError({ code: "EAUTH", responseCode: 535 })).toBe("auth");
    expect(classifyMailError({ code: "EENVELOPE", responseCode: 550 })).toBe("rejected_permanent");
    expect(classifyMailError({ code: "EMESSAGE", responseCode: 451 })).toBe("rejected_temporary");
    expect(classifyMailError({ code: "EPROTOCOL", responseCode: 503 })).toBe("rejected_temporary");
    expect(classifyMailError(new Error("x"))).toBe("unknown");
    expect(classifyMailError(null)).toBe("unknown");
    let read = false;
    const sly = {
      get code() {
        read = true;
        return "EAUTH";
      },
    };
    expect(classifyMailError(sly)).toBe("unknown");
    expect(read).toBe(false);
  });

  it("validates the outbox's settings", () => {
    const transport = { send: () => Promise.resolve() };
    expect(() => createOutbox({ transport, log, maxAttempts: 0 })).toThrow(TypeError);
    expect(() => createOutbox({ transport, log, concurrency: 1.5 })).toThrow(TypeError);
  });
});

describe("configuration from the environment", () => {
  const SECRET = "invented-secret-value";

  function refusal(env: Record<string, string | undefined>, readFile?: (p: string) => string) {
    try {
      smtpConfigFromEnv(env, readFile);
    } catch (error) {
      expect(error).toBeInstanceOf(MailConfigError);
      expect(String(error)).not.toContain(SECRET);
      return String(error);
    }
    throw new Error("not refused");
  }

  it("requires TLS by default and allows none only for this machine", () => {
    const base = {
      OCULUS_SMTP_HOST: "smtp.invented.example",
      OCULUS_MAIL_FROM: "o@invented.example",
    };
    const config = smtpConfigFromEnv(base);
    expect(config).toMatchObject({ tls: "starttls", port: 587 });
    expect(smtpConfigFromEnv({ ...base, OCULUS_SMTP_TLS: "implicit" }).port).toBe(465);
    expect(refusal({ ...base, OCULUS_SMTP_TLS: "none" })).toMatch(/this machine/);
    expect(refusal({ ...base, OCULUS_SMTP_TLS: "maybe" })).toMatch(/OCULUS_SMTP_TLS/);
    expect(refusal({ ...base, OCULUS_SMTP_PORT: "99999" })).toMatch(/OCULUS_SMTP_PORT/);
    expect(refusal({ ...base, OCULUS_SMTP_HOST: `smtp.example\r\n${SECRET}` })).toMatch(
      /OCULUS_SMTP_HOST/,
    );
    expect(refusal({ OCULUS_SMTP_HOST: "smtp.invented.example" })).toMatch(/OCULUS_MAIL_FROM/);
    expect(refusal({ ...base, OCULUS_MAIL_FROM_NAME: `Oculus\r\nBcc: ${SECRET}` })).toMatch(
      /OCULUS_MAIL_FROM_NAME/,
    );
  });

  it("takes the password from the environment or a file, never both, never shown", () => {
    const base = {
      OCULUS_SMTP_HOST: "smtp.invented.example",
      OCULUS_MAIL_FROM: "o@invented.example",
      OCULUS_SMTP_USER: "sender",
    };
    expect(smtpConfigFromEnv({ ...base, OCULUS_SMTP_PASSWORD: SECRET }).password).toBe(SECRET);
    const fromFile = smtpConfigFromEnv(
      { ...base, OCULUS_SMTP_PASSWORD_FILE: "/run/x" },
      () => `${SECRET}\n`,
    );
    expect(fromFile.password).toBe(SECRET);
    expect(
      refusal({ ...base, OCULUS_SMTP_PASSWORD: SECRET, OCULUS_SMTP_PASSWORD_FILE: "/run/x" }),
    ).toMatch(/not both/);
    expect(refusal(base)).toMatch(/go together/);
    expect(
      refusal({ ...base, OCULUS_SMTP_PASSWORD_FILE: `/nonexistent/${SECRET}` }, () => {
        throw new Error(`ENOENT /nonexistent/${SECRET}`);
      }),
    ).toMatch(/can't be read/);
    expect(refusal({ ...base, OCULUS_SMTP_PASSWORD: `${SECRET}\r\n` })).toMatch(/password/);
  });
});

describe("the development sender", () => {
  const DEV = { NODE_ENV: "development" };

  it("is refused in production, however it is asked for", () => {
    expect(() => devTransport({ env: {}, log })).toThrow(/production/);
    expect(() => devTransport({ env: { NODE_ENV: "production" }, log })).toThrow(/production/);
    expect(() => mailerFromEnv({ NODE_ENV: "production" }, { log })).toThrow(/reset sender/);
    expect(() =>
      mailerFromEnv({ ...ENV, NODE_ENV: "production", OCULUS_DEV_MAIL_SHOW_TOKENS: "1" }, { log }),
    ).toThrow(/development only/);
    expect(() =>
      mailerFromEnv({ ...ENV, NODE_ENV: "production", OCULUS_DEV_MAIL_DIR: "/tmp" }, { log }),
    ).toThrow(/development only/);
  });

  it("refuses to send if the environment turns to production", async () => {
    const env: Record<string, string> = { ...DEV };
    const transport = devTransport({ env, log });
    env.NODE_ENV = "production";
    await expect(
      transport.send(renderPasswordReset(reset(), ORIGIN), SIGNAL),
    ).rejects.toBeInstanceOf(MailConfigError);
  });

  it("logs the kind only, and shows the token only with the explicit flag", async () => {
    const written: string[] = [];
    const quiet = mailerFromEnv(DEV, { log, write: (t) => written.push(t) });
    mailers.push(quiet);
    await quiet.deliverReset(reset(), SIGNAL);
    await quiet.outbox.idle();
    expect(written).toEqual([]);
    expect(logs).toContainEqual({ event: "mail_dev", operation: "password_reset" });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);

    const loud = mailerFromEnv(
      { ...DEV, OCULUS_DEV_MAIL_SHOW_TOKENS: "1" },
      { log, write: (t) => written.push(t) },
    );
    mailers.push(loud);
    await loud.deliverReset(reset(), SIGNAL);
    await loud.outbox.idle();
    expect(written.join("")).toContain(`http://localhost/reset#${TOKEN}`);
    expect(() => mailerFromEnv({ ...DEV, OCULUS_DEV_MAIL_SHOW_TOKENS: "yes" }, { log })).toThrow(
      /may only be 1/,
    );
  });

  it("writes messages to a folder with the token hidden unless asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oculus-dev-mail-"));
    try {
      const hidden = mailerFromEnv({ ...DEV, OCULUS_DEV_MAIL_DIR: dir }, { log });
      mailers.push(hidden);
      await hidden.deliverReset(reset(), SIGNAL);
      await hidden.outbox.idle();
      const shown = mailerFromEnv(
        { ...DEV, OCULUS_DEV_MAIL_DIR: dir, OCULUS_DEV_MAIL_SHOW_TOKENS: "1" },
        { log },
      );
      mailers.push(shown);
      await shown.deliverReset(reset(TO, TOKEN_2), SIGNAL);
      await shown.outbox.idle();
      const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
      expect(files).toHaveLength(2);
      expect(files.join("\n")).not.toContain(TOKEN);
      expect(files.join("\n")).toContain("[token hidden]");
      expect(files.join("\n")).toContain(TOKEN_2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
