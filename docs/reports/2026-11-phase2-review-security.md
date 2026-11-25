# T-053 Phase 2 review — security half

Reviewer: security (Chat A). Code: the review worktree at main 6be4a8f. Scope: security across all of Phase 2, looking for gaps *between* features. A second reviewer covers data integrity and operations.

Method: read the code across core, db, service, api and admin, plus the migrations' definer functions. I wrote one proof-of-concept test against a throwaway PostgreSQL 16 (socket only, own TMPDIR, stopped by its PID), and ran one microbenchmark of the rate limiter. Scratch copy `/tmp/t053a-sec` and `/tmp/t053a-pg` are deleted. Nothing committed; the full gate was not run.

## Summary

| Severity | Count |
|---|---|
| BLOCKING | 0 |
| MEDIUM | 2 (both still latent: neither is reachable over HTTP yet) |
| LOW | 7 |
| Functional gap seen in passing | 1 |

No route, list or count leaked another organization's or another site's catalog data in what I checked. The HTTP layer, the public read path and the session/second-step core are strong. Both MEDIUM findings are in accessions and donor contacts (T-018c, D-114), which landed on 2026-11-25. They don't follow the per-site rule (D-074) that every other catalog feature follows.

---

## BLOCKING

None found.

---

## MEDIUM

### M1. Deleting a donor contact skips the site check that saving one has

- **Area:** authorization, a rule applied in one place but not another (T-018c, D-114).
- **Where:** `packages/service/src/accessions.ts`
  - `saveDonorContact` (about lines 497–560) calls `mayName(tx, org, access, [agentId])`. That needs `donors.edit` for the whole catalog of the agent's home site.
  - `deleteDonorContact` (about lines 562–580) checks only `allowed(tx, who, "donors.edit")`, which means donors.edit from a grant on **any** site. It never calls `mayName`.
- **Repro (PoC test, run and passing):**
  - Setup: organization with sites A1 and A2. `donor_relations` granted on A1 only. The system manager creates an agent on A2 and saves its contact (version 1).
  - As the A1 person:
    - `saveDonorContact(agent)` → `not_permitted` ("An accession can name only records … of sites where you work with donors").
    - `deleteDonorContact(agent, { expectedVersion: 1 })` → `{ ok: true, deleted: true }`, and the contact is gone.
  - The agent's ID is easy to learn: `listAccessions` shows every accession's `sourceAgent.recordId` organization-wide (see M2). The version is a small counter.
  - Any `site_manager` of any site can do the same, because that role holds `donors.edit`.
- **Impact:** a person on one site can permanently delete another site's donor contact details. D-114 keeps no history for contacts. Not reachable over HTTP yet (no accession routes), but the routes will be thin wrappers and the service "decides every permission".
- **Fix (task, risky):** in `deleteDonorContact`, run `mayName(..., [agentId])` before deleting (as save does), refusing like a missing contact or `not_permitted`. Add an attack test for both delete and save across sites.

### M2. Any site manager reads the whole organization's donor register and can hand that access to any member

- **Area:** organization and site scoping. D-114 conflicts with D-074 and D-072/T-064.
- **Where:**
  - `packages/service/src/accessions.ts`: `holdsDonorPermission` (about line 150). `listAccessions`, `readAccession` and `readDonorContact` read organization-wide for anyone with `donors.view` from a whole-catalog grant on any site.
  - `packages/core/src/permissions.ts`: `ROLE_PERMISSIONS.site_manager` includes every catalog permission, `donors.view` and `donors.edit` among them.
  - `packages/service/src/admin.ts`: `mayManage` and `grantRoleIn` let a site manager grant `donor_relations` on their own site to any member they can see, roleless members included (T-064).
- **Repro (by code, read path confirmed in the PoC):** the A1-only `donor_relations` person read an A2 agent's contact: `readDonorContact` → `{ ok: true, contact: { email … } }`.
  - So a site manager of a small site (for example the Library site) reads every accession of the organization: source agents, materials, restrictions, notes, the IDs of records produced on other sites, and every donor's email, phone and address.
  - They can also give the same access to any roleless member.
  - The service already hides other sites' records in one place: `nowHeld` is filtered by `visible()` to sites where the person holds donors.edit. The list and read operations give it all back.
- **Why MEDIUM, not BLOCKING:** D-114 chose "accessions are the organization's register" on purpose, and nothing is reachable over HTTP yet. But it breaks D-074 ("a person assigned to a site sees only that site's items") for the most sensitive personal data in the system.
- **Fix (task, needs John):** decide whether donor data is per-site. If it is:
  - Filter accessions by their produced records' and source's home sites.
  - Filter contacts by the agent's home site.
  - Or limit organization-wide reads to every-site grants and system managers.
  - Either way, apply `visible()` to `accession.records` and `sourceAgent` in `listAccessions` and `readAccession`.
  - Do this before any HTTP route for accessions is built.

---

## LOW

### L1. Template, Dublin Core mapping and identifier-type changes don't need a recent sign-in
- **Where:** `packages/api/src/staff-api.ts`, `PUT /api/templates/:key` (about line 1255), `PUT /api/templates/:key/dublin-core` (about line 1308) and `PUT /api/identifier-types/:key` (about line 1350). None call `recentSignIn(session)`; nothing in `service/src/definitions.ts` does either.
- **Why it matters:** these can make staff-only fields public on every published record of the organization, or take records off the public sites. A confirmation is asked, but no recent sign-in. Changing the time zone, renaming a site, System settings and file rescans all need one. A stolen system-manager session can expose staff data with no password.
- **Fix (task):** add `recentSignIn(session)` to the three PUTs, or check `notRecent` in the service, at least when the change publishes values or takes records off the public sites. Add tests.

### L2. Rate limiters can be flushed by many keys, and each new key then scans 50,000 entries
- **Where:** `packages/api/src/rate-limit.ts`, `take`/`prune`.
- **Repro (benchmark):**
  - With 50,000 windows held, each new key costs about 0.49 ms (a full scan).
  - A key at its limit (`victim`: 300/300 public reads) was **evicted and reset** after 50,000 other keys.
  - Keys are per IPv4 address or IPv6 /64, so a client with a /48 has 65,536 keys.
- **Impact:** these are brakes only; the database throttles do the real work for sign-in. But the per-address `credentials` brake and the public and OAI brakes can be reset, and a flood buys a small CPU cost on every request.
- **Fix (small task):** evict only ended windows, plus a cheap cap such as an LRU with O(1) eviction. Or don't evict windows that are still limited. Optionally group IPv6 more coarsely (/56 or /48) for the credentials bucket.

### L3. No HSTS header and no documented expectation that the proxy sets it
- **Where:** `packages/api/src/headers.ts` (`SECURITY_HEADERS`), `admin-files.ts` (`ADMIN_SECURITY_HEADERS`). There is no `Strict-Transport-Security`, and DECISIONS doesn't mention it.
- **Impact:** the `__Host-` cookie is Secure, but a first visit over http, or a stripped redirect, can serve a forged admin page on the admin host.
- **Fix (small task):** send `Strict-Transport-Security: max-age=31536000` on admin-origin replies when the admin origin is https. Or document in the deployment notes (T-051) that the proxy must set it.

### L4. `rotateSession` exists but nothing calls it
- **Where:** `packages/db/src/sessions.ts` (about line 818). Its comment says "for any change of what it may do (… T-041's role changes)", but no code calls it.
- **Impact:** small. Permissions are read from the database on every operation, and sign-in, the second step, re-entry and switching organization all issue new tokens. But the comment and ASVS 7.2.4 promise rotation on a privilege change, and it doesn't happen.
- **Fix (small task):** either delete the comment's promise (with a decision note saying why it isn't needed: roles are never cached in the session), or rotate the target's sessions on grant, revoke and enable.

### L5. Ending or disabling a session doesn't stop downloads or uploads already running
- **Where:** `packages/api/src/staff-api.ts`, `readFileRoute` and `counted` (streams last up to `MAX_DOWNLOAD_MS`, 2 h), and the upload route, which checks the session once before streaming. `service.attachFile` checks the actor's roles, not the session.
- **Impact:** after "end sessions" for a compromised account, file streams already running keep going, and an upload in progress still attaches.
- **Fix (small task):** record each stream's session ID. On `endUserSessions`, `endSession` and `setAccountDisabled`, stop that user's streams in this process. Have `attachFile` check that the session is still live.

### L6. A restore brings back ended sessions, used recovery codes and reset links, old passwords and factors, and disabled accounts
- **Where:** `packages/db/src/backup.ts` (D-064): a byte-exact restore with no step afterwards that invalidates anything.
- **Impact:** a restore during incident response (for example after an account takeover) silently brings back whatever the backup held:
  - the stolen password, an authenticator that was reset, and recovery codes already used;
  - sessions that were ended (if still inside their idle and absolute limits);
  - accounts that were enabled at the time of the backup.
- **Fix (task, coordinate with the ops reviewer):** after a restore, raise every user's `sessions_valid_after` (or delete all sessions, password resets and pending invitations). Have the command print that password, factor, role and account changes made since the backup are undone and should be checked.

### L7. Scanners (and catalogers) change what the public sees on published records with no publish permission
- **Where:** `service/src/access.ts`, `editPermissions("digital_asset")` = `records.edit` or `media.attach`. `service.ts` `updateRecord` asks the publish hook only for `confirm_made_public`.
- **This is by design** (D-075 publishes edits once the publish check passes again). But D-036 describes the scanner role as "no descriptions or publishing". A scanner can rewrite a published asset's title and descriptive fields, live at once, and can offer published assets to another organization (`offerRecord` needs the edit rule).
- **Fix:** no code change unless John wants it. Add a line to D-036/D-075 naming this, or make published-record edits by holders without `records.publish` go through review once T-035 exists.

---

## Functional gap seen in passing (not security)

- **Invitations can't be accepted.** The email links to `<admin>/invitation#<token>` (`api/src/mail-messages.ts`, `renderInvitation`). The admin has no `/invitation` route (`admin/src/App.tsx` `ROUTES`), and the API has no route calling `acceptInvitation` or `acceptInvitationForUser`.
- **Suggested task (risky):** an accept route with `credentials: true`, the D-068 no-enumeration rule, and the password rules, plus the screen.

---

## What I checked and found sound

### 1. Sign-in, sessions and their limits
- **Passwords:** hashed with a bounded work queue (`busy`). Unknown addresses get the same reply and cost. Disabled or organization-less accounts get `invalid_credentials`. Bodies are capped at 8 KiB, with 1,024-character fields.
- **Throttles:**
  - per address (IPv6 per /64) and per account, as in D-068;
  - the S-018 known-source allowance applies only after the second step (S-044);
  - every code path (sign-in, set-up, re-entry, admin two-step reset) goes through `checkCode` → `takeCodeAttempt`;
  - the wrong-code alerts and `last_sign_in_at` are stamped only on promotion (S-045, S-053, S-054a).
- **Session fixation:**
  - sign-in issues a fresh token and ends any session the browser already held;
  - promotion (`promoteSession`), re-entry, enrolment and switching organization all issue new tokens;
  - a pending session grants nothing else.
- **Sessions themselves:**
  - `resolveSession` checks the stage, idle and absolute limits on the database's clock, the account being active, `sessions_valid_after` and membership in one statement;
  - background reads (`X-Oculus-Background`) and cross-site requests (`Sec-Fetch-Site`) don't count as use (T-062).
- **Password reset:** the token is in a fragment, single use, and checked again under the user-row lock. Using it ends every session and clears the throttles. Requests always answer 202. Resets sent by an admin need a recent sign-in, plus the D-078 mailbox confirmation.
- **Recent sign-in:** checked from the database (`actingSession`) for people changes, invitations (T-065), update installs and rollbacks, purge, sites, System settings, time zone and rescans. The exception is L1.

### 2. Authorization
- Every staff route resolves a full session, then checks CSRF in constant time before the database is asked, then rate-limits. The service context comes from the session only, and `X-Oculus-Site` is checked through `worksOn` (the site must belong to the organization).
- The service reads access (system manager flag and grants) inside each transaction.
- `permits`:
  - site permissions only with a whole-catalog grant on that site;
  - catalog permissions only for the record's home site;
  - records on no site only for system managers;
  - `sitesSharedInto` stays empty (D-094), so shares never widen `onRecord`.
- **Lists and counts:**
  - search, `listItems` and the review queue use `wholeSites`;
  - the audit trail filters by site in SQL, deleted records are system-only, and system events are for system managers only;
  - the people list and person pages use `visibleMember` and `holdsRoleOn` (S-042, S-050);
  - `public-subjects` staff status is for managers of that site only.
- **Shares (T-041c–f, S-036, S-048, S-050):**
  - offers are only of published records, to a site that exists, never the record's home site;
  - another organization's share is the same `unknown_share`;
  - accept and decline need `site.settings` on the second site;
  - views are built with `publicRecordIn` and the home mapping, so accession holds apply.
- **Files:**
  - every read goes through `mayChange(... "share", [])`;
  - the file must belong to the asset, and scan state is checked after visibility;
  - thumbnails are cached per organization;
  - uploads check the edit rule, `If-Match` and quota before a byte is read.
- **System-only areas:** updates, purge, file-scan status and rescan, System settings and sites are system managers only, checked in the service.

### 3. The HTTP layer
- **Origin:** every change needs an `Origin` listed in `OCULUS_ORIGINS` and naming the request's own host, or `Sec-Fetch-Site: same-origin`. A public site can't post to the admin. The CSRF token is an HMAC of the session token, sent only in same-origin JSON.
- **Admin origin vs public hosts:** `/api` is answered only on the admin's origin (rule 12, S-049). The admin build is served on the admin origin only. Public routes answer only on hosts listed in `OCULUS_PUBLIC_SITES`. The trusted-proxy ranges are bounded.
- **Headers:**
  - every API reply: CSP `default-src 'none'`, nosniff, no-referrer, no-store;
  - admin CSP: `'self'` only, no inline script;
  - file replies: sandbox CSP, CORP, attachment as octet-stream, inline only for sniffed images within size limits;
  - OAI-PMH goes only through `oaiPmhReply`.
- **Body and upload limits:** 1 MiB JSON, 8 KiB on credentials routes, upload type allowlist and streamed caps, strict parsers.
- **Errors:** fixed codes only, with redacted logging (class name and SQLSTATE). The logger records method and path only, with query strings stripped.
- **Admin screens:** they render shared (other-organization) content as text only. No `innerHTML` or user-built `href`.

### 4. The public side
- **Public reader:** has USAGE on the schema and nothing else. `checkPublicReaderConnection` refuses any definer function the reader can run that isn't on the allowlist (trigger functions excluded).
- **Definer functions:** `public_record_snapshot`, `public_dublin_core_mapping`, `organization_local_day` and `shared_record_home` pin `search_path` and qualify every name.
- **Accepted design, noted:** the snapshot carries staff-only fields of the record and its ancestors to the public reader, and JavaScript filters them. Recorded in the T-034d review; a defence-in-depth gap, not a leak.
- **`/records/:id`** answers `id`, `dublinCore` and `jsonLd` only, with one 404 for every refusal. Shared items are read through the home site's snapshot, so the holds and the mapping are the home site's.
- **OAI-PMH:** stored datestamps (S-041, S-046, S-047), tokens sealed with AES-GCM and bound to the site, every record read again through the public reader.
- **Subject counts:** go through `publicRecordIn` too.
- **Accession holds:** applied in the publish check, public output, OAI, subjects and shared views.

### 5. Secrets and operations
- **Secret key:** required at start; error messages name the variable, never its value. The desktop key file is 0600 and its permissions are checked.
- **Files folder:** 0700, with ownership and mode checks. Files are written 0600, created exclusively, with `O_NOFOLLOW`.
- **Updates (T-060, S-050):**
  - the Ed25519 signature is checked before the manifest is parsed;
  - the archive must hold exactly the manifest's files, with sizes and SHA-256;
  - zip entry names are restricted (no absolute paths, `..`, device names or links);
  - only newer versions install;
  - the updates folder and `releases/` are 0700, `state.json` 0600, logs owner-only;
  - John's decision (D-092) keeps the owner's database URL off the running server.
- **Backups:** written 0600 as a temp file, then linked into place; the connection goes through a service file and a pgpass, never the command line.
- **Thumbnail decoder:** a child process with an empty environment.
- **Desktop launcher:** listens on 127.0.0.1 only, with admin origin set to `http://127.0.0.1:<port>`, so DNS rebinding gets the `/api` 404 and fails the Origin check. The instance proof is host-checked. `OCULUS_TRUSTED_PROXY` is cleared. In development mode the mail sender logs the message kind only.

