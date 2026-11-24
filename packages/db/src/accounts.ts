/**
 * User accounts, invitations and password sign-in (T-036, D-019, D-052,
 * D-068). The tables are `0009_users.sql`'s; the rules are core's
 * (`accounts.ts`, `passwords.ts`, `sign-in-throttle.ts`).
 *
 * - **No public sign-up.** `createFirstSystemAdmin` makes the install's one
 *   bootstrap account while there are no users at all; every other account
 *   comes from `acceptInvitation`, for an invitation a system admin made
 *   with `createInvitation`. A person who already has an account joins
 *   another organization with `acceptInvitationForUser`, which needs their
 *   user ID from a completed sign-in (T-037's session), never from a form.
 * - **Invitations** are bound to one organization and one email address,
 *   stored only as the SHA-256 of their token, single-use, and expire (7
 *   days by default, 14 at most). Every reason an invitation can't be used
 *   (unknown, expired, used, revoked, another organization, another
 *   address, a malformed token) gives the same `invalid_invitation`.
 * - **`signIn`** checks the throttle counters first (one per address typed,
 *   one per client address), counting the attempt up front; then reads the
 *   user and checks the password against its hash, or against the dummy
 *   hash for an unknown address, so both cost one scrypt run and give the
 *   same `invalid_credentials`. A disabled account, one with no access to
 *   the organization asked for, and one with no organization at all are
 *   refused the same way. Success says the second step is still to come
 *   (`secondStep: "required"`, D-052; T-038 builds it): **T-037 must not
 *   give a full session on this result alone.**
 *
 * Who may invite is, until T-041's roles, a system admin (D-019). Every
 * function takes the acting user's ID from the caller's verified session,
 * never from a request.
 */
import {
  ACCOUNT_THROTTLE,
  DEFAULT_INVITATION_SECONDS,
  MAX_INVITATION_SECONDS,
  MIN_INVITATION_SECONDS,
  PasswordWorkBusyError,
  SOURCE_THROTTLE,
  checkNewPassword,
  dummyPasswordHash,
  hashInvitationToken,
  hashPassword,
  isInvitationId,
  isInvitationToken,
  isOrganizationId,
  isPlainObject,
  isUserId,
  newInvitationId,
  newInvitationToken,
  newUserId,
  normalizeEmail,
  passwordText,
  throttleAccountKey,
  throttleAttempt,
  throttleSourceKey,
  validateDisplayName,
  verifyPassword,
  type InvitationId,
  type Issue,
  type OrganizationId,
  type PasswordCheck,
  type ThrottleState,
  type UserId,
  type Validated,
} from "@oculus/core";
import type { Database, Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * What the writer role needs on this module's tables, beyond SELECT on
 * every table (D-068). Part of `WRITER_PRIVILEGES` (roles.ts, D-067). `UPDATE` on `sign_in_throttles` is also what `SELECT … FOR UPDATE`
 * needs. Nothing deletes users, invitations or memberships.
 */
export const ACCOUNT_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  users: Object.freeze(["INSERT", "UPDATE"]),
  invitations: Object.freeze(["INSERT", "UPDATE"]),
  organization_members: Object.freeze(["INSERT"]),
  sign_in_throttles: Object.freeze(["INSERT", "UPDATE", "DELETE"]),
});

/** The longest a typed email may be before the request itself is refused. */
const MAX_TYPED_EMAIL = 1024;
/** The longest a typed password may be (in UTF-16 units) before the request is refused. */
const MAX_TYPED_PASSWORD = 4096;

// ---------------------------------------------------------------------------
// Small helpers

/** An own data property of a plain object, never a getter's result. */
function own(input: unknown, key: string): unknown {
  if (!isPlainObject(input)) return undefined;
  const d = Object.getOwnPropertyDescriptor(input, key);
  return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
}

function hasOnly(input: unknown, keys: readonly string[]): boolean {
  if (!isPlainObject(input)) return false;
  return Reflect.ownKeys(input).every((k) => typeof k === "string" && keys.includes(k));
}

function refused<T>(code: string, message: string, path: (string | number)[] = []): Validated<T> {
  return { ok: false, issues: [{ path, code, message }] };
}

function refusedWith<T>(issues: readonly Issue[]): Validated<T> {
  return { ok: false, issues };
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function constraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { constraint } = error as { constraint?: unknown };
  return typeof constraint === "string" ? constraint : undefined;
}

const RETRYABLE = new Set(["40P01", "40001"]);

/** Runs `work` in a transaction, again (up to 3 times) after a deadlock or serialization failure. */
async function inTransaction<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (attempt >= 3 || !RETRYABLE.has(sqlState(error) ?? "")) throw error;
    }
  }
}

const BUSY_MESSAGE = "Too many sign-ins are being checked right now. Try again in a moment.";

// ---------------------------------------------------------------------------
// The first system admin

/** What `createFirstSystemAdmin` takes. */
export interface FirstSystemAdmin {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

/**
 * Makes the install's first system admin, without an invitation, only while
 * there are no users at all (`already_set_up` otherwise). The database
 * allows one such account ever (`users_one_bootstrap`). For the
 * installation step (T-051); never offer it over HTTP once anyone exists.
 */
export async function createFirstSystemAdmin(
  db: Database,
  input: FirstSystemAdmin,
): Promise<Validated<{ readonly userId: UserId }>> {
  if (!hasOnly(input, ["email", "displayName", "password"])) {
    return refused("invalid_request", "Give the email, name and password only.");
  }
  const email = normalizeEmail(own(input, "email"));
  const displayName = validateDisplayName(own(input, "displayName"));
  const issues: Issue[] = [];
  if (email === undefined) {
    issues.push({
      path: ["email"],
      code: "invalid_email",
      message: "That isn't an email address Oculus accepts.",
    });
  }
  if (displayName === undefined) {
    issues.push({
      path: ["displayName"],
      code: "invalid_display_name",
      message: "A name is 1–200 characters, with no line breaks or spaces at either end.",
    });
  }
  const password = checkNewPassword(own(input, "password"), {
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
  });
  if (!password.ok)
    issues.push(...password.issues.map((i) => ({ ...i, path: ["password", ...i.path] })));
  if (issues.length > 0 || email === undefined || displayName === undefined || !password.ok) {
    return refusedWith(issues);
  }
  const existing = await db.rows(sql`SELECT 1 FROM public.users LIMIT 1`);
  if (existing.length > 0) {
    return refused(
      "already_set_up",
      "This install already has users; new ones need an invitation.",
    );
  }
  let hash: string;
  try {
    hash = await hashPassword(password.value);
  } catch (error) {
    if (error instanceof PasswordWorkBusyError) return refused("busy", BUSY_MESSAGE);
    throw error;
  }
  const userId = newUserId();
  try {
    await inTransaction(db, async (tx) => {
      const any = await tx.rows(sql`SELECT 1 FROM public.users LIMIT 1`);
      if (any.length > 0) throw new AlreadySetUp();
      await tx.execute(sql`
        INSERT INTO public.users (id, email, display_name, password_hash, system_admin, bootstrap)
        VALUES (${userId}::uuid, ${email}, ${displayName}, ${hash}, true, true)`);
    });
  } catch (error) {
    if (error instanceof AlreadySetUp || sqlState(error) === "23505") {
      return refused(
        "already_set_up",
        "This install already has users; new ones need an invitation.",
      );
    }
    throw error;
  }
  return { ok: true, value: { userId } };
}

class AlreadySetUp extends Error {}

// ---------------------------------------------------------------------------
// Invitations

/** What `createInvitation` takes. `invitedBy` comes from the session. */
export interface InvitationRequest {
  readonly organizationId: OrganizationId;
  readonly email: string;
  readonly invitedBy: UserId;
  /** How long it lasts: `MIN_INVITATION_SECONDS` to `MAX_INVITATION_SECONDS`, 7 days by default. */
  readonly expiresInSeconds?: number;
}

/** A new invitation, as the inviter sees it: never its token. */
export interface CreatedInvitation {
  readonly invitationId: InvitationId;
  readonly organizationId: OrganizationId;
  readonly email: string;
  /** In core's form, `2026-11-30T17:05:00.000Z`. */
  readonly expiresAt: string;
}

/** What is handed to the delivery for the invitee: the only place the token goes. */
export interface InvitationMessage {
  readonly email: string;
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Sends an invitation to its address (T-040 builds the email one; tests use
 * a double). Called inside the invitation's transaction, after it is
 * stored: if it throws, nothing is stored and the result is
 * `delivery_failed`. It must not show the token to the inviter.
 */
export type InvitationDelivery = (message: InvitationMessage) => Promise<void>;

/** Whether `userId` is an active system admin, read in `q`. */
async function isActiveSystemAdmin(q: Queryable, userId: UserId): Promise<boolean> {
  const rows = await q.rows<{ ok: boolean }>(sql`
    SELECT system_admin AND disabled_at IS NULL AS ok FROM public.users WHERE id = ${userId}::uuid`);
  return rows[0]?.ok === true;
}

const NOT_PERMITTED = "Only a system admin can do that.";

/**
 * Invites `email` to join `organizationId`. Only an active system admin may
 * invite (`not_permitted`; T-041 adds site managers). Refused for a person
 * already in the organization (`already_member`). Any pending invitation
 * for the same organization and address is revoked, so only the newest
 * link works. The reply never says whether the address has an account in
 * another organization (D-019).
 *
 * **The token never reaches the inviter**: it goes only to `deliver`, for
 * the invitee's mailbox. Otherwise an inviter could open their own link and
 * learn from `acceptInvitation` whether the address has an account (D-068).
 * Invitations for one organization and address are made one at a time (a
 * transaction-level advisory lock, classid 68).
 */
export async function createInvitation(
  db: Database,
  input: InvitationRequest,
  deliver: InvitationDelivery,
): Promise<Validated<CreatedInvitation>> {
  if (typeof deliver !== "function") throw new TypeError("createInvitation needs a delivery.");
  if (!hasOnly(input, ["organizationId", "email", "invitedBy", "expiresInSeconds"])) {
    return refused("invalid_request", "Give the organization, email, inviter and life only.");
  }
  const organizationId = own(input, "organizationId");
  const invitedBy = own(input, "invitedBy");
  const email = normalizeEmail(own(input, "email"));
  const life = own(input, "expiresInSeconds") ?? DEFAULT_INVITATION_SECONDS;
  if (!isOrganizationId(organizationId)) {
    return refused("invalid_request", "That isn't an organization ID.", ["organizationId"]);
  }
  if (!isUserId(invitedBy)) {
    return refused("invalid_request", "That isn't a user ID.", ["invitedBy"]);
  }
  if (email === undefined) {
    return refused("invalid_email", "That isn't an email address Oculus accepts.", ["email"]);
  }
  if (
    typeof life !== "number" ||
    !Number.isInteger(life) ||
    life < MIN_INVITATION_SECONDS ||
    life > MAX_INVITATION_SECONDS
  ) {
    return refused(
      "invalid_life",
      "An invitation lasts from 1 hour to 14 days, given in whole seconds.",
      ["expiresInSeconds"],
    );
  }
  const token = newInvitationToken();
  const invitationId = newInvitationId();
  try {
    return await inTransaction(db, async (tx): Promise<Validated<CreatedInvitation>> => {
      // One at a time per organization and address, so a second invitation
      // waits and then revokes the first instead of failing the unique index.
      await tx.rows(sql`
        SELECT pg_advisory_xact_lock(68, hashtext(${organizationId} || ' ' || ${email}))`);
      if (!(await isActiveSystemAdmin(tx, invitedBy))) {
        return refused("not_permitted", NOT_PERMITTED);
      }
      const org = await tx.rows<{ name: string }>(sql`
        SELECT name FROM public.organizations WHERE id = ${organizationId}::uuid`);
      const organizationName = org[0]?.name;
      if (organizationName === undefined) {
        return refused("unknown_organization", "There is no such organization.", [
          "organizationId",
        ]);
      }
      const member = await tx.rows(sql`
        SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId}::uuid AND u.email = ${email}`);
      if (member.length > 0) {
        return refused("already_member", "That person is already in this organization.", ["email"]);
      }
      await tx.execute(sql`
        UPDATE public.invitations SET revoked_at = now(), revoked_by = ${invitedBy}::uuid
        WHERE organization_id = ${organizationId}::uuid AND email = ${email}
          AND accepted_at IS NULL AND revoked_at IS NULL`);
      const rows = await tx.rows<{ expires_at: string }>(sql`
        INSERT INTO public.invitations
          (organization_id, id, email, token_hash, invited_by, created_at, expires_at)
        VALUES (${organizationId}::uuid, ${invitationId}::uuid, ${email},
                ${hashInvitationToken(token)}, ${invitedBy}::uuid, now(),
                now() + make_interval(secs => ${life}))
        RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`);
      const expiresAt = rows[0]?.expires_at;
      if (expiresAt === undefined) throw new Error("The invitation was not stored.");
      try {
        await deliver({ email, organizationId, organizationName, token, expiresAt });
      } catch {
        throw new DeliveryFailed();
      }
      return { ok: true, value: { invitationId, organizationId, email, expiresAt } };
    });
  } catch (error) {
    if (error instanceof DeliveryFailed) {
      return refused(
        "delivery_failed",
        "The invitation couldn't be sent, so it wasn't made. Try again later.",
      );
    }
    throw error;
  }
}

class DeliveryFailed extends Error {}

/**
 * Revokes a pending invitation of `organizationId` (`unknown_invitation` if
 * it has none by that ID that is still pending). Only an active system
 * admin (`not_permitted`).
 */
export async function revokeInvitation(
  db: Database,
  input: {
    readonly organizationId: OrganizationId;
    readonly invitationId: InvitationId;
    readonly by: UserId;
  },
): Promise<Validated<{ readonly revoked: true }>> {
  const organizationId = own(input, "organizationId");
  const invitationId = own(input, "invitationId");
  const by = own(input, "by");
  if (
    !hasOnly(input, ["organizationId", "invitationId", "by"]) ||
    !isOrganizationId(organizationId) ||
    !isInvitationId(invitationId) ||
    !isUserId(by)
  ) {
    return refused("invalid_request", "Give the organization, invitation and user IDs only.");
  }
  return inTransaction(db, async (tx) => {
    if (!(await isActiveSystemAdmin(tx, by))) return refused("not_permitted", NOT_PERMITTED);
    const n = await tx.execute(sql`
      UPDATE public.invitations SET revoked_at = now(), revoked_by = ${by}::uuid
      WHERE organization_id = ${organizationId}::uuid AND id = ${invitationId}::uuid
        AND accepted_at IS NULL AND revoked_at IS NULL`);
    return n === 1
      ? { ok: true, value: { revoked: true } }
      : refused(
          "unknown_invitation",
          "There is no pending invitation by that ID in this organization.",
        );
  });
}

const INVALID_INVITATION = "This invitation link can't be used. Ask for a new one.";

/** A usable invitation's ID and organization name, or undefined. */
async function usableInvitation(
  q: Queryable,
  tokenHash: Uint8Array,
  organizationId: OrganizationId,
  email: string,
  claimFor?: UserId,
): Promise<{ id: InvitationId; organizationName: string } | undefined> {
  const conditions = sql`
    i.token_hash = ${tokenHash} AND i.organization_id = ${organizationId}::uuid
    AND i.email = ${email} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    AND i.expires_at > clock_timestamp()`;
  const rows =
    claimFor === undefined
      ? await q.rows<{ id: InvitationId; name: string }>(sql`
          SELECT i.id::text AS id, o.name FROM public.invitations i
          JOIN public.organizations o ON o.id = i.organization_id
          WHERE ${conditions}`)
      : await q.rows<{ id: InvitationId; name: string }>(sql`
          UPDATE public.invitations i SET accepted_at = clock_timestamp(), accepted_by = ${claimFor}::uuid
          FROM public.organizations o
          WHERE o.id = i.organization_id AND ${conditions}
          RETURNING i.id::text AS id, o.name`);
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, organizationName: row.name };
}

/** What `acceptInvitation` takes: everything from the invitation form. */
export interface InvitationAcceptance {
  readonly token: string;
  readonly organizationId: OrganizationId;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

/**
 * Makes a new account from an invitation: the token, the organization and
 * the address must all be the invitation's, and it must be pending and
 * unexpired (else `invalid_invitation`, the same for every reason). Then
 * the name and the new password are checked (`invalid_display_name`,
 * core's password issues), whatever the address. Only a complete, valid
 * form learns that the address already has an account (`account_exists`:
 * sign in and use `acceptInvitationForUser`); only the invitee has the
 * token, since `createInvitation` gives it to the delivery alone. The invitation
 * is claimed, and the account and its membership written, in one
 * transaction; two acceptances of one token can't both succeed.
 */
export async function acceptInvitation(
  db: Database,
  input: InvitationAcceptance,
): Promise<Validated<Membership>> {
  if (!hasOnly(input, ["token", "organizationId", "email", "displayName", "password"])) {
    return refused(
      "invalid_request",
      "Give the token, organization, email, name and password only.",
    );
  }
  const token = own(input, "token");
  const organizationId = own(input, "organizationId");
  const email = normalizeEmail(own(input, "email"));
  if (!isInvitationToken(token) || !isOrganizationId(organizationId) || email === undefined) {
    return refused("invalid_invitation", INVALID_INVITATION);
  }
  const tokenHash = hashInvitationToken(token);
  const found = await usableInvitation(db, tokenHash, organizationId, email);
  if (found === undefined) return refused("invalid_invitation", INVALID_INVITATION);
  // The form is checked in full before anything about the address is read,
  // so a bad name or password gives the same answer whether or not the
  // address has an account (D-068).
  const displayName = validateDisplayName(own(input, "displayName"));
  const password = checkNewPassword(own(input, "password"), {
    email,
    organizationName: found.organizationName,
    ...(displayName === undefined ? {} : { displayName }),
  });
  const issues: Issue[] = [];
  if (displayName === undefined) {
    issues.push({
      path: ["displayName"],
      code: "invalid_display_name",
      message: "A name is 1–200 characters, with no line breaks or spaces at either end.",
    });
  }
  if (!password.ok)
    issues.push(...password.issues.map((i) => ({ ...i, path: ["password", ...i.path] })));
  if (displayName === undefined || !password.ok) return refusedWith(issues);
  const exists = await db.rows(sql`SELECT 1 FROM public.users WHERE email = ${email}`);
  if (exists.length > 0) {
    return refused(
      "account_exists",
      "You already have an Oculus account. Sign in, then open the invitation link again.",
    );
  }
  let hash: string;
  try {
    hash = await hashPassword(password.value);
  } catch (error) {
    if (error instanceof PasswordWorkBusyError) return refused("busy", BUSY_MESSAGE);
    throw error;
  }
  const userId = newUserId();
  try {
    return await inTransaction(db, async (tx) => {
      const claimed = await usableInvitation(tx, tokenHash, organizationId, email, userId);
      if (claimed === undefined) return refused("invalid_invitation", INVALID_INVITATION);
      await tx.execute(sql`
        INSERT INTO public.users (id, email, display_name, password_hash, created_by_invitation)
        VALUES (${userId}::uuid, ${email}, ${displayName}, ${hash}, ${claimed.id}::uuid)`);
      await tx.execute(sql`
        INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
        VALUES (${organizationId}::uuid, ${userId}::uuid, ${claimed.id}::uuid)`);
      return { ok: true, value: { userId, organizationId } };
    });
  } catch (error) {
    // Another invitation made an account for this address meanwhile.
    if (sqlState(error) === "23505" && constraintOf(error) === "users_email_key") {
      return refused(
        "account_exists",
        "You already have an Oculus account. Sign in, then open the invitation link again.",
      );
    }
    throw error;
  }
}

/**
 * Adds an existing, signed-in user to the invitation's organization.
 * `userId` must come from a completed sign-in (T-037's session), never
 * from the form. The invitation must be pending, unexpired, of
 * `organizationId` and for the user's own address (else
 * `invalid_invitation`); `already_member` if they are in it already.
 */
export async function acceptInvitationForUser(
  db: Database,
  input: {
    readonly token: string;
    readonly organizationId: OrganizationId;
    readonly userId: UserId;
  },
): Promise<Validated<Membership>> {
  const token = own(input, "token");
  const organizationId = own(input, "organizationId");
  const userId = own(input, "userId");
  if (!hasOnly(input, ["token", "organizationId", "userId"]) || !isUserId(userId)) {
    return refused("invalid_request", "Give the token, organization and user ID only.");
  }
  if (!isInvitationToken(token) || !isOrganizationId(organizationId)) {
    return refused("invalid_invitation", INVALID_INVITATION);
  }
  const tokenHash = hashInvitationToken(token);
  return inTransaction(db, async (tx): Promise<Validated<Membership>> => {
    const users = await tx.rows<{ email: string; disabled: boolean }>(sql`
      SELECT email, disabled_at IS NOT NULL AS disabled FROM public.users
      WHERE id = ${userId}::uuid FOR KEY SHARE`);
    const user = users[0];
    if (user === undefined || user.disabled)
      return refused("invalid_invitation", INVALID_INVITATION);
    const claimed = await usableInvitation(tx, tokenHash, organizationId, user.email, userId);
    if (claimed === undefined) return refused("invalid_invitation", INVALID_INVITATION);
    const inserted = await tx.execute(sql`
      INSERT INTO public.organization_members (organization_id, user_id, invitation_id)
      VALUES (${organizationId}::uuid, ${userId}::uuid, ${claimed.id}::uuid)
      ON CONFLICT (organization_id, user_id) DO NOTHING`);
    if (inserted === 0) {
      // Already in: the claim is rolled back with everything else.
      throw new AlreadyMember();
    }
    return { ok: true, value: { userId, organizationId } };
  }).catch((error: unknown) => {
    if (error instanceof AlreadyMember) {
      return refused<Membership>("already_member", "You are already in this organization.");
    }
    throw error;
  });
}

class AlreadyMember extends Error {}

/** A user's place in one organization. */
export interface Membership {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
}

// ---------------------------------------------------------------------------
// Sign-in

/** What `signIn` takes. `source` is the client address from the HTTP layer (D-058). */
export interface SignInRequest {
  readonly email: string;
  readonly password: string;
  readonly source: string;
  /** If given, the user must have access to this organization. */
  readonly organizationId?: OrganizationId;
}

/** A correct password. The second step (T-038) is still to come. */
export interface SignInSuccess {
  readonly ok: true;
  readonly userId: UserId;
  readonly systemAdmin: boolean;
  /** The organizations the user is a member of, sorted. A system admin may manage any (D-019). */
  readonly organizationIds: readonly OrganizationId[];
  /**
   * Always `"required"` (D-052: two-step sign-in for everyone). T-037 must
   * treat this result as half a sign-in until T-038's check passes.
   */
  readonly secondStep: "required";
}

export type SignInFailure =
  | { readonly ok: false; readonly code: "invalid_credentials"; readonly message: string }
  | {
      readonly ok: false;
      readonly code: "throttled";
      readonly message: string;
      readonly retryAfterSeconds: number;
    }
  | { readonly ok: false; readonly code: "busy"; readonly message: string }
  | { readonly ok: false; readonly code: "invalid_request"; readonly message: string };

export type SignInResult = SignInSuccess | SignInFailure;

/** The one reply for every wrong address, wrong password or account that can't sign in. */
export const INVALID_CREDENTIALS: SignInFailure = Object.freeze({
  ok: false,
  code: "invalid_credentials",
  message: "That email address and password don't match an account that can sign in here.",
});

const INVALID_REQUEST: SignInFailure = Object.freeze({
  ok: false,
  code: "invalid_request",
  message: "Give an email address, a password and the client address.",
});

interface CounterRow {
  key: string;
  failures: number;
  last_ms: number | null;
}

/**
 * Counts this attempt against both counters, or says how long to wait. One
 * short transaction with both rows locked (account key first; every caller
 * locks in key order), so attempts sent at once are counted one by one.
 */
async function takeAttempt(
  db: Database,
  accountKey: string,
  sourceKey: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  for (let attempt = 1; ; attempt++) {
    const decided = await inTransaction(db, (tx) => decideAttempt(tx, accountKey, sourceKey));
    // A counter deleted by the cleanup between the INSERT and the lock: go again.
    if (decided !== "row_gone" || attempt >= 3) {
      return decided === "row_gone" ? { allowed: false, retryAfterSeconds: 1 } : decided;
    }
  }
}

async function decideAttempt(
  tx: Queryable,
  accountKey: string,
  sourceKey: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number } | "row_gone"> {
  {
    await tx.execute(sql`
      INSERT INTO public.sign_in_throttles (key) VALUES (${accountKey}), (${sourceKey})
      ON CONFLICT (key) DO NOTHING`);
    const rows = await tx.rows<CounterRow>(sql`
      SELECT key, failures, (extract(epoch FROM last_failure_at) * 1000)::float8 AS last_ms
      FROM public.sign_in_throttles WHERE key IN (${accountKey}, ${sourceKey})
      ORDER BY key FOR UPDATE`);
    if (rows.length !== 2) return "row_gone";
    const clock = await tx.rows<{ now_ms: number }>(sql`
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms`);
    const now = clock[0]?.now_ms;
    if (now === undefined) throw new Error("The database gave no time.");
    const state = (key: string): ThrottleState | undefined => {
      const row = rows.find((r) => r.key === key);
      return row === undefined ? undefined : { failures: row.failures, lastFailureAt: row.last_ms };
    };
    const account = throttleAttempt(ACCOUNT_THROTTLE, state(accountKey), now);
    const source = throttleAttempt(SOURCE_THROTTLE, state(sourceKey), now);
    if (!account.allowed || !source.allowed) {
      const waits = [account, source].map((d) => (d.allowed ? 0 : d.retryAfterSeconds));
      return { allowed: false, retryAfterSeconds: Math.max(...waits) };
    }
    for (const [key, next] of [
      [accountKey, account.next],
      [sourceKey, source.next],
    ] as const) {
      await tx.execute(sql`
        UPDATE public.sign_in_throttles
        SET failures = ${next.failures}, last_failure_at = to_timestamp(${next.lastFailureAt}::float8 / 1000)
        WHERE key = ${key}`);
    }
    return { allowed: true };
  }
}

/** Takes back an attempt counted up front that was never checked (`busy`). */
async function giveBackAttempt(db: Database, accountKey: string, sourceKey: string): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx.execute(sql`
      UPDATE public.sign_in_throttles SET failures = greatest(failures - 1, 0)
      WHERE key IN (${accountKey}, ${sourceKey})`);
  });
}

interface UserRow {
  id: UserId;
  password_hash: string;
  system_admin: boolean;
  disabled: boolean;
  organization_ids: OrganizationId[];
}

/**
 * Checks an email address and password (D-052, D-068; ASVS 5.0 6.3.1,
 * 6.3.8). In order:
 * 1. The request's shape (`invalid_request`: not text, or absurdly long).
 * 2. The throttle (`throttled`, with `retryAfterSeconds`): the account and
 *    address counters; the attempt is counted now.
 * 3. One query for the user by address, then exactly one scrypt run: the
 *    user's hash, or the dummy hash for an unknown address.
 * 4. `invalid_credentials`, the same reply, for a wrong password, an unknown
 *    address, a disabled account, an account with no organization, and one
 *    without access to `organizationId`.
 * 5. On success: the account counter is cleared, one is taken off the
 *    address counter, the sign-in time is stored, and an old-settings hash
 *    is replaced. `busy` if too many passwords are being checked at once
 *    (the attempt is then not counted).
 */
export async function signIn(db: Database, input: SignInRequest): Promise<SignInResult> {
  if (!hasOnly(input, ["email", "password", "source", "organizationId"])) return INVALID_REQUEST;
  const typed = own(input, "email");
  const password = own(input, "password");
  const source = own(input, "source");
  const organizationId = own(input, "organizationId");
  if (
    typeof typed !== "string" ||
    typed.length > MAX_TYPED_EMAIL ||
    typeof password !== "string" ||
    password.length > MAX_TYPED_PASSWORD ||
    typeof source !== "string" ||
    (organizationId !== undefined && !isOrganizationId(organizationId)) ||
    // Text PostgreSQL can't store (NUL) or that isn't well-formed: refused
    // before anything is read or counted. Neither says anything about an
    // account, so it needs no hash to hide behind.
    typed.includes("\u0000") ||
    passwordText(typed) === undefined ||
    passwordText(password) === undefined
  ) {
    return INVALID_REQUEST;
  }
  // Made once per process, before anything differs between a known and an
  // unknown address, so the first unknown address doesn't pay for it.
  try {
    await dummyPasswordHash();
  } catch (error) {
    if (error instanceof PasswordWorkBusyError)
      return { ok: false, code: "busy", message: BUSY_MESSAGE };
    throw error;
  }
  const normalized = normalizeEmail(typed);
  const accountKey = throttleAccountKey(normalized ?? typed);
  const sourceKey = throttleSourceKey(source);
  const attempt = await takeAttempt(db, accountKey, sourceKey);
  if (!attempt.allowed) {
    return {
      ok: false,
      code: "throttled",
      message: "Too many sign-in attempts. Wait a little and try again.",
      retryAfterSeconds: attempt.retryAfterSeconds,
    };
  }
  // The same query whatever was typed. An address normalizeEmail refuses is
  // looked up as typed and matches nothing, since every stored address is
  // normalized (so no Unicode case folding, such as the Kelvin sign to "k",
  // can reach an account).
  const rows = await db.rows<UserRow>(sql`
    SELECT u.id::text AS id, u.password_hash, u.system_admin, u.disabled_at IS NOT NULL AS disabled,
           ARRAY(SELECT m.organization_id::text FROM public.organization_members m
                 WHERE m.user_id = u.id ORDER BY 1) AS organization_ids
    FROM public.users u WHERE u.email = ${normalized ?? typed}`);
  const user = rows[0];
  let check: PasswordCheck;
  try {
    check = await verifyPassword(password, user?.password_hash);
  } catch (error) {
    if (error instanceof PasswordWorkBusyError) {
      await giveBackAttempt(db, accountKey, sourceKey);
      return { ok: false, code: "busy", message: BUSY_MESSAGE };
    }
    throw error;
  }
  const reachable =
    user !== undefined &&
    !user.disabled &&
    (organizationId === undefined
      ? user.system_admin || user.organization_ids.length > 0
      : user.system_admin || user.organization_ids.includes(organizationId));
  if (!check.ok || user === undefined || !reachable) return INVALID_CREDENTIALS;

  let newHash: string | undefined;
  if (check.needsRehash) {
    try {
      newHash = await hashPassword(password);
    } catch (error) {
      // The sign-in still succeeds; the hash is replaced next time.
      if (!(error instanceof PasswordWorkBusyError)) throw error;
    }
  }
  await inTransaction(db, async (tx) => {
    await tx.execute(sql`DELETE FROM public.sign_in_throttles WHERE key = ${accountKey}`);
    await tx.execute(sql`
      UPDATE public.sign_in_throttles SET failures = greatest(failures - 1, 0)
      WHERE key = ${sourceKey}`);
    await tx.execute(
      sql`UPDATE public.users SET last_sign_in_at = now() WHERE id = ${user.id}::uuid`,
    );
    if (newHash !== undefined) {
      // Only if the hash is still the one checked, so a password changed
      // meanwhile is never put back.
      await tx.execute(sql`
        UPDATE public.users SET password_hash = ${newHash}
        WHERE id = ${user.id}::uuid AND password_hash = ${user.password_hash}`);
    }
  });
  return {
    ok: true,
    userId: user.id,
    systemAdmin: user.system_admin,
    organizationIds: Object.freeze([...user.organization_ids]),
    secondStep: "required",
  };
}

// ---------------------------------------------------------------------------
// Throttle upkeep

/**
 * Clears the account counter for an address typed at sign-in, so a person
 * kept waiting by someone else's guessing can sign in at once. Only an
 * active system admin (`not_permitted`). The address counter is left.
 */
export async function clearSignInThrottle(
  db: Database,
  input: { readonly email: string; readonly by: UserId },
): Promise<Validated<{ readonly cleared: boolean }>> {
  const email = own(input, "email");
  const by = own(input, "by");
  if (
    !hasOnly(input, ["email", "by"]) ||
    typeof email !== "string" ||
    email.length > MAX_TYPED_EMAIL ||
    !isUserId(by)
  ) {
    return refused("invalid_request", "Give the email address and the user ID only.");
  }
  return inTransaction(db, async (tx) => {
    if (!(await isActiveSystemAdmin(tx, by))) return refused("not_permitted", NOT_PERMITTED);
    const n = await tx.execute(sql`
      DELETE FROM public.sign_in_throttles WHERE key = ${throttleAccountKey(email)}`);
    return { ok: true, value: { cleared: n > 0 } };
  });
}

/**
 * Deletes counters that no longer matter: no failure for longer than the
 * longest reset time (24 hours), or none at all. For the cleanup command
 * any scheduler runs (T-037, D-035). Returns how many went.
 */
export async function deleteExpiredSignInThrottles(db: Queryable): Promise<number> {
  const hours = Math.max(ACCOUNT_THROTTLE.resetAfterSeconds, SOURCE_THROTTLE.resetAfterSeconds);
  return db.execute(sql`
    DELETE FROM public.sign_in_throttles
    WHERE failures = 0 OR last_failure_at IS NULL
       OR last_failure_at < clock_timestamp() - make_interval(secs => ${hours})`);
}
