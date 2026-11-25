// Loans and condition checks through the service (T-018b with T-018a and
// S-013, D-118), over a fresh database as the writer role: a loan and its
// moves saved together, the overdue list worked out from what is stored
// (never from anything the caller sends), a borrowed record found here
// unlinked making its loan unknown, accessions read by the service for
// "kept", who may see and change loans, condition checks against the
// stored loans, and nothing readable by the public reader. Every person,
// place and record here is invented.
import { afterAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  grantPublicReaderRole,
  grantWriterRole,
  insertOrganization,
  insertTemplateVersion,
  migrate,
  openDatabase,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import { createService, type RecordService, type ServiceResult } from "./service.js";
import { actorOf, grant, makeSite, people, type People } from "./people.fixtures.js";

interface Setup {
  testDb: TestDatabase;
  owner: Database;
  writer: Database;
  reader: Database;
  roles: string[];
}

let setup: Promise<Setup> | undefined;
let s: Setup;
let service: RecordService;
let folks: People;
let peopleReady: Promise<People> | undefined;

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

function as(url: string, role: string): Database {
  const u = new URL(url);
  u.username = role;
  return openDatabase(u.toString(), { max: 4 });
}

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const suffix = newRecordId().slice(0, 8);
    const roles = [`oculus_t018b_writer_${suffix}`, `oculus_t018b_reader_${suffix}`];
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      for (const role of roles) {
        await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", role));
      }
    } finally {
      await server.close();
    }
    const owner = openDatabase(testDb.url, { max: 4 });
    await owner.transaction(async (q) => {
      await grantWriterRole(q, roles[0] ?? "");
      await grantPublicReaderRole(q, roles[1] ?? "");
    });
    return {
      testDb,
      owner,
      writer: as(testDb.url, roles[0] ?? ""),
      reader: as(testDb.url, roles[1] ?? ""),
      roles,
    };
  })();
  s = await setup;
  service = createService(s.writer);
  peopleReady ??= (async () => {
    const holding = newOrganizationId();
    ok(await insertOrganization(s.owner, { id: holding, name: "Invented Holding Society" }));
    return people(s.owner, holding);
  })();
  folks = await peopleReady;
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (!done) return;
  for (const pool of [done.writer, done.reader, done.owner]) await pool.close();
  await done.testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    for (const role of done.roles) {
      await server.transaction((q) => withRole(q, "DROP ROLE IF EXISTS %I", role));
    }
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

interface World {
  org: OrganizationId;
  site: SiteId;
  lantern: CatalogRecord;
  print: CatalogRecord;
  lender: CatalogRecord;
  borrower: CatalogRecord;
  cataloger: UserId;
  reader: UserId;
  root: UserId;
}

let count = 0;
async function world(): Promise<World> {
  count += 1;
  const tag = String(count);
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: `Invented Museum ${tag}` }));
  for (const [key, appliesTo] of [
    ["t-object", ["object"]],
    ["t-agent", ["agent"]],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [...appliesTo],
        fields: [
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
        ],
      }),
    );
  }
  const root = folks.root;
  const site = await makeSite(service, root, org, `Invented site ${tag}`);
  const person = async (name: string, role: string) => {
    const userId = await folks.member(org, `${name}-${tag}`);
    await grant(service, root, org, { userId, role, siteId: site });
    return userId;
  };
  const cataloger = await person("cataloger", "cataloger");
  const reader = await person("reader", "read_only");
  const at = { organizationId: org, actor: actorOf(root), siteId: site };
  const object = async (title: string) =>
    ok(
      await service.createRecord(at, {
        kind: "object",
        title,
        templateKey: "t-object",
        fields: {},
      }),
    ).record;
  const agent = async (title: string) =>
    ok(
      await service.createRecord(at, {
        kind: "agent",
        agentType: "organization",
        title,
        templateKey: "t-agent",
        fields: {},
      }),
    ).record;
  return {
    org,
    site,
    lantern: await object("Invented brass lantern"),
    print: await object("Invented depot print"),
    lender: await agent("Invented Railroad Club"),
    borrower: await agent("Invented Coastal Museum"),
    cataloger,
    reader,
    root,
  };
}

const ctx = (w: World, who: UserId) => ({ organizationId: w.org, actor: actorOf(who) });

interface Places {
  shelf: string;
  lenderPlace: string;
  borrowerPlace: string;
}

async function places(w: World): Promise<Places> {
  const save = async (location: Record<string, unknown>) =>
    ok(
      await service.saveStorageLocation(ctx(w, w.cataloger), null, location, {
        expectedVersion: 0,
      }),
    ).location.id;
  return {
    shelf: await save({ kind: "storage", name: "Invented Room", level: 0 }),
    lenderPlace: await save({ kind: "external", name: "Invented club hall", agentId: w.lender.id }),
    borrowerPlace: await save({
      kind: "external",
      name: "Invented museum hall",
      agentId: w.borrower.id,
    }),
  };
}

function loanIn(w: World, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: "in",
    number: "LI-2026-001",
    agentId: w.lender.id,
    beginOn: "2026-06-01",
    endOn: "2026-10-31",
    status: "agreed",
    statusOn: "2026-05-20",
    items: [{ recordId: w.lantern.id }],
    ...extra,
  };
}

function loanOut(w: World, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: "out",
    number: "LO-2026-001",
    agentId: w.borrower.id,
    beginOn: "2026-06-01",
    endOn: "2026-10-31",
    status: "agreed",
    statusOn: "2026-05-20",
    items: [{ recordId: w.print.id }],
    ...extra,
  };
}

describe("loans through the service (T-018b, D-118)", () => {
  it("a loan in and its moves are saved together, and it is overdue until it departs", async () => {
    await ready();
    const w = await world();
    const p = await places(w);
    const saved = ok(
      await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w), { expectedVersion: 0 }),
    );
    expect(saved.version).toBe(1);
    expect(saved.state.phase).toBe("agreed");
    const arrived = ok(
      await service.recordLoanMove(
        ctx(w, w.cataloger),
        saved.loan.id,
        { recordId: w.lantern.id, locationId: p.shelf, movedOn: "2026-06-03" },
        { expectedVersion: 1 },
      ),
    );
    expect(arrived.move.reason).toBe("placement");
    expect(arrived.loan.version).toBe(2);
    expect(arrived.loan.state.phase).toBe("on_loan");
    // Past its end (2026-10-31) and not gone back: overdue, for a reader too.
    const late = ok(await service.overdueLoans(ctx(w, w.reader)));
    expect(late.map((x) => x.loan.id)).toEqual([saved.loan.id]);
    // A departure to the wrong place: neither the move nor the link is saved.
    const wrong = await service.recordLoanMove(
      ctx(w, w.cataloger),
      saved.loan.id,
      { recordId: w.lantern.id, locationId: p.borrowerPlace, movedOn: "2026-11-02" },
      { expectedVersion: 2 },
    );
    expect(codes(wrong)).toEqual(["not_agent_location"]);
    const history = ok(await service.recordStorage(ctx(w, w.reader), w.lantern.id)).history;
    expect(history).toHaveLength(1);
    const gone = ok(
      await service.recordLoanMove(
        ctx(w, w.cataloger),
        saved.loan.id,
        { recordId: w.lantern.id, locationId: p.lenderPlace, movedOn: "2026-11-02" },
        { expectedVersion: 2 },
      ),
    );
    expect(gone.move.reason).toBe("departure");
    expect(gone.loan.state.items[0]?.settledBy).toBe("departed");
    expect(ok(await service.overdueLoans(ctx(w, w.reader)))).toEqual([]);
    const closed = ok(
      await service.saveLoan(
        ctx(w, w.cataloger),
        saved.loan.id,
        loanIn(w, { items: gone.loan.loan.items, status: "closed", statusOn: "2026-11-03" }),
        { expectedVersion: 3 },
      ),
    );
    expect(closed.state.phase).toBe("closed");
    const versions = ok(await service.loanHistory(ctx(w, w.reader), saved.loan.id));
    expect(versions.map((v) => [v.version, v.loan.status])).toEqual([
      [1, "agreed"],
      [2, "agreed"],
      [3, "agreed"],
      [4, "closed"],
    ]);
  });

  it("S-013: a borrowed record placed here unlinked makes its loan unknown, and edits must link it", async () => {
    await ready();
    const w = await world();
    const p = await places(w);
    const saved = ok(
      await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w), { expectedVersion: 0 }),
    );
    // Placed through storage, not through the loan.
    const placed = ok(
      await service.recordMove(ctx(w, w.cataloger), {
        recordId: w.lantern.id,
        locationId: p.shelf,
        movedOn: "2026-06-03",
        reason: "placement",
      }),
    );
    const read = ok(await service.readLoan(ctx(w, w.reader), saved.loan.id));
    expect(read.state.phase).toBe("unknown");
    expect(read.state.problems.map((x) => x.code)).toEqual(["unlinked_arrival"]);
    expect(ok(await service.overdueLoans(ctx(w, w.reader))).map((x) => x.loan.id)).toEqual([
      saved.loan.id,
    ]);
    // Moving the dates doesn't help; marking it never received doesn't either.
    for (const edit of [
      { beginOn: "2026-10-01", endOn: "2027-12-31" },
      { items: [{ recordId: w.lantern.id, notReceived: true }] },
    ]) {
      const tried = await service.saveLoan(ctx(w, w.cataloger), saved.loan.id, loanIn(w, edit), {
        expectedVersion: 1,
      });
      expect(codes(tried)[0]).toMatch(/unlinked_arrival|received_after_all/);
    }
    // Linking the arrival puts it right.
    const linked = ok(
      await service.saveLoan(
        ctx(w, w.cataloger),
        saved.loan.id,
        loanIn(w, { items: [{ recordId: w.lantern.id, arrivalMoveId: placed.id }] }),
        { expectedVersion: 1 },
      ),
    );
    expect(linked.state.phase).toBe("on_loan");
  });

  it("takes nothing but the loan from the caller: no register, no book, no extra keys", async () => {
    await ready();
    const w = await world();
    for (const extra of [
      { accessions: {} },
      { register: [] },
      { id: newRecordId() },
      { organizationId: w.org },
    ]) {
      expect(
        codes(
          await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w, extra), {
            expectedVersion: 0,
          }),
        ),
      ).toEqual(["invalid_request"]);
    }
    expect(
      codes(
        await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w), {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["invalid_version"]);
  });

  it("kept for good: the service reads the accessions itself, and an accession edit reopens the loan", async () => {
    await ready();
    const w = await world();
    const p = await places(w);
    const saved = ok(
      await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w), { expectedVersion: 0 }),
    );
    const arrived = ok(
      await service.recordLoanMove(
        ctx(w, w.cataloger),
        saved.loan.id,
        { recordId: w.lantern.id, locationId: p.shelf, movedOn: "2026-06-03" },
        { expectedVersion: 1 },
      ),
    );
    const arrivalMoveId = arrived.move.id;
    const accessionId = "6b8f0f7e-2b1c-4c3d-9e8f-1a2b3c4d5e6f";
    const kept = loanIn(w, {
      items: [{ recordId: w.lantern.id, arrivalMoveId, keptByAccessionId: accessionId }],
    });
    // No such accession yet.
    expect(
      codes(
        await service.saveLoan(ctx(w, w.cataloger), saved.loan.id, kept, { expectedVersion: 2 }),
      ),
    ).toEqual(["not_kept"]);
    const definition = (records: string[]) => ({
      id: accessionId,
      organizationId: w.org,
      number: "2026.001",
      sourceAgent: { recordId: w.lender.id },
      deedStatus: "signed",
      records: records.map((recordId) => ({ recordId })),
    });
    await s.owner.execute(sql`INSERT INTO public.accessions
      (organization_id, id, definition, number_key, created_by, updated_by)
      VALUES (${w.org}::uuid, ${accessionId}::uuid,
              ${JSON.stringify(definition([w.lantern.id]))}::jsonb, '2026.001',
              ${w.root}::uuid, ${w.root}::uuid)`);
    const settled = ok(
      await service.saveLoan(ctx(w, w.cataloger), saved.loan.id, kept, { expectedVersion: 2 }),
    );
    expect(settled.state.items[0]?.settledBy).toBe("kept");
    expect(ok(await service.overdueLoans(ctx(w, w.reader)))).toEqual([]);
    // The accession no longer names it: the loan is unknown and overdue again.
    await s.owner.execute(sql`UPDATE public.accessions
      SET definition = ${JSON.stringify(definition([w.print.id]))}::jsonb, version = version + 1,
          updated_by = ${w.root}::uuid
      WHERE organization_id = ${w.org}::uuid AND id = ${accessionId}::uuid`);
    const late = ok(await service.overdueLoans(ctx(w, w.reader)));
    expect(late.map((x) => [x.loan.id, x.problems.map((i) => i.code)])).toEqual([
      [saved.loan.id, ["not_kept"]],
    ]);
  });

  it("who may see and change loans; another organization's loan answers like a missing one", async () => {
    await ready();
    const a = await world();
    const b = await world();
    const saved = ok(
      await service.saveLoan(ctx(a, a.cataloger), null, loanIn(a), { expectedVersion: 0 }),
    );
    expect(
      codes(
        await service.saveLoan(ctx(a, a.reader), null, loanIn(a, { number: "LI-2" }), {
          expectedVersion: 0,
        }),
      ),
    ).toEqual(["not_permitted"]);
    expect(ok(await service.listLoans(ctx(a, a.reader))).map((v) => v.loan.id)).toEqual([
      saved.loan.id,
    ]);
    const theirs = await service.readLoan(ctx(b, b.cataloger), saved.loan.id);
    const missing = await service.readLoan(ctx(b, b.cataloger), newRecordId());
    expect(codes(theirs)).toEqual(["unknown_loan"]);
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(missing));
    expect(ok(await service.listLoans(ctx(b, b.cataloger)))).toEqual([]);
    // Another organization's records can't go on a loan.
    expect(
      codes(
        await service.saveLoan(
          ctx(b, b.cataloger),
          null,
          loanIn(b, { items: [{ recordId: a.lantern.id }] }),
          {
            expectedVersion: 0,
          },
        ),
      ),
    ).toEqual(["unknown_record"]);
    expect(
      codes(
        await service.saveLoan(ctx(b, b.cataloger), null, loanIn(b, { agentId: b.lantern.id }), {
          expectedVersion: 0,
        }),
      ),
    ).toEqual(["unknown_agent"]);
    // Numbers are unique per direction; in and out are kept apart.
    expect(
      codes(
        await service.saveLoan(ctx(a, a.cataloger), null, loanIn(a, { number: "li-2026-001" }), {
          expectedVersion: 0,
        }),
      ),
    ).toEqual(["duplicate_number"]);
    ok(
      await service.saveLoan(
        ctx(a, a.cataloger),
        null,
        loanOut(a, { number: "LI-2026-001", items: [{ recordId: a.print.id, notSent: true }] }),
        {
          expectedVersion: 0,
        },
      ),
    );
  });

  it("an agreed loan keeps its records, and a record on a loan is kept", async () => {
    await ready();
    const w = await world();
    const saved = ok(
      await service.saveLoan(
        ctx(w, w.cataloger),
        null,
        loanIn(w, { items: [{ recordId: w.lantern.id }, { recordId: w.print.id }] }),
        { expectedVersion: 0 },
      ),
    );
    expect(
      codes(
        await service.saveLoan(ctx(w, w.cataloger), saved.loan.id, loanIn(w), {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["item_removed"]);
    expect(
      codes(
        await service.saveLoan(
          ctx(w, w.cataloger),
          saved.loan.id,
          loanIn(w, {
            status: "declined",
            items: [{ recordId: w.lantern.id }, { recordId: w.print.id }],
          }),
          {
            expectedVersion: 1,
          },
        ),
      ),
    ).toEqual(["status_change_refused"]);
    const at = { organizationId: w.org, actor: actorOf(w.root), siteId: w.site };
    expect(codes(await service.deleteRecord(at, w.print.id, { expectedVersion: 1 }))).toContain(
      "on_loan",
    );
    expect(codes(await service.deleteRecord(at, w.lender.id, { expectedVersion: 1 }))).toContain(
      "loan_agent",
    );
  });

  it("two saves racing on one loan: one wins, the other is a conflict", async () => {
    await ready();
    const w = await world();
    const p = await places(w);
    const saved = ok(
      await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w), { expectedVersion: 0 }),
    );
    const results = await Promise.all(
      ["2026-06-03", "2026-06-04"].map((movedOn) =>
        service.recordLoanMove(
          ctx(w, w.cataloger),
          saved.loan.id,
          { recordId: w.lantern.id, locationId: p.shelf, movedOn },
          { expectedVersion: 1 },
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => codes(r))).toEqual(["version_conflict"]);
    // Only the winner's move was written.
    expect(ok(await service.recordStorage(ctx(w, w.reader), w.lantern.id)).history).toHaveLength(1);
  });
});

describe("condition checks (T-018a: checks against the stored loans, fit-to-move warnings)", () => {
  it("records checks, ties them only to a loan listing the record, and warns before a loan out", async () => {
    await ready();
    const w = await world();
    const p = await places(w);
    const out = ok(
      await service.saveLoan(ctx(w, w.cataloger), null, loanOut(w), { expectedVersion: 0 }),
    );
    // Never checked: a warning, not a refusal.
    const read = ok(await service.readLoan(ctx(w, w.reader), out.loan.id));
    expect(read.fitWarnings.map((f) => [f.recordId, f.because])).toEqual([
      [w.print.id, "unchecked"],
    ]);
    const check = {
      recordId: w.print.id,
      checkedOn: "2026-05-30",
      checkedBy: "Invented Conservator",
      condition: "good",
      reason: "loan_out",
      loanId: out.loan.id,
    };
    // A loan that doesn't list the record, or another organization's: refused.
    expect(
      codes(
        await service.recordConditionCheck(ctx(w, w.cataloger), {
          ...check,
          recordId: w.lantern.id,
        }),
      ),
    ).toEqual(["unknown_loan"]);
    expect(codes(await service.recordConditionCheck(ctx(w, w.reader), check))).toEqual([
      "not_permitted",
    ]);
    const made = ok(await service.recordConditionCheck(ctx(w, w.cataloger), check));
    expect(made.recordedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    ok(
      await service.recordMove(ctx(w, w.cataloger), {
        recordId: w.print.id,
        locationId: p.shelf,
        movedOn: "2026-01-02",
        reason: "placement",
      }),
    );
    const sent = ok(
      await service.recordLoanMove(
        ctx(w, w.cataloger),
        out.loan.id,
        { recordId: w.print.id, locationId: p.borrowerPlace, movedOn: "2026-06-05" },
        { expectedVersion: 1 },
      ),
    );
    expect(sent.fitWarning).toBeNull();
    const after = ok(await service.readLoan(ctx(w, w.reader), out.loan.id));
    expect(after.fitWarnings).toEqual([]);
    expect(after.state.items[0]?.dueBack).toBe("2026-10-31");
    const history = ok(await service.conditionHistory(ctx(w, w.reader), w.print.id));
    expect(history.checks.map((c) => c.id)).toEqual([made.id]);
  });

  it("keeps loans and checks as written, and the public reader reads none of it", async () => {
    await ready();
    const w = await world();
    const saved = ok(
      await service.saveLoan(ctx(w, w.cataloger), null, loanIn(w), { expectedVersion: 0 }),
    );
    for (const statement of [
      sql`DELETE FROM public.loans WHERE organization_id = ${w.org}::uuid`,
      sql`DELETE FROM public.loan_versions WHERE organization_id = ${w.org}::uuid`,
      sql`INSERT INTO public.loan_records (organization_id, loan_id, record_id)
          VALUES (${w.org}::uuid, ${saved.loan.id}::uuid, ${w.print.id}::uuid)`,
      sql`UPDATE public.condition_checks SET definition = definition`,
      sql`DELETE FROM public.condition_checks`,
    ]) {
      await expect(s.writer.execute(statement)).rejects.toThrow(/permission denied/);
    }
    // The direction never changes, even by hand.
    await expect(
      s.owner.execute(sql`UPDATE public.loans
        SET definition = jsonb_set(definition, '{direction}', '"out"'), version = version + 1
        WHERE organization_id = ${w.org}::uuid`),
    ).rejects.toMatchObject({ code: "OC082" });
    // A check's time is the database's.
    const id = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";
    const check = {
      id,
      organizationId: w.org,
      recordId: w.print.id,
      checkedOn: "2020-01-01",
      checkedBy: "Invented",
      condition: "good",
      reason: "audit",
      recordedAt: "2020-01-01T00:00:00.000Z",
    };
    await expect(
      s.writer.execute(sql`INSERT INTO public.condition_checks
        (organization_id, id, definition, recorded_by, recorded_at)
        VALUES (${w.org}::uuid, ${id}::uuid, ${JSON.stringify(check)}::jsonb,
                ${w.cataloger}::uuid, '2020-01-01T00:00:00.000Z'::timestamptz)`),
    ).rejects.toMatchObject({ code: "OC085" });
    for (const table of [
      sql`SELECT 1 FROM public.loans`,
      sql`SELECT 1 FROM public.loan_records`,
      sql`SELECT 1 FROM public.loan_versions`,
      sql`SELECT 1 FROM public.condition_checks`,
    ]) {
      await expect(s.reader.rows(table)).rejects.toThrow(/permission denied/);
    }
  });
});
