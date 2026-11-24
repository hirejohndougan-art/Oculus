/**
 * Invented people for the service's tests (T-041): the install's first
 * system manager, members made through real invitations (D-068), sites and
 * role grants made through the service itself. Every address is at
 * example.org and every name is invented.
 */
import {
  newRecordId,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  acceptInvitation,
  acceptInvitationForUser,
  createFirstSystemAdmin,
  createInvitation,
  type Database,
  type InvitationMessage,
} from "@oculus/db";
import type { RecordService, ServiceResult } from "./service.js";

/** A password the checks accept (invented; long, not a common one). */
export const TEST_PASSWORD = "Invented river bend lantern 2026";

function ok<T>(result: Validated<T> | ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

export interface People {
  /** The install's first system manager. */
  readonly root: UserId;
  /** Makes (or reuses, by name) a person and adds them to the organization. */
  member(organizationId: OrganizationId, name: string): Promise<UserId>;
  /** A person with an account (made for another organization first) but not in this one. */
  outsider(name: string): Promise<UserId>;
}

export const actorOf = (userId: UserId): string => `user:${userId}`;

/** Sets up the first system manager in `db` (a fresh database) and returns the helpers. */
export async function people(db: Database, holdingOrganization: OrganizationId): Promise<People> {
  const root = ok(
    await createFirstSystemAdmin(db, {
      email: `root-${newRecordId().slice(0, 8)}@example.org`,
      displayName: "Invented Root",
      password: TEST_PASSWORD,
    }),
  ).userId;
  const known = new Map<string, { userId: UserId; email: string }>();

  async function invite(organizationId: OrganizationId, email: string): Promise<string> {
    const box: InvitationMessage[] = [];
    ok(
      await createInvitation(db, { organizationId, email, invitedBy: root }, (m) => {
        box.push(m);
        return Promise.resolve();
      }),
    );
    const token = box[0]?.token;
    if (token === undefined) throw new Error("not delivered");
    return token;
  }

  async function member(organizationId: OrganizationId, name: string): Promise<UserId> {
    const found = known.get(name);
    if (found !== undefined) {
      const token = await invite(organizationId, found.email);
      const joined = await acceptInvitationForUser(db, {
        token,
        organizationId,
        userId: found.userId,
      });
      if (!joined.ok && joined.issues[0]?.code !== "already_member") {
        throw new Error(JSON.stringify(joined.issues));
      }
      return found.userId;
    }
    const email = `${name.toLowerCase()}-${newRecordId().slice(0, 8)}@example.org`;
    const token = await invite(organizationId, email);
    const made = ok(
      await acceptInvitation(db, {
        token,
        organizationId,
        email,
        displayName: `Invented ${name}`,
        password: TEST_PASSWORD,
      }),
    );
    known.set(name, { userId: made.userId, email });
    return made.userId;
  }

  return {
    root,
    member,
    async outsider(name) {
      return member(holdingOrganization, name);
    },
  };
}

/** A site of the organization, made by the system manager through the service. */
export async function makeSite(
  service: RecordService,
  root: UserId,
  organizationId: OrganizationId,
  name = "Invented public site",
): Promise<SiteId> {
  const site = ok(
    await service.createSite({ organizationId, actor: actorOf(root) }, { organizationId, name }),
  );
  return site.id;
}

/** Grants a role through the service, as the system manager. Returns the assignment ID. */
export async function grant(
  service: RecordService,
  root: UserId,
  organizationId: OrganizationId,
  request: {
    userId: UserId;
    role: string;
    siteId?: SiteId | null;
    scope?: string | null;
  },
): Promise<string> {
  const made = ok(
    await service.grantRole(
      { organizationId, actor: actorOf(root) },
      { siteId: null, scope: null, ...request },
    ),
  );
  return made.id;
}
