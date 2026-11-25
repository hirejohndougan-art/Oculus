// Sharing items between sites (T-041b, D-074, D-094) through the service,
// over a fresh database as the writer role: offering (only who may edit
// the record, never to its home site, one live offer per site), deciding
// and removing (only the second site's manager), withdrawing (the home
// side), what the second site sees (public fields and names only: never a
// staff-only field, ID number or history), and above all that nothing
// crosses organizations otherwise: another organization's shares, records
// and sites answer exactly like missing ones, and a share never lets the
// second site read or change the record through the ordinary operations.
// Every person, site and record here is invented.
import { afterAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  newSiteId,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
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

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const role = `oculus_t041b_writer_${newRecordId().slice(0, 8)}`;
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", role));
    } finally {
      await server.close();
    }
    const owner = openDatabase(testDb.url, { max: 4 });
    await owner.transaction((q) => grantWriterRole(q, role));
    const u = new URL(testDb.url);
    u.username = role;
    return { testDb, owner, writer: openDatabase(u.toString(), { max: 6 }), roles: [role] };
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
  for (const pool of [done.writer, done.owner]) await pool.close();
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

/** The refusal as it would go out, for comparing two byte for byte. */
const shape = (result: { ok: boolean; issues?: readonly Issue[] }) => JSON.stringify(result);

const STAFF_NOTE = "Invented shelf 4, box 2: staff only";

async function catalogOrganization(name: string): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name }));
  const field = (key: string, visibility: "public" | "staff") => ({
    key,
    label: key,
    kind: "text",
    required: false,
    repeatable: false,
    visibility,
    inherited: false,
  });
  ok(
    await insertTemplateVersion(s.owner, {
      key: "t-object",
      organizationId: org,
      label: "Objects",
      appliesTo: ["object"],
      fields: [field("description", "public"), field("shelf", "staff")],
    }),
  );
  return org;
}

interface World {
  /** The Library (home of the item) with sites L1 and L2; the Society with site D1. */
  lib: OrganizationId;
  dhs: OrganizationId;
  l1: SiteId;
  l2: SiteId;
  d1: SiteId;
  item: CatalogRecord;
  /** On L1: a cataloger (may edit) and a read-only person (may not). */
  libCataloger: UserId;
  libReader: UserId;
  /** Site managers of L2 and D1, a cataloger and a read-only person of D1. */
  l2Manager: UserId;
  dhsManager: UserId;
  dhsCataloger: UserId;
  dhsReader: UserId;
}

let count = 0;
async function world(): Promise<World> {
  count += 1;
  const tag = String(count);
  const lib = await catalogOrganization(`Invented Library ${tag}`);
  const dhs = await catalogOrganization(`Invented Historical Society ${tag}`);
  const root = folks.root;
  const l1 = await makeSite(service, root, lib, `Invented library site ${tag}`);
  const l2 = await makeSite(service, root, lib, `Invented branch site ${tag}`);
  const d1 = await makeSite(service, root, dhs, `Invented society site ${tag}`);
  const person = async (org: OrganizationId, name: string, role: string, siteId: SiteId) => {
    const userId = await folks.member(org, `${name}-${tag}`);
    await grant(service, root, org, { userId, role, siteId });
    return userId;
  };
  const libCataloger = await person(lib, "lib-cataloger", "cataloger", l1);
  const libReader = await person(lib, "lib-reader", "read_only", l1);
  const l2Manager = await person(lib, "l2-manager", "site_manager", l2);
  const dhsManager = await person(dhs, "dhs-manager", "site_manager", d1);
  const dhsCataloger = await person(dhs, "dhs-cataloger", "cataloger", d1);
  const dhsReader = await person(dhs, "dhs-reader", "read_only", d1);
  const item = ok(
    await service.createRecord(
      { organizationId: lib, actor: actorOf(libCataloger), siteId: l1 },
      {
        kind: "object",
        title: "Invented depot lantern",
        templateKey: "t-object",
        fields: { description: "A tin lantern.", shelf: STAFF_NOTE },
      },
    ),
  ).record;
  return {
    lib,
    dhs,
    l1,
    l2,
    d1,
    item,
    libCataloger,
    libReader,
    l2Manager,
    dhsManager,
    dhsCataloger,
    dhsReader,
  };
}

const at = (organizationId: OrganizationId, userId: UserId, siteId?: SiteId) => ({
  organizationId,
  actor: actorOf(userId),
  ...(siteId === undefined ? {} : { siteId }),
});

async function offer(w: World, to: { org: OrganizationId; site: SiteId }) {
  return ok(
    await service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
      recordId: w.item.id,
      targetOrganizationId: to.org,
      targetSiteId: to.site,
    }),
  );
}

describe("offering an item", () => {
  it("lets someone who may edit it offer it to a site of another organization", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    expect(share).toMatchObject({
      state: "offered",
      recordId: w.item.id,
      targetOrganizationId: w.dhs,
      targetSiteId: w.d1,
    });
    const listed = ok(await service.sharesOfRecord(at(w.lib, w.libCataloger), w.item.id));
    expect(listed.map((x) => x.id)).toEqual([share.id]);
  });

  it("refuses someone who can only read it, and answers a hidden record as missing", async () => {
    await ready();
    const w = await world();
    const request = { recordId: w.item.id, targetOrganizationId: w.dhs, targetSiteId: w.d1 };
    expect(codes(await service.offerRecord(at(w.lib, w.libReader), request))).toEqual([
      "not_permitted",
    ]);
    // The L2 manager can't see L1's items: the same reply as a missing record.
    const hidden = await service.offerRecord(at(w.lib, w.l2Manager), request);
    const missing = await service.offerRecord(at(w.lib, w.l2Manager), {
      ...request,
      recordId: newRecordId(),
    });
    expect(codes(hidden)).toEqual(["unknown_record"]);
    expect(shape(hidden)).toBe(shape(missing));
    // Another organization's people can't offer it at all: as missing.
    const stranger = await service.offerRecord(at(w.dhs, w.dhsManager), request);
    expect(shape(stranger)).toBe(
      shape(
        await service.offerRecord(at(w.dhs, w.dhsManager), { ...request, recordId: newRecordId() }),
      ),
    );
  });

  it("never offers to its own home site, an unknown site, or twice to one site", async () => {
    await ready();
    const w = await world();
    const ctx = at(w.lib, w.libCataloger);
    const home = await service.offerRecord(ctx, {
      recordId: w.item.id,
      targetOrganizationId: w.lib,
      targetSiteId: w.l1,
    });
    const unknown = await service.offerRecord(ctx, {
      recordId: w.item.id,
      targetOrganizationId: w.dhs,
      targetSiteId: newSiteId(),
    });
    // A real site under the wrong organization is unknown too.
    const crossed = await service.offerRecord(ctx, {
      recordId: w.item.id,
      targetOrganizationId: w.lib,
      targetSiteId: w.d1,
    });
    expect(codes(home)).toEqual(["unknown_site"]);
    expect(shape(unknown)).toBe(shape(home));
    expect(shape(crossed)).toBe(shape(home));
    await offer(w, { org: w.lib, site: w.l2 });
    const again = await service.offerRecord(ctx, {
      recordId: w.item.id,
      targetOrganizationId: w.lib,
      targetSiteId: w.l2,
    });
    expect(codes(again)).toEqual(["already_shared"]);
    for (const bad of [
      null,
      { recordId: w.item.id },
      { recordId: "x", targetOrganizationId: w.dhs, targetSiteId: w.d1 },
      { recordId: w.item.id, targetOrganizationId: w.dhs, targetSiteId: w.d1, state: "accepted" },
    ]) {
      expect(codes(await service.offerRecord(ctx, bad)).length).toBe(1);
    }
  });
});

describe("deciding and ending", () => {
  it("lets only the second site's manager accept, decline or remove", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    // Not the second site's cataloger, nor anyone at home, nor the L2 manager.
    for (const ctx of [
      at(w.dhs, w.dhsCataloger),
      at(w.dhs, w.dhsReader),
      at(w.lib, w.libCataloger),
      at(w.lib, w.l2Manager),
    ]) {
      const r = await service.acceptShare(ctx, share.id);
      expect(shape(r)).toBe(shape(await service.acceptShare(ctx, newRecordId())));
      expect(codes(r)).toEqual(["unknown_share"]);
    }
    const accepted = ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    expect(accepted.state).toBe("accepted");
    expect(codes(await service.declineShare(at(w.dhs, w.dhsManager), share.id))).toEqual([
      "share_not_open",
    ]);
    const removed = ok(await service.removeShare(at(w.dhs, w.dhsManager), share.id));
    expect(removed.state).toBe("removed");
    // Offering again after a removal makes a new offer.
    expect((await offer(w, { org: w.dhs, site: w.d1 })).id).not.toBe(share.id);
  });

  it("lets the home side withdraw an offer or an accepted item, and no one else", async () => {
    await ready();
    const w = await world();
    const offered = await offer(w, { org: w.dhs, site: w.d1 });
    for (const ctx of [at(w.dhs, w.dhsManager), at(w.lib, w.libReader), at(w.lib, w.l2Manager)]) {
      const r = await service.withdrawShare(ctx, offered.id);
      expect(codes(r)).toEqual(["unknown_share"]);
      expect(shape(r)).toBe(shape(await service.withdrawShare(ctx, newRecordId())));
    }
    expect(ok(await service.withdrawShare(at(w.lib, w.libCataloger), offered.id)).state).toBe(
      "withdrawn",
    );
    const second = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), second.id));
    expect(ok(await service.withdrawShare(at(w.lib, w.libCataloger), second.id)).state).toBe(
      "withdrawn",
    );
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), second.id))).toEqual([
      "unknown_share",
    ]);
  });

  it("decides each share once, even when two decide at the same moment", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    const results = await Promise.all([
      service.acceptShare(at(w.dhs, w.dhsManager), share.id),
      service.declineShare(at(w.dhs, w.dhsManager), share.id),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).flatMap((r) => codes(r))).toEqual(["share_not_open"]);
    // A withdrawal racing a decision: whichever is first, the share ends
    // withdrawn or declined, never accepted after a withdrawal.
    const next = await offer(w, { org: w.lib, site: w.l2 });
    const [accept, withdraw] = await Promise.all([
      service.acceptShare(at(w.lib, w.l2Manager), next.id),
      service.withdrawShare(at(w.lib, w.libCataloger), next.id),
    ]);
    expect(withdraw.ok).toBe(true);
    if (!accept.ok) expect(codes(accept)).toEqual(["share_not_open"]);
  });
});

describe("what the second site sees", () => {
  it("shows public fields and the home names only, to whoever views the site's catalog", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    // Not yet accepted: nobody on D1 reads it as a shared item.
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id))).toEqual([
      "unknown_share",
    ]);
    // The manager sees the offer, with the same view.
    const offers = ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1));
    expect(offers.map((x) => x.id)).toEqual([share.id]);
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    for (const userId of [w.dhsReader, w.dhsCataloger, w.dhsManager]) {
      const seen = ok(await service.readSharedItem(at(w.dhs, userId), share.id));
      expect(seen.item).toEqual({
        title: "Invented depot lantern",
        kind: "object",
        published: false,
        fields: { description: "A tin lantern." },
        homeSite: "Invented library site " + String(count),
        homeOrganization: "Invented Library " + String(count),
      });
      expect(JSON.stringify(seen)).not.toContain(STAFF_NOTE);
      const list = ok(await service.listSharedItems(at(w.dhs, userId), w.d1));
      expect(list.map((x) => x.id)).toEqual([share.id]);
      expect(JSON.stringify(list)).not.toContain(STAFF_NOTE);
    }
    // An edit at home shows on the second site.
    const now = ok(await service.readRecord(at(w.lib, w.libCataloger), w.item.id));
    ok(
      await service.updateRecord(
        at(w.lib, w.libCataloger),
        w.item.id,
        { ...now.record, title: "Invented depot lantern, restored" },
        { expectedVersion: now.version },
      ),
    );
    expect(ok(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id)).item.title).toBe(
      "Invented depot lantern, restored",
    );
  });

  it("never lets the second site read or change the record the ordinary way", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.lib, site: w.l2 });
    ok(await service.acceptShare(at(w.lib, w.l2Manager), share.id));
    // Same organization, the second site's manager: the record is still
    // invisible to the ordinary operations, exactly as a missing one.
    const ctx = at(w.lib, w.l2Manager, w.l2);
    const read = await service.readRecord(ctx, w.item.id);
    expect(codes(read)).toEqual(["unknown_record"]);
    expect(shape(read)).toBe(shape(await service.readRecord(ctx, newRecordId())));
    const edit = await service.updateRecord(
      ctx,
      w.item.id,
      { ...w.item, title: "Changed from the second site" },
      { expectedVersion: 1 },
    );
    expect(codes(edit)).toEqual(["unknown_record"]);
    expect(codes(await service.listVersions(ctx, w.item.id))).toEqual(["unknown_record"]);
    // And it can't offer it on, or withdraw it.
    const onward = await service.offerRecord(ctx, {
      recordId: w.item.id,
      targetOrganizationId: w.dhs,
      targetSiteId: w.d1,
    });
    expect(codes(onward)).toEqual(["unknown_record"]);
    expect(codes(await service.withdrawShare(ctx, share.id))).toEqual(["unknown_share"]);
    // The item list of the second site doesn't hold it.
    const shared = ok(await service.listSharedItems(ctx, w.l2));
    expect(shared.map((x) => x.recordId)).toEqual([w.item.id]);
  });

  it("keeps another organization's sites and shares out of reach", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    // The Library's people asking about the Society's site, and the
    // Society's people asking under the Library's organization: refused
    // before anything is read.
    expect(codes(await service.sharesIntoSite(at(w.lib, w.l2Manager), w.d1))).toEqual([
      "not_permitted",
    ]);
    expect(codes(await service.listSharedItems(at(w.lib, w.libCataloger), w.d1))).toEqual([
      "not_permitted",
    ]);
    // A Society session naming the Library's organization isn't a member there.
    expect((await service.readSharedItem(at(w.lib, w.dhsReader), share.id)).ok).toBe(false);
    // The share's ID from the home side's session reads nothing as a shared item.
    expect(codes(await service.readSharedItem(at(w.lib, w.libCataloger), share.id))).toEqual([
      "unknown_share",
    ]);
    // The home side's list doesn't name anyone of the Society.
    const listed = ok(await service.sharesOfRecord(at(w.lib, w.libCataloger), w.item.id));
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(
      [
        "decidedAt",
        "endedAt",
        "id",
        "offeredAt",
        "recordId",
        "state",
        "targetOrganizationId",
        "targetSiteId",
      ].sort(),
    );
  });

  it("drops a share when its record is deleted", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    const now = ok(await service.readRecord(at(w.lib, folks.root, w.l1), w.item.id));
    ok(
      await service.deleteRecord(at(w.lib, folks.root, w.l1), w.item.id, {
        expectedVersion: now.version,
      }),
    );
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id))).toEqual([
      "unknown_share",
    ]);
    expect(ok(await service.listSharedItems(at(w.dhs, w.dhsReader), w.d1))).toEqual([]);
  });
});

describe("the database backs the shares up", () => {
  it("refuses shares to the home site, changed identities and moves off the life", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    const refusesWith = async (statement: ReturnType<typeof sql>, constraint: string) => {
      await expect(s.writer.execute(statement)).rejects.toMatchObject({ constraint });
    };
    await refusesWith(
      sql`INSERT INTO public.record_shares
            (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
          VALUES (${newRecordId()}::uuid, ${w.lib}::uuid, ${w.item.id}::uuid, ${w.lib}::uuid,
                  ${w.l1}::uuid, ${w.libCataloger}::uuid)`,
      "record_shares_not_home",
    );
    await refusesWith(
      sql`UPDATE public.record_shares SET target_site_id = ${w.l2}::uuid,
            target_organization_id = ${w.lib}::uuid WHERE id = ${share.id}::uuid`,
      "record_shares_identity",
    );
    await refusesWith(
      sql`UPDATE public.record_shares SET state = 'removed', ended_by = ${w.dhsManager}::uuid,
            ended_at = now() WHERE id = ${share.id}::uuid`,
      "record_shares_life",
    );
    // A second live offer to the same site.
    await expect(
      s.writer.execute(sql`INSERT INTO public.record_shares
            (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
          VALUES (${newRecordId()}::uuid, ${w.lib}::uuid, ${w.item.id}::uuid, ${w.dhs}::uuid,
                  ${w.d1}::uuid, ${w.libCataloger}::uuid)`),
    ).rejects.toMatchObject({ code: "23505" });
    // The writer can't delete shares.
    await expect(
      s.writer.execute(sql`DELETE FROM public.record_shares WHERE id = ${share.id}::uuid`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
