// A sign-in that replaces an old-settings password hash racing a password
// reset (S-056, from S-053's review). Since S-053, `signIn`'s success
// transaction touches the user row only when it replaces a hash made with
// other settings than today's (`UPDATE public.users SET password_hash ...
// WHERE password_hash = <the checked hash>`), so the reset deadlock test in
// password-resets.test.ts no longer covers user-row contention. This file
// pins the sign-in just before and just after that UPDATE, lets
// `completePasswordReset` run on another connection until it waits on a
// lock (or ends), then lets the sign-in go on: no deadlock either way, and
// the reset's password is the one kept.
//
// Today only one scrypt setting is allowed (ALLOWED_SCRYPT_SETTINGS, and the
// database's `password_hash_ok` CHECK), so no stored hash can really be an
// old-settings one. The file's `verifyPassword` is core's own, run for real,
// but it says `needsRehash` while `rehash.on` is set: exactly what an
// old-settings hash makes it say, so `signIn` takes its rehash path. Every
// person, address and password is invented (example.org is reserved for
// examples, RFC 2606; addresses are from RFC 1918's private ranges).
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  newOrganizationId,
  resetThrottleAccountKey,
  type OrganizationId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  INVALID_CREDENTIALS,
  acceptInvitation,
  createFirstSystemAdmin,
  createInvitation,
  signIn,
  type InvitationMessage,
} from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable, type Row } from "./client.js";
import { migrate } from "./migrate.js";
import { completePasswordReset, requestPasswordReset } from "./password-resets.js";
import { giveTestFactor, testKeyring } from "./second-factor.fixtures.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const rehash = vi.hoisted(() => ({ on: false }));

vi.mock("@oculus/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@oculus/core")>();
  return {
    ...core,
    verifyPassword: async (
      password: unknown,
      stored: string | undefined,
    ): ReturnType<typeof core.verifyPassword> => {
      const check = await core.verifyPassword(password, stored);
      return check.ok && rehash.on ? { ...check, needsRehash: true } : check;
    },
  };
});

const ADMIN_EMAIL = "rehash.admin@example.org";
const ADMIN_PASSWORD = "a first admin passphrase, invented";
const PASSWORD = "an invented passphrase for tests";
const NEW_PASSWORD = "a different invented passphrase";

let setup: Promise<{ testDb: TestDatabase; db: Database; admin: UserId }> | undefined;
const keys = testKeyring();
let db: Database;
let admin: UserId;
let testDb: TestDatabase;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const t = await freshDatabase();
    await migrate({ connectionString: t.url });
    const d = openDatabase(t.url, { max: 6 });
    const made = await createFirstSystemAdmin(d, {
      email: ADMIN_EMAIL,
      displayName: "Rehash Admin",
      password: ADMIN_PASSWORD,
    });
    const adminId = ok(made).userId;
    await giveTestFactor(d, keys, adminId);
    return { testDb: t, db: d, admin: adminId };
  })();
  ({ db, admin, testDb } = await setup);
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (done) {
    await done.db.close();
    await done.testDb.drop();
  }
});

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

let counter = 0;
function unique(): number {
  counter += 1;
  return counter;
}
/** A client address of its own (a private range, RFC 1918). */
function source(): string {
  const n = unique();
  return `10.56.${String(Math.floor(n / 250))}.${String(1 + (n % 250))}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function organization(): Promise<OrganizationId> {
  const id = newOrganizationId();
  ok(await insertOrganization(db, { id, name: `Invented Society ${String(unique())}` }));
  return id;
}

/** A new person in `organizationId`, with a second factor in use (T-038). */
async function member(organizationId: OrganizationId): Promise<{ email: string }> {
  const address = `rehash.person${String(unique())}@example.org`;
  const box: InvitationMessage[] = [];
  ok(
    await createInvitation(db, { organizationId, email: address, invitedBy: admin }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const userId = ok(
    await acceptInvitation(db, {
      token: box[0]?.token ?? "",
      organizationId,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    }),
  ).userId;
  await giveTestFactor(db, keys, userId);
  return { email: address };
}

/** A reset link's token for `address`, sent at once. */
async function linkFor(address: string): Promise<string> {
  await db.execute(sql`
    DELETE FROM public.sign_in_throttles WHERE key = ${resetThrottleAccountKey(address)}`);
  const tokens: string[] = [];
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const reply = await requestPasswordReset(
    db,
    { email: address, source: source() },
    (m) => {
      tokens.push(m.token);
      return Promise.resolve();
    },
    {
      backgroundDelayMs: { min: 0, max: 0 },
      onSettled: () => {
        settle();
      },
    },
  );
  if (!reply.ok) throw new Error("no reply");
  await settled;
  const token = tokens[0];
  if (token === undefined) throw new Error("no link");
  return token;
}

async function deadlocks(): Promise<number> {
  await db.rows(sql`SELECT pg_stat_clear_snapshot()`);
  const rows = await db.rows<{ n: string }>(sql`
    SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`);
  return Number(rows[0]?.n ?? "0");
}

/** The rehash's UPDATE in `signIn`'s success transaction. */
const REHASH = "UPDATE public.users SET password_hash";

describe("a sign-in's rehash racing a reset (S-056)", { timeout: 180_000 }, () => {
  it("never deadlocks, and keeps the reset's password, the reset starting just before or just after the rehash (ordered)", async () => {
    await ready();
    const a = openDatabase(testDb.url, { max: 2 });
    const b = openDatabase(testDb.url, { max: 2 });
    const start = await deadlocks();
    const waitedOn: string[] = [];
    try {
      const org = await organization();
      for (const when of ["before", "after"] as const) {
        for (let round = 0; round < 2; round++) {
          const person = await member(org);
          const token = await linkFor(person.email);
          const next = `${NEW_PASSWORD} ${when} ${String(round)}`;
          // A wrong guess, so the sign-in's success deletes a counter row
          // the reset's own clearing (after its commit) deletes too.
          expect(
            await signIn(db, {
              email: person.email,
              password: "a wrong invented guess",
              source: source(),
            }),
          ).toBe(INVALID_CREDENTIALS);

          // The reset starts on its own connection, and the sign-in goes on
          // once the reset waits on a lock (or is done).
          let fired = false;
          let use: Promise<Validated<{ readonly reset: true }>> | undefined;
          const race = async (): Promise<void> => {
            fired = true;
            use = completePasswordReset(b, { token, password: next });
            const state = { settled: false };
            void use.then(() => {
              state.settled = true;
            });
            for (let wait = 0; wait < 400 && !state.settled; wait++) {
              const waiting = await db.rows<{ query: string }>(sql`
                SELECT query FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`);
              if (waiting.length > 0) {
                waitedOn.push(
                  `${when}: ${waiting[0]?.query.trim().split(/\s+/).slice(0, 3).join(" ") ?? ""}`,
                );
                break;
              }
              await sleep(25);
            }
          };
          const isRehash = (query: Sql): boolean => !fired && query.text.includes(REHASH);
          const wrap = (q: Queryable): Queryable => ({
            rows: async <R extends Row = Row>(query: Sql): Promise<R[]> => {
              const pin = isRehash(query);
              if (pin && when === "before") await race();
              const result = await q.rows<R>(query);
              if (pin && when === "after") await race();
              return result;
            },
            execute: async (query: Sql): Promise<number> => {
              const pin = isRehash(query);
              if (pin && when === "before") await race();
              const result = await q.execute(query);
              if (pin && when === "after") await race();
              return result;
            },
          });
          const pinned: Database = {
            ...wrap(a),
            transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
              a.transaction((tx) => work(wrap(tx))),
            close: () => a.close(),
          };

          rehash.on = true;
          let signedIn: Awaited<ReturnType<typeof signIn>>;
          try {
            signedIn = await signIn(pinned, {
              email: person.email,
              password: PASSWORD,
              source: source(),
            });
          } finally {
            rehash.on = false;
          }
          expect({ when, round, fired }).toEqual({ when, round, fired: true });
          expect(signedIn.ok).toBe(true);
          expect(await use).toEqual({ ok: true, value: { reset: true } });

          // The reset's password is the one kept: the rehash never put the
          // old password back, before or after.
          expect(
            (await signIn(db, { email: person.email, password: next, source: source() })).ok,
          ).toBe(true);
          expect(
            await signIn(db, { email: person.email, password: PASSWORD, source: source() }),
          ).toBe(INVALID_CREDENTIALS);
        }
      }
    } finally {
      // Statistics are written when a connection ends.
      await a.close();
      await b.close();
    }
    // Both orders really made the reset wait on the sign-in: just before the
    // rehash on its clearing of the counter row the sign-in deleted, just
    // after it on the user row the rehash updated.
    expect(waitedOn.filter((w) => w.startsWith("before"))).toHaveLength(2);
    expect(waitedOn.filter((w) => w.startsWith("after"))).toHaveLength(2);
    await sleep(500);
    expect(await deadlocks()).toBe(start);
  });
});
