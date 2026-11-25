// S-028: the S-020 dependents check made cheap without weakening it.
// An edit or restore that changes nothing a record below it inherits by
// (`changesInheritance`) takes no below-locks and compares no published
// record below it; `hiddenAmong` reads every record's place in one query
// with the same answers as reading them one by one; the 500 cap applies
// only to edits that can change what a published record below shows; and
// the below-locks are taken only once an unlocked look says the edit is
// allowed, at the version the person saw, and changes inheritance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  permits,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  grantWriterRole,
  insertOrganization,
  insertTemplateVersion,
  loadAccess,
  migrate,
  openDatabase,
  readRecordPlace,
  sitesSharedInto,
  sql,
  unitsHolding,
  type Database,
  type Queryable,
  type Row,
  type Sql,
} from "@oculus/db";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import { RecordAccess } from "./access.js";
import { createService, type RecordService, type ServiceResult } from "./service.js";
import { actorOf, grant, makeSite, people, type People } from "./people.fixtures.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const INC = "http://rightsstatements.org/vocab/InC/1.0/";

interface Setup {
  testDb: TestDatabase;
  owner: Database;
  writer: Database;
  role: string;
  folks: People;
}

let setup: Promise<Setup> | undefined;
let s: Setup;
let service: RecordService;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const role = `oculus_s028_writer_${newRecordId().slice(0, 8)}`;
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction(async (q) => {
        await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true)`);
        await q.execute(sql`DO $$ BEGIN
          EXECUTE format('CREATE ROLE %I LOGIN', current_setting('oculus_test.role'));
        END $$`);
      });
    } finally {
      await server.close();
    }
    const owner = openDatabase(testDb.url, { max: 4 });
    await owner.transaction((q) => grantWriterRole(q, role));
    const holding = newOrganizationId();
    ok(await insertOrganization(owner, { id: holding, name: "Invented Holding Society" }));
    const folks = await people(owner, holding);
    return { testDb, owner, writer: as(testDb.url, role), role, folks };
  })();
  s = await setup;
  service = createService(s.writer, { now: () => NOW });
}

// Warm the setup before the first test, under the suite's longer hook limit
// (U-008). A failure stays in `setup`, so with no database each test still
// fails on its own when it calls ready().
beforeAll(() => ready().catch(() => undefined));

function as(url: string, role: string): Database {
  const u = new URL(url);
  u.username = role;
  return openDatabase(u.toString(), { max: 3 });
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (!done) return;
  await done.writer.close();
  await done.owner.close();
  await done.testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction(async (q) => {
      await q.rows(sql`SELECT set_config('oculus_test.role', ${done.role}, true)`);
      await q.execute(sql`DO $$ BEGIN
        EXECUTE format('DROP ROLE IF EXISTS %I', current_setting('oculus_test.role'));
      END $$`);
    });
  } finally {
    await server.close();
  }
});

function ok<T>(result: Validated<T> | ServiceResult<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: { ok: boolean; issues?: readonly Issue[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((i) => i.code);
}

function field(key: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    label: key,
    kind,
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  };
}

const UNIT_FIELDS = [field("rights", "rights"), field("provenance", "text", { inherited: true })];

/**
 * An organization with two sites: `here`, which Bob manages whole (no
 * scoped grant), and `there`, which he can't see.
 */
async function organization() {
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: "Invented Society" }));
  for (const [key, kind, fields] of [
    ["pub-unit", "archival_unit", UNIT_FIELDS],
    // provenance is in the template but not inherited: nothing comes down past it.
    ["pub-unit-stop", "archival_unit", [field("rights", "rights"), field("provenance", "text")]],
    ["pub-asset", "digital_asset", [field("rights", "rights")]],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [kind],
        fields,
      }),
    );
  }
  const here = await makeSite(service, s.folks.root, org, "Invented here site");
  const there = await makeSite(service, s.folks.root, org, "Invented there site");
  const bob = await s.folks.member(org, "Bob");
  await grant(service, s.folks.root, org, { userId: bob, role: "site_manager", siteId: here });
  return { org, here, there, bob: actorOf(bob), bobId: bob };
}

type Org = Awaited<ReturnType<typeof organization>>;

const rootCtx = (o: Org, siteId: SiteId) => ({
  organizationId: o.org,
  actor: actorOf(s.folks.root),
  siteId,
});

async function make(
  o: Org,
  siteId: SiteId,
  draft: Record<string, unknown>,
): Promise<CatalogRecord> {
  return ok(await service.createRecord(rootCtx(o, siteId), draft)).record;
}

/**
 * Fonds F on the site Bob can't see (public provenance), series S on his
 * site under it, and `n` files under S published by the system manager.
 * With `stop`, S's template keeps F's provenance from coming down; with
 * `fondsSite`, F is on that site instead.
 */
async function tree(o: Org, n: number, stop = false, fondsSite: SiteId = o.there) {
  const fonds = await make(o, fondsSite, {
    kind: "archival_unit",
    level: "fonds",
    title: "Invented Fonds",
    templateKey: "pub-unit",
    fields: { rights: { uri: INC }, provenance: "FONDS-SECRET" },
  });
  const series = await make(o, o.here, {
    kind: "archival_unit",
    level: "series",
    parentId: fonds.id,
    title: "Invented series",
    templateKey: stop ? "pub-unit-stop" : "pub-unit",
    fields: {
      rights: { uri: INC },
      ...(stop ? {} : { provenance: "Invented series provenance." }),
    },
  });
  const files: CatalogRecord[] = [];
  for (let i = 0; i < n; i++) {
    const file = await make(o, o.here, {
      kind: "archival_unit",
      level: "file",
      parentId: series.id,
      title: `Invented file ${String(i)}`,
      templateKey: "pub-unit",
      fields: { rights: { uri: INC } },
    });
    ok(await service.publish(rootCtx(o, o.here), file.id, { expectedVersion: 1 }));
    files.push(file);
  }
  return { fonds, series, files };
}

/** A service over its own pool that counts the statements its transactions send. */
function countingService(): {
  service: RecordService;
  count: () => number;
  close: () => Promise<void>;
} {
  const pool = as(s.testDb.url, s.role);
  let n = 0;
  const db: Database = {
    rows: (q) => pool.rows(q),
    execute: (q) => pool.execute(q),
    close: () => pool.close(),
    transaction: (work) =>
      pool.transaction((tx) =>
        work({
          rows: <R extends Row = Row>(q: Sql): Promise<R[]> => {
            n += 1;
            return tx.rows<R>(q);
          },
          execute: (q) => {
            n += 1;
            return tx.execute(q);
          },
        }),
      ),
  };
  return {
    service: createService(db, { now: () => NOW }),
    count: () => n,
    close: () => pool.close(),
  };
}

/** Statements one edit by `actor` sends, and its result. */
async function measure(
  o: Org,
  actor: string,
  recordId: RecordId,
  draft: Record<string, unknown>,
  expectedVersion: number,
) {
  const counting = countingService();
  try {
    const result = await counting.service.updateRecord(
      { organizationId: o.org, actor, siteId: o.here },
      recordId,
      draft,
      { expectedVersion },
    );
    return { result, statements: counting.count() };
  } finally {
    await counting.close();
  }
}

/** How many published records sit below the series in the measurement (OCULUS_S028_BELOW to change it). */
const BELOW = Number(process.env.OCULUS_S028_BELOW ?? "12");

describe("the cost of the dependents check (S-028 measurement)", () => {
  // Logs the statements (and, for information only, the milliseconds) each
  // edit takes; asserts only on statement counts. Run with
  // OCULUS_S028_BELOW=250 and --silent=false for D-076's figures.
  const rename = (r: CatalogRecord) => ({ ...r, title: `${r.title}, renamed` });
  const reword = (r: CatalogRecord) => ({
    ...r,
    fields: { ...r.fields, provenance: "A new series provenance." },
  });

  let catalogers = 0;
  async function scopedCataloger(o: Org, scope: RecordId): Promise<string> {
    catalogers += 1;
    const dave = await s.folks.member(o.org, `Dave${String(catalogers)}`);
    await grant(service, s.folks.root, o.org, {
      userId: dave,
      role: "cataloger",
      siteId: o.here,
      scope,
    });
    return actorOf(dave);
  }

  it("a title change sends a number of statements that doesn't grow with what is published below", async () => {
    await ready();
    const o = await organization();
    const lines: string[] = [];
    const run = async (
      label: string,
      n: number,
      who: "whole" | "scoped",
      change: typeof rename,
    ) => {
      const t = await tree(o, n);
      const actor = who === "whole" ? o.bob : await scopedCataloger(o, t.series.id);
      const started = performance.now();
      const m = await measure(o, actor, t.series.id, change(t.series), 1);
      const ms = performance.now() - started;
      ok(m.result);
      lines.push(
        `${label}, ${String(n)} published below: ${String(m.statements)} statements, ${ms.toFixed(0)} ms`,
      );
      return m.statements;
    };
    const wholeFew = await run("whole-site manager, title", 2, "whole", rename);
    const wholeMany = await run("whole-site manager, title", BELOW, "whole", rename);
    const wholeValue = await run("whole-site manager, provenance", BELOW, "whole", reword);
    const scopedFew = await run("scoped cataloger, title", 2, "scoped", rename);
    const scopedMany = await run("scoped cataloger, title", BELOW, "scoped", rename);
    const scopedValue = await run("scoped cataloger, provenance", BELOW, "scoped", reword);
    console.log(`S-028 measurement:\n${lines.join("\n")}`);
    expect(wholeMany).toBe(wholeFew);
    expect(scopedMany).toBe(scopedFew);
    // A change of an inherited value still compares every published record below.
    expect(wholeValue).toBeGreaterThan(wholeMany + BELOW);
    expect(scopedValue).toBeGreaterThan(scopedMany + BELOW);
  }, 600_000);
});

/** The old `hiddenAmong`: each record's place read on its own, as before S-028. */
async function hiddenOneByOne(
  tx: Queryable,
  org: OrganizationId,
  checker: RecordAccess,
  ids: readonly RecordId[],
): Promise<Set<RecordId>> {
  const hidden = new Set<RecordId>();
  if (ids.length === 0 || checker.access.systemManager) return hidden;
  for (const id of [...new Set(ids)].sort()) {
    const place = await readRecordPlace(tx, org, id);
    if (place === undefined) continue;
    const position = {
      kind: place.kind,
      id,
      parentId: place.parentId,
      represents: place.represents,
      siteId: place.siteId,
    };
    const site = place.siteId ?? null;
    const sharedInto = await sitesSharedInto(org, id);
    const target = checker.scoped
      ? { on: "units" as const, units: await unitsHolding(tx, org, position), site, sharedInto }
      : { on: "catalog" as const, site, sharedInto };
    if (!permits(checker.access, "records.view", target)) hidden.add(id);
  }
  return hidden;
}

/** Of `ids`, those another connection can't lock `FOR UPDATE NOWAIT` now. */
async function lockedNow(ids: readonly RecordId[]): Promise<RecordId[]> {
  const locked: RecordId[] = [];
  for (const id of ids) {
    try {
      await s.owner.transaction((q) =>
        q.rows(sql`SELECT id FROM public.records WHERE id = ${id}::uuid FOR UPDATE NOWAIT`),
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "55P03") throw error;
      locked.push(id);
    }
  }
  return locked.sort();
}

describe("hiddenAmong reads every place at once (S-028)", () => {
  it("gives the answers (and takes the locks) reading them one by one gave, for scoped, whole-site, every-site and system managers", async () => {
    await ready();
    const o = await organization();
    const unit = (siteId: SiteId, level: string, title: string, parentId?: RecordId) =>
      make(o, siteId, {
        kind: "archival_unit",
        level,
        ...(parentId === undefined ? {} : { parentId }),
        title,
        templateKey: "pub-unit",
        fields: { rights: { uri: INC } },
      });
    const asset = (siteId: SiteId, title: string, represents?: RecordId) =>
      make(o, siteId, {
        kind: "digital_asset",
        mediaType: "image/tiff",
        ...(represents === undefined ? {} : { represents }),
        title,
        templateKey: "pub-asset",
        fields: { rights: { uri: INC } },
      });
    // Fonds A here > series A1 here > file A1a here; series A2 there under
    // A > file A2a here; fonds B there > series B1 here.
    const a = await unit(o.here, "fonds", "Invented A");
    const a1 = await unit(o.here, "series", "Invented A1", a.id);
    const a1a = await unit(o.here, "file", "Invented A1a", a1.id);
    const a2 = await unit(o.there, "series", "Invented A2", a.id);
    const a2a = await unit(o.here, "file", "Invented A2a", a2.id);
    const b = await unit(o.there, "fonds", "Invented B");
    const b1 = await unit(o.here, "series", "Invented B1", b.id);
    // Scans: of a file, of a scan (a chain), of a series on another site,
    // of nothing; a chain of ten scans from A1 (longer than unitsHolding follows).
    const x1 = await asset(o.here, "Invented scan 1", a1a.id);
    const x2 = await asset(o.there, "Invented scan 2", x1.id);
    const x3 = await asset(o.here, "Invented scan 3", b1.id);
    const x4 = await asset(o.here, "Invented scan 4");
    const chain: CatalogRecord[] = [];
    let at: RecordId = a1.id;
    for (let i = 0; i < 10; i++) {
      const next = await asset(
        i % 2 === 0 ? o.here : o.there,
        `Invented chained scan ${String(i)}`,
        at,
      );
      chain.push(next);
      at = next.id;
    }
    const other = (siteId: SiteId | undefined, draft: Record<string, unknown>) =>
      service.createRecord(
        {
          organizationId: o.org,
          actor: actorOf(s.folks.root),
          ...(siteId === undefined ? {} : { siteId }),
        },
        { templateKey: "pub-unit", fields: {}, ...draft },
      );
    // A unit on no site (only system managers see it), filed under A.
    const loose = ok(
      await other(undefined, {
        kind: "archival_unit",
        level: "series",
        parentId: a.id,
        title: "Invented loose",
      }),
    ).record;
    const ids: RecordId[] = [a, a1, a1a, a2, a2a, b, b1, x1, x2, x3, x4, loose, ...chain].map(
      (r) => r.id,
    );
    ids.push(newRecordId(), "not-a-record-id" as RecordId, a1.id);

    // Erin: cataloger below A1 here. Fay: reviewer below A here and below B
    // there. Gus: cataloger on every site. Bob: manages here. Root: system manager.
    const erin = await s.folks.member(o.org, "Erin");
    await grant(service, s.folks.root, o.org, {
      userId: erin,
      role: "cataloger",
      siteId: o.here,
      scope: a1.id,
    });
    const fay = await s.folks.member(o.org, "Fay");
    await grant(service, s.folks.root, o.org, {
      userId: fay,
      role: "reviewer",
      siteId: o.here,
      scope: a.id,
    });
    await grant(service, s.folks.root, o.org, {
      userId: fay,
      role: "reviewer",
      siteId: o.there,
      scope: b.id,
    });
    const gus = await s.folks.member(o.org, "Gus");
    await grant(service, s.folks.root, o.org, { userId: gus, role: "cataloger", siteId: null });
    const who: [string, UserId][] = [
      ["Erin (scoped)", erin],
      ["Fay (scoped on two sites)", fay],
      ["Gus (every site)", gus],
      ["Bob (whole site)", o.bobId],
      ["root (system manager)", s.folks.root],
    ];
    const answers = new Map<string, number>();
    for (const [name, userId] of who) {
      const run = async (way: "set" | "one by one") => {
        let statements = 0;
        let locked: RecordId[] = [];
        // Rolled back: the answer and the locks held, seen from another connection.
        const hidden = await s.writer
          .transaction(async (tx) => {
            const access = await loadAccess(tx, o.org, userId);
            if (access === undefined) throw new Error("no access");
            const checker = new RecordAccess(tx, o.org, access);
            await checker.settle();
            const counted: Queryable = {
              rows: <R extends Row = Row>(q: Sql) => {
                statements += 1;
                return tx.rows<R>(q);
              },
              execute: (q) => {
                statements += 1;
                return tx.execute(q);
              },
            };
            const answer =
              way === "set"
                ? new Set(await new RecordAccess(counted, o.org, access).hiddenAmong(ids))
                : await hiddenOneByOne(counted, o.org, checker, ids);
            locked = await lockedNow(ids.filter((id) => id !== "not-a-record-id"));
            throw new Rollback([...answer].sort());
          })
          .catch((error: unknown) => {
            if (error instanceof Rollback) return error.hidden;
            throw error;
          });
        return { hidden, statements, locked };
      };
      const set = await run("set");
      const old = await run("one by one");
      expect([name, set.hidden]).toEqual([name, old.hidden]);
      expect([name, set.locked]).toEqual([name, old.locked]);
      // Scoped people's checks lock the records scans stand for, as before; nobody else's do.
      expect([name, set.locked.length > 0]).toEqual([name, name.includes("scoped")]);
      // allowsUnlocked (S-028's first look) answers as onRecord does, and locks no record.
      const looks = await s.writer
        .transaction(async (tx) => {
          const access = await loadAccess(tx, o.org, userId);
          if (access === undefined) throw new Error("no access");
          const checker = new RecordAccess(tx, o.org, access);
          const unlocked: unknown[] = [];
          for (const id of ids.filter((i) => i !== "not-a-record-id")) {
            unlocked.push([
              id,
              await checker.allowsUnlocked(
                id,
                ["records.history"],
                ["records.edit", "media.attach"],
              ),
            ]);
          }
          const lockedByLook = await lockedNow(ids.filter((id) => id !== "not-a-record-id"));
          const viaOnRecord: unknown[] = [];
          for (const id of ids.filter((i) => i !== "not-a-record-id")) {
            const place = await readRecordPlace(tx, o.org, id);
            viaOnRecord.push([
              id,
              place === undefined
                ? undefined
                : {
                    allowed:
                      (await checker.onRecord(
                        {
                          kind: place.kind,
                          id,
                          parentId: place.parentId,
                          represents: place.represents,
                          siteId: place.siteId,
                        },
                        ["records.history"],
                        ["records.edit", "media.attach"],
                      )) === undefined,
                    version: place.version,
                  },
            ]);
          }
          throw new Looks(unlocked, viaOnRecord, lockedByLook);
        })
        .catch((error: unknown) => {
          if (error instanceof Looks) return error;
          throw error;
        });
      expect([name, looks.unlocked]).toEqual([name, looks.viaOnRecord]);
      expect([name, looks.locked]).toEqual([name, []]);
      // One read (plus, with scans in a chain, one statement locking them).
      expect(set.statements).toBeLessThanOrEqual(name.startsWith("root") ? 0 : 3);
      answers.set(name, set.hidden.length);
    }
    // The tree tells them apart: each sees some and not others (root sees all).
    expect(answers.get("root (system manager)")).toBe(0);
    for (const name of ["Erin (scoped)", "Fay (scoped on two sites)", "Bob (whole site)"]) {
      expect(answers.get(name) ?? 0).toBeGreaterThan(0);
      expect(answers.get(name) ?? 0).toBeLessThan(ids.length - 2);
    }
    expect(answers.get("Gus (every site)")).toBe(1); // the unit on no site
  }, 120_000);
});

class Looks extends Error {
  constructor(
    readonly unlocked: unknown[],
    readonly viaOnRecord: unknown[],
    readonly locked: RecordId[],
  ) {
    super("rollback");
  }
}

class Rollback extends Error {
  constructor(readonly hidden: RecordId[]) {
    super("rollback");
  }
}

/**
 * A pool as the writer whose first transaction pauses after its first
 * statement whose text includes `marker` (by default the write of a record
 * version), until `resume`.
 */
function pausingWriter(marker = "INSERT INTO public.record_versions"): {
  db: Database;
  reached: Promise<void>;
  resume: () => void;
} {
  const pool = as(s.testDb.url, s.role);
  let reach: () => void = () => undefined;
  let resume: () => void = () => undefined;
  const reached = new Promise<void>((r) => {
    reach = r;
  });
  const resumed = new Promise<void>((r) => {
    resume = r;
  });
  let paused = false;
  const pauseAfter = async (text: string): Promise<void> => {
    if (paused || !text.includes(marker)) return;
    paused = true;
    reach();
    await resumed;
  };
  const db: Database = {
    rows: (q) => pool.rows(q),
    execute: (q) => pool.execute(q),
    close: () => pool.close(),
    transaction: (work) =>
      pool.transaction((tx) =>
        work({
          rows: async <R extends Row = Row>(q: Sql): Promise<R[]> => {
            const out = await tx.rows<R>(q);
            await pauseAfter(q.text);
            return out;
          },
          execute: async (q) => {
            const n = await tx.execute(q);
            await pauseAfter(q.text);
            return n;
          },
        }),
      ),
  };
  return { db, reached, resume };
}

describe("only edits that can change inheritance lock and compare what is below (S-028)", () => {
  /**
   * Runs `write` on a pausing pool and returns which of `below` it held
   * locked once its write was made, and its result.
   */
  async function lockedDuring(
    below: readonly RecordId[],
    write: (svc: RecordService) => Promise<ServiceResult<unknown>>,
    marker?: string,
  ): Promise<{ locked: RecordId[]; result: ServiceResult<unknown> }> {
    const p = pausingWriter(marker);
    try {
      const writing = write(createService(p.db, { now: () => NOW }));
      const first = await Promise.race([p.reached.then(() => undefined), writing]);
      if (first !== undefined) throw new Error(`ended before writing: ${JSON.stringify(first)}`);
      const locked = await lockedNow(below);
      p.resume();
      return { locked, result: await writing };
    } finally {
      p.resume();
      await p.db.close();
    }
  }

  it("takes no below-locks for a title change, and takes them for every change that can alter what is inherited", async () => {
    await ready();
    const o = await organization();
    const other = await make(o, o.here, {
      kind: "archival_unit",
      level: "fonds",
      title: "Invented other fonds",
      templateKey: "pub-unit",
      fields: { rights: { uri: INC } },
    });
    const cases: [string, (r: CatalogRecord) => Record<string, unknown>, boolean][] = [
      ["title", (r) => ({ ...r, title: "Invented series, renamed" }), false],
      ["a field's value", (r) => ({ ...r, fields: { ...r.fields, provenance: "Another." } }), true],
      [
        "a field removed",
        (r) => ({
          ...r,
          fields: Object.fromEntries(Object.entries(r.fields).filter(([k]) => k !== "provenance")),
        }),
        true,
      ],
      // (On a series whose template stops provenance: its own value goes no further.)
      ["a field added", (r) => ({ ...r, fields: { ...r.fields, provenance: "Its own." } }), true],
      ["the template", (r) => ({ ...r, templateKey: "pub-unit-stop" }), true],
      ["the parent", (r) => ({ ...r, parentId: other.id }), true],
    ];
    for (const [name, change, expected] of cases) {
      // (Moved from a fonds Bob can see: he may not move it out of one he can't.)
      const t = await tree(
        o,
        2,
        name === "a field added",
        name === "the parent" ? o.here : o.there,
      );
      const below = t.files.map((f) => f.id).sort();
      const { locked, result } = await lockedDuring(below, (svc) =>
        svc.updateRecord(
          { organizationId: o.org, actor: o.bob, siteId: o.here },
          t.series.id,
          change(t.series),
          { expectedVersion: 1 },
        ),
      );
      expect([name, locked]).toEqual([name, expected ? below : []]);
      // Every one is allowed here (no hidden pair is added); the template
      // change lets the fonds's value down and is refused.
      if (name === "a field removed") {
        expect([name, codes(result)]).toEqual([name, ["inherits_from_hidden"]]);
      } else {
        expect([name, codes(result)]).toEqual([name, []]);
      }
    }
  }, 120_000);

  it("a restore takes them only when the version restored differs in what is inherited", async () => {
    await ready();
    const o = await organization();
    const t = await tree(o, 2);
    const below = t.files.map((f) => f.id).sort();
    const where = { organizationId: o.org, actor: o.bob, siteId: o.here };
    // Version 2: renamed. Version 3: a new provenance.
    const v2 = ok(
      await service.updateRecord(
        where,
        t.series.id,
        { ...t.series, title: "Renamed" },
        { expectedVersion: 1 },
      ),
    );
    ok(
      await service.updateRecord(
        where,
        t.series.id,
        { ...v2.record, fields: { ...v2.record.fields, provenance: "Another." } },
        { expectedVersion: 2 },
      ),
    );
    // Back to version 2: the provenance changes back, so the locks are taken.
    const back = await lockedDuring(below, (svc) =>
      svc.restoreVersion(where, t.series.id, 2, {
        expectedVersion: 3,
        confirmMadePublic: ["provenance"],
      }),
    );
    expect(back.locked).toEqual(below);
    ok(back.result);
    // Then version 1 (only the title differs from version 4): none.
    const title = await lockedDuring(below, (svc) =>
      svc.restoreVersion(where, t.series.id, 1, { expectedVersion: 4 }),
    );
    expect(title.locked).toEqual([]);
    ok(title.result);
  }, 120_000);

  it("never locks below for an edit the unlocked look already sees refused (its version, or not permitted)", async () => {
    await ready();
    const o = await organization();
    const t = await tree(o, 2, false, o.here);
    const below = t.files.map((f) => f.id).sort();
    const reword = { ...t.series, fields: { ...t.series.fields, provenance: "Another." } };
    // Paused once the record's own row is locked: the below-locks would be taken by then.
    const ROW_LOCK = "FOR NO KEY UPDATE";
    const stale = await lockedDuring(
      below,
      (svc) =>
        svc.updateRecord(
          { organizationId: o.org, actor: o.bob, siteId: o.here },
          t.series.id,
          reword,
          {
            expectedVersion: 7,
          },
        ),
      ROW_LOCK,
    );
    expect(stale.locked).toEqual([]);
    expect(codes(stale.result)).toEqual(["version_conflict"]);
    // A viewer may see the series but not edit it: refused, nothing below locked.
    const vic = await s.folks.member(o.org, "Vic");
    await grant(service, s.folks.root, o.org, { userId: vic, role: "read_only", siteId: o.here });
    const viewer = await lockedDuring(
      below,
      (svc) =>
        svc.updateRecord(
          { organizationId: o.org, actor: actorOf(vic), siteId: o.here },
          t.series.id,
          reword,
          {
            expectedVersion: 1,
          },
        ),
      ROW_LOCK,
    );
    expect(viewer.locked).toEqual([]);
    expect(codes(viewer.result)).toEqual(["not_permitted"]);
    // Bob, at the right version: locked as before, and saved.
    const allowed = await lockedDuring(
      below,
      (svc) =>
        svc.updateRecord(
          { organizationId: o.org, actor: o.bob, siteId: o.here },
          t.series.id,
          reword,
          {
            expectedVersion: 1,
          },
        ),
      ROW_LOCK,
    );
    expect(allowed.locked).toEqual(below);
    ok(allowed.result);
  });

  it("applies the 500 cap only to edits that can change what is inherited", async () => {
    await ready();
    const o = await organization();
    const t = await tree(o, 501);
    const where = { organizationId: o.org, actor: o.bob, siteId: o.here };
    // Bob can't see the fonds: a title change is fine, however many are published below.
    const renamed = ok(
      await service.updateRecord(
        where,
        t.series.id,
        { ...t.series, title: "Renamed" },
        { expectedVersion: 1 },
      ),
    );
    // A change of an inherited value is refused, naming nothing, as before.
    const reword = {
      ...renamed.record,
      fields: { ...renamed.record.fields, provenance: "Another." },
    };
    const capped = await service.updateRecord(where, t.series.id, reword, { expectedVersion: 2 });
    expect(codes(capped)).toEqual(["too_many_published_below"]);
    expect(JSON.stringify(capped)).not.toContain(t.fonds.id);
    // A system manager makes it.
    ok(await service.updateRecord(rootCtx(o, o.here), t.series.id, reword, { expectedVersion: 2 }));
  }, 300_000);
});
