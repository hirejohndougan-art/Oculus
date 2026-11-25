/**
 * A test world for the staff API (T-042): a fresh migrated database, two
 * invented organizations with sites, templates and an identifier type,
 * invented people with roles granted through the service, and sessions made
 * directly in the database (as the owner) so no password hashing slows the
 * tests. Every name and address here is invented (example.org, RFC 2606).
 *
 * Full sessions go through the real second step (D-077): a waiting
 * session inserted for a member, then completed with a test recovery code.
 */
import {
  hashSessionToken,
  newOrganizationId,
  newSessionId,
  newSessionToken,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  completeSecondStep,
  insertIdentifierType,
  insertOrganization,
  insertTemplateVersion,
  migrate,
  openDatabase,
  sql,
  type Database,
} from "@oculus/db";
import { createService, type RecordService, type ServiceResult } from "@oculus/service";
import { actorOf, grant, makeSite, people } from "../../service/src/people.fixtures.js";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import {
  giveTestFactor,
  testKeyring,
  type TestFactor,
} from "../../db/src/second-factor.fixtures.js";

export const INC = "http://rightsstatements.org/vocab/InC/1.0/";

export function ok<T>(result: Validated<T> | ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

export function field(key: string, kind: string, extra: Record<string, unknown> = {}) {
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

export const OBJECT_FIELDS = [
  field("rights", "rights"),
  field("note", "text"),
  field("secret", "text", { visibility: "staff" }),
];

export interface World {
  testDb: TestDatabase;
  db: Database;
  service: RecordService;
  a: OrganizationId;
  b: OrganizationId;
  a1: SiteId;
  a2: SiteId;
  b1: SiteId;
  root: UserId;
  /** Site manager of A1 (definitions, publish on A1). */
  manager: UserId;
  /** Cataloger on A1. */
  cataloger: UserId;
  /** Read-only on A1. */
  reader: UserId;
  /** Cataloger on A2 only. */
  other: UserId;
  /** Cataloger in B (site B1) only. */
  stranger: UserId;
  /** Donor relations on A1: no catalog record permission (D-072). */
  donor: UserId;
  /** Makes (or reuses, by name) an invented person and adds them to the organization. */
  member: (organizationId: OrganizationId, name: string) => Promise<UserId>;
}

async function catalog(db: Database, org: OrganizationId): Promise<void> {
  for (const [key, kind] of [
    ["t-unit", "archival_unit"],
    ["t-asset", "digital_asset"],
  ] as const) {
    ok(
      await insertTemplateVersion(db, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [kind],
        fields: [field("rights", "rights")],
      }),
    );
  }
  ok(
    await insertTemplateVersion(db, {
      key: "t-object",
      organizationId: org,
      label: "Object",
      appliesTo: ["object"],
      fields: OBJECT_FIELDS,
    }),
  );
  ok(
    await db.transaction((q) =>
      insertIdentifierType(q, {
        organizationId: org,
        key: "object_number",
        label: "Object number",
        uniqueness: "all_time",
      }),
    ),
  );
}

/** Builds the world; `serviceOptions` reach `createService`. */
export async function makeWorld(
  serviceOptions: Parameters<typeof createService>[1] = {},
): Promise<World> {
  const testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  const db = openDatabase(testDb.url, { max: 6 });
  const service = createService(db, serviceOptions);
  const a = newOrganizationId();
  const b = newOrganizationId();
  ok(await insertOrganization(db, { id: a, name: "Invented Archive" }));
  ok(await insertOrganization(db, { id: b, name: "Invented Library" }));
  await catalog(db, a);
  await catalog(db, b);
  const folks = await people(db, b);
  const root = folks.root;
  const a1 = await makeSite(service, root, a, "Invented archive site");
  const a2 = await makeSite(service, root, a, "Invented second site");
  const b1 = await makeSite(service, root, b, "Invented library site");
  const manager = await folks.member(a, "Manager");
  const cataloger = await folks.member(a, "Cataloger");
  const reader = await folks.member(a, "Reader");
  const other = await folks.member(a, "Other");
  const stranger = await folks.member(b, "Stranger");
  const donor = await folks.member(a, "Donor");
  await grant(service, root, a, { userId: manager, role: "site_manager", siteId: a1 });
  await grant(service, root, a, { userId: cataloger, role: "cataloger", siteId: a1 });
  await grant(service, root, a, { userId: reader, role: "read_only", siteId: a1 });
  await grant(service, root, a, { userId: other, role: "cataloger", siteId: a2 });
  await grant(service, root, b, { userId: stranger, role: "cataloger", siteId: b1 });
  await grant(service, root, a, { userId: donor, role: "donor_relations", siteId: a1 });
  return {
    testDb,
    db,
    service,
    a,
    b,
    a1,
    a2,
    b1,
    root,
    manager,
    cataloger,
    reader,
    other,
    stranger,
    donor,
    member: (organizationId, name) => folks.member(organizationId, name),
  };
}

/** A session waiting for its second step (grants nothing). Returns its token. */
export async function pendingSession(
  db: Database,
  userId: UserId,
  organizationId: OrganizationId,
): Promise<{ token: string; sessionId: string }> {
  const token = newSessionToken();
  const id = newSessionId();
  await db.execute(sql`
    INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
      created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds, expires_at)
    SELECT ${id}::uuid, ${hashSessionToken(token)}, ${userId}::uuid, ${organizationId}::uuid,
      'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
    FROM (SELECT clock_timestamp() AS t) c`);
  return { token, sessionId: id };
}

const keys = testKeyring();
const factors = new Map<UserId, TestFactor>();
let sources = 0;

/**
 * A full session in `organizationId`, through the real second step (T-038,
 * D-077): the person is given a test factor once (as the owner), then each
 * session waits for its second step and is completed with one of their
 * recovery codes. Returns its token.
 */
export async function fullSession(
  db: Database,
  userId: UserId,
  organizationId: OrganizationId,
): Promise<{ token: string; sessionId: string }> {
  let factor = factors.get(userId);
  if (factor === undefined) {
    factor = await giveTestFactor(db, keys, userId, 20);
    factors.set(userId, factor);
  }
  const code = factor.codes.pop();
  if (code === undefined) throw new Error("out of test recovery codes");
  const waiting = await pendingSession(db, userId, organizationId);
  sources += 1;
  const done = await completeSecondStep(db, keys, waiting.token, {
    recoveryCode: code,
    // A private range (RFC 1918), one address per sign-in.
    source: `10.42.${String(Math.floor(sources / 250))}.${String(1 + (sources % 250))}`,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  return { token: done.token, sessionId: done.session.sessionId };
}

/**
 * Moves a session's times back by `seconds` (as the owner, with the change
 * triggers off inside this transaction only and back on ALWAYS before it
 * commits, D-067), so it has expired.
 */
export async function ageSession(db: Database, sessionId: string, seconds: number): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER sessions_check_change`);
    await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER zzzz_sessions_keep_identity`);
    await q.execute(sql`
      UPDATE public.sessions SET
        signed_in_at = signed_in_at - make_interval(secs => ${seconds}),
        created_at = created_at - make_interval(secs => ${seconds}),
        rotated_at = rotated_at - make_interval(secs => ${seconds}),
        password_at = password_at - make_interval(secs => ${seconds}),
        second_step_at = second_step_at - make_interval(secs => ${seconds}),
        expires_at = expires_at - make_interval(secs => ${seconds}),
        last_seen_at = last_seen_at - make_interval(secs => ${seconds})
      WHERE id = ${sessionId}::uuid`);
    await q.execute(sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_change`);
    await q.execute(
      sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER zzzz_sessions_keep_identity`,
    );
  });
}

/** An object draft for the test template. */
export function objectDraft(
  title = "An invented lantern",
  fields: Record<string, unknown> = { rights: { uri: INC }, note: "Tin.", secret: "Back room." },
) {
  return { kind: "object", title, templateKey: "t-object", fields };
}

/** Makes an object on `siteId` as the system manager, through the service. */
export async function makeObject(
  world: World,
  organizationId: OrganizationId,
  siteId: SiteId,
  title?: string,
): Promise<{ id: string; version: number }> {
  const saved = ok(
    await world.service.createRecord(
      { organizationId, actor: actorOf(world.root), siteId },
      objectDraft(title),
    ),
  );
  return { id: saved.record.id, version: saved.version };
}

/** Makes a record from `draft` on `siteId` as the system manager; returns its ID. */
export async function makeAs(
  world: World,
  organizationId: OrganizationId,
  siteId: SiteId,
  draft: Record<string, unknown>,
): Promise<string> {
  const saved = ok(
    await world.service.createRecord({ organizationId, actor: actorOf(world.root), siteId }, draft),
  );
  return saved.record.id;
}

/** Publishes a record (at version 1) as the system manager. */
export async function publishAs(
  world: World,
  organizationId: OrganizationId,
  recordId: string,
  version = 1,
): Promise<void> {
  ok(
    await world.service.publish({ organizationId, actor: actorOf(world.root) }, recordId as never, {
      expectedVersion: version,
    }),
  );
}

export { actorOf };

/** One unused recovery code of a person who already has a test factor (T-048: an admin's own code). */
export function spareRecoveryCode(userId: UserId): string {
  const code = factors.get(userId)?.codes.pop();
  if (code === undefined) throw new Error("no test factor or no codes left");
  return code;
}

/**
 * Moves a whole session back by `seconds` (sign-in, password entry, last
 * use and end alike, so it stays live), so its password entry is no longer
 * "recent" (D-069: 10 minutes).
 */
export async function staleReauth(db: Database, sessionId: string, seconds: number): Promise<void> {
  await ageSession(db, sessionId, seconds);
}
