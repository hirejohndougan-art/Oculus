// Users, invitations and password sign-in (0009_users.sql, accounts.ts,
// D-068) on a freshly migrated database: the bootstrap admin, invitations
// (hashed, single-use, expiring, bound to one organization and address),
// sign-in that answers an unknown address exactly like a wrong password and
// costs it a hash, throttling and its expiry, organizations kept apart,
// concurrent sign-ins and acceptances on two connections, the database's own
// guards, and the writer grants D-068 lists. Every person, address and
// password is invented (example.org is reserved for examples, RFC 2606).
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  newInvitationToken,
  newOrganizationId,
  passwordWorkCount,
  throttleAccountKey,
  throttleSourceKey,
  type InvitationId,
  type OrganizationId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  ACCOUNT_TABLE_PRIVILEGES,
  INVALID_CREDENTIALS,
  acceptInvitation,
  acceptInvitationForUser,
  clearSignInThrottle,
  createFirstSystemAdmin,
  createInvitation,
  deleteExpiredSignInThrottles,
  revokeInvitation,
  signIn,
  type CreatedInvitation,
  type InvitationMessage,
  type InvitationRequest,
  type SignInResult,
} from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { migrate } from "./migrate.js";
import { WRITER_PRIVILEGES, checkWriterConnection, grantWriterRole } from "./roles.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, with its bootstrap admin, set up
// lazily inside each test. Throttle counters are install-wide, so every test
// uses its own addresses and client addresses.

const ADMIN_EMAIL = "first.admin@example.org";
const ADMIN_PASSWORD = "a first admin passphrase, invented";
const PASSWORD = "an invented passphrase for tests";
/** A well-formed stored hash of no password, for direct SQL. */
const PLACEHOLDER_HASH = "$scrypt$ln=14,r=8,p=5$" + "A".repeat(22) + "$" + "A".repeat(43);

let setup: Promise<{ testDb: TestDatabase; db: Database; admin: UserId }> | undefined;
let db: Database;
let admin: UserId;
const cleanups: (() => Promise<void>)[] = [];

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const d = openDatabase(testDb.url, { max: 6 });
    const made = await createFirstSystemAdmin(d, {
      email: ADMIN_EMAIL,
      displayName: "First Admin",
      password: ADMIN_PASSWORD,
    });
    return { testDb, db: d, admin: ok(made).userId };
  })();
  ({ db, admin } = await setup);
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (done) {
    await done.db.close();
    await done.testDb.drop();
  }
  for (const cleanup of cleanups) await cleanup();
});

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

let counter = 0;
function unique(): number {
  counter += 1;
  return counter;
}
function email(): string {
  return `person${String(unique())}@example.org`;
}
/** A client address of its own (a private range, RFC 1918). */
function source(): string {
  const n = unique();
  return `10.36.${String(Math.floor(n / 250))}.${String(1 + (n % 250))}`;
}

async function organization(
  name = `Invented Society ${String(unique())}`,
): Promise<OrganizationId> {
  const id = newOrganizationId();
  ok(await insertOrganization(db, { id, name }));
  return id;
}

type Sent = CreatedInvitation & { readonly token: string };

/**
 * createInvitation with a delivery double that keeps the message, as the
 * invitee's mailbox would: the token comes from there, never from the
 * function's result.
 */
async function inviteVia(conn: Database, input: InvitationRequest): Promise<Validated<Sent>> {
  const box: InvitationMessage[] = [];
  const made = await createInvitation(conn, input, (m) => {
    box.push(m);
    return Promise.resolve();
  });
  if (!made.ok) return made;
  expect(made.value).not.toHaveProperty("token");
  const message = box[0];
  if (box.length !== 1 || message === undefined) throw new Error("not delivered once");
  expect(message).toMatchObject({
    email: made.value.email,
    organizationId: made.value.organizationId,
  });
  return { ok: true, value: { ...made.value, token: message.token } };
}

async function invite(organizationId: OrganizationId, address: string): Promise<Sent> {
  return ok(await inviteVia(db, { organizationId, email: address, invitedBy: admin }));
}

/** A new member of `organizationId`, through an invitation. */
async function member(
  organizationId: OrganizationId,
  address = email(),
): Promise<{ userId: UserId; email: string }> {
  const inv = await invite(organizationId, address);
  const done = ok(
    await acceptInvitation(db, {
      token: inv.token,
      organizationId,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    }),
  );
  return { userId: done.userId, email: address };
}

/** Moves a counter's last failure back in time, as if `seconds` had passed. */
async function age(key: string, seconds: number): Promise<void> {
  await db.execute(sql`
    UPDATE public.sign_in_throttles
    SET last_failure_at = last_failure_at - make_interval(secs => ${seconds})
    WHERE key = ${key}`);
}

async function counterOf(
  key: string,
): Promise<{ failures: number; last: string | null } | undefined> {
  const rows = await db.rows<{ failures: number; last: string | null }>(sql`
    SELECT failures, last_failure_at AS last FROM public.sign_in_throttles WHERE key = ${key}`);
  return rows[0];
}

/**
 * Makes an invitation look created 8 days ago (so it has expired), as the
 * owner: the identity trigger is turned off inside this transaction only and
 * turned back on ALWAYS before it commits, as main's tests do (D-067).
 */
async function expire(invitationId: InvitationId): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.invitations DISABLE TRIGGER zzzz_invitations_keep_identity`,
    );
    await q.execute(sql`
      UPDATE public.invitations
      SET created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days'
      WHERE id = ${invitationId}::uuid`);
    await q.execute(
      sql`ALTER TABLE public.invitations ENABLE ALWAYS TRIGGER zzzz_invitations_keep_identity`,
    );
  });
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

// ---------------------------------------------------------------------------

describe("the first system admin", () => {
  it("is made once, while there are no users, and never again", async () => {
    await ready();
    const again = await createFirstSystemAdmin(db, {
      email: "second.admin@example.org",
      displayName: "Second Admin",
      password: "another invented passphrase",
    });
    expect(codes(again)).toEqual(["already_set_up"]);
    const rows = await db.rows<{ n: string }>(
      sql`SELECT count(*) AS n FROM public.users WHERE bootstrap`,
    );
    expect(rows[0]?.n).toBe("1");
    const r = await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: source() });
    expect(r).toMatchObject({ ok: true, userId: admin, systemAdmin: true, secondStep: "required" });
  });

  it("checks the address, the name and the password before anything is stored", async () => {
    const testDb = await freshDatabase();
    try {
      await migrate({ connectionString: testDb.url });
      const d = openDatabase(testDb.url, { max: 2 });
      try {
        const bad = await createFirstSystemAdmin(d, {
          email: "not an address",
          displayName: " padded",
          password: "password1",
        });
        expect(codes(bad)).toEqual(["invalid_email", "invalid_display_name", "common_password"]);
        expect(
          codes(
            await createFirstSystemAdmin(d, {
              email: "admin@example.org",
              displayName: "Admin",
              password: "Oculus2026!",
            }),
          ),
        ).toEqual(["context_words"]);
        expect(
          codes(
            await createFirstSystemAdmin(d, {
              email: "admin@example.org",
              displayName: "Admin",
              password: "a fine invented passphrase",
              extra: true,
            } as never),
          ),
        ).toEqual(["invalid_request"]);
        expect(await d.rows(sql`SELECT 1 FROM public.users`)).toEqual([]);
        // Two at once: exactly one wins.
        const both = await Promise.all(
          ["a", "b"].map((x) =>
            createFirstSystemAdmin(d, {
              email: `${x}.admin@example.org`,
              displayName: "Admin",
              password: "a fine invented passphrase",
            }),
          ),
        );
        expect(both.filter((r) => r.ok)).toHaveLength(1);
        expect(both.flatMap(codes)).toEqual(["already_set_up"]);
      } finally {
        await d.close();
      }
    } finally {
      await testDb.drop();
    }
  });
});

describe("invitations", () => {
  it("store only the token's hash and make an account and membership when accepted", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const inv = await invite(org, address);
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inv.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const stored = await db.rows<{ token_hash: Uint8Array; text: string }>(sql`
      SELECT token_hash, row_to_json(i)::text AS text FROM public.invitations i
      WHERE id = ${inv.invitationId}::uuid`);
    const expected = createHash("sha256").update(inv.token).digest();
    expect(Buffer.from(stored[0]?.token_hash ?? []).equals(expected)).toBe(true);
    expect(stored[0]?.text).not.toContain(inv.token);
    const life = await db.rows<{ days: string }>(sql`
      SELECT extract(epoch FROM expires_at - created_at) / 86400 AS days
      FROM public.invitations WHERE id = ${inv.invitationId}::uuid`);
    expect(Number(life[0]?.days)).toBe(7);

    const accepted = await acceptInvitation(db, {
      token: inv.token,
      organizationId: org,
      email: address.toUpperCase(),
      displayName: "Invented Person",
      password: PASSWORD,
    });
    const { userId } = ok(accepted);
    const r = await signIn(db, { email: address, password: PASSWORD, source: source() });
    expect(r).toEqual({
      ok: true,
      userId,
      systemAdmin: false,
      organizationIds: [org],
      secondStep: "required",
    });
    const user = await db.rows<{ password_hash: string; system_admin: boolean }>(sql`
      SELECT password_hash, system_admin FROM public.users WHERE id = ${userId}::uuid`);
    expect(user[0]?.password_hash).toMatch(/^\$scrypt\$ln=14,r=8,p=5\$/);
    expect(user[0]?.system_admin).toBe(false);
  });

  it("can be used once only, even by the same person", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const inv = await invite(org, address);
    const form = {
      token: inv.token,
      organizationId: org,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    };
    const first = ok(await acceptInvitation(db, form));
    expect(codes(await acceptInvitation(db, form))).toEqual(["invalid_invitation"]);
    expect(
      codes(
        await acceptInvitationForUser(db, {
          token: inv.token,
          organizationId: org,
          userId: first.userId,
        }),
      ),
    ).toEqual(["invalid_invitation"]);
  });

  it("can't be accepted once expired, by the function or by direct SQL", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const inv = await invite(org, address);
    await expire(inv.invitationId);
    const r = await acceptInvitation(db, {
      token: inv.token,
      organizationId: org,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    });
    expect(codes(r)).toEqual(["invalid_invitation"]);
    await expect(
      db.execute(sql`
        UPDATE public.invitations SET accepted_at = now(), accepted_by = ${admin}::uuid
        WHERE id = ${inv.invitationId}::uuid`),
    ).rejects.toMatchObject({ constraint: "invitations_expired" });
    expect(await db.rows(sql`SELECT 1 FROM public.users WHERE email = ${address}`)).toEqual([]);
  });

  it("are bound to their organization and address, and every refusal looks the same", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const address = email();
    const inv = await invite(orgA, address);
    const base = {
      token: inv.token,
      organizationId: orgA,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    };
    const attempts = [
      { ...base, organizationId: orgB },
      { ...base, organizationId: newOrganizationId() },
      { ...base, email: email() },
      { ...base, token: newInvitationToken() },
      { ...base, token: `${inv.token.slice(0, -1)}!` },
      { ...base, token: inv.token.slice(1) },
      { ...base, organizationId: "not-an-id" as OrganizationId },
      { ...base, email: "not an address" },
    ];
    const results = await Promise.all(attempts.map((a) => acceptInvitation(db, a)));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(codes(results[0] ?? { ok: true, value: 0 })).toEqual(["invalid_invitation"]);
    // The real one still works afterwards.
    expect((await acceptInvitation(db, base)).ok).toBe(true);
    expect(
      await db.rows(sql`SELECT organization_id::text AS o FROM public.organization_members m
        JOIN public.users u ON u.id = m.user_id WHERE u.email = ${address}`),
    ).toEqual([{ o: orgA }]);
  });

  it("are revoked by the admin, or by a newer invitation to the same address", async () => {
    await ready();
    const org = await organization();
    const other = await organization();
    const address = email();
    const first = await invite(org, address);
    const second = await invite(org, address);
    const form = (token: string) => ({
      token,
      organizationId: org,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    });
    expect(codes(await acceptInvitation(db, form(first.token)))).toEqual(["invalid_invitation"]);
    // Revoking needs the invitation's own organization.
    expect(
      codes(
        await revokeInvitation(db, {
          organizationId: other,
          invitationId: second.invitationId,
          by: admin,
        }),
      ),
    ).toEqual(["unknown_invitation"]);
    ok(
      await revokeInvitation(db, {
        organizationId: org,
        invitationId: second.invitationId,
        by: admin,
      }),
    );
    expect(codes(await acceptInvitation(db, form(second.token)))).toEqual(["invalid_invitation"]);
    expect(
      codes(
        await revokeInvitation(db, {
          organizationId: org,
          invitationId: second.invitationId,
          by: admin,
        }),
      ),
    ).toEqual(["unknown_invitation"]);
    const third = await invite(org, address);
    expect((await acceptInvitation(db, form(third.token))).ok).toBe(true);
  });

  it("are made only by an active system admin, for real organizations and addresses", async () => {
    await ready();
    const org = await organization();
    const someone = await member(org);
    const r = await inviteVia(db, {
      organizationId: org,
      email: email(),
      invitedBy: someone.userId,
    });
    expect(codes(r)).toEqual(["not_permitted"]);
    expect(
      codes(
        await inviteVia(db, {
          organizationId: org,
          email: email(),
          invitedBy: newUserIdLike(),
        }),
      ),
    ).toEqual(["not_permitted"]);
    expect(
      codes(
        await inviteVia(db, {
          organizationId: newOrganizationId(),
          email: email(),
          invitedBy: admin,
        }),
      ),
    ).toEqual(["unknown_organization"]);
    expect(
      codes(await inviteVia(db, { organizationId: org, email: someone.email, invitedBy: admin })),
    ).toEqual(["already_member"]);
    expect(
      codes(await inviteVia(db, { organizationId: org, email: "nope", invitedBy: admin })),
    ).toEqual(["invalid_email"]);
    for (const life of [0, 3599, 14 * 86400 + 1, 1.5, Number.NaN, "3600"]) {
      expect(
        codes(
          await inviteVia(db, {
            organizationId: org,
            email: email(),
            invitedBy: admin,
            expiresInSeconds: life as number,
          }),
        ),
      ).toEqual(["invalid_life"]);
    }
    const short = ok(
      await inviteVia(db, {
        organizationId: org,
        email: email(),
        invitedBy: admin,
        expiresInSeconds: 3600,
      }),
    );
    expect(short.token).toHaveLength(43);
    // A disabled admin can't invite.
    await db.execute(sql`UPDATE public.users SET disabled_at = now() WHERE id = ${admin}::uuid`);
    try {
      expect(
        codes(await inviteVia(db, { organizationId: org, email: email(), invitedBy: admin })),
      ).toEqual(["not_permitted"]);
    } finally {
      await db.execute(sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${admin}::uuid`);
    }
    // In the database, at most 14 days.
    await expect(
      db.execute(sql`
        INSERT INTO public.invitations (organization_id, id, email, token_hash, invited_by, expires_at)
        VALUES (${org}::uuid, gen_random_uuid(), 'x@example.org', ${new Uint8Array(32).fill(9)},
                ${admin}::uuid, now() + interval '15 days')`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuse an address that has an account; that person joins as themselves", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA);
    const stranger = await member(orgA);
    const inv = await invite(orgB, person.email);
    expect(
      codes(
        await acceptInvitation(db, {
          token: inv.token,
          organizationId: orgB,
          email: person.email,
          displayName: "Someone Else",
          password: "a password chosen by someone else",
        }),
      ),
    ).toEqual(["account_exists"]);
    // The password was not changed by that attempt.
    expect(
      (await signIn(db, { email: person.email, password: PASSWORD, source: source() })).ok,
    ).toBe(true);
    // Someone else's account can't take the invitation.
    expect(
      codes(
        await acceptInvitationForUser(db, {
          token: inv.token,
          organizationId: orgB,
          userId: stranger.userId,
        }),
      ),
    ).toEqual(["invalid_invitation"]);
    expect(
      codes(
        await acceptInvitationForUser(db, {
          token: inv.token,
          organizationId: orgA,
          userId: person.userId,
        }),
      ),
    ).toEqual(["invalid_invitation"]);
    ok(
      await acceptInvitationForUser(db, {
        token: inv.token,
        organizationId: orgB,
        userId: person.userId,
      }),
    );
    const r = await signIn(db, { email: person.email, password: PASSWORD, source: source() });
    expect(r).toMatchObject({ ok: true, organizationIds: [orgA, orgB].sort() });
    expect(
      codes(
        await acceptInvitationForUser(db, {
          token: inv.token,
          organizationId: orgB,
          userId: person.userId,
        }),
      ),
    ).toEqual(["invalid_invitation"]);
  });

  it("check the new account's name and password, with the organization's name as context", async () => {
    await ready();
    const org = await organization("Riverbend Heritage Trust");
    const address = email();
    const inv = await invite(org, address);
    const form = {
      token: inv.token,
      organizationId: org,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    };
    expect(codes(await acceptInvitation(db, { ...form, password: "Riverbend1!" }))).toEqual([
      "context_words",
    ]);
    expect(codes(await acceptInvitation(db, { ...form, password: "short" }))).toEqual([
      "too_short",
    ]);
    expect(codes(await acceptInvitation(db, { ...form, displayName: "" }))).toEqual([
      "invalid_display_name",
    ]);
    expect(codes(await acceptInvitation(db, { ...form, extra: 1 } as never))).toEqual([
      "invalid_request",
    ]);
    // None of that used the invitation up.
    expect((await acceptInvitation(db, form)).ok).toBe(true);
  });

  it("can be accepted only once when two connections try at the same moment", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const inv = await invite(org, address);
    const url = (await setup)?.testDb.url ?? "";
    const other = openDatabase(url, { max: 4 });
    try {
      const forms = [db, other, db, other].map((conn, i) =>
        acceptInvitation(conn, {
          token: inv.token,
          organizationId: org,
          email: address,
          displayName: `Invented Person ${String(i)}`,
          password: PASSWORD,
        }),
      );
      const results = await Promise.all(forms);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((x) => !x.ok)) {
        expect(["invalid_invitation", "account_exists"]).toContain(codes(r)[0]);
      }
      expect(await db.rows(sql`SELECT 1 FROM public.users WHERE email = ${address}`)).toHaveLength(
        1,
      );
      expect(
        await db.rows(
          sql`SELECT 1 FROM public.organization_members WHERE invitation_id = ${inv.invitationId}::uuid`,
        ),
      ).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("for one address made at the same moment leave exactly one pending", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const url = (await setup)?.testDb.url ?? "";
    const other = openDatabase(url, { max: 4 });
    try {
      const made = await Promise.all(
        [db, other, db, other].map((conn) =>
          inviteVia(conn, { organizationId: org, email: address, invitedBy: admin }),
        ),
      );
      expect(made.every((r) => r.ok)).toBe(true);
      const pending = await db.rows(sql`
        SELECT 1 FROM public.invitations WHERE organization_id = ${org}::uuid AND email = ${address}
          AND accepted_at IS NULL AND revoked_at IS NULL`);
      expect(pending).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
});

function newUserIdLike(): UserId {
  return "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c" as UserId;
}

describe("signIn", () => {
  it("answers an unknown address exactly like a wrong password, and both cost one hash", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const tries: [string, string][] = [
      [person.email, "not the right password"],
      [email(), "not the right password"],
      ["not even an address", "not the right password"],
      [person.email.toUpperCase(), "not the right password"],
      [person.email, PASSWORD.toUpperCase()],
      [person.email, ""],
      [person.email, "x".repeat(2000)],
    ];
    const results: SignInResult[] = [];
    for (const [address, password] of tries) {
      const before = passwordWorkCount();
      results.push(await signIn(db, { email: address, password, source: source() }));
      expect(passwordWorkCount() - before).toBe(1);
    }
    for (const r of results) expect(r).toEqual(INVALID_CREDENTIALS);
    expect(JSON.stringify(INVALID_CREDENTIALS)).not.toMatch(/exist|unknown|wrong password/i);
  });

  it("never reaches an account through Unicode case folding of the address", async () => {
    await ready();
    const org = await organization();
    const address = `kat${String(unique())}@example.org`;
    await member(org, address);
    // U+212A KELVIN SIGN lower-cases to "k".
    for (const typed of [`\u212A${address.slice(1)}`]) {
      expect(typed.toLowerCase()).toBe(address);
      expect(await signIn(db, { email: typed, password: PASSWORD, source: source() })).toEqual(
        INVALID_CREDENTIALS,
      );
    }
    expect(
      await signIn(db, { email: address, password: PASSWORD, source: source() }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("takes about as long for an unknown address as for a wrong password", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      for (const [list, address] of [
        [known, person.email],
        [unknown, email()],
      ] as const) {
        const t = performance.now();
        await signIn(db, { email: address, password: "not the right password", source: source() });
        list.push(performance.now() - t);
      }
      // Stay under the account counter's free failures.
      await db.execute(
        sql`DELETE FROM public.sign_in_throttles WHERE key = ${throttleAccountKey(person.email)}`,
      );
    }
    // Both run one scrypt (about 0.1–0.3 s); an unknown address that
    // skipped it would take a few milliseconds.
    const ratio = median(unknown) / median(known);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  }, 60_000);

  it("refuses a disabled account and one without access, the same way", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA);
    const right = { email: person.email, password: PASSWORD };
    expect(await signIn(db, { ...right, source: source(), organizationId: orgA })).toMatchObject({
      ok: true,
    });
    expect(await signIn(db, { ...right, source: source(), organizationId: orgB })).toEqual(
      INVALID_CREDENTIALS,
    );
    expect(
      await signIn(db, { ...right, source: source(), organizationId: newOrganizationId() }),
    ).toEqual(INVALID_CREDENTIALS);
    // A system admin may enter any organization (D-019).
    expect(
      await signIn(db, {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        source: source(),
        organizationId: orgB,
      }),
    ).toMatchObject({ ok: true, systemAdmin: true });
    await db.execute(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
    );
    const before = passwordWorkCount();
    expect(await signIn(db, { ...right, source: source() })).toEqual(INVALID_CREDENTIALS);
    expect(passwordWorkCount() - before).toBe(1);
    await db.execute(
      sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${person.userId}::uuid`,
    );
    expect(await signIn(db, { ...right, source: source() })).toMatchObject({ ok: true });
  });

  it("refuses an account with no organization at all", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // No trigger guards a membership's DELETE (removing people is T-048's).
    await db.execute(
      sql`DELETE FROM public.organization_members WHERE user_id = ${person.userId}::uuid`,
    );
    expect(await signIn(db, { email: person.email, password: PASSWORD, source: source() })).toEqual(
      INVALID_CREDENTIALS,
    );
  });

  it("refuses malformed requests without counting or hashing", async () => {
    await ready();
    const s = source();
    const hostile = Object.defineProperty({ password: "x", source: s }, "email", {
      get: () => "first.admin@example.org",
      enumerable: true,
    });
    const before = passwordWorkCount();
    for (const input of [
      { email: 1, password: "x", source: s },
      { email: "a@example.org", password: null, source: s },
      { email: "a@example.org", password: "x" },
      { email: "a@example.org", password: "x", source: s, organizationId: "nope" },
      { email: "a@example.org", password: "x", source: s, extra: 1 },
      { email: "a".repeat(1025), password: "x", source: s },
      { email: "a@example.org", password: "x".repeat(4097), source: s },
      hostile,
      null,
      [],
    ]) {
      expect(await signIn(db, input as never)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }
    expect(passwordWorkCount() - before).toBe(0);
    expect(await counterOf(throttleSourceKey(s))).toBeUndefined();
  });
});

describe("sign-in throttling", () => {
  it("lets five wrong passwords through, then makes the account wait, even for the right one", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const key = throttleAccountKey(person.email);
    for (let i = 0; i < 5; i++) {
      expect(
        await signIn(db, { email: person.email, password: "wrong guess", source: source() }),
      ).toEqual(INVALID_CREDENTIALS);
    }
    expect(await counterOf(key)).toMatchObject({ failures: 5 });
    const before = passwordWorkCount();
    const right = await signIn(db, { email: person.email, password: PASSWORD, source: source() });
    expect(right).toMatchObject({ ok: false, code: "throttled", retryAfterSeconds: 1 });
    // A refused attempt checks no password and isn't counted.
    expect(passwordWorkCount() - before).toBe(0);
    expect(await counterOf(key)).toMatchObject({ failures: 5 });
    // The wait passes; the right password works and clears the counter.
    await age(key, 1);
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: source() }),
    ).toMatchObject({
      ok: true,
    });
    expect(await counterOf(key)).toBeUndefined();
  });

  it("throttles an address with no account exactly like one with an account", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const nobody = email();
    const run = async (address: string): Promise<SignInResult[]> => {
      const out: SignInResult[] = [];
      for (let i = 0; i < 7; i++)
        out.push(await signIn(db, { email: address, password: "wrong guess", source: source() }));
      return out;
    };
    const a = await run(person.email);
    const b = await run(nobody);
    expect(a).toEqual(b);
    expect(a.map((r) => (r.ok ? "ok" : r.code))).toEqual([
      ...Array<string>(5).fill("invalid_credentials"),
      "throttled",
      "throttled",
    ]);
  });

  it("grows the wait to at most 15 minutes and lifts it when the wait has passed", async () => {
    await ready();
    const address = email();
    const key = throttleAccountKey(address);
    await signIn(db, { email: address, password: "wrong guess", source: source() });
    await db.execute(sql`UPDATE public.sign_in_throttles SET failures = 400 WHERE key = ${key}`);
    expect(
      await signIn(db, { email: address, password: "wrong guess", source: source() }),
    ).toMatchObject({
      code: "throttled",
      retryAfterSeconds: 900,
    });
    await age(key, 899);
    expect(
      await signIn(db, { email: address, password: "wrong guess", source: source() }),
    ).toMatchObject({
      code: "throttled",
      retryAfterSeconds: 1,
    });
    await age(key, 1);
    expect(await signIn(db, { email: address, password: "wrong guess", source: source() })).toEqual(
      INVALID_CREDENTIALS,
    );
    expect(await counterOf(key)).toMatchObject({ failures: 401 });
  });

  it("forgets the account counter after a day without failures", async () => {
    await ready();
    const address = email();
    const key = throttleAccountKey(address);
    for (let i = 0; i < 6; i++)
      await signIn(db, { email: address, password: "wrong guess", source: source() });
    expect((await signIn(db, { email: address, password: "x", source: source() })).ok).toBe(false);
    await age(key, 24 * 3600);
    expect(await signIn(db, { email: address, password: "wrong guess", source: source() })).toEqual(
      INVALID_CREDENTIALS,
    );
    expect(await counterOf(key)).toMatchObject({ failures: 1 });
  });

  it("limits one client address across many accounts, and leaves other addresses alone", async () => {
    await ready();
    const from = source();
    for (let i = 0; i < 20; i++) {
      expect(await signIn(db, { email: email(), password: "spray guess", source: from })).toEqual(
        INVALID_CREDENTIALS,
      );
    }
    expect(
      await signIn(db, { email: email(), password: "spray guess", source: from }),
    ).toMatchObject({
      code: "throttled",
      retryAfterSeconds: 1,
    });
    // The admin, from that address, waits too; from another address, not.
    expect(
      await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: from }),
    ).toMatchObject({
      code: "throttled",
    });
    expect(
      await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: source() }),
    ).toMatchObject({
      ok: true,
    });
    await age(throttleSourceKey(from), 1);
    expect(
      await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: from }),
    ).toMatchObject({
      ok: true,
    });
    // The success took one off the address's count (21 counted, 20 left).
    expect(await counterOf(throttleSourceKey(from))).toMatchObject({ failures: 20 });
  }, 60_000);

  it("counts a whole IPv6 /64 as one address", async () => {
    await ready();
    const n = unique().toString(16);
    for (let i = 0; i < 20; i++) {
      await signIn(db, {
        email: email(),
        password: "spray guess",
        source: `2001:db8:${n}:1::${i.toString(16)}`,
      });
    }
    expect(
      await signIn(db, {
        email: email(),
        password: "spray guess",
        source: `2001:db8:${n}:1:ffff::9`,
      }),
    ).toMatchObject({ code: "throttled" });
    expect(
      await signIn(db, { email: email(), password: "spray guess", source: `2001:db8:${n}:2::1` }),
    ).toEqual(INVALID_CREDENTIALS);
  }, 60_000);

  it("counts every one of many attempts sent at once on two connections", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const url = (await setup)?.testDb.url ?? "";
    const other = openDatabase(url, { max: 6 });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          signIn(i % 2 === 0 ? db : other, {
            email: person.email,
            password: "parallel guess",
            source: source(),
          }),
        ),
      );
      const tally = results.map((r) => (r.ok ? "ok" : r.code)).sort();
      expect(tally).toEqual([
        ...Array<string>(5).fill("invalid_credentials"),
        ...Array<string>(5).fill("throttled"),
      ]);
      expect(await counterOf(throttleAccountKey(person.email))).toMatchObject({ failures: 5 });
    } finally {
      await other.close();
    }
  }, 60_000);

  it("lets the same person sign in on two connections at once", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const url = (await setup)?.testDb.url ?? "";
    const other = openDatabase(url, { max: 4 });
    try {
      const from = source();
      const results = await Promise.all(
        [db, other, db, other].map((conn) =>
          signIn(conn, { email: person.email, password: PASSWORD, source: from }),
        ),
      );
      for (const r of results) expect(r).toMatchObject({ ok: true, userId: person.userId });
      expect(await counterOf(throttleAccountKey(person.email))).toBeUndefined();
      expect(await counterOf(throttleSourceKey(from))).toMatchObject({ failures: 0 });
    } finally {
      await other.close();
    }
  });

  it("lets a system admin clear an account's counter, and nobody else", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const victim = await member(org);
    const key = throttleAccountKey(victim.email);
    for (let i = 0; i < 6; i++)
      await signIn(db, { email: victim.email, password: "attacker guess", source: source() });
    expect(
      await signIn(db, { email: victim.email, password: PASSWORD, source: source() }),
    ).toMatchObject({
      code: "throttled",
    });
    expect(
      codes(await clearSignInThrottle(db, { email: victim.email, by: person.userId })),
    ).toEqual(["not_permitted"]);
    expect(
      ok(await clearSignInThrottle(db, { email: victim.email.toUpperCase(), by: admin })),
    ).toEqual({
      cleared: true,
    });
    expect(await counterOf(key)).toBeUndefined();
    expect(
      await signIn(db, { email: victim.email, password: PASSWORD, source: source() }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("deletes counters nobody needs any more", async () => {
    await ready();
    const fresh = email();
    const old = email();
    await signIn(db, { email: fresh, password: "a guess", source: source() });
    await signIn(db, { email: old, password: "a guess", source: source() });
    await age(throttleAccountKey(old), 24 * 3600 + 1);
    await deleteExpiredSignInThrottles(db);
    expect(await counterOf(throttleAccountKey(old))).toBeUndefined();
    expect(await counterOf(throttleAccountKey(fresh))).toMatchObject({ failures: 1 });
  });
});

describe("known addresses: strangers can't keep anyone out where they sign in (S-018)", () => {
  async function knownRow(
    address: string,
    from: string,
  ): Promise<{ failures: number } | undefined> {
    const rows = await db.rows<{ failures: number }>(sql`
      SELECT failures FROM public.sign_in_known_sources
      WHERE account_key = ${throttleAccountKey(address)} AND source_key = ${throttleSourceKey(from)}`);
    return rows[0];
  }

  /** The account counter at its longest wait, just now, as a stranger guessing once per wait leaves it. */
  async function heldByStranger(address: string): Promise<void> {
    await signIn(db, { email: address, password: "stranger guess", source: source() });
    await db.execute(sql`
      UPDATE public.sign_in_throttles SET failures = 400, last_failure_at = clock_timestamp()
      WHERE key = ${throttleAccountKey(address)}`);
  }

  it("lets the only system admin in from their own address however long a stranger keeps guessing", async () => {
    await ready();
    const home = source();
    const key = throttleAccountKey(ADMIN_EMAIL);
    try {
      expect(
        await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: home }),
      ).toMatchObject({ ok: true, systemAdmin: true });
      // The attack: one wrong guess from elsewhere each time the wait ends.
      for (let round = 0; round < 3; round++) {
        await age(key, 900);
        expect(
          await signIn(db, { email: ADMIN_EMAIL, password: "stranger guess", source: source() }),
        ).toEqual(INVALID_CREDENTIALS);
        expect((await counterOf(key))?.failures).toBeGreaterThan(0);
        await db.execute(
          sql`UPDATE public.sign_in_throttles SET failures = 400 WHERE key = ${key}`,
        );
        // Anywhere new still waits (John, 2026-11-23: waits apply everywhere) …
        expect(
          await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: source() }),
        ).toMatchObject({ code: "throttled", retryAfterSeconds: 900 });
        // … but the admin's own address gets the password checked.
        expect(
          await signIn(db, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, source: home }),
        ).toMatchObject({ ok: true, systemAdmin: true });
        // The right password cleared the account counter.
        expect(await counterOf(key)).toBeUndefined();
        await signIn(db, { email: ADMIN_EMAIL, password: "stranger guess", source: source() });
      }
    } finally {
      await db.execute(sql`DELETE FROM public.sign_in_throttles WHERE key = ${key}`);
    }
  });

  it("gives a known address only the account rule's guesses during the account's wait", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const home = source();
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ ok: true });
    expect(await knownRow(person.email, home)).toEqual({ failures: 0 });
    await heldByStranger(person.email);
    const tally: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await signIn(db, { email: person.email, password: "home guess", source: home });
      tally.push(r.ok ? "ok" : r.code);
    }
    expect(tally).toEqual([
      ...Array<string>(5).fill("invalid_credentials"),
      "throttled",
      "throttled",
    ]);
    expect(await knownRow(person.email, home)).toEqual({ failures: 5 });
    // Every attempt checked was counted on the account counter too.
    expect((await counterOf(throttleAccountKey(person.email)))?.failures).toBe(405);
    // Even the right password waits now at home, and elsewhere.
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ code: "throttled", retryAfterSeconds: 1 });
  });

  it("keeps the client address counter at a known address", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const home = source();
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ ok: true });
    for (let i = 0; i < 20; i++) {
      await signIn(db, { email: email(), password: "spray guess", source: home });
    }
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ code: "throttled" });
  }, 60_000);

  it("forgets a known address 30 days after its last right password", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const home = source();
    await signIn(db, { email: person.email, password: PASSWORD, source: home });
    await db.execute(sql`
      UPDATE public.sign_in_known_sources SET signed_in_at = signed_in_at - interval '30 days'
      WHERE account_key = ${throttleAccountKey(person.email)}`);
    await heldByStranger(person.email);
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ code: "throttled" });
    await deleteExpiredSignInThrottles(db);
    expect(await knownRow(person.email, home)).toBeUndefined();
  });

  it("keeps at most the 20 newest known addresses per account", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const key = throttleAccountKey(person.email);
    const old = Array.from({ length: 25 }, () => source());
    for (const [i, from] of old.entries()) {
      await db.execute(sql`
        INSERT INTO public.sign_in_known_sources (account_key, source_key, signed_in_at)
        VALUES (${key}, ${throttleSourceKey(from)},
                clock_timestamp() - make_interval(secs => ${100 - i}))`);
    }
    const newest = source();
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: newest }),
    ).toMatchObject({ ok: true });
    const rows = await db.rows<{ source_key: string }>(sql`
      SELECT source_key FROM public.sign_in_known_sources WHERE account_key = ${key}
      ORDER BY signed_in_at DESC`);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.source_key).toBe(throttleSourceKey(newest));
    // The newest 19 of the old ones stay; the 6 oldest went.
    expect(rows.slice(1).map((r) => r.source_key)).toEqual(
      old
        .slice(6)
        .reverse()
        .map((a) => throttleSourceKey(a)),
    );
  });

  it("never makes an unreadable client address known, and never from a wrong password", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const from = source();
    await signIn(db, { email: person.email, password: "wrong guess", source: from });
    expect(await knownRow(person.email, from)).toBeUndefined();
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: "not an address" }),
    ).toMatchObject({ ok: true });
    const rows = await db.rows(sql`
      SELECT 1 FROM public.sign_in_known_sources
      WHERE account_key = ${throttleAccountKey(person.email)}`);
    expect(rows).toHaveLength(0);
  });

  it("answers a stranger the same for an address with known addresses as for one with none", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    await signIn(db, { email: person.email, password: PASSWORD, source: source() });
    const nobody = email();
    const run = async (address: string): Promise<SignInResult[]> => {
      const out: SignInResult[] = [];
      for (let i = 0; i < 7; i++)
        out.push(await signIn(db, { email: address, password: "wrong guess", source: source() }));
      return out;
    };
    expect(await run(person.email)).toEqual(await run(nobody));
  });
});

describe("what the inviter can learn (D-068)", () => {
  it("never gets the token, and an invitation that can't be sent is withdrawn", async () => {
    await ready();
    const org = await organization();
    const address = email();
    let token = "";
    const made = await createInvitation(
      db,
      { organizationId: org, email: address, invitedBy: admin },
      (m) => {
        token = m.token;
        return Promise.reject(new Error("mail server down: secret detail"));
      },
    );
    expect(made).toEqual({
      ok: false,
      issues: [
        {
          path: [],
          code: "delivery_failed",
          message: "The invitation couldn't be sent, so it was withdrawn. Try again later.",
        },
      ],
    });
    expect(JSON.stringify(made)).not.toContain(token);
    const rows = await db.rows<{ revoked: boolean; by: string }>(sql`
      SELECT revoked_at IS NOT NULL AS revoked, revoked_by::text AS by
      FROM public.invitations WHERE email = ${address}`);
    expect(rows).toEqual([{ revoked: true, by: admin }]);
    expect(
      codes(
        await acceptInvitation(db, {
          token,
          organizationId: org,
          email: address,
          displayName: "Invented Person",
          password: PASSWORD,
        }),
      ),
    ).toEqual(["invalid_invitation"]);
    // A delivery that throws at once, not by rejecting, is the same.
    const sync = await createInvitation(
      db,
      { organizationId: org, email: email(), invitedBy: admin },
      () => {
        throw new Error("boom");
      },
    );
    expect(codes(sync)).toEqual(["delivery_failed"]);
    await expect(
      createInvitation(
        db,
        { organizationId: org, email: address, invitedBy: admin },
        undefined as never,
      ),
    ).rejects.toThrow(TypeError);
    for (const bad of [0, -1, 1.5, 300_001, "10"]) {
      await expect(
        createInvitation(
          db,
          { organizationId: org, email: address, invitedBy: admin },
          () => Promise.resolve(),
          {
            deliveryTimeoutMs: bad as number,
          },
        ),
      ).rejects.toThrow(TypeError);
    }
  });

  it("sends after committing: a slow send holds no lock and no connection", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const url = (await setup)?.testDb.url ?? "";
    const single = openDatabase(url, { max: 1 });
    try {
      let release: () => void = () => undefined;
      let called: () => void = () => undefined;
      const sending = new Promise<void>((resolve) => {
        called = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = createInvitation(
        single,
        { organizationId: org, email: address, invitedBy: admin },
        () => {
          called();
          return gate;
        },
      );
      await sending;
      // The pool's only connection is free, and the address's lock is free:
      // another invitation for it goes through at once.
      expect(await single.rows(sql`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
      const second = await inviteVia(db, { organizationId: org, email: address, invitedBy: admin });
      expect(second.ok).toBe(true);
      release();
      // The first was revoked by the second while it was being sent: it is
      // reported as superseded, not as a success with a dead ID (S-016).
      expect(await slow).toEqual({
        ok: false,
        issues: [
          {
            path: [],
            code: "superseded",
            message:
              "A newer invitation to this address replaced this one while it was being sent; only the newer one works.",
          },
        ],
      });
      const pending = await db.rows(sql`
        SELECT 1 FROM public.invitations WHERE organization_id = ${org}::uuid AND email = ${address}
          AND accepted_at IS NULL AND revoked_at IS NULL`);
      expect(pending).toHaveLength(1);
    } finally {
      await single.close();
    }
  });

  it("reports an invitation an admin withdrew while it was being sent as revoked (S-016)", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const made = await createInvitation(
      db,
      { organizationId: org, email: address, invitedBy: admin },
      async () => {
        const [row] = await db.rows<{ id: InvitationId }>(sql`
          SELECT id::text AS id FROM public.invitations
          WHERE organization_id = ${org}::uuid AND email = ${address}`);
        ok(
          await revokeInvitation(db, {
            organizationId: org,
            invitationId: row?.id ?? ("" as InvitationId),
            by: admin,
          }),
        );
      },
    );
    expect(codes(made)).toEqual(["revoked"]);
  });

  it("retries a failed withdrawal once, and says the invitation may still be pending if that fails too (S-016)", async () => {
    await ready();
    const org = await organization();
    /** The real pool, with every transaction after the first `pass` failing as `error`. */
    const failingAfter = (pass: number, error: Error, failures = Infinity) => {
      let calls = 0;
      let failed = 0;
      const wrapped: Database = {
        ...db,
        rows: db.rows.bind(db),
        execute: db.execute.bind(db),
        close: () => Promise.resolve(),
        transaction: (work) => {
          calls += 1;
          if (calls > pass && failed < failures) {
            failed += 1;
            return Promise.reject(error);
          }
          return db.transaction(work);
        },
      };
      return { wrapped, calls: () => calls };
    };
    const pendingFor = async (address: string): Promise<number> => {
      const [row] = await db.rows<{ n: number }>(sql`
        SELECT count(*)::integer AS n FROM public.invitations
        WHERE organization_id = ${org}::uuid AND email = ${address}
          AND accepted_at IS NULL AND revoked_at IS NULL`);
      return row?.n ?? -1;
    };
    const notSent = () => Promise.reject(new Error("not sent"));
    // Both withdrawals fail: a distinct answer, and the invitation is still pending.
    const lost = Object.assign(new Error("terminating connection"), { code: "57P01" });
    const twice = failingAfter(1, lost);
    const first = email();
    const made = await createInvitation(
      twice.wrapped,
      { organizationId: org, email: first, invitedBy: admin },
      notSent,
    );
    expect(codes(made)).toEqual(["delivery_failed_may_be_pending"]);
    expect(JSON.stringify(made)).not.toContain("terminating");
    expect(twice.calls()).toBe(3);
    expect(await pendingFor(first)).toBe(1);
    // The first withdrawal fails, the retry works: withdrawn.
    const once = failingAfter(1, lost, 1);
    const second = email();
    expect(
      codes(
        await createInvitation(
          once.wrapped,
          { organizationId: org, email: second, invitedBy: admin },
          notSent,
        ),
      ),
    ).toEqual(["delivery_failed"]);
    expect(once.calls()).toBe(3);
    expect(await pendingFor(second)).toBe(0);
    // A programming error in the withdrawal is thrown, not answered.
    const bug = Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" });
    await expect(
      createInvitation(
        failingAfter(1, bug).wrapped,
        { organizationId: org, email: email(), invitedBy: admin },
        notSent,
      ),
    ).rejects.toBe(bug);
  });

  it("answers only database and network failures as database_unavailable, and throws programming errors (S-016)", async () => {
    await ready();
    const org = await organization();
    const failing = (error: Error): Database => ({
      ...db,
      rows: () => Promise.reject(error),
      execute: () => Promise.reject(error),
      close: () => Promise.resolve(),
      transaction: () => Promise.reject(error),
    });
    const request = { organizationId: org, email: email(), invitedBy: admin };
    const send = () => Promise.resolve();
    for (const failure of [
      Object.assign(new Error("the server's own text"), { code: "53300" }),
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      }),
      new Error("Connection terminated unexpectedly"),
    ]) {
      const made = await createInvitation(failing(failure), request, send);
      expect(codes(made)).toEqual(["database_unavailable"]);
      expect(JSON.stringify(made)).not.toContain(failure.message);
    }
    for (const bug of [
      Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" }),
      new TypeError("Queries must be made with the sql tag."),
      new Error("something we did wrong"),
    ]) {
      await expect(createInvitation(failing(bug), request, send)).rejects.toBe(bug);
    }
    // A real network failure: no server behind the socket directory.
    const nowhere = openDatabase("postgresql://nobody@localhost/nothing?host=%2Fnonexistent-s016");
    try {
      expect(codes(await createInvitation(nowhere, request, send))).toEqual([
        "database_unavailable",
      ]);
    } finally {
      await nowhere.close();
    }
  });

  it("withdraws an invitation whose send runs out of time, and tells the sender to stop", async () => {
    await ready();
    const org = await organization();
    const address = email();
    let aborted = false;
    const started = Date.now();
    const made = await createInvitation(
      db,
      { organizationId: org, email: address, invitedBy: admin },
      (_m, signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      { deliveryTimeoutMs: 100 },
    );
    expect(codes(made)).toEqual(["delivery_failed"]);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const rows = await db.rows<{ revoked: boolean }>(sql`
      SELECT revoked_at IS NOT NULL AS revoked FROM public.invitations WHERE email = ${address}`);
    expect(rows).toEqual([{ revoked: true }]);
  });

  it("leaves an invitation that was accepted although its send seemed to fail", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const made = await createInvitation(
      db,
      { organizationId: org, email: address, invitedBy: admin },
      async (m) => {
        // The message got through and the invitee was quick.
        ok(
          await acceptInvitation(db, {
            token: m.token,
            organizationId: m.organizationId,
            email: m.email,
            displayName: "Quick Invitee",
            password: PASSWORD,
          }),
        );
        throw new Error("the mail server answered late");
      },
    );
    expect(made).toMatchObject({ ok: true, value: { email: address } });
    expect((await signIn(db, { email: address, password: PASSWORD, source: source() })).ok).toBe(
      true,
    );
  });

  it("withdraws an unsent invitation even if its inviter was disabled meanwhile", async () => {
    await ready();
    const org = await organization();
    const address = email();
    try {
      const made = await createInvitation(
        db,
        { organizationId: org, email: address, invitedBy: admin },
        async () => {
          await db.execute(
            sql`UPDATE public.users SET disabled_at = now() WHERE id = ${admin}::uuid`,
          );
          throw new Error("not sent");
        },
      );
      expect(codes(made)).toEqual(["delivery_failed"]);
      const rows = await db.rows<{ revoked: boolean }>(sql`
        SELECT revoked_at IS NOT NULL AS revoked FROM public.invitations WHERE email = ${address}`);
      expect(rows).toEqual([{ revoked: true }]);
    } finally {
      await db.execute(sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${admin}::uuid`);
    }
  });

  it("answers not_permitted, not a database error, if the inviter loses the right just before the insert", async () => {
    await ready();
    const org = await organization();
    // A test-only trigger, firing before invitations_check_new (name
    // order), disables the inviter as the INSERT happens: the race the
    // check before it can't see.
    await db.execute(sql`CREATE FUNCTION public.t036_disable_inviter() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE public.users SET disabled_at = now() WHERE id = NEW.invited_by; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER aaaa_t036_disable_inviter BEFORE INSERT ON public.invitations
      FOR EACH ROW EXECUTE FUNCTION public.t036_disable_inviter()`);
    try {
      const made = await createInvitation(
        db,
        { organizationId: org, email: email(), invitedBy: admin },
        () => Promise.resolve(),
      );
      expect(made).toEqual({
        ok: false,
        issues: [{ path: [], code: "not_permitted", message: "Only a system admin can do that." }],
      });
    } finally {
      await db.execute(sql`DROP TRIGGER aaaa_t036_disable_inviter ON public.invitations`);
      await db.execute(sql`DROP FUNCTION public.t036_disable_inviter()`);
      await db.execute(sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${admin}::uuid`);
    }
  });

  it("answers a database failure with a fixed refusal, never the database's message", async () => {
    await ready();
    const org = await organization();
    await db.execute(sql`CREATE FUNCTION public.t036_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'internal detail 1234' USING ERRCODE = 'XX000'; END $$`);
    await db.execute(sql`CREATE TRIGGER aaaa_t036_fail BEFORE INSERT ON public.invitations
      FOR EACH ROW EXECUTE FUNCTION public.t036_fail()`);
    try {
      const made = await createInvitation(
        db,
        { organizationId: org, email: email(), invitedBy: admin },
        () => Promise.resolve(),
      );
      expect(codes(made)).toEqual(["database_unavailable"]);
      expect(JSON.stringify(made)).not.toContain("1234");
    } finally {
      await db.execute(sql`DROP TRIGGER aaaa_t036_fail ON public.invitations`);
      await db.execute(sql`DROP FUNCTION public.t036_fail()`);
    }
  });

  it("gives an incomplete form the same answer whether or not the address has an account", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const existing = await member(orgA);
    const fresh = email();
    const invExisting = await invite(orgB, existing.email);
    const invFresh = await invite(orgB, fresh);
    for (const form of [
      { displayName: "", password: PASSWORD },
      { displayName: "Invented Person", password: "short" },
      { displayName: "Invented Person", password: "password1" },
      { displayName: " ", password: "x" },
      { displayName: "Invented Person", password: "broken \ud800 text" },
    ]) {
      const a = await acceptInvitation(db, {
        token: invExisting.token,
        organizationId: orgB,
        email: existing.email,
        ...form,
      });
      const b = await acceptInvitation(db, {
        token: invFresh.token,
        organizationId: orgB,
        email: fresh,
        ...form,
      });
      expect(a.ok).toBe(false);
      expect(a).toEqual(b);
    }
    // Both links still work for their invitees.
    expect(
      codes(
        await acceptInvitation(db, {
          token: invExisting.token,
          organizationId: orgB,
          email: existing.email,
          displayName: "Invented Person",
          password: PASSWORD,
        }),
      ),
    ).toEqual(["account_exists"]);
    expect(
      (
        await acceptInvitation(db, {
          token: invFresh.token,
          organizationId: orgB,
          email: fresh,
          displayName: "Invented Person",
          password: PASSWORD,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("inputs that never reach the database", () => {
  it("refuses NUL and broken text at sign-in without counting or hashing", async () => {
    await ready();
    const s = source();
    const before = passwordWorkCount();
    for (const input of [
      { email: "first.admin@example.org\u0000", password: ADMIN_PASSWORD, source: s },
      { email: "\u0000", password: "x", source: s },
      { email: "half\ud800@example.org", password: "x", source: s },
      { email: ADMIN_EMAIL, password: "broken \udc00", source: s },
    ]) {
      expect(await signIn(db, input)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(passwordWorkCount() - before).toBe(0);
    expect(await counterOf(throttleSourceKey(s))).toBeUndefined();
    expect(await counterOf(throttleAccountKey(ADMIN_EMAIL))).toBeUndefined();
    // NUL elsewhere is refused by the checks, never by PostgreSQL.
    const org = await organization();
    expect(
      codes(
        await inviteVia(db, {
          organizationId: org,
          email: "a\u0000@example.org",
          invitedBy: admin,
        }),
      ),
    ).toEqual(["invalid_email"]);
    expect(ok(await clearSignInThrottle(db, { email: "a\u0000b", by: admin }))).toEqual({
      cleared: false,
    });
  });

  it("makes invitations for one address one at a time, on many connections at once", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const url = (await setup)?.testDb.url ?? "";
    const other = openDatabase(url, { max: 6 });
    try {
      const made = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          inviteVia(i % 2 === 0 ? db : other, {
            organizationId: org,
            email: address,
            invitedBy: admin,
          }),
        ),
      );
      // Each one is stored; one sent while a newer one was already being made comes back
      // superseded (S-016), so every answer is ok or superseded and exactly one stays pending.
      for (const r of made) {
        if (!r.ok) expect(r.issues.map((i) => i.code)).toEqual(["superseded"]);
      }
      const rows = await db.rows<{ pending: boolean }>(sql`
        SELECT accepted_at IS NULL AND revoked_at IS NULL AS pending FROM public.invitations
        WHERE organization_id = ${org}::uuid AND email = ${address}`);
      expect(rows).toHaveLength(12);
      expect(rows.filter((r) => r.pending)).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
});

describe("passwords at sign-in", () => {
  it("accepts the composed and decomposed forms of one password", async () => {
    await ready();
    const org = await organization();
    const address = email();
    const inv = await invite(org, address);
    ok(
      await acceptInvitation(db, {
        token: inv.token,
        organizationId: org,
        email: address,
        displayName: "Invented Person",
        password: "cafe\u0301 au lait at the bayou",
      }),
    );
    for (const typed of ["cafe\u0301 au lait at the bayou", "caf\u00e9 au lait at the bayou"]) {
      expect(await signIn(db, { email: address, password: typed, source: source() })).toMatchObject(
        { ok: true },
      );
    }
  });

  it("refuses a stored hash with other settings like an unknown user, at the same cost", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const { scrypt } = await import("node:crypto");
    const salt = Buffer.alloc(16, 5);
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(PASSWORD, salt, 32, { N: 2 ** 12, r: 8, p: 1 }, (e, k) => {
        if (e) reject(e);
        else resolve(k);
      });
    });
    const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
    const old = `$scrypt$ln=12,r=8,p=1$${b64(salt)}$${b64(key)}`;
    // The database won't store it ...
    await expect(
      db.execute(
        sql`UPDATE public.users SET password_hash = ${old} WHERE id = ${person.userId}::uuid`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // ... and if the CHECK were bypassed, core wouldn't run it.
    const saved = await db.rows<{ h: string }>(sql`
      SELECT password_hash AS h FROM public.users WHERE id = ${person.userId}::uuid`);
    await db.execute(sql`ALTER TABLE public.users DROP CONSTRAINT users_password_hash_check`);
    try {
      await db.execute(
        sql`UPDATE public.users SET password_hash = ${old} WHERE id = ${person.userId}::uuid`,
      );
      const before = passwordWorkCount();
      const r = await signIn(db, { email: person.email, password: PASSWORD, source: source() });
      expect(r).toEqual(INVALID_CREDENTIALS);
      expect(passwordWorkCount() - before).toBe(1);
    } finally {
      await db.execute(sql`UPDATE public.users SET password_hash = ${saved[0]?.h ?? ""}
        WHERE id = ${person.userId}::uuid`);
      await db.execute(sql`ALTER TABLE public.users ADD CONSTRAINT users_password_hash_check
        CHECK (public.password_hash_ok(password_hash))`);
    }
  });

  it("stores only hashes with allowed settings: the database refuses every other", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const tail = "$" + "A".repeat(22) + "$" + "A".repeat(43);
    for (const settings of [
      "ln=12,r=8,p=1",
      "ln=16,r=1,p=1",
      "ln=18,r=2,p=4",
      "ln=21,r=8,p=1",
      "ln=13,r=8,p=5",
      "ln=14,r=8,p=4",
      "ln=14,r=9,p=5",
    ]) {
      await expect(
        db.execute(sql`UPDATE public.users SET password_hash = ${`$scrypt$${settings}${tail}`}
          WHERE id = ${person.userId}::uuid`),
      ).rejects.toMatchObject({ code: "23514" });
    }
    for (const settings of ["ln=14,r=8,p=5"]) {
      await db.execute(sql`UPDATE public.users SET password_hash = ${`$scrypt$${settings}${tail}`}
        WHERE id = ${person.userId}::uuid`);
    }
    await expect(
      db.execute(
        sql`UPDATE public.users SET password_hash = 'plain text' WHERE id = ${person.userId}::uuid`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the database's own guards", () => {
  it("refuses an account made without an accepted invitation for its address", async () => {
    await ready();
    const org = await organization();
    const hash = "$scrypt$ln=14,r=8,p=5$" + "A".repeat(22) + "$" + "A".repeat(43);
    await expect(
      db.execute(sql`INSERT INTO public.users (id, email, display_name, password_hash)
        VALUES (gen_random_uuid(), 'direct@example.org', 'Direct', ${hash})`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.execute(sql`INSERT INTO public.users (id, email, display_name, password_hash, system_admin, bootstrap)
        VALUES (gen_random_uuid(), 'direct@example.org', 'Direct', ${hash}, true, true)`),
    ).rejects.toMatchObject({ code: "23505" });
    const inv = await invite(org, "invited@example.org");
    await expect(
      db.execute(sql`INSERT INTO public.users (id, email, display_name, password_hash, created_by_invitation)
        VALUES (gen_random_uuid(), 'invited@example.org', 'Direct', ${hash}, ${inv.invitationId}::uuid)`),
    ).rejects.toMatchObject({ constraint: "users_invitation_accepted" });
  });

  it("never lets an UPDATE change a sign-in address or make anyone a system admin", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    for (const change of [
      sql`UPDATE public.users SET email = 'taken.over@example.org' WHERE id = ${person.userId}::uuid`,
      sql`UPDATE public.users SET system_admin = true WHERE id = ${person.userId}::uuid`,
      sql`UPDATE public.users SET system_admin = false WHERE id = ${admin}::uuid`,
      sql`UPDATE public.users SET bootstrap = true, system_admin = true WHERE id = ${person.userId}::uuid`,
    ]) {
      await expect(db.execute(change)).rejects.toMatchObject({ code: "23000" });
    }
    // Only the bootstrap account is a system admin, even on INSERT.
    const inv = await invite(org, email());
    await expect(
      db.transaction(async (q) => {
        const id = "5a1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
        await q.execute(sql`UPDATE public.invitations SET accepted_at = now(), accepted_by = ${id}::uuid
          WHERE id = ${inv.invitationId}::uuid`);
        await q.execute(sql`INSERT INTO public.users
            (id, email, display_name, password_hash, system_admin, created_by_invitation)
          VALUES (${id}::uuid, ${inv.email}, 'Direct', ${"$scrypt$ln=14,r=8,p=5$" + "A".repeat(22) + "$" + "A".repeat(43)},
                  true, ${inv.invitationId}::uuid)`);
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await signIn(db, { email: person.email, password: PASSWORD, source: source() })).ok,
    ).toBe(true);
  });

  it("fires every guard trigger on the account tables in replica mode too", async () => {
    await ready();
    const rows = await db.rows<{ name: string; enabled: string }>(sql`
      SELECT c.relname || '.' || t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname IN ('users', 'invitations', 'organization_members', 'sign_in_throttles')
      ORDER BY 1`);
    expect(rows.map((r) => r.name)).toEqual([
      "invitations.invitations_check_new",
      "invitations.invitations_settle_once",
      "invitations.zzzz_invitations_keep_identity",
      "organization_members.organization_members_check_invitation",
      // 0010 (T-037): removing a membership or disabling an account ends sessions.
      // 0015 (T-039): losing the last membership revokes pending reset links.
      "organization_members.organization_members_end_resets",
      "organization_members.organization_members_end_sessions",
      "organization_members.zzzz_organization_members_keep_identity",
      "users.users_check_invitation",
      "users.users_end_sessions",
      // 0015 (T-039): the password change time only moves forward.
      "users.users_password_changed_at",
      "users.users_sessions_valid_after",
      "users.zzzz_users_keep_identity",
    ]);
    for (const r of rows) expect(r).toEqual({ name: r.name, enabled: "A" });
    const pending = await invite(await organization(), email());
    await expect(
      db.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(sql`UPDATE public.invitations SET email = 'moved@example.org'
          WHERE id = ${pending.invitationId}::uuid`);
      }),
    ).rejects.toMatchObject({ code: "23000" });
  });

  it("checks invitations for accounts and memberships in replica mode too", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const pending = await invite(org, email());
    const replica = (statement: Sql) =>
      db.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(statement);
      });
    // Foreign keys are skipped in replica mode; the triggers are not.
    await expect(
      replica(sql`INSERT INTO public.users (id, email, display_name, password_hash, created_by_invitation)
        VALUES (gen_random_uuid(), 'replica@example.org', 'Replica', ${PLACEHOLDER_HASH},
                gen_random_uuid())`),
    ).rejects.toMatchObject({ constraint: "users_invitation_accepted" });
    await expect(
      replica(sql`INSERT INTO public.users (id, email, display_name, password_hash, created_by_invitation)
        VALUES (gen_random_uuid(), ${pending.email}, 'Replica', ${PLACEHOLDER_HASH}, ${pending.invitationId}::uuid)`),
    ).rejects.toMatchObject({ constraint: "users_invitation_accepted" });
    const other = await organization();
    await expect(
      replica(sql`INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
        VALUES (${other}::uuid, ${person.userId}::uuid, gen_random_uuid())`),
    ).rejects.toMatchObject({ constraint: "organization_members_invitation_accepted" });
    await expect(
      replica(sql`INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
        VALUES (${org}::uuid, ${person.userId}::uuid, ${pending.invitationId}::uuid)`),
    ).rejects.toMatchObject({ constraint: "organization_members_invitation_accepted" });
    await expect(
      replica(sql`INSERT INTO public.invitations (organization_id, id, email, token_hash, invited_by, expires_at, accepted_at, accepted_by)
        VALUES (${org}::uuid, gen_random_uuid(), 'replica@example.org', ${new Uint8Array(32).fill(4)},
                ${admin}::uuid, now() + interval '1 day', now(), ${person.userId}::uuid)`),
    ).rejects.toMatchObject({ constraint: "invitations_new_pending" });
  });

  it("refuses a membership without an accepted invitation of that organization", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA);
    const joined = await db.rows<{ invitation_id: string }>(sql`
      SELECT invitation_id::text FROM public.organization_members WHERE user_id = ${person.userId}::uuid`);
    const used = joined[0]?.invitation_id ?? "";
    // Another organization's invitation can't be reused for orgB.
    await expect(
      db.execute(sql`INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
        VALUES (${orgB}::uuid, ${person.userId}::uuid, ${used}::uuid)`),
    ).rejects.toMatchObject({ constraint: "organization_members_invitation_accepted" });
    const pending = await invite(orgB, person.email);
    await expect(
      db.execute(sql`INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
        VALUES (${orgB}::uuid, ${person.userId}::uuid, ${pending.invitationId}::uuid)`),
    ).rejects.toMatchObject({ constraint: "organization_members_invitation_accepted" });
  });

  it("never changes a settled invitation or an invitation's identity", async () => {
    await ready();
    const org = await organization();
    const other = await organization();
    const person = await member(org);
    const rows = await db.rows<{ id: string }>(sql`
      SELECT invitation_id::text AS id FROM public.organization_members WHERE user_id = ${person.userId}::uuid`);
    const id = rows[0]?.id ?? "";
    await expect(
      db.execute(
        sql`UPDATE public.invitations SET accepted_at = NULL, accepted_by = NULL WHERE id = ${id}::uuid`,
      ),
    ).rejects.toMatchObject({ constraint: "invitations_settled" });
    const pending = await invite(org, email());
    for (const change of [
      sql`UPDATE public.invitations SET organization_id = ${other}::uuid WHERE id = ${pending.invitationId}::uuid`,
      sql`UPDATE public.invitations SET email = 'moved@example.org' WHERE id = ${pending.invitationId}::uuid`,
      sql`UPDATE public.invitations SET expires_at = expires_at + interval '1 day' WHERE id = ${pending.invitationId}::uuid`,
      sql`UPDATE public.invitations SET token_hash = ${new Uint8Array(32)} WHERE id = ${pending.invitationId}::uuid`,
    ]) {
      await expect(db.execute(change)).rejects.toMatchObject({ code: "23000" });
    }
  });
});

describe("the writer's grants (D-068)", () => {
  it("are in the writer's list, enough for every account function, and nothing beyond is allowed", async () => {
    await ready();
    const role = `oculus_test_t036_${unique().toString()}_${String(process.pid)}`;
    // Role names can't be parameters; the name is made here, then quoted by format().
    const run = async (statement: string, q: Queryable): Promise<void> => {
      const set: Sql = sql`SELECT set_config('oculus_test.role', ${role}, true),
                                  set_config('oculus_test.statement', ${statement}, true)`;
      await q.rows(set);
      await q.execute(sql`DO $$ BEGIN
        EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
      END $$`);
    };
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction((q) => run("CREATE ROLE %I LOGIN", q));
    } finally {
      await server.close();
    }
    cleanups.push(async () => {
      const s = openDatabase(testServerUrl(), { max: 1 });
      try {
        await s.transaction((q) => run("DROP ROLE IF EXISTS %I", q));
      } finally {
        await s.close();
      }
    });
    // Exactly the writer's grants (D-067), which now include D-068's.
    await db.transaction((q) => grantWriterRole(q, role));
    const url = new URL((await setup)?.testDb.url ?? "");
    url.username = role;
    const writer = openDatabase(url.toString(), { max: 3 });
    try {
      expect(await checkWriterConnection(writer)).toEqual([]);
      for (const [table, privileges] of Object.entries(ACCOUNT_TABLE_PRIVILEGES)) {
        expect(WRITER_PRIVILEGES[table]).toEqual(privileges);
      }
      // Anything beyond the list is refused.
      for (const extra of [
        "GRANT DELETE ON public.users TO %I",
        "GRANT DELETE ON public.invitations TO %I",
        "GRANT UPDATE ON public.organization_members TO %I",
        "GRANT TRUNCATE ON public.sign_in_throttles TO %I",
        "GRANT TRIGGER ON public.users TO %I",
      ]) {
        await db.transaction((q) => run(extra, q));
        try {
          expect((await checkWriterConnection(writer)).map((p) => p.code)).toEqual([
            "extra_privilege",
          ]);
        } finally {
          await db.transaction((q) =>
            run(extra.replace("GRANT", "REVOKE").replace(" TO ", " FROM "), q),
          );
        }
      }
      expect(await checkWriterConnection(writer)).toEqual([]);
      const org = await organization();
      const address = email();
      const inv = ok(
        await inviteVia(writer, { organizationId: org, email: address, invitedBy: admin }),
      );
      ok(await inviteVia(writer, { organizationId: org, email: address, invitedBy: admin }));
      const again = ok(
        await inviteVia(writer, { organizationId: org, email: address, invitedBy: admin }),
      );
      expect(inv.token).not.toBe(again.token);
      const made = ok(
        await acceptInvitation(writer, {
          token: again.token,
          organizationId: org,
          email: address,
          displayName: "Invented Person",
          password: PASSWORD,
        }),
      );
      const other = await organization();
      const second = ok(
        await inviteVia(writer, { organizationId: other, email: address, invitedBy: admin }),
      );
      ok(
        await acceptInvitationForUser(writer, {
          token: second.token,
          organizationId: other,
          userId: made.userId,
        }),
      );
      const revocable = ok(
        await inviteVia(writer, { organizationId: org, email: email(), invitedBy: admin }),
      );
      ok(
        await revokeInvitation(writer, {
          organizationId: org,
          invitationId: revocable.invitationId,
          by: admin,
        }),
      );
      expect(
        await signIn(writer, { email: address, password: "wrong guess", source: source() }),
      ).toEqual(INVALID_CREDENTIALS);
      expect(
        await signIn(writer, { email: address, password: PASSWORD, source: source() }),
      ).toMatchObject({
        ok: true,
      });
      ok(await clearSignInThrottle(writer, { email: address, by: admin }));
      await deleteExpiredSignInThrottles(writer);

      // The review's sequence: mint an account by inserting an invitation
      // already accepted, back-dated or from someone who can't invite.
      const forged = { org, address: email(), id: "6b1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c" };
      const tokenHash = new Uint8Array(32).fill(7);
      const refusedAs = async (statement: Sql, constraint: string): Promise<void> => {
        await expect(writer.execute(statement)).rejects.toMatchObject({ constraint });
      };
      await refusedAs(
        sql`INSERT INTO public.invitations (organization_id, id, email, token_hash, invited_by, expires_at, accepted_at, accepted_by)
          VALUES (${org}::uuid, gen_random_uuid(), ${forged.address}, ${tokenHash}, ${admin}::uuid,
                  now() + interval '1 day', now(), ${forged.id}::uuid)`,
        "invitations_new_pending",
      );
      await refusedAs(
        sql`INSERT INTO public.invitations (organization_id, id, email, token_hash, invited_by, created_at, expires_at)
          VALUES (${org}::uuid, gen_random_uuid(), ${forged.address}, ${tokenHash}, ${admin}::uuid,
                  now() - interval '8 days', now() - interval '1 day')`,
        "invitations_new_now",
      );
      await refusedAs(
        sql`INSERT INTO public.invitations (organization_id, id, email, token_hash, invited_by, expires_at)
          VALUES (${org}::uuid, gen_random_uuid(), ${forged.address}, ${tokenHash}, ${made.userId}::uuid,
                  now() + interval '1 day')`,
        "invitations_invited_by_admin",
      );
      const pending = ok(
        await inviteVia(writer, { organizationId: org, email: email(), invitedBy: admin }),
      );
      await refusedAs(
        sql`UPDATE public.invitations SET revoked_at = now(), revoked_by = ${made.userId}::uuid
          WHERE id = ${pending.invitationId}::uuid`,
        "invitations_revoked_by_admin",
      );
      await refusedAs(
        sql`UPDATE public.invitations SET accepted_at = now() - interval '1 hour', accepted_by = ${forged.id}::uuid
          WHERE id = ${pending.invitationId}::uuid`,
        "invitations_settled_now",
      );
      // What remains (D-068): a pending invitation forged in an active
      // admin's name, accepted by UPDATE now, then the account and its
      // membership. The writer can mint an account only like this.
      await writer.transaction(async (q) => {
        const inv = "7c1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
        await q.execute(sql`INSERT INTO public.invitations (organization_id, id, email, token_hash, invited_by, expires_at)
          VALUES (${org}::uuid, ${inv}::uuid, ${forged.address}, ${tokenHash}, ${admin}::uuid, now() + interval '1 day')`);
        await q.execute(sql`UPDATE public.invitations SET accepted_at = clock_timestamp(), accepted_by = ${forged.id}::uuid
          WHERE id = ${inv}::uuid`);
        await q.execute(sql`INSERT INTO public.users (id, email, display_name, password_hash, created_by_invitation)
          VALUES (${forged.id}::uuid, ${forged.address}, 'Forged', ${PLACEHOLDER_HASH}, ${inv}::uuid)`);
        await q.execute(sql`INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
          VALUES (${org}::uuid, ${forged.id}::uuid, ${inv}::uuid)`);
      });
      for (const statement of [
        sql`DELETE FROM public.users WHERE id = ${made.userId}::uuid`,
        sql`DELETE FROM public.invitations WHERE id = ${inv.invitationId}::uuid`,
        sql`DELETE FROM public.organization_members WHERE user_id = ${made.userId}::uuid`,
        sql`TRUNCATE public.sign_in_throttles`,
        sql`ALTER TABLE public.invitations DISABLE TRIGGER invitations_settle_once`,
      ]) {
        await expect(writer.execute(statement)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await writer.close();
      await db.transaction(async (q) => {
        await run("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I", q);
        await run("REVOKE ALL ON SCHEMA public FROM %I", q);
      });
    }
  }, 60_000);
});
