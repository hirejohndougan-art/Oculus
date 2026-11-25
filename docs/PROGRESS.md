# Progress

One entry per run, newest at the top. Format: see [AUTOPILOT.md](AUTOPILOT.md).

## 2026-11-25 04:30 CT — Chat B — T-041d, T-041e, T-060a, T-063
- Result: done (T-041b continues as T-041f, sharing on the public sites)
- What changed: T-041d, shares over HTTP (`staff-api.ts`: a record's shares and offering it, a share's view and its four moves, a site's offers and shared items; an unknown share answers the same 404 as another organization's). T-041e, shares in the admin (`packages/admin/src/shares/`: a record's Sharing panel, each site's Shared with this site screen, a read-only view). T-060a, installs and rollbacks in the change log (migration 0030 `system_events`, written after each switch, shown to system managers only). T-063, the approval queue for reviewers who cover part of a site (John's Q-7: `recordsInState` walks scoped grants' subtrees in SQL).
- Decisions: D-094 (HTTP and admin bullets), D-104, D-082 amended
- Review: independent rounds for T-041d (tests and docs claimed more than they checked; fixed), T-041e (double submits, silent results, focus, a share under the wrong site; fixed) and T-060a (a possible hang after a command-line install, the change log before state.json; fixed). T-063 is tested equal to core's `permits` for every record, with a negative control.
- Gate: PASS · tests_passing 4695 (was 4666) · npm audit clean
- Next: every job in the pool is taken; Chat B stops.

## 2026-11-25 02:45 CT — manual (Chat G) — T-050e Dublin Core mappings in the admin and in setup
- Result: done
- What changed: new screen Settings › Templates › Dublin Core (`packages/admin/src/settings/DublinCoreEditor.tsx`, linked from each template) saving through `GET`/`PUT /api/templates/:key/dublin-core` with If-None-Match/If-Match and D-076's confirmation; `npm run setup` stores the starter template's mapping (public fields as their `dcterms` standards, rights included) in its transaction; the record editor says when the template has no mapping that fits it, so no public site shows the record. Unit tests for the screen, the record editor's note and setup; the settings e2e visits the new screen with Alfa's rules.
- Decisions: none new (D-096 amended)
- Review: one independent round, nothing blocking. Fixed: the warning missed a mapping naming a field since made staff only; "Saved." could show for another template; the note named only system managers; D-096's "left for later" line. Filed S-039 (a first mapping for over 10,000 published records; saving an empty mapping).
- Gate: see the merge commit · npm audit clean
- Next: the job pool (T-034e is the first free job)

## 2026-11-25 03:30 CT — manual (Chat D) — T-034e, T-064, T-065, S-032, S-029
- Result: done (merged together)
- What changed: **T-034e** each organization's time zone (migration 0029) and its own calendar day in the publish check and public output, through `organization_local_day`; `GET`/`PUT /api/organization/time-zone`. **T-064** (John, Q-10) site managers see role-less members by name only and grant only to people holding a role on their sites. **T-065** (John, Q-11) inviting needs a recent sign-in. **S-032** a too-large `If-Match` version is 400. **S-029** the deadlock test not reproduced in 270+ rounds under load; notes in the roadmap.
- Decisions: D-103; D-084 amended (T-064, T-065)
- Review: T-034e two independent rounds, nothing blocking (canonical zone names, failing closed on an unknown stored zone, who changed it). T-064 two rounds: the first found a manager of every site could grant to (and so reveal) someone holding only an every-site role, fixed with one shared rule and tests, and a read race fixed; the second found nothing blocking.
- Gate: PASS · tests_passing 4651 (was 4624) · npm audit clean · licences all permissive
- Next: the next free job on the board

## 2026-11-25 02:40 CT — manual (Chat E) — T-034d Public subject counts
- Result: done
- What changed: `publicTermCounts` (packages/db/src/public-terms.ts) counts, for one site, the controlled terms each public record shows in its own public output (one Repeatable Read snapshot; records the output refuses count for nothing), on the server's staff connection; only labels, URIs and counts come out; at most 10,000 records and a time limit. `readPublicRecord`'s work is shared as `publicRecordIn` (stored mappings included). Never from `record_terms`. Follow-up S-038 (a cached public Subjects page).
- Decisions: D-095
- Review: two independent rounds. Round 1 (fixed): the first design gave the public reader a function listing every published record (migration 0023, now gone), which would have handed out the IDs of held-back records whose snapshots carry staff values; a records count that included held-back records; vocabulary keys and term hashes in the result; no time limit. Round 2 (fixed): terms told apart by what the public sees; a hard time ceiling; tests for held-back records and stored mappings. Caching left to S-038.
- Gate: PASS · tests_passing 4624 (was 4618) · npm audit clean
- Next: S-038 (after T-050d), or the next free job on the board

## 2026-11-25 03:10 CT — manual (Chat C) — S-033 Identifier type edits list the records a new format drops
- Result: done
- What changed: `saveIdentifierType` lists the published records a new format takes off public sites and needs `confirmDropped` naming exactly them; `droppedFromPublic` in the reply; `PUT /api/identifier-types/:key` passes `confirmDropped` (409 `drops_published_records`); `readRecordsForChecks` exported from `@oculus/db`.
- Decisions: D-091 amendment
- Review: one independent round, nothing blocking; fixed an undercounting message, a confirmation that could skip the list (now tied to the exact IDs), and per-record reads under the type's lock.
- Gate: PASS (T-050d and S-033 merged together) · tests_passing 4618 (was 4611) · npm audit clean
- Next: T-050c (OAI-PMH)

## 2026-11-25 02:00 CT — manual (Chat C) — T-050d Public record reads
- Result: done
- What changed: `packages/api/src/public-api.ts` (`GET /records/:id` on public hosts, mounted by `buildAdminServer` when public sites are configured); a `public` rate bucket.
- Decisions: D-100
- Review: one independent round, nothing blocking; fixed the public pool filling under many slow reads (a cap on reads at once, IPv6 counted by /64), the log line, and D-100's wording; S-037 filed (time limits on the reader pool).
- Gate: PASS (T-050d and S-033 merged together) · tests_passing 4618 (was 4611) · npm audit clean
- Next: T-050c (OAI-PMH) or T-050e

## 2026-11-25 01:55 CT — Chat B — T-041c Shares: storage and the service (part of T-041b)
- Result: done (T-041b continues as T-041d to T-041f)
- What changed: migration 0024 (`record_shares`), `packages/db/src/shares.ts`, `publishedRecordView` (workflow.ts), `packages/service/src/shares.ts`: offer a published item to another site (any organization's), accept, decline, remove (the second site's manager), withdraw (home), lists, and a read-only view for the second site that is what the public could see, never through the record's own checks.
- Decisions: D-094
- Review: three independent rounds (the third found no leak). Fixed: the view copied raw values (links, rights notes, non-public numbers) and showed unpublished items; it then skipped public output's gates (home site, publish check, one snapshot); lock order; withdraw vs delete; moves onto the second site; concurrent offers; locking another organization's shares; trigger gaps; hidden shares filling lists; view errors thrown instead of refused. Left as S-036.
- Gate: PASS · tests_passing 4611 (was 4591) · npm audit clean
- Next: T-041d (shares over HTTP), then T-041e.

## 2026-11-25 01:00 CT — manual (Chat D) — S-034a and S-034b Desktop follow-ups, parts one and two
- Result: done (S-034 stays open for its other items)
- What changed: S-034a: `exec.cmd` at the root and in packages/db (npm's `exec node …` scripts start under cmd.exe), `npm run desktop:password` (the ordinary reset with the console as the mailbox), launcher exit code 4 for "already starting/busy". S-034b: a `direct` tool runner for pg_dump/pg_restore where there's no `sh` (Windows; the POSIX watchdog unchanged), tools found in `%ProgramFiles%\\PostgreSQL\\<major>\\bin`, and the desktop backs up before every update that changes the database (fails closed; Ctrl+C stops it cleanly).
- Decisions: D-099, D-102
- Review: one independent round each. S-034a: busy also exits 4; wording. S-034b: nothing blocking; fail closed when the change list can't be read, signal handling for the pre-update backup, reasons on every failure. Filed: a rare restore hang at a chunk boundary (both runners, pre-existing) and pruning old backups (S-034 items 12, 13).
- Gate: PASS · tests_passing 4591 (was 4580) · npm audit clean
- Next: T-034e (Chat D, in review)

## 2026-11-24 22:45 CT — manual (Chat F) — T-060 Updates from an uploaded package
- Result: done
- What changed: a strict ZIP reader and writer, signed packages (Ed25519 over a manifest of every file's SHA-256), `npm run release` (keygen, pack, verify, first install), an updates folder with releases, `current`, backups and history, staff API routes under `/api/system/update` (system managers; install and rollback need a fresh entry), and the admin's Updates screen with chunked upload and progress. Tried end to end in the sandbox: a 6.5 MB, 4,003-file package of this build installed into an empty folder, migrated a fresh database and started from `current`.
- Decisions: D-092
- Review: one independent round. Two blocking findings fixed: migrations ran with the app's writer URL (now an owner URL given only to the backup, migrate and new grant steps, which re-grants the writer after migrating; without it, database-changing updates are refused from the admin) and the release scripts did nothing when the updates folder's path held a link (now started by real paths). Also fixed: an atomic lock file removed only by its holder, one part written at a time, the screen retrying parts when rate-limited, failed steps' output kept in `logs/`, leftovers and old backups removed, no local extra fields, the writer's entry limit, bookkeeping after the switch no longer reported as a failure.
- Gate: PASS (full gate, end-to-end included, after the review fixes) · tests_passing 4580 (was 4420) · npm audit clean
- Next: T-060a filed (the change log); T-051 notes added for SiteGround. Renumbered twice: T-056/D-088 went to the desktop launcher and T-058 to IIIF while this was built.

## 2026-11-25 00:40 CT — manual (Chat C) — T-050b Stored Dublin Core mappings
- Result: done (the old T-050b split into T-050b, T-050d and T-050e)
- What changed: migration 0022 (`dublin_core_mappings`, `public_dublin_core_mapping`); `packages/db/src/dublin-core-mappings.ts`; `readPublicRecord` uses the stored mapping when none is passed; service `readDublinCoreMapping`/`saveDublinCoreMapping`; `GET`/`PUT /api/templates/:key/dublin-core`.
- Decisions: D-096
- Review: one independent round, nothing blocking; fixed a mapping without rights taking records offline, the full record read under the lock, the version check passable by direct SQL, and two stale comments.
- Gate: PASS · tests_passing 4420 (was 4411) · npm audit clean. Migration renumbered 0022 at merge (main stopped at 0021).
- Next: T-050d (public record reads)

## 2026-11-25 00:35 CT — manual (Chat E) — S-026 Publish check for ID number formats
- Result: done
- What changed: the publish check (`publishCheckIssues`) runs the public output's own template check (`publicTemplateIssues`, new in core), so a public ID number that no longer fits its type's changed format fails it (`format_mismatch`, fixed text) instead of the record passing and quietly dropping off the public sites; `identifierTypeChanges` takes `existing.published` and lists on `format_changed` the published records that would show as not available. Tests in core and against the database (publish check, public output, the fix path, inherited numbers). Follow-up S-033 (the service-side confirmation).
- Decisions: D-091
- Review: one independent round. Fixed: records that only inherit a misfit number were listed as going offline (they stay public without it; now tested against `readPublicRecord`); an error code; D-091 now says the publish check applies every template-check refusal. The missing service confirmation is S-033.
- Gate: PASS · tests_passing 4411 (was 4405) · npm audit clean
- Next: T-034d (public subject counts, Chat E)

## 2026-11-25 00:15 CT — manual (Chat D) — T-057 Desktop database helper
- Result: done
- What changed: `npm run desktop:database` makes `oculus_owner`, `oculus_app` and the `oculus` database on the person's own PostgreSQL with the `postgres` password typed once (SCRAM verifiers, never plain passwords), keeps the passwords only in pgpass, writes `desktop.json` and runs setup; resumes an unfinished setup; undoes a failed creation. The launcher migrates as the owner, grants and checks the writer, and serves as the writer. `start-oculus.cmd` runs the helper the first time. `@oculus/db` exports `createDatabase`, `dropDatabase`, `runSetupCli`, `terminalAsk`.
- Decisions: D-093
- Review: two independent rounds; fixed the stuck unfinished setup, leftover pgpass lines, a non-UTF-8 pgpass being damaged, query keys overriding the new addresses, and the pre-grant check that would have refused a correct writer after an update. Left as S-034 (9, 10).
- Gate: PASS · tests_passing 4405 (was 4391) · npm audit clean
- Next: S-034 (desktop follow-ups), or the job pool

## 2026-11-24 22:20 CT — manual (Chat C) — T-050a Hosts for the admin and the public sites
- Result: done (T-050 split into T-050a to T-050c)
- What changed: server rule 12, `/api` on the admin's host only; `OCULUS_ADMIN_ORIGIN` required in production; `OCULUS_PUBLIC_SITES` and the public reader pool (`OCULUS_PUBLIC_DATABASE_URL`, `publicDb`) checked at startup. New `packages/api/src/public-sites.ts`.
- Decisions: D-090
- Review: one independent round, nothing blocking; fixed the admin's hostname on another port passing as a public site, a site ID held by two organizations, a reader of another database, and shutdown closing only one pool; added an https-behind-proxy test.
- Gate: PASS · tests_passing 4391 (was 4376) · npm audit clean. Main then moved by roadmap text only (4 lines); merged, with the format and lint checks re-run. A first run timed out once in `second-factor.test.ts` › "locks user rows before factor rows" under load (passes alone 3 of 3; this change doesn't touch the database package), like S-029.
- Next: S-026 (T-050b needs stored Dublin Core mappings first)

## 2026-11-24 22:15 CT — Chat B — S-030 Regression tests for restore's retry path
- Result: done
- What changed: four tests that save a record from another session just before a restore takes its row lock: retry after the attempts with nothing written, success on the next attempt, a conflict when it keeps moving, and 503 `retry` over HTTP followed by a restore that goes through. Checked that they fail without the retry check.
- Decisions: none
- Review: n/a (not risky; tests only)
- Gate: PASS · tests_passing 4376 (was 4372) · npm audit clean
- Next: the next job in the work board's pool.
## 2026-11-24 21:20 CT — Chat B — M-001 Serve active file types safely
- Result: done
- What changed: `fileReply` (packages/api/src/file-replies.ts) is the only way a handler sends a file's bytes: plain images, audio and video may be shown as their bare type, everything else (HTML, SVG, XML, scripts, PDF, unknown) downloads as `application/octet-stream`; every file reply has nosniff, a sandboxing CSP, same-origin CORP and nothing the handler set; safe RFC 6266/8187 names; streams opened only when sent, outside the handler timeout, within a 2-hour deadline, closed on errors, wrong lengths, hang-ups and shutdown; HEAD opens nothing. HTTP attack tests and a Chromium test that a page on another origin can't run an HTML, SVG or XHTML file's script.
- Decisions: D-089
- Review: three independent rounds plus a short fourth look. Fixed: a storage error or an object-mode stream could crash the server, downloads were cut at 30 s, sources leaked on abort, wrong lengths and failed handlers, HEAD read whole files, a missing file dropped the connection, failures were logged as hang-ups, shutdown could be held, name details. Left as S-035 (download limits per client).
- Gate: PASS · tests_passing 4372 (was 4344) · npm audit clean
- Next: the next job in the work board's pool (S-026).

## 2026-11-24 22:40 CT — manual (Chat D) — T-056 Desktop launcher
- Result: done
- What changed: `npm run desktop` and `scripts/start-oculus.cmd` run the admin on 127.0.0.1 in an Edge or Chrome app window with its own profile, stopping when the window closes; settings, a 0600 secret key and a single-instance lock in the per-user settings folder; `extraRoutes` on `buildAdminServer`; docs/DESKTOP.md (Windows guide). John chose to stay inside D-002 (no Electron, no bundled PostgreSQL). Smoke-tested with a real Chrome under Xvfb: sign-in screen in the window, server stopped on close.
- Decisions: D-088
- Review: three independent rounds. Fixed: server left running after a failure after listen; stale and reused-PID locks (now an HMAC challenge to the running server, whole-file lock, rename takeover, busy is not stale); a new key over sealed two-step secrets or a wrong key (refused, revoked set-ups ignored); weak Origin test; SIGHUP/SIGBREAK; npm ci after updates; Windows setup step (`exec` in npm scripts). Left as S-034.
- Gate: PASS · tests_passing 4344 (was 4292) · npm audit clean
- Next: T-057 (desktop database helper, Chat D)

## 2026-11-24 21:10 CT — manual (Chat A) — T-040 Sending password reset email
- Result: done
- What changed: `packages/api` mail-messages, mail-outbox and mail (SMTP, STARTTLS required, development sender refused in production); reset links, set-up codes and invitations by email, wired into T-048's hooks; the second-step alert notices (migration 0021, one summary per admin per run, longer retries, alerts listed on the Person page and in the frame); the password-changed notice.
- Decisions: D-085
- Review: one independent round, no blocking issue; fixed alert loss under credential stuffing and short outages, TLS failure classes, close() deadline, first-send expiry, TLS option order, address-only admin summaries.
- Gate: PASS · tests_passing 4292 (was 4261, with T-048a merged) · npm audit clean
- Next: M-002 (finishing), M-003

## 2026-11-24 21:05 CT — manual (Chat C) — T-048a Admin: System settings
- Result: done
- What changed: System settings for system managers (sidebar "System" group, `/settings`): Sites (list, add, rename), Templates (list and a field editor through the existing template PUT with its confirmations), Sign-in rules. API: `POST /api/sites`, `PUT /api/sites/:id`, `GET`/`PUT /api/system-settings`, each change behind a recent sign-in answered with T-048's re-entry form. HTTP, screen and e2e tests (Alfa on each settings screen).
- Decisions: D-087
- Review: one independent round, nothing blocking; fixed confirmations arriving published-records-first (the first answer is now kept) and two wordings; S-032 filed (huge If-Match versions answer 422).
- Gate: PASS · tests_passing 4239 (was 4208) · npm audit clean
- Next: M-001

## 2026-11-24 20:15 CT — Chat B — T-055 First-time setup command
- Result: done
- What changed: `npm run setup` migrates an empty database and makes the first system admin (two-step set-up at first sign-in), organization, site and a starter `Item` template in one transaction; refuses, before changing anything, a database that is set up or not Oculus's. `setUpFirstInstall`, `databaseBeforeSetup`, README note.
- Decisions: none
- Review: three independent rounds; fixed every finding (it migrated before refusing; the empty-database check now reuses restore's `contentsOf`; terminal input that could become an answer; input checks). Left as S-031.
- Gate: PASS · tests_passing 4208 (was 4193) · npm audit clean
- Next: the next job in the work board's pool.

## 2026-11-24 19:57 CT — manual (Chat A) — T-048 Admin: people, roles and the audit trail
- Result: done
- What changed: service `people.ts`, db `people.ts`, migration 0020 (`people_events`, append-only; the last-active-system-manager trigger), `people-api.ts` routes, `POST /api/reauthenticate`, and admin screens for people, a person, invitations, roles (built-in, read-only) and the audit trail. Role and account changes need the password and code entered in the last 10 minutes.
- Decisions: D-084
- Review: one independent round, no blocking issue. Fixed: impossible cursor and date values (422), the audit trail's timeout and rate bucket, one query for members' roles, logging of failed or superseded sends, membership re-checked inside the acting transaction, D-084 accuracy. Q-8 to Q-11 asked of John.
- Gate: PASS · tests_passing 4193 (was 4141) · npm audit clean
- Next: T-040 (finishing), M-002 (building); helper chats take the job pool on the project work board

## 2026-11-24 18:25 CT — manual (Chat A) — T-046 Admin: item list and record editor
- Result: done
- What changed: admin item list and approval queue; a record editor built from the template (inherited values, checks beside fields, If-Match conflicts named, workflow buttons per `can`, history view/compare/restore, delete, new records, leave guard). API: `GET /api/records`, `GET /api/working-site`, `GET /api/record-types`; `can` and `inherited` on record reads. `endSession` clears the CSRF token, query cache and list memory whenever a session ends or begins. e2e walks the whole flow by keyboard with Alfa.
- Decisions: D-083
- Review: one independent round, no blocking issue; four findings fixed (search words surviving a session end; organization switch keeping old templates; `inherited` read race failing open; edits lost on reconnect).
- Gate: PASS · tests_passing 4141 (was 4090) · npm audit clean
- Next: T-048 (building), T-040

## 2026-11-24 17:35 CT — manual (Chat A) — T-043 API: history, restore, approval and publishing
- Result: done
- What changed: staff API routes for a record's version list (summaries only), one version, compare, restore (If-Match, `confirmMadePublic`), submit for review, return to draft, publish and withdraw (each its own POST with If-Match), and the approval queue over whole publish sites. Read-only and Scanner see no history (John). `readRecord` returns the workflow state. Migration 0019: a partial index for the queue, which runs under the search timeout.
- Decisions: D-082
- Review: first round found restore's unlocked look read the old version before any permission check (timing showed a hidden record's existence and size) and the version list read every full snapshot; both fixed. A second review of the fix found no blocking issue. Q-6 and Q-7 asked of John; S-030 filed.
- Gate: PASS · tests_passing 4090 (was 4063) · npm audit clean
- Next: T-046 (in review); then T-048

## 2026-11-24 16:03 CT — manual (John: "continue building") — T-045 Admin: sign-in and the screen frame
- Result: done
- What changed: `packages/admin` (React 19, Vite, React Router, TanStack Query, React Aria; D-073): sign-in, the two-step code with a recovery-code option, organization choice, two-step set-up (QR, the key in groups, ten recovery codes shown once), forgot and reset password (token in the address fragment, removed at once), and the frame with the sidebar, site picker and top bar. `packages/api/src/sign-in-api.ts`: sign-in, pending, code, set-up, sign-out, sign-out elsewhere, organization switch, me, password reset. `admin-server.ts` serves the built admin from memory on the admin origin with its own strict CSP; `npm run admin` starts it. Gate: a keyboard-only Playwright end-to-end step with Siteimprove Alfa accessibility checks; font files checked against FONTS.json (OFL-1.1 for fonts only).
- Decisions: D-081
- Review: one independent round, no blocking issue. Fixed: sign-out said "signed out" when the server hadn't; some routes looked up sessions before the per-address limit (now limited first, with Retry-After); after choosing an organization an expired code left no field to retype it. S-029 filed (one deadlock-test failure under load, not reproduced).
- Gate: PASS · tests_passing 4063 (was 3971) · npm audit clean
- Next: T-043 (Chat A); Chats B and C per the project work board

## 2026-11-24 15:26 CT — manual (John: "continue building") — S-028 Make the S-020 dependents check cheap
- Result: done
- What changed: core `changesInheritance` names the properties that can't change what records below inherit (title, record type, media type, agent type, coordinates); edits that change only those skip the dependents check. `placesHolding` and `hiddenAmong` are set-based (one query). The 500-dependent cap applies only to edits that can change inheritance. `belowAtStake` and `RecordAccess.allowsUnlocked` decide before locking whether records below need locking; the answer is recomputed under the row lock and a mismatch retries. A title edit on a unit with 250 published below: 5,538 statements → 33.
- Decisions: none
- Review: one independent round, no blocking issue (concurrent publish/edit pinned on two pools, a version race, adversarial chains and loops, an 8-pool deadlock loop with zero deadlocks). Note carried to T-041b: keep `allowsUnlocked` in step with `onRecord`.
- Gate: PASS · tests_passing 3971 (was 3961) · npm audit clean
- Next: T-045 review fixes (in progress), then T-046 item list and record editor

## 2026-11-24 14:27 CT — manual (John: "continue building") — S-027 Review of the S-020 lock order
- Result: done (review only)
- What changed: nothing in code. An independent review of ca063e3 checked every edit and publish path against the below → record → above order, pinned seven race variants on two pools (all refused `inherits_from_hidden`), and ran 20 rounds of mixed concurrent operations without a deadlock. The one deadlock found (a system manager's invalid loop move against an edit below) is retried and refused. Cost on large fonds filed as S-028.
- Decisions: none
- Gate: PASS · tests_passing 3961 · npm audit clean (reviewer's run on main)
- Next: T-045 admin sign-in and frame (building)

## 2026-11-24 12:06 CT — manual (John: "finish the 3 in progress and the security ones and stop") — S-018 to S-025 Security findings
- Result: done
- What changed: S-018 an address that signed in successfully in the last 30 days keeps its own counter, so strangers can't keep a person (the only system admin) out; re-entry has its own counter (migration 0016). S-019 public output by site only, through `public_record_snapshot` and a public reader role with no table privileges and its own connection check (migration 0017, D-080). S-020 publishing and edits refuse values from records the actor can't see, by (field, source) pairs and over published descendants, with locks below → record → above. S-021 identical clash replies. S-022 a database trigger mirrors who may grant roles (migration 0018). S-024 cookie duplicates by exact name. S-025 more active content types refused.
- Decisions: D-080; amendments to D-058, D-068 (John), D-072, D-074, D-076
- Review: two independent rounds (a hidden ancestor's value through editing an intermediate unit; SECURITY DEFINER functions widening the reader; a publish/edit race). The last race fix (ca063e3) has its pinned race test but no separate reviewer yet: filed as S-027.
- Gate: PASS · tests_passing 3961 (was 3887) · npm audit clean
- Next: stopped here at John's request. Next session: S-027 review, then Phase 2's remaining tasks (T-043, T-034d/e, T-040, T-041b, T-045 onward)

## 2026-11-24 10:39 CT — manual (John: "finish the 3 in progress and the security ones") — T-042 HTTP API: records, templates and identifier types; S-023
- Result: done
- What changed: `packages/api/src/staff-api.ts`: `GET /api/session`; records read, create, update and delete with ETag and If-Match; a dry-run `POST /api/records/check`; staff search under a statement timeout and a cap, filtered to the sites a person can see; templates and identifier types read and saved. Every request needs the `__Host-` session cookie of a full session (second step passed), a CSRF header on changes checked in constant time, D-058's origin, size and content-type rules, a per-session rate limit; missing, other-site and other-organization records answer byte-identically; logs carry only error class and SQLSTATE. `packages/service/src/definitions.ts`: definitions are system managers only (John); a save that can change a published record's public output lists those records and needs `confirmPublished`.
- Decisions: D-079; D-072 amendment (John: definitions are system managers only)
- Review: three independent rounds (the dry-run check revealing other sites' parents; template and identifier-type changes reaching published records unlisted; hidden parents' and children's levels named in messages); all fixed with tests. Also a timing test in sessions.test.ts made steady under load. S-026 filed (publish check doesn't validate identifier formats; fails closed).
- Gate: PASS · tests_passing 3887 (was 3843) · npm audit clean
- Next: S-018 security batch (fixing review findings), then stop (John)

## 2026-11-24 10:00 CT — manual (John: "finish the 3 in progress and the security ones") — T-039 Password reset tokens
- Result: done
- What changed: migration `0015_password_resets.sql` and `packages/db/src/password-resets.ts`: a request gets the same reply for every address before any account-dependent work, which runs after a random 1–10 s wait (dummy work of the same shape for non-accounts); throttles per address typed, per client address and per IPv6 /48; 256-bit single-use links stored as SHA-256, 30 minutes, one pending per account, sent after commit with a time limit and withdrawn if sending fails; completing a reset sets the password, ends every session and signs nobody in; links die on password change, "end all", disabling or losing the last membership; no self-service reset for an account without an active second factor (code and trigger), admins can send one after re-entering their password; the second factor and its enrolment token stay required.
- Decisions: D-078
- Review: three independent rounds (enumeration by the next request's latency; mailbox-only takeover of accounts without a factor; a lock-order deadlock with sign-in; the work cap filled by waiting requests); all fixed with tests.
- Gate: PASS · tests_passing 3843 (was 3806) · npm audit clean
- Next: T-042 API (small fix), S-018 security batch (fixing review findings)

## 2026-11-24 08:08 CT — manual (John: "continue on phase 2") — T-038 Two-step sign-in, required for all staff
- Result: done
- What changed: core `totp.ts` (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, no replay). Migration `0014_second_factors.sql` and `packages/db/src/second-factor.ts`: set-up at first sign-in from a waiting session, 10 single-use recovery codes stored hashed, the secret sealed with AES-256-GCM under a key from `OCULUS_SECRET_KEY` (HKDF; rotation with `OCULUS_SECRET_KEY_PREVIOUS`), throttling that can't lock anyone out (recovery codes always work; app codes wait at most 15 minutes; alerts recorded), promotion bound in the database to a pass that only someone holding the secret (an S/KEY-style hash chain) or a recovery code can make, re-entering the password needing a code too, admin reset with a one-time enrolment token required for every new set-up after it.
- Decisions: D-077
- Review: three independent rounds (lockout by a password holder; a chosen ratchet anchor; re-enrolment after a reset without the token; lock order; a cascading delete and clock order dropping the token requirement); all fixed with tests.
- Gate: PASS · tests_passing 3806 (was 3745) · npm audit clean
- Next: T-039 password reset (final piece), T-042 API (fixing review findings)

## 2026-11-24 05:51 CT — security — S-017 Migrations, cleanup and the app pool connected without verified TLS
- Result: done (findings; most serious fixed)
- Security: `npm audit` 0 vulnerabilities. Secret scan of the whole tree and every commit since the last security run (`8b3d556..944e16b`, 282 commits; keys, tokens, private keys, JWTs, `.env`, URL credentials, emails, phone numbers): nothing; only obvious fakes in tests. All commit authors are `noreply@anthropic.com`. No private data about real people. Dependabot and code-scanning alerts: 403 (not reachable); no open Dependabot pull requests. Code review of every commit in the range by three independent reviewers (HTTP layer and sign-in; service, roles and workflow; public boundary and database layer), two findings confirmed with tests: **medium** S-017 (fixed here); **medium** S-018 anyone can keep the only system admin throttled indefinitely (confirmed); **medium** S-019 `readPublicRecord` ignores sites and needs a role that can read staff data; **low** S-020 to S-025 (inherited values published past the publisher's scope, identifier existence oracle across sites, no database guard on who grants roles, `catalog.definitions` unenforced and organization-wide, case-folded duplicate-cookie denial of service, XML not treated as active content). All added to ROADMAP as `(risky)` at the top of Phase 2. Nothing private reaches `publicOutput`; the `sql` tag, cross-organization filters, sessions, CSRF, invitations and backup file handling held up.
- What changed: `clientConfig` no longer hands `OCULUS_DATABASE_URL` to node-pg (which used no TLS to a remote host without `sslmode`, and no certificate check for `no-verify` or libpq-compatible `require`); every URL goes through backup's `resolveConnection`, so a remote host always gets a verified certificate. `db:cleanup` reports a refused URL as `bad_url` (exit 2) without its value; `withDatabaseName` drops a query `dbname`. Attack tests in `client-tls.attacks.test.ts` (all fail without the fix), including a fake server refusing TLS that never receives the startup message or password. Commits fa86cba, 39ffeb6. Behaviour change for operators: the URL must name user, host and database and use only the listed keywords (README, D-064).
- Decisions: D-064 amendment
- Review: one independent review of the diff: safe; its points (a query `dbname` overriding `withDatabaseName`, docs naming the backup-only rule) fixed; the downgrade test binds 127.0.0.2, which macOS lacks by default (Linux and CI fine).
- Sources: PostgreSQL 16 libpq SSL support (sslmode table); pg-connection-string 2.x README; OWASP ASVS 4.0.3 V2.2.1, V4.1, V9.2.2.
- Gate: PASS · tests_passing 3755 (was 3745) · npm audit clean
- Next: S-018 admin lockout (coordinate with the manual session's T-038/T-039), then S-019 before T-050; build order otherwise unchanged

## 2026-11-24 04:07 CT — manual (John: "continue on phase 2") — T-041 Roles and collection-level permissions
- Result: done
- What changed: migration `0013_roles.sql`: `sites`, `role_assignments` (one built-in role per member, per site or every site, optionally scoped to an archival unit's subtree), `system_settings`, `records.site_id`. Core `permissions.ts` (fixed roles and permissions; system permissions only from `system_admin`) and `system-settings.ts`. Service checks every operation inside its own transaction (user row, then arrangement lock, then record row), roles reach only their site's records (D-074), no-site records only system managers, new records join the working site, moves between sites need both, same-site filing and scans, publishing needs `records.publish` through T-034's hook, grants and revokes by site managers below themselves, session limits read from System settings. Invisible and missing records answer identically everywhere.
- Decisions: D-072 (John: only site managers delete; read-only users don't see old versions), D-074 amendment (accepted one-bit signals)
- Review: three independent rounds (an asset slipping out of scope between check and write; grant/revoke deadlocks; link and scope existence oracles; a scope grant blocking another site's deletions; restores dropping the home site; cross-site filing); all fixed with tests.
- Gate: PASS · tests_passing 3745 (was 3690) · npm audit clean. The password timing test now times each check right after its baseline, so load hits both.
- Next: T-038 two-step sign-in (second review running), T-039 password reset (fixing review findings)

## 2026-11-24 03:27 CT — upkeep — Dependency update: typescript-eslint 8.74.0
- Result: done
- What changed: `npm outdated` showed one in-major update, typescript-eslint 8.73.0 → 8.74.0 (released 2026-11-23); bumped in package.json and the lockfile. TypeScript 7 and Vite 8 stay on T-001b (typescript-eslint still requires TypeScript `<6.1`; note added there).
- Decisions: none
- Review: n/a (dev dependency bump within a major)
- Gate: PASS · tests_passing 3690 (was 3690) · npm audit clean
- Next: T-041 roles and T-038 two-step sign-in (claimed by the manual session); otherwise the next unclaimed build task

## 2026-11-24 02:41 CT — manual (John: "continue on phase 2") — T-034b, T-034c Stored workflow state; public output reads what is published
- Result: done
- What changed: migration `0012_workflow_states.sql`: `records.workflow_state` (D-075's four states), workflow actions as versions (history shows who published or withdrew, when and why), the database refusing any state change without a valid workflow version, a publish that also changes content, a record starting published, and deleting a published record. Service `submitForReview`, `returnToDraft`, `publish`, `withdraw` with the publish check in the same transaction; edits, restores and identifier saves of a published record must still pass it; a `mayChangePublicOutput` hook that T-041 fills with `records.publish`. `readPublicRecord` builds public output from one Repeatable Read snapshot; unpublished, missing and other organizations' records answer identically; unpublished links and places show nothing.
- Decisions: D-076 (John: edits to published records go live with edit permission)
- Review: one independent round, no blocking issues; notes recorded in D-076 and on T-042.
- Gate: PASS · tests_passing 3690 (was 3663) · npm audit clean
- Next: T-041 roles (finishing), T-038 two-step sign-in (building)

## 2026-11-24 02:11 CT — manual (John: "continue on phase 2") — T-037 Sessions
- Result: done
- What changed: migration `0010_sessions.sql` and `packages/db/src/sessions.ts`: hashed 256-bit tokens in one spelling, a 10-minute second-step stage that grants nothing until T-038 promotes it (no exported way to skip it), 4 h idle and 12 h absolute limits checked by the database, one organization per session, new tokens at promotion, switch, rotation and re-entering the password, a person's own session list, sign-out and "sign out everywhere else", admin sign-out of a user (re-entered password required), `users.sessions_valid_after` so disabling, resets and "end all" kill every older session, user-row-first locking, a derived CSRF token, `npm run db:cleanup`. Also two flaky tests fixed (concurrent invitations may now answer `superseded`; the password timing test uses a median of nine).
- Decisions: D-069
- Review: three independent rounds (revocation racing an organization switch; a sign-in finishing after a reset; lock order; error mapping); all fixed with tests.
- Gate: PASS · tests_passing 3663 (was 3605) · npm audit clean
- Next: T-038 two-step sign-in and T-039 password reset; T-041 and T-034b/c in progress (claimed in the roadmap so nightly runs skip them)

## 2026-11-24 00:39 CT — build — T-034a Workflow states in core
- Result: done
- What changed: T-034 split into T-034a to T-034e (parent `[~]`). New `packages/core/src/workflow.ts`: the four states (draft, ready for review, published, withdrawn; new records start as draft; only published is public), four actions (`submit_for_review`, `return_to_draft`, `publish`, `withdraw`) and the allowed moves (`workflowTransition`, `applyWorkflowAction`, `workflowMoves`); a published record leaves the public only by withdrawing; `changesPublicOutput` marks the two actions that need the publish permission. T-035 now carries the approval-step narrowing. Main moved during the run (T-044, U-005 by a manual session), so the work was rebased and the gate re-run.
- Decisions: D-075 (numbered past D-072, which the manual session's log skips, to avoid a collision)
- Review: one independent round, safe; two minor points fixed (labels for non-states, the T-035 note).
- Gate: PASS · tests_passing 3605 (was 3592) · npm audit clean
- Next: T-034b stored state and the workflow actions in the service (build order); the manual session is on T-037 and T-041

## 2026-11-24 00:42 CT — manual (John: "start on phase 2, easiest wins first") — T-044 How the admin is built; U-005 test timeouts
- Result: done
- What changed: D-073 picks the admin's stack (React 19 on Vite 7, React Router 8, TanStack Query 5, React Aria Components with the design tokens, an in-house template form renderer checked by a server dry-run endpoint, Vitest with Testing Library, Playwright end-to-end tests, Siteimprove Alfa for accessibility, self-hosted fonts with OFL-1.1 allowed for font files only). U-005: explicit timeouts for two load-sensitive test hooks.
- Decisions: D-073 (three answers from John)
- Review: n/a (decision); U-005 changes timeouts only
- Gate: PASS · tests_passing 3592 · npm audit clean
- Next: T-037 sessions (final review), T-041 roles and permissions (building)

## 2026-11-24 00:25 CT — manual (John: "start on phase 2, easiest wins first") — T-019, T-019b, T-019b2 Organization separation
- Result: done
- What changed: core `StoredTerm` with a required `organizationId` (`validateStoredTerm(s)`, plain objects only) and one `termIdentity` rule that db hashes for `term_key` (bytes unchanged, now pinned by a test). The near-duplicate and LC-without-URI reports take the expected organization and refuse mixed or unowned lists with fixed text. The D-019 items still to build are written into T-041 (sites table, sites by role, System settings access), T-045 (site selector), T-048 (Users page) and a new task T-048a (Admin: System settings).
- Decisions: D-071
- Review: one independent round (no leaks; key bytes fuzzed identical; planning gaps and test strength); all fixed.
- Gate: PASS · tests_passing 3592 (was 3567) · npm audit clean
- Next: T-037 sessions (fixing review findings), then T-044 and T-038

## 2026-11-24 00:19 CT — manual (John: "start on phase 2, easiest wins first") — S-015, S-016, T-012a follow-ups
- Result: done
- What changed: the writer check also refuses grant options on any database and schema public, any guard trigger that isn't ALWAYS, and any subscription, and no longer counts temporary objects as owned. `createInvitation` answers superseded, revoked or may-be-pending instead of a misleading ok; only connection-class failures become `database_unavailable` and everything else is rethrown. Template moves (`templateMoveChanges`) need confirmation for values that would change visibility, in `updateRecord` and in `restoreVersion` across templates; `nextIdentifier` can count numbers held in template fields.
- Decisions: amendments to D-029, D-067, D-068
- Review: one independent round (a restore across templates publishing a staff value without confirmation; missed network errors; programming errors hidden); all fixed with tests. Filed T-012b and U-005 as future features.
- Gate: PASS · tests_passing 3567 (was 3554) · npm audit clean
- Next: T-037 sessions and T-019b2 organization separation (fixing review findings)

## 2026-11-23 23:13 CT — manual (John: "move them to future features") — Launch scope
- Result: done
- What changed: ROADMAP gains a "Future features (after launch)" section. Moved there: the loan rework (T-018a, T-018b, S-013), vocabulary URI checks (T-009a), the TypeScript 7 and Vite 8 revisit (T-001b), search follow-ups (S-014), custom roles (T-041a), the optional approval step (T-035) and review queue (T-049), site passwords (T-019d), Argon2id (U-004) and the templates and identifier types admin screen (T-047). T-043 and T-048 no longer wait on T-035 and T-041a.
- Decisions: none (scope only)
- Next: T-037 sessions (review), then T-038 two-step sign-in

## 2026-11-23 22:51 CT — manual (John: "continue") — T-036 User accounts and password sign-in
- Result: done
- What changed: migration `0009_users.sql`: install-wide users with per-organization memberships (D-019), invitations (256-bit tokens stored as SHA-256, single use, 1 hour to 14 days, bound to one organization and address, sent only to the invitee after commit with a time limit and withdrawn if sending fails), one bootstrap system admin, sign-in throttle counters per address and per client network. Core: scrypt passwords at one allowed setting (NFC, 8 to 1,024 bytes, a common-password list and context words refused), progressive waits up to 15 minutes with no permanent lockout. `signIn` gives the same reply and cost for every failure and requires the second step (T-038). `client.ts`: a lost connection inside a transaction fails cleanly instead of crashing the process.
- Decisions: D-068
- Review: three independent rounds (the inviter learning whether an address has an account; timing for non-current hashes; the writer minting accounts with ready-made invitations; email sent inside the transaction; a process crash on a lost connection); all fixed with tests. Small follow-ups filed as S-016.
- Gate: PASS · tests_passing 3554 (was 3465) · npm audit clean
- Next: T-037 sessions

## 2026-11-23 21:40 CT — manual (John: "continue") — T-032 The service layer: one writer
- Result: done
- What changed: new `packages/service` (`createService`), the only writer of records, identifiers, term usages, versions and arrangement, one transaction per operation with locked checks, clean issues, retries on deadlocks. Migration `0008_record_deletion.sql`: deletion as a tombstone version, nothing after a delete, append-only template and record type versions, definition advisory locks, every guard trigger set to fire ALWAYS (also in replica mode). `roles.ts`: `grantWriterRole` with the minimum privileges and `checkWriterConnection`, an allowlist that refuses any membership, attribute, owned object, extra or column privilege, grant option, schema CREATE, parameter grant, role setting or replica-mode session.
- Decisions: D-067
- Review: five independent rounds (a version after a delete; roles that could switch off the triggers through membership, column grants, subscriptions or replica mode); all fixed with tests. Small follow-ups filed as S-015; loans storage as T-018b.
- Gate: PASS · tests_passing 3465 (was 3426) · npm audit clean
- Next: T-036 user accounts and password sign-in (in progress)

## 2026-11-23 20:14 CT — manual (John: "keep going") — T-028 Staff search
- Result: done
- What changed: migration `0007_staff_search.sql`: a stored, database-computed search document per record (title and text fields, folded for Latin, Greek and Cyrillic accents and case) with a GIN index, and `public.rebuild_search_documents()` for after a PostgreSQL or locale upgrade. `packages/db/src/search.ts` `searchRecords`: staff-only, one organization, current and former identifiers first, then ranked text hits, keyset paging with strictly validated cursors, a 500-character query limit.
- Decisions: D-066
- Review: two independent rounds (ranks sorted as text so paging skipped hits; OR'd exclusions; cost and upgrade notes; Hebrew and Arabic wording); all fixed with tests. Small follow-ups filed as S-014.
- Gate: PASS · tests_passing 3426 (was 3406) · npm audit clean
- Next: T-032 service layer (in progress)

## 2026-11-23 19:33 CT — manual (John: "keep going") — T-052 Backup and restore tools
- Result: done
- What changed: `npm run backup` / `npm run restore` (`packages/db/src/backup*.ts`): one file holding pg_dump's custom archive plus a manifest (format 2: versions, counts, role settings), restored only into a database exactly as CREATE DATABASE made it, by a role that is not a superuser and has no direct grants beyond what the restore needs, then checked (row counts, schema, role settings). One stop per Ctrl-C, partial files removed, a 20 s wait for other sessions. CI installs the PGDG client and server so pg_dump matches the server.
- Decisions: D-064
- Review: five independent rounds (TLS downgrade, superuser bypass, restoring over a live database, signal handling, privileges granted straight to the restore role, partial files); all fixed with tests. One integration fix: a backup test updated for T-029's transactional `insertRecord`.
- Gate: PASS · tests_passing 3406 (was 3342) · npm audit clean
- Next: T-028 staff search (fixing review findings: ranking order), then T-032 service layer

## 2026-11-23 19:06 CT — manual (John: "continue") — T-030 Compare and restore versions; T-031 Edit-conflict protection
- Result: done
- What changed: `compareRecords` (core) and `compareVersions` (db); `restoreVersion` writes a new version equal to an old one only after today's template, rights, identifier, link, record-type and arrangement checks, with fixed-text refusals and an explicit list confirmation for values landing in fields public today; identifiers are never restored. `updateRecord` conflicts list the field names changed since the editor's version (no values). Migration `0006_arrangement_guard.sql`: a per-organization arrangement lock and a trigger refusing parent loops and depth over 64 (ancestors and moved subtrees) for any writer.
- Decisions: D-065
- Review: three independent rounds (concurrent restores forming a loop; old staff values restored into fields since made public; conflict results and refusal messages exposing old values; subtree depth; lock order); all fixed with tests, including two-connection races.
- Gate: PASS · tests_passing 3342 (was 3311) · npm audit clean
- Next: T-052 backup and restore (fourth round: allowlisted restore role, signals); T-032 service layer

## 2026-11-23 18:12 CT — manual (John: "keep going") — T-029 Change log and version history
- Result: done
- What changed: migration `0005_record_versions.sql`: `records.version` and an append-only `record_versions` table (full validated snapshot, actor, time and changed fields filled by the database, optional reason, the writing transaction). The database refuses a record write without its own version written in the same transaction (checked at COMMIT), reuse of a deleted ID, kind changes, backwards `updatedAt`, and any UPDATE/DELETE/TRUNCATE of versions. `catalog.ts` `insertRecord`/`updateRecord` (expected version) / `readStoredRecord`; `record-versions.ts` `readVersions`/`readVersion` re-validated with core. App-role GRANTs documented and tested with a non-owner role (no DELETE on records until T-032's tombstones).
- Decisions: D-063
- Review: three independent rounds (a deleted record re-created to wind history back; free kind changes; deletion not versioned; refusal codes); all fixed with tests.
- Gate: PASS · tests_passing 3311 (was 3287) · npm audit clean
- Next: T-052 backup and restore (fixing review findings), then T-030 compare and restore versions, T-031 edit-conflict protection

## 2026-11-23 17:31 CT — manual (John: "continue") — T-027 Schema: vocabularies and terms
- Result: done
- What changed: migration `0004_vocabularies.sql`: an organization's stored local and authority terms (keyed by vocabulary plus `termUriKey`, or label), and a staff-only index of which records use which terms with what it was built from. `packages/db/src/vocabularies.ts`: save/read terms, `refreshRecordTerms`/`clearRecordTerms` under the record lock (refused refreshes clear old usages), staff-only `termUsageCounts` that never shows text from records (stored copy or canonical URI only), paging, and `recordsWithStaleTerms`.
- Decisions: D-062
- Review: three independent rounds (staff-field labels shown as a heading's label; a save/delete deadlock; old usages counted after a refused refresh; a private note hidden in a dot-segment URI; a public-fields count that didn't follow core's visibility rules — removed; stale-check paging); all fixed with tests.
- Gate: PASS · tests_passing 3287 (was 3261) · npm audit clean
- Next: T-029 Change log and version history (risky)

## 2026-11-23 17:20 CT — manual (John: "continue") — T-026 Schema: identifiers, with uniqueness the database enforces
- Result: done
- What changed: migration `0003_identifiers.sql`: identifier types per organization; holdings carrying the type's uniqueness rule (copied by trigger, kept current by a cascading foreign key, adopted by a trigger when a type is created); partial unique indexes on `(organization_id, type_key, key)` for `current` and `all_time`; current and former value tables; auto-number counters. `packages/db/src/identifiers.ts`: saves write holdings in sorted order then release; allocation under counter and type-key locks; bucketed advisory locks (64 per organization); Read Committed only; lenient reads; clean `not_unique`, `retry` and `read_committed_required` issues.
- Decisions: D-061
- Review: three independent rounds (type creation racing a save let an `all_time` number be given twice; swap and opposite-order deadlocks; strict reads after an allowed type edit; unbounded advisory locks; the race returning under Repeatable Read; direct-SQL type inserts not adopting holdings), all fixed with two-connection race tests; final round's remaining notes (per-organization lock bound, bucket-collision deadlocks ending in `retry`) documented.
- Gate: PASS · tests_passing 3261 (was 3223) · npm audit clean
- Next: T-027 (term tables, in second review), then T-029 change log and version history

## 2026-11-23 16:45 CT — manual (John: "continue") — S-009b, S-011c
- Result: done
- What changed: **S-009b** `validateIdentifierTypes(types, organizationId)` and `makeIdentifierChecker(types, organizationId)` take the caller's organization and refuse any list holding another organization's entry before quoting anything (D-030 amended). **S-011c** a public record link whose target no longer exists is left out of public output like an unpublished one, with a staff-only `link_target_missing` warning in `staffWarnings`; saving such a link is still refused (D-045 amended).
- Decisions: D-030 and D-045 amended
- Review: independent review: safe (notes: T-050 must render only the public forms, never `staffWarnings`).
- Note: the first gate run failed because a reviewer's cleanup removed the gate's temporary database socket mid-run; the re-run passed.
- Gate: PASS · tests_passing 3223 (was 3210) · npm audit clean
- Next: T-026 (identifier schema, fixing review findings)

## 2026-11-23 16:05 CT — manual (John: "do a long building") — T-025 Schema: records, templates and record types
- Result: done
- What changed: migration `0002_catalog.sql`: organizations; templates and record types as identity rows plus versioned, validated JSON; records keyed by `(organization_id, id)`; every foreign key between catalog rows includes the organization; checks back up core's rules; `catalog_keep_identity` (fixed search path, fires last) refuses any UPDATE that changes a row's organization or identity. `packages/db/src/catalog.ts` inserts and reads with core validation on both sides; record type versions are checked against the stored default template in the same statement. `npm run db:migrate` builds core first (with a clean-checkout test).
- Decisions: D-060
- Review: two independent rounds (records movable between organizations by UPDATE, global record IDs, db:migrate failing on a fresh clone, overclaimed delete and link protections, trusting a caller's template; then the trigger's search path, trigger order, test cleanup); all fixed with tests.
- Gate: PASS · tests_passing 3210 (was 3175) · npm audit clean
- Next: T-026 Schema: identifiers, with uniqueness the database enforces (risky); T-027; T-029

## 2026-11-23 15:55 CT — manual (John: "do a long building") — S-012 Loan link reads use own properties; S-013 deferred
- Result: S-012 done; S-013 attempt 1 not merged (joins the loans redesign with T-018a)
- What changed: `readTop` in storage.ts returns frozen prototype-free copies at every depth (storage, loans, condition checks); loans read item links through `ownLink`, so a polluted `Object.prototype` can't link a departure and hide an overdue loan. S-013's `unlinked_arrival` rule (branch `autopilot/S-012`, b623eb9) was reviewed: still hideable in five ways and too many false positives; it is redesigned together with T-018a.
- Decisions: none (D-044 amendment held back with S-013)
- Review: independent; S-012 safe, S-013 not.
- Gate: PASS · tests_passing 3175 (was 3171) · npm audit clean
- Next: T-025 Schema: records, templates and record types (fixes in second review)

## 2026-11-23 15:45 CT — manual (John: "do a long building") — T-022a The HTTP layer on Fastify
- Result: done
- What changed: `packages/api` (D-058) on Fastify 5.12.8, its only runtime dependency (`@fastify/cookie` dropped because its writer parsed every cookie). App routes are plain objects checked once and frozen; handlers get a frozen request view (never Fastify, `raw` or the socket), an `AbortSignal`, and may return only plain data or text within size caps; every throw or rejection is rebuilt as a fresh `Refusal` (400-599) or a plain 500, and late failures are logged by Oculus; handlers may set only allowlisted headers and Oculus cookies through one `__Host-` writer; exact JSON and form parsers (depth, duplicate keys, non-finite numbers, strict UTF-8), byte-counted limits (1 MiB, 8 KiB on credential routes), path refusals, 404/405 before handlers, Origin checked against `OCULUS_ORIGINS`, trusted proxies limited, security headers (nosniff, no-referrer, CSP, no-store) on every reply including Node and router errors, and logs holding method and path only.
- Decisions: D-058 (amends D-051: no `@fastify/cookie`)
- Review: five independent rounds (route options and the routes callback switching rules off, cookies parsed by the plugin, returned Response objects and request.server/raw escapes, hostile thrown values reaching Fastify's own error handlers, header blocklist gaps, late rejections logging query strings); every finding fixed with a test.
- Gate: PASS · tests_passing 3171 (was 2761) · npm audit clean · licenses 205 packages permissive
- Next: T-025 Schema: records, templates and record types (risky); S-009b, S-011c, S-012, S-013

## 2026-11-23 15:35 CT — manual (John: "do a long building") — T-024 Migrations tooling and the empty schema; T-018a stuck
- Result: T-024 done; T-018a stuck (attempts: 3)
- What changed: **T-024** (D-057) `packages/db`: `pg` 8.23.1 behind one `sql` tag (every value a parameter, extended protocol only, placeholders can't touch surrounding text); a forward-only migration runner holding its advisory lock on a separate connection, one transaction and savepoint per file, refusing any file that ended, prepared or escaped the runner's transaction (`transaction_ended`), re-reading the record before and after COMMIT (`applied_not_recorded`), `lock_lost`, `commit_unknown`, `connection_failed`; `npm run db:migrate`; lint keeping `pg` inside `packages/db`; the gate starts a throwaway PostgreSQL (as the postgres user when root, socket only, minimal env, always cleaned up); CI runs the gate against postgres:15 and :19 with a summary `gate` job. **T-018a** stuck: three reviews each found ways to hide an overdue loan through caller-supplied accession registers; new approach recorded (close loans only in the service layer, T-032); branch pushed; S-012 and S-013 added for gaps on main.
- Decisions: D-057
- Review: five independent rounds on T-024 (multi-statement queries, half-applied migrations in many forms, settings leaking between files, placeholder mis-binding, root environment, lock swaps, other applications' prepared transactions, idle timeouts, deferred-trigger tricks); every finding fixed with a test.
- Gate: PASS · tests_passing 2761 (was 2661) · npm audit clean
- Next: T-022a (HTTP layer, final fixes), then T-025 (schema: records, templates and record types)

## 2026-11-23 15:30 CT — manual (John: "do a long building") — S-010, S-007, T-013a, T-015a, T-016a
- Result: done (built in parallel worktrees, each reviewed, merged into integrate-2; gate on the result)
- What changed: **S-010** (D-054) `publicOutput` requires current `records` and `templateFor` for every view and indexes records once, so a kept view can't publish data made staff, moved or deleted since. **S-007** `publicOutput` issues are staff-only and their field messages are fixed text. **T-013a** (D-053) `recordTypeChanges`/`recordTypeDeletion` list the records an edit strands; without the records, always needs confirmation. **T-015a** (D-055) `templateChanges` reports narrowed link kinds (fail closed on any link the checker can't resolve); `findStaleLinkLabels` staff report; a record link checker's organization comes from the whole set and an organization-less checker refuses everything. **T-016a** (D-056) accession restrictions (closed until a date; staff and researchers only) hold records back like an unsigned deed; `today` is the caller's.
- Decisions: D-053, D-054, D-055, D-056
- Review: every branch had an independent review; T-013a (needsConfirmation false without records), T-015a (empty, stale or organization-less checkers made narrowing look harmless; another organization's invalid records got through; two rounds), S-010 (check order, stale docs) and T-016a (prototype reads, quoted keys) had findings, all fixed with tests.
- Note: a builder's `git merge` was blocked by the permission system; John approved it.
- Gate: PASS · tests_passing 2661 (was 2530) · npm audit clean
- Next: T-024 (database package, third review), T-022a (HTTP layer, third round of fixes), T-018a (loans, third round of fixes)

## 2026-11-23 12:40 CT — manual (John: "do a long building") — S-009a, S-011, S-011a, T-019b1, U-003, T-020, T-021, T-022, T-023
- Result: done (four branches built in parallel worktrees, reviewed, merged into one integration branch; gate on the result)
- What changed: **S-009a** identifier type lists, accession registers and template registries check organization before validating, and `validateIdentifierTypes` gives only organization issues for a mixed list, so no message names another organization's keys. **S-011** (D-045, John) the public view holds no record links; `publicOutput` names a link only when it may, otherwise nothing at all. **S-011a** (D-048, John) a place name shows even when its place record isn't public, but only when the organization's own place checker vouches for it. **T-019b1** (D-047) Dublin Core mappings belong to an organization; built-in mappings are presets. **U-003** `templateChanges` reads `templateKey` as an own property; blowup tests assert process CPU time, so a busy machine no longer fails them. **T-020 to T-023** Phase 2 decisions: PostgreSQL 15–19 with a throwaway test database (D-049), `pg` with hand-written SQL and plain `.sql` migrations (D-050), Fastify 5 (D-051, John), scrypt passwords, two-step sign-in required for all staff and 4-hour idle sessions (D-052, John).
- Decisions: D-047, D-048 (John), D-049, D-050, D-051 (John), D-052 (John)
- Review: every branch had an independent review. S-009a: round 1 found the leak still open in `validateIdentifierTypes` and `makeIdentifierChecker`; round 2 found non-object entries skipped; both fixed with attack tests (S-009b added for lists wholly owned by another organization). S-011: round 1 found a record link left in a field changed to `place` published a donor's label; fixed (D-048 rule); round 2 safe (S-011c added). U-003: the first version timed only the main thread, 25–70% looser than wall clock; switched to process CPU time. T-019b1: safe (wording fixes). Decision drafts were researched by separate agents; John chose Fastify, required two-step sign-in and a 4-hour idle limit.
- Note: builders couldn't start their own reviewers; the reviews were run from the main session. `git stash` is shared between worktrees: builders now save patches to /tmp instead.
- Gate: PASS · tests_passing 2530 (was 2502) · npm audit clean
- Next: T-013a and T-016a (built, in review), T-024 (building); then S-010, S-007, T-015a, T-018a, S-009b, S-011c, T-022a

## 2026-11-23 10:55 CT — manual (John: "continue") — S-009 Identifier type creation reveals another organization's keys
- Result: done
- What changed: `readUse` in `identifier-type-changes.ts` checks `existing.identifierTypes`' organization before looking the key up, so `identifierTypeCreation`, `identifierTypeDeletion` and `identifierTypeChanges` give the same `mixed_organizations` answer whether or not another organization's list holds the key. Attack test in `identifier-type-changes.attacks.test.ts` (fails without the fix).
- Decisions: none
- Review: one independent review of the diff: safe. It noted an older, non-probing gap (invalid foreign list's message names a key), added as S-009a.
- Sources: OWASP ASVS 4.0.3 V4.2.1.
- Gate: PASS · tests_passing 2502 (was 2501) · npm audit clean
- Next: S-010 Kept views publish without re-checks by default (risky)

## 2026-11-23 08:40 CT — manual (John: "Hard push on phase 1") — T-016, T-018
- Result: done (two branches built in parallel worktrees, fixed after review, merged; gate on the result)
- What changed: **T-016** accessions and deeds of gift (`accessions.ts`, `accession-holds.ts`): a staff-only register per organization; `effectivePublishIssues` and `publicOutput` take `accessions` and refuse records whose deed is missing or sent (and units below, and assets representing them); links to held records go out as labels. **T-018** loans in and out (`loans.ts`) and condition checks (`condition-checks.ts`) on the move log, and a `departure` move reason in `storage.ts`.
- Decisions: D-043, D-044 (and D-040 amended)
- Review: three independent rounds each. T-016: round 1 found a stale or partial register let a represented asset and empty registers through, and links to held records went live; round 2 found partial and stale registers still made held link targets live; round 3 safe. T-018: round 1 found `departure` could hide an overdue loan, links ignored dates, 500 items couldn't fit, future status dates, and one stale loan refused the book; round 2 found decoy edits, problem loans and back-dated or "found at home" moves could all take an overdue loan off the lists; round 3 found a self-edit of the genuine loan could. All fixed with tests that fail without the fix. The last T-018 fix set (link_removed, extensions only move a due date, correcting a departure's place) had no fourth review; the next security run reviews it with every other commit since its last run.
- Gate: PASS · tests_passing 2501 (was 2365) · npm audit clean
- Next: Phase 1 is done except T-009a part 1 (sources unreachable), T-001a (John) and T-001b (blocked upstream); the follow-ups T-013a, T-015a, T-016a, T-018a, S-007, U-003 and the security run's S-009 to S-011. Phase 2 can start: T-019b, then the decision tasks T-020 to T-023.

## 2026-11-23 05:51 CT — security — S-008 Another organization's template keys revealed
- Result: done (findings; most serious fixed)
- Security: `npm audit` 0 vulnerabilities. Secret scan of the whole tree and every commit since the last security run (`ec7153e..91763eb`; keys, tokens, private keys, JWTs, `.env`, URL credentials, emails, phone numbers): nothing; only obvious fakes in tests (`user:pw@example.org`). No private data about real people on `main`. Note: the leftover branches `autopilot/T-004` to `T-011` on GitHub still hold John's three original commits with his personal commit email (now gone from `main`); deleting those merged branches on GitHub would remove it from the branch list (this run can't delete remote branches). Dependabot and code-scanning alerts: not reachable from this run (T-001a, needs John). Code review of every commit since the last security run (T-005a, T-012, T-013, T-014, T-015, T-017, T-019, T-019a, T-009a, T-010a, S-005a, S-006a, U-002) by two independent reviewers (public boundary; organization isolation and input handling), with scratch tests: no high or medium findings, nothing private reaches `publicView` or `publicOutput`. Low findings: another organization's template keys revealed by check order and messages (fixed here, S-008); the same for identifier type creation (S-009); kept views publish without re-checks unless the caller passes `records` and `templateFor` (S-010); link labels to unpublished targets (S-011). No changes to `scripts/` or `.github/` in the range.
- What changed: `templateOfRecord` checks the template's (or registry's) organization before comparing or looking up the key; `wrong_organization` names no key. Attack tests in `templates.organizations.test.ts` (4 fail without the fix). Commit 8b3d556.
- Decisions: none
- Review: one independent review of the diff: safe (noted the inner registry check can no longer fail; kept as defence in depth).
- Sources: OWASP ASVS 4.0.3 V4.2.1, V7.4.1.
- Note: local `main` in the sandbox was stale again (origin/main had been rewritten before this run, not by it); this run built from origin/main and pushed a fast-forward.
- Gate: PASS · tests_passing 2365 (was 2360) · npm audit clean
- Next: T-016 Accessions and deeds of gift (risky); security follow-ups S-009, S-010, S-011

## 2026-11-23 03:27 CT — upkeep — U-002 Direct tests for the organization helpers
- Result: done
- What changed: `npm outdated` shows nothing to update within majors; TypeScript 7 and Vite 8 are still blocked (typescript-eslint 8.73.0 still needs TypeScript `<6.1`, Vite 8.3.8 still requires MPL-2.0 `lightningcss`), so T-001b stays open. Added 17 direct tests for `oneOrganization`, `organizationIdOf`, `mixedOrganizationsIssue` and `isIdentifierTypeKey` (getters and Proxies never run, inherited IDs ignored, unowned items at any position give `mixed`, unwalkable lists don't throw, the issue names no organization, the key rule and prototype keys). Commit 9ea22c2. Test-only; no code changed.
- Decisions: none
- Review: n/a (tests only)
- Gate: PASS · tests_passing 2131 (was 2114) · npm audit clean
- Next: T-019b Organizations on vocabularies, terms, rights settings and Dublin Core mappings (risky)

## 2026-11-23 05:30 CT — manual (John: "Hard push on phase 1") — T-013, T-014, T-015, T-017, S-005a, S-006a, T-009a (part), T-010a
- Result: done (six branches built in parallel worktrees, merged one at a time into one integration branch, gate on the result); T-009a partial
- What changed: **T-013** organization record types on the six kinds (`record-types.ts`). **T-014** numbers live only in `RecordIdentifiers`; identifier fields point at a current identifier (`identifier-fields.ts`); `effectiveRecord` and `publicOutput` take the identifier sets. **T-015** a `record_link` kind and `makeRecordLinkChecker` (`record-links.ts`); the public view holds no linked IDs. **T-017** storage levels, locations and moves (`storage.ts`). **S-005a** near-duplicate detection on 50,000 two-letter keys in ~1.8 s (was ~4 s). **S-006a** inherited staff-type identifiers kept for staff. **T-009a** LC terms with no URI report. **T-010a** output checked against the specs; `dcterms:type` has no range; `jsonld` test-only dev dependency.
- Decisions: D-037, D-038, D-039, D-040, D-041, D-042
- Review: every branch had an independent review. T-017 and S-005a/S-006a: two rounds each by their builders' reviewers (T-017: due dates lost, never-placed items, edits that made the log unreadable, a forged future `recordedAt`; S-005a: a timing test that proved nothing, unbounded working arrays; all fixed). T-013: safe; `recordTypeDefaults` could create a record in another organization and one broken template disabled all record types; both fixed. T-014: a retired number could be published from a kept view, and identifier sets were only shape-checked; fixed. T-015: a link left in a field changed to text kept its ID in the public view; fixed (misfit values are held back). T-009a/T-010a: safe. A second review of the merged result found no leak; it found a staff-type number quoted in a child's staff note, fixed with a test, and raised S-007 (messages in `publicOutput` issues).
- Note: the gate's timing tests failed while six agents shared the 2-CPU machine (they fail on main under the same load); the final gate ran on a quiet machine. U-003 makes them robust.
- Sources: see D-040 and D-042.
- Gate: PASS · tests_passing 2360 (was 2131) · npm audit clean
- Next: T-016 Accessions and deeds of gift (risky), then T-018 Loans and condition checks

## 2026-11-22 06:30 CT — manual (John) — Q-4 Roles
- Result: done (decision recorded; no code)
- What changed: John added the Scanner and Donor relations roles and asked that system managers can create custom roles. D-036: roles are sets of permissions from a fixed list, checked by permission rather than by name; custom roles belong to one organization and can't hold system-manager powers. T-041 updated; new task T-041a (custom roles); T-048 waits on it. Every Q- question is now answered.
- Decisions: D-036 (John)
- Review: n/a
- Gate: PASS · tests_passing 2114 (unchanged)
- Next: T-019b Organizations on vocabularies, terms, rights settings and Dublin Core mappings (risky)

## 2026-11-22 06:10 CT — manual (John) — Q-1 and Q-2 answered; Q-4 assumption
- Result: done (decisions recorded; no code)
- What changed: Q-1: one server app, with the public sites on their own read-only path (D-034). Q-2: SiteGround for the Society, but Oculus stays host-flexible (Node LTS, PostgreSQL, environment variables, optional scheduled commands, SMTP, local or S3-compatible files; D-035). T-050 and T-040 no longer wait on John; T-051 still needs him to confirm his SiteGround plan allows a long-running Node process. Q-4 wasn't answered: T-041 builds the plan's roles so more can be added later.
- Decisions: D-034, D-035 (John)
- Sources: https://www.siteground.com/kb/what_databases_can_i_use_with_my_account, https://www.siteground.com/technology
- Review: n/a
- Gate: PASS · tests_passing 2114 (unchanged)
- Next: T-019b Organizations on vocabularies, terms, rights settings and Dublin Core mappings (risky)

## 2026-11-22 05:50 CT — manual (John) — Q-5 OCR and D-004
- Result: done (decision recorded; no code)
- What changed: John answered Q-5: allow trained models for OCR. Recorded as D-033, a narrow exception to D-004 (OCR only, run locally, permissive licenses for engine and model files, machine-read text marked and staff-only until published). D-004, ROADMAP.md (Q-5 closed, Phase 3 note) and AUTOPILOT.md's rule updated.
- Decisions: D-033 (John)
- Review: n/a
- Gate: PASS · tests_passing 2114 (unchanged)
- Next: T-019b Organizations on vocabularies, terms, rights settings and Dublin Core mappings (risky)

## 2026-11-22 05:40 CT — manual (John) — Q-3 The Society's other websites
- Result: done (decision recorded; no code)
- What changed: John answered Q-3: no, the Society's other websites stay where they are. Recorded as D-032; Q-3 closed in ROADMAP.md and removed from PLATFORM_PLAN.md's open questions; AUTOPILOT.md's list of John's decisions updated.
- Decisions: D-032 (John)
- Review: n/a
- Gate: PASS · tests_passing 2114 (unchanged)
- Next: T-019b Organizations on vocabularies, terms, rights settings and Dublin Core mappings (risky)

## 2026-11-22 05:15 CT — manual (John: "Continue") — T-019a Organizations on templates
- Result: done
- What changed: templates carry a required `organizationId`. Every path that picks a record's template (`checkRecordAgainstTemplate`, `effectiveRecord` with a lookup or a registry, for the record and its ancestors, and `publicOutput`) refuses another organization's (`wrong_organization`); `indexTemplates` and `legacyTemplateIssues` refuse mixed lists; `templateChanges` refuses two organizations' templates or another organization's records; identifier type changes refuse another organization's templates. Presets are now organization-free `TemplatePreset`s, and `templateFromPreset` makes an organization's copy. Commits 82cd40e, e53e04b.
- Decisions: D-030 (new "Templates" bullet; D-031 note updated)
- Review: one independent review. Safe: no path used another organization's template, and no message leaked another organization's IDs or values. It found that `legacyTemplateIssues` reported another organization's template keys, that `templateFromPreset`'s "won't move a template" guard was overstated, and that Dublin Core mappings have no organization yet. The first two are fixed (with a test); the third is now part of T-019b.
- Gate: PASS · tests_passing 2114 (was 2091) · npm audit clean
- Next: T-019b Organizations on vocabularies, terms, rights settings and Dublin Core mappings (risky)

## 2026-11-21 17:30 CT — manual (John: "Continue building") — T-005a, T-012, T-019 (part)
- Result: done (T-005a, T-012); partial (T-019, follow-ups T-019a, T-019b, T-019d)
- What changed: **T-005a** identifier type changes are checked before saving (format, uniqueness, reissued numbers, made public or staff, renamed onto leftover values, deleted, templates that name the type) and template `identifierTypes` follow the identifier type key rule, with legacy templates still readable. **T-012** records store `templateKey`; `indexTemplates` gives a registry that `checkRecordAgainstTemplate`, `effectiveRecord` and `publicOutput` accept; a record checked against another template is refused. **T-019** organizations and sites in the model; `organizationId` required on records, identifier types and identifier sets; mixed or unowned sets refused, inputs read once, identifier checkers tied to their organization.
- Decisions: D-029 (records name their template, no version pin), D-030 (organizations in the core model), D-031 (identifier type changes; one key rule)
- Review: T-012 two rounds (a present-but-undefined key fell back to legacy; templateChanges took other templates' records); safe after fixes. T-005a three rounds (one stranded value blocked later checks, legacy data broke, made-staff and reissue gaps, a rename adopting leftover staff values published them, unchecked mode trusted the old type); all fixed. T-019 three rounds (an entry with no organization skipped the check and leaked numbers across organizations, another organization's identifier checker published staff values, double reads of hostile lists); all fixed.
- Gate: PASS · tests_passing 2091 (was 1956) · npm audit clean
- Next: T-019a Organizations on templates and record types

## 2026-11-21 15:45 CT — manual (John) — Site editor structure
- Result: done (plan recorded; no code)
- What changed: John's site editor parts (headers, footers, pages, popups, plus global blocks, notice bar, menus, record templates, exhibits, forms and site-wide settings) added to the Phase 4 note in ROADMAP.md, drawn on the Oculus Site Design whiteboard. Fixed the "Oculusolybius" typo in DESIGN.md left by the D-018 rename.
- Decisions: none yet (news and events placement is open)
- Review: n/a
- Gate: PASS · tests_passing 1956 (unchanged)
- Next: T-005a remaining part (identifier types)

## 2026-11-21 14:55 CT — manual (John) — D-025 System managers and site managers
- Result: done (decision recorded; no code)
- What changed: John's roles: system managers can do everything (create and set up sites, install plugins and themes, all users, System settings); site managers have full control of only their assigned sites (one or more) and choose among installed plugins and themes. PLATFORM_PLAN.md §3 and T-041 updated; plugins are new, so P-001 (plugin security model) is added before any plugin system. The Oculus Sitemap whiteboard shows the same structure.
- Decisions: D-025 (John)
- Review: n/a
- Gate: PASS · tests_passing 1956 (unchanged)
- Next: T-005a remaining part (identifier types)

## 2026-11-21 07:30 CT — manual (John: "Fix the rest") — S-001a to S-006 Remaining security findings
- Result: done (six fixes built in parallel worktrees, merged one at a time onto origin/main; gate on the result)
- What changed: **S-001a** `publicOutput` takes `records` and refuses a kept view whose record or ancestors changed since (`record_changed`). **S-002** `templateChanges(old, new, records?)` reports every template change that would publish stored staff data or strand data, with the affected record IDs; making a field public always needs confirmation (main part of T-005a). **S-003** identifier keys decompose before mapping lookalikes (Greek/Cyrillic precomposed letters, more lookalikes), remove blanks and invisibles first, stay linear at any length; values with blank characters or more than 8 combining marks in a row are refused. **S-004** every dash-like character is read as `-` before the ambiguity checks, and a dash after "probably"/"maybe" is flagged. **S-005** near-duplicate terms: two lossless prefilters, a typed-array pair set and a faster distance; same recall, hostile 50,000-term shapes from ~3.6 s to ~2 s. **S-006** identifier types are staff only unless marked `public`; staff-type values never reach `publicView` or public output, and the view holds identifiers as `{ value }`.
- Decisions: D-021 (records re-check), D-022 (identifier type visibility), D-023 (template changes), D-024 (identifier keys)
- Review: each change had independent reviews. S-001a: safe. S-002: two rounds (missed new public fields without records, widened `appliesTo`, inheritance switched on, then stranded data from lowered `maxLength`, dropped vocabularies, new required fields); all fixed. S-003: three rounds (quadratic normalisation, blanks between letter and accent, more lookalikes; then a mark-run path that let an equivalent spelling bypass uniqueness; then U+0345 and halfwidth sound marks); all fixed. S-004: a dash after a qualifier read as BCE; fixed. S-005: two rounds (budget lost real pairs, skipped pairs overcharged, hash clustering; then proved lossless and matched the old distance on 2M comparisons). S-006: two rounds (own staff-type values in `publicView`, inherited staff values dropped from the staff view); fixed. Left as tasks: S-005a, S-006a.
- Note: S-006 changes behaviour: `effectiveRecord` needs `checkers.identifier` (from `makeIdentifierChecker`) or every public identifier field is held back.
- Gate: PASS · tests_passing 1956 (was 1397) · npm audit clean
- Next: T-005a remaining part (identifier types), then T-012 Records name their template

## 2026-11-21 05:51 CT — security — S-001 Public output re-checks ancestors' templates
- Result: done (findings; most serious fixed)
- Security: `npm audit` 0 vulnerabilities. Secret scan of the whole tree and every commit (keys, tokens, passwords, private keys, `.env`, URL credentials, emails, phone numbers): nothing; only obvious fakes in tests (`user:pw@example.org`). No private data about real people. GitHub Dependabot/code-scanning alerts still not reachable (T-001a, needs John). Code review: every commit since the last security run (T-002 to U-001, all of `packages/core`) by two independent reviewers (public boundary; input handling, CI and gate scripts), each finding proven with a test. Confirmed: a stale public view still published a value inherited from a parent whose template had since made that field staff (medium, fixed here); stored staff values published once their field turns public (S-002); precomposed Greek/Cyrillic lookalikes beat identifier uniqueness (S-003); en/em dashes bypass the date ambiguity guard (S-004); term-duplicate detection at ~3.6 s vs a 2 s target (S-005); identifier types without visibility (S-006). CI workflow is read-only with no secrets; gate script has no shell injection.
- What changed: public views remember every record up the tree with the template used; `publicOutput` takes `templateFor` and re-checks them all (`template_changed`); `currentTemplate` alone is refused for a record with parents (`ancestor_templates_unchecked`). Attack tests in `public-output.attacks.test.ts` fail without the fix.
- Decisions: D-020
- Review: one independent review of the diff: safe. It noted the ancestry itself isn't re-checked (S-001a), DECISIONS not updated (fixed) and a test not checking the issue path (fixed).
- Sources: OWASP ASVS 4.0.3 V8 (data protection), V5 (validation); Unicode UAX #15 (NFKC keeps precomposed letters).
- Note: the history on GitHub was rewritten before this run (the root commit is now T-005 and the local `main` had diverged); not by this run. This run built from origin/main and pushes a fast-forward.
- Gate: PASS · tests_passing 1397 (was 1393) · npm audit clean
- Next: T-005a Safe template changes (risky), now including S-002

## 2026-11-21 03:27 CT — upkeep — U-001 Direct tests for the shared helpers
- Result: done
- What changed: `npm outdated` shows only TypeScript 7 and Vite 8, both new majors turned down in D-006; the blockers still hold (typescript-eslint 8.73 peers TypeScript `<6.1`; Vite 8 requires MPL-2.0 `lightningcss`), so no bump and T-001b now tracks them. Everything else is current. Nine public helpers that every validator relies on had no tests of their own; `plain-data.test.ts` and `helpers.test.ts` now check their results directly (frozen copy, every refusal code and path, each limit at and over its edge, bounded work on hostile input). Tests only, no code changed; nothing they found was a bug. Commit 2436814.
- Decisions: none (D-006 still covers the two majors)
- Review: n/a (tests only)
- Note: local `main` in the sandbox was stale again (origin/main had been rewritten before this run, not by it); this run started from origin/main and pushed a fast-forward.
- Gate: PASS · tests_passing 1393 (was 1278) · npm audit clean
- Next: T-005a Safe template changes (risky)

## 2026-11-21 02:30 CT — manual (John) — D-019 Several organizations per install
- Result: done (decision recorded; no code)
- What changed: John's decision that each site's organization has its own IDs, rights, people and roles (the Society's archives and the library it hosts). PLATFORM_PLAN.md decision 3 updated; new task T-019 (organizations in the model) added before the schema, and T-025 and T-041 now depend on it.
- Decisions: D-019 (John)
- Review: n/a
- Gate: PASS · tests_passing 1278 (unchanged)
- Next: T-005a Safe template changes (risky)

## 2026-11-21 01:55 CT — manual (John) — D-018 One name: Oculus
- Result: done
- What changed: John dropped the part names. The whole project is Oculus; the staff back end is "the admin" and the public front end is "the public sites". Updated README, PLATFORM_PLAN, ROADMAP (planned packages are now `packages/service` and `packages/api`), AUTOPILOT, DESIGN.md, the mockup screens and the mockup generator (wordmark "Oculus"). "Polybius" stays only where it means the earlier desktop catalog or John's private repository.
- Decisions: D-018 (John; supersedes D-005)
- Review: n/a (names in docs and mockups only; no code)
- Gate: PASS · tests_passing 1278 (unchanged) · npm audit clean
- Next: T-005a Safe template changes (risky)

## 2026-11-21 00:39 CT — build — T-003a EDTF review follow-ups
- Result: done
- What changed: read the LoC EDTF spec (2019-02-04) and tested every example string in it (`edtf.spec-examples.test.ts`): all parse at their level except exponential years and significant digits, left out by D-008. `2004?-06~-11` stays refused, and the error now gives the prefix form `%2004-~06-11` (the old doc comment's `?2004-~06-11` dropped the year's `~`). Free text with a trailing `?` after a range ("1920-1925?") is flagged as ambiguous instead of getting `?` on both ends. Commits b468c26, 48abbc9.
- Decisions: D-017
- Review: one independent review (input handling). No security, data-loss or leak problems; the prefix suggestion is correct and includes only regex-matched parts. It found that "19th century?" was wrongly flagged (a single date that reads as an interval), a hint with fixed example years, and a wrong hint for "probably 1920-1925?". All fixed, with tests.
- Sources: https://www.loc.gov/standards/datetime/edtf.html
- Note: local `main` was stale (origin/main had been force-updated before this run, not by this run), so the merge was pushed as a fast-forward of origin/main (`git push origin HEAD:main`).
- Gate: PASS · tests_passing 1278 (was 1194) · npm audit clean
- Next: T-005a Safe template changes (risky)

## 2026-11-20 23:40 CT — manual (John asked to finish Phase 1) — T-011 Phase 1 review
- Result: done
- What changed: `docs/reports/2026-11-phase1-review.md` checks Phase 1 against PLATFORM_PLAN.md §1–2 and the mockup. The original Phase 1 tasks (T-001 to T-010) are done and strong, but §1 isn't fully met: admins can't add record types, records don't store which template they use, identifiers can live in two places, and accessions/deeds, storage and moves, loans and condition, and links between records aren't modelled. Those became Phase 1 tasks T-012 to T-018. Phase 2 is written as run-sized tasks T-020 to T-053, starting with decision tasks (PostgreSQL version, database access and migrations, HTTP framework, passwords and sessions, admin build); only T-040, T-050 and T-051 wait on Q-1 or Q-2. Added Q-4 (roles in the mockup) and Q-5 (OCR and D-004) for John.
- Decisions: none
- Review: n/a (planning only)
- Gate: PASS · tests_passing 1194 (unchanged) · npm audit clean
- Risk to note: Phase 2's logins and roles will be merged by the autopilot with only AI review; a person should review them before anything is deployed.
- Next: T-012 Records name their template

## 2026-11-20 23:00 CT — manual (John asked to finish Phase 1) — T-010 Dublin Core and JSON-LD output
- Result: done
- What changed: `publicOutput()` (`public-output.ts`) turns a `publicView` into a Dublin Core values object, OAI-PMH oai_dc XML and JSON-LD, refusing output unless the publish, mapping, rights-mapping and template checks all pass. Small changes to `effective.ts` (a view mark; the rights note left out of `publicView`) and doc comments in `rights.ts` and `templates.ts`. A separate fix to `dublin-core.ts`: the duplicate check no longer uses `JSON.stringify`, so a polluted `toJSON` can't block publishing (found by the builder, test added).
- Decisions: D-016 (supersedes D-015's rights-note bullet)
- Review: three independent reviews. None found a leak: staff values, notes, identifier types, ancestor IDs and unpublished records stayed out of every form; forging, mutation and injection held. Round 1 found own values published without the template check, JSON-LD ignoring DCMI term ranges, non-canonical URIs, a size cap that didn't count escaping (45M under a "5M" cap), rights not required in the mapping, an unclear rights-note policy and prototype pollution via `iri`. Round 2 found IRI characters RFC 3987 forbids, the rights note in `publicView`, stale views, the JSON text built before it was capped, `toJSON` pollution and missing DCMI types for digital assets. All fixed with tests that fail without the fix. The third reviewer ran realistic DACS, Spectrum and digital-asset records through jsonld.toRDF (in the scratchpad, not the repo) and the triples were correct.
- Sources: written from knowledge of DCMI Terms, DCMI Type, OAI-PMH 2.0 oai_dc, JSON-LD 1.1 and XML 1.0, because those sites couldn't be reached (T-010a).
- Gate: PASS · tests_passing 1194 (was 1110) · npm audit clean
- Next: T-011 Phase 1 review

## 2026-11-20 20:30 CT — manual (John asked to finish Phase 1) — T-006, T-007a, T-008, T-009
- Result: done (four tasks in parallel worktrees, merged one at a time with the gate after each rebase)
- What changed: **T-006** DACS, Spectrum and digital-asset presets with every public field citing its standard element, privacy-first defaults, and Dublin Core mappings that can only map public fields (`presets.ts`, `dublin-core.ts`). **T-007a** default checkers for rights and identifiers (`field-checkers.ts`); the stored rights value is `{ uri, note? }` and the `rights` field must be single, public and keyed `rights`. **T-008** the effective record with inheritance, sources and strictest visibility, `publicView` as the only source of public output, and `effectivePublishIssues` (`effective.ts`). **T-009** vocabularies and URI rules, a default controlled-term checker, and near-duplicate detection for Data Cleaning (`vocabularies.ts`, `term-duplicates.ts`).
- Decisions: D-012, D-013, D-014, D-015 (and D-011's first sentence corrected for the `{ uri, note? }` shape)
- Review: T-006 one review: safe; seven free-text fields that could name private people moved to staff, staff fields lost their DC cites, unconfirmed Spectrum cites marked as groups. T-007a one review: no check could be skipped, but the template and publish rule disagreed four ways (repeatable, staff, other-key and unchecked rights); all fixed. T-008 two reviews: the first confirmed a leak (a shared template object changed between calls turned a staff value public) plus five more; the second found a checker could rewrite a value after it was checked and that docs pointed publishing at the wrong check; all fixed with attack tests. T-009 two reviews: the first found 15–111 s runs and whole-check failure on one bad term; the second found an out-of-memory crash on NFKD-expanding labels, 23–30 s hostile runs and false pairs (World War I/II, Devanagari); all fixed, 50,000 hostile terms now under 2 s. A cross-cutting bug found by three builders (rights stored as an object but checked as a string) was decided and fixed in T-007a.
- Sources: SAA DACS (saa-ts-dacs.github.io 2022.0.4), DCMI Metadata Terms 2020-01-20, Collections Trust Spectrum 5.1 PDFs, id.loc.gov and "The LCCN Namespace". Not reachable: nomenclature.info, USGS GNIS, Collections Trust unit pages (see T-009a).
- Gate: PASS · tests_passing 1110 (was 810) · npm audit clean
- Next: T-010 Dublin Core and JSON-LD output, then T-011 Phase 1 review

## 2026-11-20 16:30 CT — manual (John asked to finish Phase 1) — T-004, T-005, T-007
- Result: done (three tasks built in parallel worktrees, merged one at a time with the gate run after each rebase)
- What changed: **T-004** identifier types with a safe format language (no admin-written regexes), comparison keys for lookalike characters, current and former identifiers with one primary, uniqueness checks, lookup by current or former ID, auto-numbering (`identifier-pattern.ts`, `identifier-key.ts`, `identifiers.ts`). **T-005** field templates as untrusted data, nine field kinds with value shapes, required/repeatable/visibility/inherited flags stated explicitly, record checking with a checker hook (`templates.ts`). **T-007** the 12 rightsstatements.org statements, CC 4.0, CC0 and the Public Domain Mark with canonical URIs, a normalizer that reports changes, and the publish rule for objects, archival units and digital assets (`rights.ts`).
- Decisions: D-009, D-010, D-011
- Review: T-004 had two fresh reviews (run as separate `claude -p` reviewers, read-only): retiring could lose notes, unchecked notes, numbering blocked by a stray value, lookalike gaps, decomposed accents; all fixed with tests. T-005 had one: rejected valid large templates, failed open on an unvalidated template, prototype-pollution reads, dropped checker paths, reserved keys, backslash URLs; all fixed with tests; three design gaps became T-005a and notes on T-008 and T-010. T-007 had one: safe; all URIs and labels confirmed; a hidden `rights` property passed the check (fixed), message wording (fixed); the which-kinds question was decided (D-011).
- Sources: rightsstatements.org (vocabulary 1.0, technical requirements v1.2.2) and creativecommons.org, read through WebFetch.
- Gate: PASS · tests_passing 810 (was 463) · npm audit clean
- Note: the remote task branches couldn't be deleted (the proxy refused with 403); they are merged and can be removed on GitHub.
- Next: T-006 Standards presets, T-008 Effective record, T-009 Controlled vocabularies (all unblocked)

## 2026-11-20 13:30 CT — manual (John asked to continue) — T-003 EDTF dates
- Result: done
- What changed: `parseEdtf()` (`edtf.ts`) validates EDTF levels 0 and 1 and the level 2 parts archives use (part qualifiers, X digits anywhere, groupings 25–41, sets), and gives every date earliest/latest days that hold every possible reading, a sort key and a sort year (null when the year starts with X). `edtfFromText()` (`edtf-text.ts`) turns common free text into EDTF and flags two-way forms (1900s, 6/5/1920, 1920-25, 1901-05, c1920, leading dash) instead of guessing; notes keep the original wording. 3 commits.
- Decisions: D-008
- Review: two independent reviews. The first found 7 problems (qualified "1920-25" read as a season, leading dash read as BCE, ISO-start ranges unreadable, no-year dates sorting as year 0, -0, doubled qualifiers, small free-text guesses); the second found 15, mostly bounds and guessing (hemisphere-free seasons, winter, XXX1 sort year, c1920 = copyright in library catalogs, centuries, "between" as a one-of set, separators in notes, unfrozen day objects). All fixed with tests except three judgement calls moved to T-003a. Neither review found a security hole; fuzzing 600k inputs found no throw or slow path.
- Sources: LoC EDTF 2019 (worked from knowledge of the spec: the loc.gov page couldn't be fetched this run, see T-003a), DACS 2.4, AACR2 "c" for copyright.
- Gate: PASS · tests_passing 463 (was 214) · npm audit clean
- Next: T-004 Typed identifiers (T-005 and T-007 are also unblocked)

## 2026-11-20 11:20 CT — manual (John asked to continue) — T-002 Record types
- Result: done
- What changed: six record kinds with `validateRecord()` / `createRecord()` (`records.ts`); `readPlainData()` copies untrusted input into frozen plain JSON and refuses getters, Proxies, hidden and symbol keys, arrays with extra properties or holes, disguised built-ins, prototype keys, control, invisible and direction-changing characters, and enforces size limits (`plain-data.ts`); arrangement rules and `validateArrangement()` / `unfiledUnits()` (`arrangement.ts`). 3 commits on the branch.
- Decisions: D-007 (record kinds and arrangement levels)
- Review: two independent reviews. The first found 15 problems (bypass via the caller's own object, throws, quadratic loops, sparse arrays and more); the second found 11 lower-severity ones (message escaping, wide objects, units lost from view and more). All fixed, each with a test in `records.attacks.test.ts` or `arrangement.test.ts`, except active media types, which moved to Phase 3 as M-001.
- Gate: PASS · tests_passing 214 (was 37) · npm audit clean
- Next: T-003 EDTF dates (T-004, T-005 and T-007 are also unblocked)

## 2026-11-20 05:51 CT — security — T-001 Project scaffold and gate
- Result: clean, then done (T-001)
- Security: clean. No package.json existed before this run, so nothing to audit; after T-001, `npm audit` finds 0. Secret scan of the whole tree and all 3 commits (keys, tokens, passwords, private keys, `.env`): nothing. Private data: mockup and generator use placeholders (`[Donor name]`, `[Volunteer]`) and public place and organization names; the only real person named is John. Dependabot alerts are disabled on the repo and code scanning is not reachable (403), so added T-001a (needs John). No code existed to review against ASVS.
- What changed: npm workspaces scaffold with `packages/core` (TypeScript 6 strict, ESLint 10, Prettier, Vitest 5), `npm run gate` (`scripts/gate.mjs`), SPDX-parsing license check, `gate-baseline.json`, `.nvmrc` 26, GitHub Actions gate workflow, and permanent record IDs (`packages/core/src/record-id.ts`) as the first real module. Vite 8 pulled in MPL-2.0 `lightningcss`, so Vite is pinned to 7. Commits 0f47579, 81a3798.
- Decisions: D-006
- Review: n/a (tooling only; no auth, data or public-output code)
- Gate: PASS · tests_passing 37 (was 0) · npm audit clean
- Next: T-002 Record types (T-003 EDTF dates is also unblocked)

## 2026-11-20 03:45 CT — setup — autopilot set up
- Result: done
- What changed: added AUTOPILOT.md, ROADMAP.md, DECISIONS.md and this file. There is no code and no gate yet.
- Decisions: D-001 to D-005
- Review: n/a
- Gate: none yet · tests_passing 0
- Next: T-001 Project scaffold and gate
