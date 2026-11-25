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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  DECLINE_COOLDOWN_DAYS,
  MAX_OPEN_OFFERS,
  MAX_SHARE_PAGE,
  migrate,
  openDatabase,
  sharesIntoSite,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import {
  freshDatabase,
  storeDirectVersion,
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

// Warm the setup before the first test, under the suite's longer hook limit
// (U-008). A failure stays in `setup`, so with no database each test still
// fails on its own when it calls ready().
beforeAll(() => ready().catch(() => undefined));

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
const RIGHTS_NOTE = "Invented note: the donor asked us to keep this private";
const LINK_LABEL = "Invented private donor name";
const SECRETS = [STAFF_NOTE, RIGHTS_NOTE, LINK_LABEL];
const leaks = (value: unknown) => SECRETS.filter((x) => JSON.stringify(value).includes(x));

async function catalogOrganization(name: string): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name }));
  const field = (
    key: string,
    visibility: "public" | "staff",
    kind = "text",
    extra: Record<string, unknown> = {},
  ) => ({
    key,
    label: key,
    kind,
    required: false,
    repeatable: false,
    visibility,
    inherited: false,
    ...extra,
  });
  ok(
    await insertTemplateVersion(s.owner, {
      key: "t-object",
      organizationId: org,
      label: "Objects",
      appliesTo: ["object"],
      fields: [
        field("description", "public"),
        field("shelf", "staff"),
        field("rights", "public", "rights"),
        // A public link: the public never sees it, not even its label (D-045).
        field("related", "public", "record_link"),
      ],
    }),
  );
  ok(
    await insertTemplateVersion(s.owner, {
      key: "t-unit",
      organizationId: org,
      label: "Units",
      appliesTo: ["archival_unit"],
      fields: [field("rights", "public", "rights")],
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
  // What the public pages publish (D-096); a shared item shows only these (S-036a).
  for (const org of [lib, dhs]) {
    for (const [template, entries] of [
      [
        "t-object",
        [
          { field: "description", term: "description" },
          { field: "rights", term: "rights" },
        ],
      ],
      ["t-unit", [{ field: "rights", term: "rights" }]],
    ] as const) {
      ok(
        await service.saveDublinCoreMapping(
          { organizationId: org, actor: actorOf(root) },
          template,
          { entries },
          { expectedVersion: 0 },
        ),
      );
    }
  }
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
  const linked = ok(
    await service.createRecord(
      { organizationId: lib, actor: actorOf(libCataloger), siteId: l1 },
      { kind: "object", title: LINK_LABEL, templateKey: "t-object", fields: {} },
    ),
  ).record;
  const item = ok(
    await service.createRecord(
      { organizationId: lib, actor: actorOf(libCataloger), siteId: l1 },
      {
        kind: "object",
        title: "Invented depot lantern",
        templateKey: "t-object",
        fields: {
          description: "A tin lantern.",
          shelf: STAFF_NOTE,
          rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/", note: RIGHTS_NOTE },
          related: { recordId: linked.id, label: LINK_LABEL },
        },
      },
    ),
  ).record;
  // Published by the system manager (only published items are shared).
  ok(
    await service.publish({ organizationId: lib, actor: actorOf(root), siteId: l1 }, item.id, {
      expectedVersion: 1,
    }),
  );
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
    const listed = ok(await service.sharesOfRecord(at(w.lib, w.libCataloger), w.item.id)).shares;
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
    for (const ctx of [at(w.dhs, w.dhsCataloger), at(w.lib, w.l2Manager)]) {
      const acts = [
        (c: typeof ctx, id: unknown) => service.declineShare(c, id),
        (c: typeof ctx, id: unknown) => service.removeShare(c, id),
        (c: typeof ctx, id: unknown) => service.readSharedItem(c, id),
      ];
      for (const act of acts) {
        const r = await act(ctx, share.id);
        expect(codes(r)).toEqual(["unknown_share"]);
        expect(shape(r)).toBe(shape(await act(ctx, newRecordId())));
        expect(shape(r)).toBe(shape(await act(ctx, "not an id")));
      }
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
    const [state] = await s.owner.rows<{ state: string }>(
      sql`SELECT state FROM public.record_shares WHERE id = ${next.id}::uuid`,
    );
    expect(state?.state).toBe("withdrawn");
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
    const offers = ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares;
    expect(offers.map((x) => x.id)).toEqual([share.id]);
    expect(leaks(offers)).toEqual([]);
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    for (const userId of [w.dhsReader, w.dhsCataloger, w.dhsManager]) {
      const seen = ok(await service.readSharedItem(at(w.dhs, userId), share.id));
      expect(seen.item).toEqual({
        title: "Invented depot lantern",
        kind: "object",
        // What the public sees: no staff field, no link, no rights note.
        fields: {
          description: "A tin lantern.",
          rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" },
        },
        labels: { description: "description", rights: "rights" },
        homeSite: "Invented library site " + String(count),
        homeOrganization: "Invented Library " + String(count),
      });
      expect(leaks(seen)).toEqual([]);
      const list = ok(await service.listSharedItems(at(w.dhs, userId), w.d1)).shares;
      expect(list.map((x) => x.id)).toEqual([share.id]);
      expect(leaks(list)).toEqual([]);
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
    expect(ok(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id)).item?.title).toBe(
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
    // It is listed only among the items shared with the second site.
    const shared = ok(await service.listSharedItems(ctx, w.l2)).shares;
    expect(shared.map((x) => x.recordId)).toEqual([w.item.id]);
    // Another organization's manager of an accepting site can't read it the ordinary way either.
    const other = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), other.id));
    const fromDhs = await service.readRecord(at(w.dhs, w.dhsManager, w.d1), w.item.id);
    expect(fromDhs.ok).toBe(false);
    expect(shape(fromDhs)).toBe(
      shape(await service.readRecord(at(w.dhs, w.dhsManager, w.d1), newRecordId())),
    );
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
    const listed = ok(await service.sharesOfRecord(at(w.lib, w.libCataloger), w.item.id)).shares;
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
    const rootAt = at(w.lib, folks.root, w.l1);
    const before = ok(await service.readRecord(rootAt, w.item.id));
    ok(await service.withdraw(rootAt, w.item.id, { expectedVersion: before.version }));
    // Withdrawn from publication: the second site shows it no more.
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id))).toEqual([
      "unknown_share",
    ]);
    const now = ok(await service.readRecord(rootAt, w.item.id));
    ok(await service.deleteRecord(rootAt, w.item.id, { expectedVersion: now.version }));
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id))).toEqual([
      "unknown_share",
    ]);
    expect(ok(await service.listSharedItems(at(w.dhs, w.dhsReader), w.d1)).shares).toEqual([]);
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

describe("second review", () => {
  it("offers only published items", async () => {
    await ready();
    const w = await world();
    const draft = ok(
      await service.createRecord(at(w.lib, w.libCataloger, w.l1), {
        kind: "object",
        title: "Invented unpublished lantern",
        templateKey: "t-object",
        fields: { shelf: STAFF_NOTE },
      }),
    ).record;
    const r = await service.offerRecord(at(w.lib, w.libCataloger), {
      recordId: draft.id,
      targetOrganizationId: w.dhs,
      targetSiteId: w.d1,
    });
    expect(codes(r)).toEqual(["not_published"]);
  });

  it("answers two offers at once to one site with one share and already_shared", async () => {
    await ready();
    const w = await world();
    const request = { recordId: w.item.id, targetOrganizationId: w.dhs, targetSiteId: w.d1 };
    const results = await Promise.all([
      service.offerRecord(at(w.lib, w.libCataloger), request),
      service.offerRecord(at(w.lib, w.libCataloger), request),
      service.offerRecord(at(w.lib, w.libCataloger), request),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).flatMap((r) => codes(r))).toEqual([
      "already_shared",
      "already_shared",
    ]);
  });

  it("stops showing an item moved onto the site it was shared into", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.lib, site: w.l2 });
    ok(await service.acceptShare(at(w.lib, w.l2Manager), share.id));
    expect(ok(await service.listSharedItems(at(w.lib, w.l2Manager), w.l2)).shares).toHaveLength(1);
    const rootAt = at(w.lib, folks.root, w.l1);
    const now = ok(await service.readRecord(rootAt, w.item.id));
    ok(
      await service.updateRecord(
        rootAt,
        w.item.id,
        { ...now.record, siteId: w.l2 },
        { expectedVersion: now.version },
      ),
    );
    expect(ok(await service.listSharedItems(at(w.lib, w.l2Manager), w.l2)).shares).toEqual([]);
    expect(codes(await service.readSharedItem(at(w.lib, w.l2Manager), share.id))).toEqual([
      "unknown_share",
    ]);
  });

  it("lets a person scoped to part of the home site offer only what they may edit, without deadlocks", async () => {
    await ready();
    const w = await world();
    const rootAt = at(w.lib, folks.root, w.l1);
    const make = async (draft: Record<string, unknown>) => {
      const made = ok(await service.createRecord(rootAt, draft)).record;
      ok(await service.publish(rootAt, made.id, { expectedVersion: 1 }));
      return made;
    };
    const rights = { uri: "http://rightsstatements.org/vocab/NoC-US/1.0/" };
    const fonds = await make({
      kind: "archival_unit",
      level: "fonds",
      title: "Invented fonds",
      templateKey: "t-unit",
      fields: { rights },
    });
    const file = await make({
      kind: "archival_unit",
      level: "file",
      title: "Invented file",
      parentId: fonds.id,
      templateKey: "t-unit",
      fields: { rights },
    });
    const scoped = await folks.member(w.lib, `scoped-${String(count)}`);
    await grant(service, folks.root, w.lib, {
      userId: scoped,
      role: "cataloger",
      siteId: w.l1,
      scope: fonds.id,
    });
    const ctx = at(w.lib, scoped, w.l1);
    const to = { targetOrganizationId: w.dhs, targetSiteId: w.d1 };
    // Outside the scope: as missing.
    expect(codes(await service.offerRecord(ctx, { recordId: w.item.id, ...to }))).toEqual([
      "unknown_record",
    ]);
    // Inside it, while the fonds is being edited at the same moment: both go through.
    const now = ok(await service.readRecord(rootAt, fonds.id));
    const [offered, edited] = await Promise.all([
      service.offerRecord(ctx, { recordId: file.id, ...to }),
      service.updateRecord(
        rootAt,
        fonds.id,
        { ...now.record, title: "Invented fonds, renamed" },
        { expectedVersion: now.version },
      ),
    ]);
    expect(offered.ok).toBe(true);
    expect(edited.ok).toBe(true);
    // The scoped person can't see what is shared into the site (not the whole catalog).
    expect(codes(await service.listSharedItems(ctx, w.l1))).toEqual(["not_permitted"]);
  });

  it("refuses a decision made by withdrawing, and times that aren't now", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    await expect(
      s.writer.execute(sql`UPDATE public.record_shares
        SET state = 'withdrawn', ended_by = ${w.libCataloger}::uuid, ended_at = clock_timestamp(),
            decided_by = ${w.dhsManager}::uuid, decided_at = clock_timestamp()
        WHERE id = ${share.id}::uuid`),
    ).rejects.toMatchObject({ constraint: "record_shares_identity" });
    await expect(
      s.writer.execute(sql`UPDATE public.record_shares
        SET state = 'accepted', decided_by = ${w.dhsManager}::uuid,
            decided_at = now() - interval '1 day'
        WHERE id = ${share.id}::uuid`),
    ).rejects.toMatchObject({ constraint: "record_shares_now" });
    // The checks hold in replica mode too (ENABLE ALWAYS).
    await expect(
      s.owner.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(sql`UPDATE public.record_shares SET state = 'removed',
          ended_by = ${w.dhsManager}::uuid, ended_at = clock_timestamp()
          WHERE id = ${share.id}::uuid`);
      }),
    ).rejects.toMatchObject({ constraint: "record_shares_life" });
  });

  it("shows nothing the public couldn't see: no home site, or public output refused", async () => {
    await ready();
    const w = await world();
    const rootNoSite = { organizationId: w.lib, actor: actorOf(folks.root) };
    const noSite = ok(
      await service.createRecord(rootNoSite, {
        kind: "object",
        title: "Invented lantern on no site",
        templateKey: "t-object",
        fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
      }),
    ).record;
    ok(await service.publish(rootNoSite, noSite.id, { expectedVersion: 1 }));
    expect(
      codes(
        await service.offerRecord(rootNoSite, {
          recordId: noSite.id,
          targetOrganizationId: w.dhs,
          targetSiteId: w.d1,
        }),
      ),
    ).toEqual(["not_published"]);
    // A shown item whose public output is refused later (its description no
    // longer fits the field after a template change) is shown no more.
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    expect(ok(await service.listSharedItems(at(w.dhs, w.dhsReader), w.d1)).shares).toHaveLength(1);
    ok(
      await insertTemplateVersion(s.owner, {
        key: "t-object",
        organizationId: w.lib,
        label: "Objects",
        appliesTo: ["object"],
        fields: [
          {
            key: "description",
            label: "description",
            kind: "date",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
          {
            key: "rights",
            label: "rights",
            kind: "rights",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
        ],
      }),
    );
    expect(ok(await service.listSharedItems(at(w.dhs, w.dhsReader), w.d1)).shares).toEqual([]);
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id))).toEqual([
      "unknown_share",
    ]);
  });

  it("doesn't let items nobody on the site can see fill its lists", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    const rootAt = at(w.lib, folks.root, w.l1);
    const now = ok(await service.readRecord(rootAt, w.item.id));
    ok(await service.withdraw(rootAt, w.item.id, { expectedVersion: now.version }));
    const [row] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.record_shares WHERE id = ${share.id}::uuid`);
    expect(row?.n).toBe(1);
    // Left out in the query itself (before its limit), not after.
    expect(await sharesIntoSite(s.owner, w.dhs, w.d1, "offered")).toEqual([]);
    expect(ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares).toEqual([]);
  });

  it("stops showing an accepted item once it is on no site", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    await s.owner.transaction(async (q) => {
      await q.execute(sql`UPDATE public.records SET site_id = NULL, version = version + 1
        WHERE organization_id = ${w.lib}::uuid AND id = ${w.item.id}::uuid`);
      await storeDirectVersion(q, w.lib, w.item.id);
    });
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id))).toEqual([
      "unknown_share",
    ]);
  });

  it("answers a failure while building the view as a clean refusal, logged", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    const failure = new Error("connection to 10.0.0.5 lost while reading");
    const flaky: Database = {
      rows: (q) => s.writer.rows(q),
      execute: (q) => s.writer.execute(q),
      close: () => Promise.resolve(),
      transaction: (work) =>
        s.writer.transaction((tx) =>
          work({
            rows: (q) => tx.rows(q),
            execute: (q) =>
              q.text.includes("REPEATABLE READ") ? Promise.reject(failure) : tx.execute(q),
          }),
        ),
    };
    const errors: unknown[] = [];
    const failing = createService(flaky, { onError: (e) => errors.push(e) });
    for (const result of [
      await failing.readSharedItem(at(w.dhs, w.dhsReader), share.id),
      await failing.listSharedItems(at(w.dhs, w.dhsReader), w.d1),
      await failing.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1),
    ]) {
      expect(codes(result)).toEqual(["internal_error"]);
      expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    }
    expect(errors).toEqual([failure, failure, failure]);
  });
});

describe("share lists and views (S-036a)", () => {
  /** A published object made by the library's cataloger on L1. */
  async function publishedItem(w: World, title: string, templateKey = "t-object") {
    const made = ok(
      await service.createRecord(at(w.lib, w.libCataloger, w.l1), {
        kind: "object",
        title,
        templateKey,
        fields: {
          description: "An invented description.",
          rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" },
        },
      }),
    ).record;
    ok(
      await service.publish(
        { organizationId: w.lib, actor: actorOf(folks.root), siteId: w.l1 },
        made.id,
        {
          expectedVersion: 1,
        },
      ),
    );
    return made;
  }

  /** `recordId` offered to D1 by the library's cataloger. */
  async function offerToD1(w: World, recordId: string) {
    return ok(
      await service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
        recordId,
        targetOrganizationId: w.dhs,
        targetSiteId: w.d1,
      }),
    );
  }

  it("pages each list newest first, by the last share's ID, and refuses a bad page", async () => {
    await ready();
    const w = await world();
    const shares = [await offerToD1(w, w.item.id)];
    for (const n of [1, 2]) {
      const item = await publishedItem(w, `Invented paged lantern ${String(n)}`);
      shares.push(await offerToD1(w, item.id));
    }
    const newestFirst = [...shares].reverse().map((x) => x.id);
    const manager = at(w.dhs, w.dhsManager);
    const first = ok(await service.sharesIntoSite(manager, w.d1)).shares;
    expect(first.map((x) => x.id)).toEqual(newestFirst);
    const after = ok(
      await service.sharesIntoSite(manager, w.d1, { state: "offered", before: newestFirst[0] }),
    ).shares;
    expect(after.map((x) => x.id)).toEqual(newestFirst.slice(1));
    const last = ok(
      await service.sharesIntoSite(manager, w.d1, { state: "offered", before: newestFirst[2] }),
    ).shares;
    expect(last).toEqual([]);
    // An accepted item's page doesn't see the offers, and no one else's share is a cursor.
    expect(ok(await service.sharesIntoSite(manager, w.d1, { state: "accepted" })).shares).toEqual(
      [],
    );
    for (const before of [newRecordId(), "not-an-id"]) {
      expect(
        ok(await service.sharesIntoSite(manager, w.d1, { state: "offered", before })).shares,
      ).toEqual([]);
    }
    // A record's own list pages the same way.
    const home = at(w.lib, w.libCataloger, w.l1);
    const own = ok(await service.sharesOfRecord(home, w.item.id)).shares;
    expect(own.map((x) => x.id)).toEqual([shares[0]?.id]);
    expect(
      ok(await service.sharesOfRecord(home, w.item.id, { before: shares[0]?.id })).shares,
    ).toEqual([]);
    for (const bad of [{ state: "declined" }, { before: 7 }, { other: 1 }]) {
      expect(codes(await service.sharesIntoSite(manager, w.d1, bad))).toEqual(["invalid_request"]);
    }
    expect(codes(await service.sharesOfRecord(home, w.item.id, { state: "offered" }))).toEqual([
      "invalid_request",
    ]);
  });

  it("gives a page of at most MAX_SHARE_PAGE and an exact next, even when it leaves some out", async () => {
    await ready();
    const w = await world();
    // A template with no stored mapping: its items' offers can't be shown (nothing to decide on).
    ok(
      await insertTemplateVersion(s.owner, {
        key: "t-unmapped",
        organizationId: w.lib,
        label: "Unmapped objects",
        appliesTo: ["object"],
        fields: [
          {
            key: "rights",
            label: "Rights",
            kind: "rights",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
        ],
      }),
    );
    const shown: string[] = [];
    const all: string[] = [];
    for (let n = 0; n < MAX_SHARE_PAGE + 2; n++) {
      // Two of the newest page's offers can't be shown.
      const unmapped = n === MAX_SHARE_PAGE - 1 || n === MAX_SHARE_PAGE - 10;
      const made = unmapped
        ? ok(
            await service.createRecord(at(w.lib, w.libCataloger, w.l1), {
              kind: "object",
              title: `Invented unmapped lantern ${String(n)}`,
              templateKey: "t-unmapped",
              fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
            }),
          ).record
        : undefined;
      if (made !== undefined) {
        ok(
          await service.publish(
            { organizationId: w.lib, actor: actorOf(folks.root), siteId: w.l1 },
            made.id,
            { expectedVersion: 1 },
          ),
        );
      }
      const id = made?.id ?? (await publishedItem(w, `Invented many lantern ${String(n)}`)).id;
      const share = await offerToD1(w, id);
      all.push(share.id);
      if (!unmapped) shown.push(share.id);
    }
    const manager = at(w.dhs, w.dhsManager);
    const page1 = ok(await service.sharesIntoSite(manager, w.d1, { state: "offered" }));
    // A full page was read; two of it weren't shown, and the next page still follows it.
    expect(page1.shares).toHaveLength(MAX_SHARE_PAGE - 2);
    expect(page1.next.offered).toBe([...all].reverse()[MAX_SHARE_PAGE - 1]);
    expect(page1.next.accepted).toBeNull();
    const page2 = ok(
      await service.sharesIntoSite(manager, w.d1, {
        state: "offered",
        before: page1.next.offered,
      }),
    );
    expect(page2.next.offered).toBeNull();
    expect([...page1.shares, ...page2.shares].map((x) => x.id)).toEqual([...shown].reverse());
  }, 180_000);

  it("never takes another list's share as a cursor, and needs a state with a cursor", async () => {
    await ready();
    const w = await world();
    const intoD1 = await offerToD1(w, w.item.id);
    // A share of the same record into another site of the home organization.
    const intoL2 = ok(
      await service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
        recordId: w.item.id,
        targetOrganizationId: w.lib,
        targetSiteId: w.l2,
      }),
    );
    const other = await publishedItem(w, "Invented other lantern");
    const otherShare = await offerToD1(w, other.id);
    const manager = at(w.dhs, w.dhsManager);
    // L2's share, and an accepted-list cursor for the offered list, give empty pages.
    for (const before of [intoL2.id]) {
      expect(
        ok(await service.sharesIntoSite(manager, w.d1, { state: "offered", before })).shares,
      ).toEqual([]);
    }
    // A cursor share that was decided since still marks where its page ended.
    ok(await service.acceptShare(manager, otherShare.id));
    expect(
      ok(
        await service.sharesIntoSite(manager, w.d1, { state: "offered", before: otherShare.id }),
      ).shares.map((x) => x.id),
    ).toEqual([intoD1.id]);
    // Another record's share isn't a cursor for this record's list.
    const home = at(w.lib, w.libCataloger, w.l1);
    expect(
      ok(await service.sharesOfRecord(home, w.item.id, { before: otherShare.id })).shares,
    ).toEqual([]);
    expect(ok(await service.sharesOfRecord(home, w.item.id)).shares.map((x) => x.id)).toEqual([
      intoL2.id,
      intoD1.id,
    ]);
    // A cursor without a state on a site's list is refused.
    expect(codes(await service.sharesIntoSite(manager, w.d1, { before: intoD1.id }))).toEqual([
      "invalid_request",
    ]);
  });

  it("shows the manager, and only the manager, an accepted item the public can't see now, to remove it", async () => {
    await ready();
    const w = await world();
    const share = await offerToD1(w, w.item.id);
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    const rootAt = { organizationId: w.lib, actor: actorOf(folks.root), siteId: w.l1 };
    const now = ok(await service.readRecord(rootAt, w.item.id));
    ok(await service.withdraw(rootAt, w.item.id, { expectedVersion: now.version }));
    const managed = ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares;
    expect(managed.map((x) => [x.id, x.state, x.item])).toEqual([[share.id, "accepted", null]]);
    // Nobody else sees it, and its view isn't readable.
    for (const userId of [w.dhsReader, w.dhsCataloger, w.dhsManager]) {
      expect(ok(await service.listSharedItems(at(w.dhs, userId), w.d1)).shares).toEqual([]);
      expect(codes(await service.readSharedItem(at(w.dhs, userId), share.id))).toEqual([
        "unknown_share",
      ]);
    }
    // The manager can remove it.
    expect(ok(await service.removeShare(at(w.dhs, w.dhsManager), share.id)).state).toBe("removed");
    expect(ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares).toEqual([]);
  });

  it("shows only the fields the home mapping publishes, named by the home template's labels", async () => {
    await ready();
    const w = await world();
    // A new version of the home template with labels of its own.
    const field = (key: string, label: string, visibility: "public" | "staff", kind = "text") => ({
      key,
      label,
      kind,
      required: false,
      repeatable: false,
      visibility,
      inherited: false,
    });
    ok(
      await insertTemplateVersion(s.owner, {
        key: "t-labelled",
        organizationId: w.lib,
        label: "Labelled objects",
        appliesTo: ["object"],
        fields: [
          field("description", "What it is", "public"),
          field("maker", "Who made it", "public"),
          field("rights", "Rights", "public", "rights"),
        ],
      }),
    );
    ok(
      await service.saveDublinCoreMapping(
        { organizationId: w.lib, actor: actorOf(folks.root) },
        "t-labelled",
        // "maker" is public but not published by the mapping.
        {
          entries: [
            { field: "description", term: "description" },
            { field: "rights", term: "rights" },
          ],
        },
        { expectedVersion: 0 },
      ),
    );
    const made = ok(
      await service.createRecord(at(w.lib, w.libCataloger, w.l1), {
        kind: "object",
        title: "Invented labelled lantern",
        templateKey: "t-labelled",
        fields: {
          description: "A tin lantern.",
          maker: "An invented tinsmith",
          rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" },
        },
      }),
    ).record;
    ok(
      await service.publish(
        { organizationId: w.lib, actor: actorOf(folks.root), siteId: w.l1 },
        made.id,
        {
          expectedVersion: 1,
        },
      ),
    );
    const share = await offerToD1(w, made.id);
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    const seen = ok(await service.readSharedItem(at(w.dhs, w.dhsReader), share.id));
    expect(seen.item?.fields).toEqual({
      description: "A tin lantern.",
      rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" },
    });
    expect(seen.item?.labels).toEqual({ description: "What it is", rights: "Rights" });
    expect(JSON.stringify(seen)).not.toContain("tinsmith");
  });

  it("hides an accepted item whose home template has no stored mapping, as the public sites do", async () => {
    await ready();
    const w = await world();
    ok(
      await insertTemplateVersion(s.owner, {
        key: "t-unmapped",
        organizationId: w.lib,
        label: "Unmapped objects",
        appliesTo: ["object"],
        fields: [
          {
            key: "rights",
            label: "Rights",
            kind: "rights",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
        ],
      }),
    );
    const made = ok(
      await service.createRecord(at(w.lib, w.libCataloger, w.l1), {
        kind: "object",
        title: "Invented unmapped lantern",
        templateKey: "t-unmapped",
        fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
      }),
    ).record;
    ok(
      await service.publish(
        { organizationId: w.lib, actor: actorOf(folks.root), siteId: w.l1 },
        made.id,
        {
          expectedVersion: 1,
        },
      ),
    );
    const share = await offerToD1(w, made.id);
    // An offer the public can't see isn't listed at all (nothing to decide on).
    expect(ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares).toEqual([]);
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), share.id));
    expect(
      ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares.map((x) => x.item),
    ).toEqual([null]);
    expect(ok(await service.listSharedItems(at(w.dhs, w.dhsReader), w.d1)).shares).toEqual([]);
  });
});

describe("share limits and endings (S-036b)", () => {
  interface Row {
    state: string;
    decided_by: string | null;
    decided_at: string | null;
    ended_by: string | null;
    ended_at: string | null;
  }
  const stored = async (id: string): Promise<Row | undefined> =>
    (
      await s.owner.rows<Row>(sql`
        SELECT state, decided_by::text AS decided_by, decided_at::text AS decided_at,
               ended_by::text AS ended_by, ended_at::text AS ended_at
        FROM public.record_shares WHERE id = ${id}::uuid`)
    )[0];

  /** A published item of the Library's L1, besides the world's own. */
  async function anotherItem(w: World, title: string): Promise<CatalogRecord> {
    const made = ok(
      await service.createRecord(at(w.lib, w.libCataloger, w.l1), {
        kind: "object",
        title,
        templateKey: "t-object",
        fields: {
          description: "Invented.",
          rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" },
        },
      }),
    ).record;
    ok(await service.publish(at(w.lib, folks.root, w.l1), made.id, { expectedVersion: 1 }));
    return made;
  }

  it("keeps the second site's decisions when the home side deletes the item", async () => {
    await ready();
    const w = await world();
    const accepted = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.acceptShare(at(w.dhs, w.dhsManager), accepted.id));
    const declined = await offer(w, { org: w.lib, site: w.l2 });
    ok(await service.declineShare(at(w.lib, w.l2Manager), declined.id));
    const rootAt = at(w.lib, folks.root, w.l1);
    const before = ok(await service.readRecord(rootAt, w.item.id));
    ok(await service.withdraw(rootAt, w.item.id, { expectedVersion: before.version }));
    const now = ok(await service.readRecord(rootAt, w.item.id));
    ok(await service.deleteRecord(rootAt, w.item.id, { expectedVersion: now.version }));
    // The accepted share ends as deleted, its decision kept; the declined one stays.
    const a = await stored(accepted.id);
    expect(a).toMatchObject({ state: "deleted", decided_by: w.dhsManager, ended_by: null });
    expect(a?.ended_at).not.toBeNull();
    expect(await stored(declined.id)).toMatchObject({
      state: "declined",
      decided_by: w.l2Manager,
    });
    // Still shown nowhere.
    expect(codes(await service.readSharedItem(at(w.dhs, w.dhsManager), accepted.id))).toEqual([
      "unknown_share",
    ]);
    expect(ok(await service.sharesIntoSite(at(w.dhs, w.dhsManager), w.d1)).shares).toEqual([]);
    expect(codes(await service.removeShare(at(w.dhs, w.dhsManager), accepted.id))).toEqual([
      "share_not_open",
    ]);
  });

  it("ends a share when its item moves onto the second site, and doesn't bring it back", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.lib, site: w.l2 });
    ok(await service.acceptShare(at(w.lib, w.l2Manager), share.id));
    // An offer elsewhere is untouched by the move.
    const other = await offer(w, { org: w.dhs, site: w.d1 });
    const rootAt = at(w.lib, folks.root, w.l1);
    const move = async (siteId: SiteId) => {
      const now = ok(await service.readRecord(rootAt, w.item.id));
      ok(
        await service.updateRecord(
          rootAt,
          w.item.id,
          { ...now.record, siteId },
          { expectedVersion: now.version },
        ),
      );
    };
    await move(w.l2);
    expect(await stored(share.id)).toMatchObject({
      state: "moved",
      decided_by: w.l2Manager,
      ended_by: null,
    });
    expect((await stored(other.id))?.state).toBe("offered");
    // Back home: the old share stays ended, and L2 shows nothing.
    await move(w.l1);
    expect((await stored(share.id))?.state).toBe("moved");
    expect(ok(await service.listSharedItems(at(w.lib, w.l2Manager), w.l2)).shares).toEqual([]);
    const listed = ok(await service.sharesOfRecord(rootAt, w.item.id)).shares;
    expect(listed.find((x) => x.id === share.id)?.state).toBe("moved");
    // It can be offered anew.
    const again = await offer(w, { org: w.lib, site: w.l2 });
    expect(again.state).toBe("offered");
  });

  it("refuses moves to deleted or moved that didn't happen", async () => {
    await ready();
    const w = await world();
    const share = await offer(w, { org: w.lib, site: w.l2 });
    for (const state of ["deleted", "moved"]) {
      await expect(
        s.writer.execute(sql`UPDATE public.record_shares
          SET state = ${state}, ended_at = clock_timestamp() WHERE id = ${share.id}::uuid`),
      ).rejects.toMatchObject({ constraint: "record_shares_life" });
    }
    // An offer of a record that doesn't exist.
    await expect(
      s.writer.execute(sql`INSERT INTO public.record_shares
            (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
          VALUES (${newRecordId()}::uuid, ${w.lib}::uuid, ${newRecordId()}::uuid, ${w.dhs}::uuid,
                  ${w.d1}::uuid, ${w.libCataloger}::uuid)`),
    ).rejects.toMatchObject({ constraint: "record_shares_record" });
  });

  it("refuses offering a record again soon after the site declined it", async () => {
    await ready();
    const w = await world();
    const first = await offer(w, { org: w.dhs, site: w.d1 });
    ok(await service.declineShare(at(w.dhs, w.dhsManager), first.id));
    const again = await service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
      recordId: w.item.id,
      targetOrganizationId: w.dhs,
      targetSiteId: w.d1,
    });
    expect(codes(again)).toEqual(["declined_recently"]);
    // Another site may still be offered it, and a withdrawn offer doesn't count.
    const l2 = await offer(w, { org: w.lib, site: w.l2 });
    ok(await service.withdrawShare(at(w.lib, w.libCataloger, w.l1), l2.id));
    expect((await offer(w, { org: w.lib, site: w.l2 })).state).toBe("offered");
    // Once the wait is over (the decline set back by hand), it can be offered again.
    await s.owner.transaction(async (q) => {
      await q.execute(sql`ALTER TABLE public.record_shares DISABLE TRIGGER record_shares_check`);
      await q.execute(sql`UPDATE public.record_shares
        SET decided_at = now() - make_interval(days => ${String(DECLINE_COOLDOWN_DAYS)} + 1)
        WHERE id = ${first.id}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.record_shares ENABLE ALWAYS TRIGGER record_shares_check`,
      );
    });
    expect((await offer(w, { org: w.dhs, site: w.d1 })).state).toBe("offered");
  });

  it("limits the open offers one organization has into one site", async () => {
    await ready();
    const w = await world();
    // MAX_OPEN_OFFERS - 1 offers stored directly (the limit is the database's).
    const ids: string[] = [];
    const fillers: CatalogRecord[] = [];
    for (let n = 0; n < MAX_OPEN_OFFERS - 1; n++) {
      const r = await anotherItem(w, `Invented filler ${String(n)}`);
      fillers.push(r);
      const id = newRecordId();
      await s.writer.execute(sql`INSERT INTO public.record_shares
            (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
          VALUES (${id}::uuid, ${w.lib}::uuid, ${r.id}::uuid, ${w.dhs}::uuid, ${w.d1}::uuid,
                  ${w.libCataloger}::uuid)`);
      ids.push(id);
    }
    // Two offers at the same moment for the last place: exactly one gets it.
    const a = await anotherItem(w, "Invented lamp A");
    const b = await anotherItem(w, "Invented lamp B");
    const both = await Promise.all(
      [a, b].map((r) =>
        service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
          recordId: r.id,
          targetOrganizationId: w.dhs,
          targetSiteId: w.d1,
        }),
      ),
    );
    expect(both.map((r) => (r.ok ? "ok" : codes(r)[0])).sort()).toEqual(["ok", "too_many_offers"]);
    // The world's own item is refused too, until the site answers one.
    const offerItem = () =>
      service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
        recordId: w.item.id,
        targetOrganizationId: w.dhs,
        targetSiteId: w.d1,
      });
    expect(codes(await offerItem())).toEqual(["too_many_offers"]);
    // Other sites, and other organizations' offers into D1, aren't counted.
    expect((await offer(w, { org: w.lib, site: w.l2 })).state).toBe("offered");
    // An offer whose item the home side unpublished since no longer takes a
    // place (the second site can't see or answer it).
    const rootAt = at(w.lib, folks.root, w.l1);
    const first = fillers[0];
    if (first === undefined) throw new Error("no filler");
    const now = ok(await service.readRecord(rootAt, first.id));
    ok(await service.withdraw(rootAt, first.id, { expectedVersion: now.version }));
    expect((await offerItem()).ok).toBe(true);
    // Full again; answering one frees a place.
    const c = await anotherItem(w, "Invented lamp C");
    const offerItemAgain = () =>
      service.offerRecord(at(w.lib, w.libCataloger, w.l1), {
        recordId: c.id,
        targetOrganizationId: w.dhs,
        targetSiteId: w.d1,
      });
    expect(codes(await offerItemAgain())).toEqual(["too_many_offers"]);
    await s.writer.execute(sql`UPDATE public.record_shares
        SET state = 'accepted', decided_by = ${w.dhsManager}::uuid, decided_at = clock_timestamp()
        WHERE id = ${ids[1] ?? ""}::uuid`);
    expect((await offerItemAgain()).ok).toBe(true);
  }, 120_000);

  it("ends offers not yet answered too, when the item is moved or deleted", async () => {
    await ready();
    const w = await world();
    const toL2 = await offer(w, { org: w.lib, site: w.l2 });
    const toD1 = await offer(w, { org: w.dhs, site: w.d1 });
    const rootAt = at(w.lib, folks.root, w.l1);
    let now = ok(await service.readRecord(rootAt, w.item.id));
    ok(
      await service.updateRecord(
        rootAt,
        w.item.id,
        { ...now.record, siteId: w.l2 },
        { expectedVersion: now.version },
      ),
    );
    expect(await stored(toL2.id)).toMatchObject({ state: "moved", decided_by: null });
    expect(codes(await service.acceptShare(at(w.lib, w.l2Manager), toL2.id))).toEqual([
      "share_not_open",
    ]);
    now = ok(await service.readRecord(rootAt, w.item.id));
    ok(
      await service.withdraw(at(w.lib, folks.root, w.l2), w.item.id, {
        expectedVersion: now.version,
      }),
    );
    now = ok(await service.readRecord(rootAt, w.item.id));
    ok(
      await service.deleteRecord(at(w.lib, folks.root, w.l2), w.item.id, {
        expectedVersion: now.version,
      }),
    );
    expect(await stored(toD1.id)).toMatchObject({ state: "deleted", decided_by: null });
  });

  it("refuses an offer made outside Read Committed (the limit's count needs it)", async () => {
    await ready();
    const w = await world();
    await expect(
      s.writer.transaction(async (q) => {
        await q.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await q.execute(sql`INSERT INTO public.record_shares
            (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
          VALUES (${newRecordId()}::uuid, ${w.lib}::uuid, ${w.item.id}::uuid, ${w.dhs}::uuid,
                  ${w.d1}::uuid, ${w.libCataloger}::uuid)`);
      }),
    ).rejects.toMatchObject({ code: "OC061" });
  });

  it("keeps the limits in shares.ts and the migration the same", () => {
    const text = readFileSync(
      new URL("../../db/migrations/0043_share_limits_and_endings.sql", import.meta.url),
      "utf8",
    );
    expect(text).toContain(`IF open_offers >= ${String(MAX_OPEN_OFFERS)} THEN`);
    expect(text).toContain(
      `d.decided_at > now() - interval '${String(DECLINE_COOLDOWN_DAYS)} days'`,
    );
  });
});
