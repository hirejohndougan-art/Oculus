// Installs and rollbacks in the change log (T-060a, D-104), against a fresh
// migrated database: the table takes rows stamped now and never changes,
// deletes or empties them (by the owner or in replica mode), with every
// trigger ALWAYS; the hook writes the system manager from the admin and
// no account from the command line, and refuses an admin entry naming no
// one; the audit trail shows them to a system manager in any organization
// (named, filtered by person and dates, paged through) and to nobody else,
// and never under a record filter. Every person and version is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type UserId } from "@oculus/core";
import { WRITER_PRIVILEGES, sql } from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { serviceErrorLogger, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import { fullSession, makeObject, makeWorld, type World } from "./staff-api.fixtures.js";
import { updateChangeLog } from "./update-change-log.js";
import type { HistoryEntry } from "./update-manager.js";
import { testKeyring } from "../../db/src/second-factor.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const logged: ApiLogRecord[] = [];
const tokens: Record<string, string> = {};

const entry = (change: Partial<HistoryEntry>): HistoryEntry => ({
  kind: "install",
  version: "1.2.0",
  from: "1.1.0",
  at: new Date().toISOString(),
  by: "release-cli",
  ...change,
});

beforeAll(async () => {
  w = await makeWorld({ onError: serviceErrorLogger((r) => logged.push(r)) });
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({
      db: w.db,
      service: w.service,
      log: (r) => logged.push(r),
      people: {
        keys: testKeyring(),
        deliverInvitation: () => Promise.resolve(),
        deliverEnrolment: () => Promise.resolve(),
        deliverReset: () => Promise.resolve(),
      },
    }),
  });
  const make = async (name: string, user: UserId, org = w.a) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root);
  await make("rootInB", w.root, w.b);
  await make("manager", w.manager);
  await make("cataloger", w.cataloger);
  await make("stranger", w.stranger, w.b);
  await makeObject(w, w.a, w.a1, "An invented lamp");
  // Three changes: an install from the admin, a rollback from the admin,
  // and an install on the command line from a development build.
  await updateChangeLog(w.db, "admin")(entry({ by: w.root }));
  await updateChangeLog(
    w.db,
    "admin",
  )(entry({ kind: "rollback", version: "1.1.0", from: "1.2.0", by: w.root }));
  await updateChangeLog(w.db, "command_line")(entry({ version: "1.3.0", from: null }));
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

interface Entry {
  type: string;
  actor?: string;
  actorName?: string | null;
  kind?: string;
  version?: string;
  fromVersion?: string | null;
}

async function trail(as: string, query = "?limit=100") {
  const token = tokens[as] ?? "";
  const res = await app.inject({
    method: "GET",
    url: `/api/audit${query}`,
    headers: { origin: SAME_ORIGIN.origin, cookie: `${OCULUS_COOKIES.session}=${token}` },
  });
  const json = JSON.parse(res.body) as { entries?: Entry[]; next?: string | null };
  return { status: res.statusCode, entries: json.entries ?? [], next: json.next ?? null };
}

const system = (entries: readonly Entry[]) => entries.filter((e) => e.type === "system");

describe("system_events", () => {
  it("takes a row stamped now and refuses one dated otherwise or malformed", async () => {
    await expect(
      w.db.execute(sql`
        INSERT INTO public.system_events (id, occurred_at, kind, version)
        VALUES (gen_random_uuid(), now() - interval '1 day', 'update_installed', '1.0.0')`),
    ).rejects.toMatchObject({ constraint: "system_events_now" });
    await expect(
      w.db.execute(sql`
        INSERT INTO public.system_events (id, kind, version)
        VALUES (gen_random_uuid(), 'update_installed', '1.0')`),
    ).rejects.toMatchObject({ constraint: "system_events_version_shape" });
    await expect(
      w.db.execute(sql`
        INSERT INTO public.system_events (id, kind, version)
        VALUES (gen_random_uuid(), 'dance', '1.0.0')`),
    ).rejects.toMatchObject({ constraint: "system_events_kind_known" });
  });

  it("is never changed, deleted or emptied, by the owner or in replica mode", async () => {
    for (const statement of [
      sql`UPDATE public.system_events SET version = '9.9.9'`,
      sql`DELETE FROM public.system_events`,
      sql`TRUNCATE public.system_events`,
    ]) {
      await expect(w.db.execute(statement)).rejects.toMatchObject({
        constraint: "system_events_append_only",
      });
      await expect(
        w.db.transaction(async (q) => {
          await q.execute(sql`SET LOCAL session_replication_role = replica`);
          await q.execute(statement);
        }),
      ).rejects.toMatchObject({ constraint: "system_events_append_only" });
    }
    const [row] = await w.db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.system_events`,
    );
    expect(row?.n).toBe(3);
  });

  it("lets the app's writer only add rows", () => {
    expect(WRITER_PRIVILEGES.system_events).toEqual(["INSERT"]);
  });

  it("has every 0030 trigger enabled ALWAYS", async () => {
    const rows = await w.db.rows<{ name: string; enabled: string }>(sql`
      SELECT t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgrelid = 'public.system_events'::regclass
      ORDER BY 1`);
    expect(rows).toEqual([
      { name: "system_events_append_only", enabled: "A" },
      { name: "system_events_check_new", enabled: "A" },
      { name: "system_events_no_truncate", enabled: "A" },
    ]);
  });
});

describe("the hook", () => {
  it("refuses an entry from the admin that names no system manager", async () => {
    await expect(updateChangeLog(w.db, "admin")(entry({ by: "release-cli" }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      updateChangeLog(w.db, "admin")(entry({ by: w.root, version: "1" })),
    ).rejects.toThrow(TypeError);
  });
});

describe("installs and rollbacks in the audit trail", () => {
  it("are shown to a system manager, named, newest first", async () => {
    const r = await trail("root");
    expect(r.status).toBe(200);
    expect(system(r.entries)).toEqual([
      expect.objectContaining({
        actor: "command_line",
        actorName: null,
        kind: "update_installed",
        version: "1.3.0",
        fromVersion: null,
      }),
      expect.objectContaining({
        actor: `user:${w.root}`,
        actorName: expect.any(String) as unknown,
        kind: "update_rolled_back",
        version: "1.1.0",
        fromVersion: "1.2.0",
      }),
      expect.objectContaining({
        actor: `user:${w.root}`,
        kind: "update_installed",
        version: "1.2.0",
        fromVersion: "1.1.0",
      }),
    ]);
    // The same in another organization: they belong to none.
    expect(system((await trail("rootInB")).entries)).toHaveLength(3);
  });

  it("are shown to nobody else", async () => {
    for (const who of ["manager", "cataloger", "stranger"]) {
      const r = await trail(who);
      expect(r.status, who).toBe(200);
      // They see their own entries (B has none), never a system one.
      if (who !== "stranger") expect(r.entries.length, who).toBeGreaterThan(0);
      expect(system(r.entries), who).toEqual([]);
    }
  });

  it("are filtered by person and dates, left out of a record's history, and paged", async () => {
    expect(system((await trail("root", `?person=${w.root}&limit=100`)).entries)).toHaveLength(2);
    expect(system((await trail("root", `?person=${w.manager}&limit=100`)).entries)).toEqual([]);
    expect(system((await trail("root", "?from=2999-01-01")).entries)).toEqual([]);
    const records = await trail("root", "?limit=100");
    const recordId = (records.entries.find((e) => e.type === "record") as { recordId?: string })
      .recordId;
    expect(system((await trail("root", `?record=${String(recordId)}`)).entries)).toEqual([]);
    // One entry a page: every system entry is reached once, through its own cursors.
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const query = `?limit=1${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
      const r = await trail("root", query);
      expect(r.status).toBe(200);
      for (const e of system(r.entries)) seen.push(`${String(e.kind)} ${String(e.version)}`);
      after = r.next;
      if (after === null) break;
    }
    expect(seen).toEqual([
      "update_installed 1.3.0",
      "update_rolled_back 1.1.0",
      "update_installed 1.2.0",
    ]);
  });
});
