# T-053 Phase 2 review: data integrity, correctness and operations

Reviewer: Chat A's second reviewer, at main 6be4a8f . Proof-of-concept tests ran in a scratch copy (`/tmp/t053b-work`) against a throwaway PostgreSQL 16 (socket only, under `/tmp/t053b-tmp`). Both are deleted. Security is the other reviewer's half; this report covers data, correctness and operations.

**Summary.** I found **no BLOCKING issue**: nothing reachable from the admin today loses or corrupts data, or takes the server down by itself. The schema guards (triggers, privileges, the writer check, the lock order) hold up well. The gaps sit *between* features:

- One write path has neither a version nor lost-update protection.
- The production start command skips the writer-role check that the desktop launcher runs.
- Several jobs that the plan expects "a scheduler" to run are run by nothing.
- The gate's flaky tests come from a single cause.

---

## BLOCKING

None found.

---

## MEDIUM

### M1. Identifier-only edits write no version and slip past If-Match: a stale save silently undoes them
- **Area:** record lifecycle, change log, lost updates (D-061, D-063, D-079).
- **Where:** `packages/service/src/service.ts`.
  - `updateRecord`: lines 2192–2235. A record version (`updateStoredRecord`, which bumps `records.version` and writes `record_versions`) is written only when `compared.value.differences.length > 0`. The identifier set is saved at line 2230 with no version.
  - `saveIdentifiers`: lines 2260–2295, also with no version.
  - `record_snapshot` (0013) does not include identifiers, so no version records them either way.
  - The API exposes this: `PUT /api/records/:id` takes `identifiers` (`staff-api.ts`, around line 1028).
- **Repro** (scratch test added to `service.test.ts`; output kept):
  1. Create a record with numbers `DHS-1` (main) and `DHS-2`.
  2. Alice saves at `expectedVersion: 1` with the same fields and `DHS-2` as main. Result: `changed:false`, version stays 1.
  3. Bob, who also read version 1, saves at `expectedVersion: 1` with `DHS-1, DHS-2, DHS-3`. Result: `ok:true`.
  4. Final state: `DHS-1` main plus `DHS-3`. Alice's change is gone, and `record_versions` holds only version 1, so neither change appears in History or the Audit trail.
  5. The `numbers_dropped` confirmation catches only the case where the stale save *drops* a number. Changing which number is main, re-adding a number someone removed, or changing a former number all pass silently.
  6. Restoring an old version doesn't bring old numbers back either.
- **Why only MEDIUM:** the admin's `RecordEditor` sends `{ record }` only, so no screen can trigger this yet. It becomes data loss as soon as an identifier editor (or any API client) sends `identifiers`. Removing numbers through this path before a deletion (`holds_identifiers`) also leaves no trace of who removed them.
- **Suggested task (risky, one run):** treat an identifier change as a change.
  - Bump the record version and write a version row with `action = 'save'` and `changed_fields` naming the identifier types.
  - Either add `identifiers` to the snapshot (a migration replacing `record_snapshot`) or keep an `identifier_events` log.
  - Make `saveIdentifiers` take `expectedVersion`.
  - Tests: the race above, and History showing the change.

### M2. The production server never checks its database role; an update without `OCULUS_UPDATE_WRITER_ROLE` leaves new tables without grants
- **Area:** operations, the service as the only writer (D-067).
- **Where:**
  - `roles.ts:288` says to run `checkWriterConnection` "at startup and after every migration", and D-067 says the server "should refuse to start" when it reports anything.
  - Only `desktop-cli.ts:487–496` calls it. `RecordService.checkConnection` (`service.ts:3062`) has no caller.
  - `admin-cli.ts` and `buildAdminServer` (the documented `npm run admin` and T-060's start command) start on any role: a superuser, the owner (which can disable triggers and TRUNCATE history), or a writer missing privileges.
  - `release-cli.ts:390–406` with `update-manager.ts:918–937`: `npm run release -- install` migrates through `OCULUS_UPDATE_MIGRATE_DATABASE_URL ?? OCULUS_DATABASE_URL`. If `OCULUS_UPDATE_WRITER_ROLE` is unset, it skips the grant, prints a "Note:" and still switches `current`.
- **Repro, by code path:**
  1. Install a release that adds a table (as 0048 and 0049 did) with `OCULUS_UPDATE_WRITER_ROLE` unset. D-092 says database-changing updates go through `release -- install` on the server.
  2. The new version starts with no check. Every request touching the new table (each upload, for 0048's `file_scans`) answers 500 with `42501` until someone runs `db:grant`.
  3. Separately, every test that builds the admin server connects as the `postgres` superuser and starts fine, which shows that nothing refuses such a role.
- **Suggested task (risky):** make `buildAdminServer` (or `runAdminCli`) call `checkWriterConnection` before listening and refuse to start on anything it reports. Add a test with an owner, a superuser and a writer missing one grant. Make `release -- install` refuse to switch after migrations unless the writer role is named (or it can confirm `missing_privilege` is empty), instead of printing a note.

### M3. Nothing runs the cleanup or the alert notices on the desktop, and no time limit bounds staff transactions
- **Area:** operations, unbounded tables, timers.
- **Where:**
  - `runCleanup` (`sessions.ts:1239`) is run only by `npm run db:cleanup`. Neither `admin-cli.ts` nor `desktop-cli.ts` schedules it, and neither README nor DESKTOP.md tells a desktop user to.
  - `startAlertNotices` runs only in `admin-cli.ts`. The desktop launcher builds the server directly, so it never sends two-step alert notices.
  - S-045's alerts for unexplained wrong codes an hour old are written only by `runCleanup`.
  - Separately, the staff pool (`admin-cli.ts:47`: `openDatabase` with `max: 10`, no `connectionTimeoutMillis`, no `query_timeout`) and every staff transaction outside the searches run with no `lock_timeout` or `statement_timeout`. Neither `desktop:database` nor setup sets `ALTER ROLE … SET lock_timeout` (`ALLOWED_ROLE_SETTINGS` allows it; D-067 leaves it to T-051).
- **Effect:**
  - On the desktop, which is where Oculus actually runs today, `sessions`, `sign_in_throttles`, `second_step_throttles` and `password_resets` only grow, and the S-045 alert path is half off.
  - On any install, one transaction stuck holding a row or advisory lock makes staff requests queue on it, each holding one of the 10 connections. After that, sign-in and every staff route wait indefinitely in the pool queue: an outage until the holder ends. Example holders: a psql session, or an attach whose file-system call hangs inside its transaction.
- **Suggested task:**
  - Run `runCleanup` hourly in the admin process, with an overlap guard and failures logged by class. The desktop and the server both use `buildAdminServer`.
  - Start the alert notices from `buildAdminServer` too.
  - Give the staff pool a bounded wait (`connectionTimeoutMillis`, answered `503 busy`).
  - Have `desktop:database` and the T-051 runbook set `lock_timeout` and `idle_in_transaction_session_timeout` on the writer role.
  - Document `db:cleanup` in DESKTOP.md if it stays external.

### M4. The gate's load-sensitive failures come from vitest's default 5-second test timeout
- **Area:** tests and the gate.
- **Where:** `vitest.config.js` sets no `testTimeout`. Only one test in `second-factor.test.ts` has its own (line 1501).
- **Repro:** I ran `vitest run packages/db/src/vocabularies.test.ts packages/db/src/second-factor.test.ts` with 10 busy loops on this 2-core machine, twice.
  - Both runs failed with `Test timed out in 5000ms`, each time in three *different* second-factor tests (for example "the right password and a wrong code leave it alone", "lets a signed-in person re-enter…", "refuses the writer role every way around a code check").
  - Unloaded, the same tests take 0.24–1.3 s. The two deadlock tests (lines 1293 and 1848) took 1.9–2.3 s under load and passed in my runs; each also polls for up to 5 s before releasing.
  - Scrypt sign-ins plus several connections easily pass 5 s on a busy machine.
  - `vocabularies.test.ts` creates and migrates its database lazily inside whichever test calls `ready()` first (line 64), so the first test pays for all 34 migrations under the same 5 s limit.
- **The `migrate.test` 1 ms test** (line 879, "doesn't let one file's settings reach the next file"):
  - The file ends with `SET statement_timeout = 1`, so the runner's next statement, `RESET ALL` in `resetSession`, runs under a 1 ms limit. On a loaded machine that round trip can exceed 1 ms, giving `57014`, reported as a failure.
  - I couldn't reproduce it here, even with the server niced to 19 behind 8 busy loops. The mechanism follows from the code: only that one statement is exposed.
- **Suggested task (U-type, one run):**
  - Set `testTimeout: 30_000` and `hookTimeout: 120_000` for the suite (U-005 did this piecemeal).
  - Move lazy `ready()` migrations into `beforeAll`.
  - In migrate.test, use `SET statement_timeout = '20ms'` with `pg_sleep(0.2)` in 0003, which proves the same thing without a 1 ms window.
  - In the deadlock tests, wait for the specific backend (`pg_blocking_pids(<reset pid>)`) rather than any `Lock` wait, and fail clearly if it never waits instead of releasing after 5 s.
  - Assertions unchanged.

### M5. The change log misses definition edits and file actions
- **Area:** change log completeness (PLATFORM_PLAN §3: "A log of every change: who, what and when").
- **Where:** these in-place UPDATEs keep no history and, except where noted, no "who":
  - `identifier_types`: `identifiers.ts:328`. Neither who nor when-by-whom, although a format change can take published records off the public sites (S-033).
  - `terms`: `vocabularies.ts:393`. Renaming a label changes every published record that uses the term.
  - `sites.name`: `permissions.ts:443`.
  - `storage_levels` and `storage_locations`: the last `updated_by` only. Renaming or moving a location changes what past moves mean.
  - `dublin_core_mappings`: the last `changed_by` only. Accepted in D-096.
  - `system_settings`: the last `changed_by` only.
- **Not in the audit trail:** `readAuditTrail` (`people.ts:637–724`) reads only `record_versions`, `people_events` and `system_events`. File attaches and removals (`stored_file_events`), storage moves (`storage_moves`), accession saves (`accession_versions`) and share decisions are all logged but not shown, so "who removed this scan" is not answerable from the admin.
- **Suggested task:** a decision entry listing which definition edits get history. Then one task for a `definition_events` log covering identifier types, terms, sites and storage locations (insert-only, ALWAYS triggers, written in the save's transaction). A second task to add file events and storage moves to the audit query, scoped like record versions.

---

## LOW

### L1. A copy placed by an attach that then rolls back is never reclaimed
- **Where:**
  - `files.ts:950` places the bytes inside the attach transaction, before the `attached` event and COMMIT.
  - `purgeCandidates` (`stored-files.ts:397`) takes only contents whose newest event is `removed`.
  - The sweep removes only `incoming/` temporaries.
- **Effect:** if the attach fails after `place` (connection lost, COMMIT failure, a crash), the copy stays at its content path with no row and no event, forever and invisibly. It is also outside the quota, which counts rows. Migration 0039's header (line 37) says the purge would also free "a copy an attach placed but never committed", and D-086's history mentions "old orphans", but S-052 implemented only removals. A database restored alone leaves the same kind of orphan.
- **Task:** decide (decision entry) whether to bring back a committed `placing` intent before `place`, so the purge can take a placing with no `attached` after 7 days, or to document that such copies stay. Fix the 0039 and D-086 wording either way.

### L2. Migrations run under the database's own time limits, and with no lock limit during an in-place update
- **Where:** `migrate.ts:627` opens the files' session without overriding `statement_timeout`, `transaction_timeout` (PG17+) or `lock_timeout`, although the runner turns these off on its lock session.
- **Repro:** with `ALTER DATABASE … SET statement_timeout = '500ms'`, a migration file holding `SELECT pg_sleep(1)` fails: `refused failed 0002_slow_one.sql failed: canceling statement due to statement timeout`. A heavy real migration (a table rewrite, a validated constraint on `records`) on a large catalog would fail the same way. The failure is safe: the file is rolled back.
- **In-place updates:** T-060 migrates while the old server is still serving. An `ALTER TABLE records` waits behind a long reader (a Subjects count may run up to 120 s), and every staff and public query queues behind the ALTER meanwhile.
- **Task:**
  - Set `statement_timeout` and `transaction_timeout` to 0 inside each file's transaction (`set_config(…, true)`, so the reset still isolates files).
  - Give it a bounded `lock_timeout` with a retry or a clear refusal.
  - Write a rule (DECISIONS) that migrations must be safe for the previous release to keep running on, since `migrations_failed` and `grant_failed` leave the old version running on the new schema.

### L3. No test upgrades a *populated* database across migrations
Every test migrates an empty database from 0001.

I read each data-sensitive statement:
- 0005 backfills versions.
- 0013 adds `records_home_site`.
- 0015, 0016 and 0040 widen key checks; each new pattern is a superset of the old.
- 0014 deletes sessions.
- 0039 tightens `stored_files_original_name_format`, but 0038 and 0039 merged together in 1782e83.
- 0043 runs an UPDATE through the share trigger.
- 0049 adds `system_events_shape`.

None fails on rows the earlier code could write. Nothing *tests* that, though.

**Task:** a test that migrates to N−1 (a truncated migrations directory), writes representative rows with direct SQL, and migrates to head, for each migration that ALTERs an existing table.

### L4. Append-only tables guarded only by privileges
- `storage_moves` ("insert only", D-115) and `accession_versions` have no UPDATE, DELETE or TRUNCATE triggers.
- `second_step_alert_notices` has an UPDATE guard but nothing against DELETE or TRUNCATE.
- `second_step_passes` has no DELETE guard.
- `record_versions`, `people_events`, `system_events`, `stored_file_events` and the purge and scan logs all have both.

The writer can't change any of these by privilege, so this is defence in depth only, but the pattern is inconsistent. I confirmed on a migrated database that all 111 non-internal triggers are `ENABLE ALWAYS`.

**Task:** add `*_append_only` and `*_no_truncate` triggers to these four in one migration.

### L5. Writers outside the service
The API writes three tables through the db package directly, not through the service:
- `oai_datestamps` (`public-subjects.ts:291`, `writeOaiStamps`);
- `system_events` (`update-change-log.ts`);
- `second_step_alert_notices` (`alert-notices.ts`).

All are on the writer role, and none touches catalog data. The lint rule (driver and `.query()` only inside packages/db) holds: no `.query(` or `pg` import outside `client.ts` and `packages/db`. "The service is the only writer" is therefore a convention, not something the code enforces.

**Task:** list these exceptions in D-067, or route them through service functions.

### L6. The alert-notice runner queues missed ticks
`alert-notices.ts:65`: `running = running.then(once)` every minute. A run that hangs on the unbounded staff pool (M3), or on the advisory lock `pg_advisory_xact_lock(85, 0)`, which waits with no limit, piles up one queued run per minute. All of them then run back-to-back, and `stop()` waits for all of them.

**Task:** skip a tick while a run is in flight, and use `pg_try_advisory_xact_lock` (another process is already doing the work).

### L7. Stale comments
- `roles.ts:88`: stored files "rows never change and nothing deletes them yet". The writer has DELETE, and `removeFile` uses it.
- `roles.ts:105`: shares "rows go with their record". 0043 dropped the cascade, and shares now outlive their record as `deleted`.
- `admin-server.ts:579` and `:616` call `publicSubjects?.start()` twice. This is harmless, because `start()` returns when a timer exists, but the second call is dead code.

---

## Checked and found sound

**Migrations and runner**
- 0001–0049 apply cleanly (34 files; the numbers have gaps).
- The runner's lock, its checks for edited, missing and out-of-order files, the transaction-ended, prepared-transaction and deferred-trigger cases, the session reset between files, and two concurrent runners: 56 tests pass.
- Restore's `compareMigrations` lets an older backup be restored and then migrated.

**Writer role and triggers**
- `WRITER_PRIVILEGES` covers every table written after 0046–0049: `accessions`, `donor_contacts`, `storage_*`, `file_scans`, `file_scan_events` and `file_purge_steps`. Tables filled by triggers (`accession_records`, `accession_numbers`, `accession_versions`) are SELECT-only for the writer and written by a SECURITY DEFINER trigger.
- `checkWriterConnection` allowlists exactly these grants and requires every non-internal trigger to fire ALWAYS. All 111 do.

**Record lifecycle**
- Deletion refuses or locks correctly against every table that references records:
  - foreign keys from `identifier_holdings`, `record_term_index`, `role_assignments`, `stored_files`, `accession_records`, `accessions.source_agent_id`, `donor_contacts`, `storage_locations.agent_id` and `storage_moves`;
  - `record_shares` (trigger, 0043, offer `FOR SHARE`);
  - `oai_datestamps` (no foreign key by design, marked deleted by the pass).
- `records.kind` is immutable (0005's keep-identity), so the "files only on digital assets" check at INSERT can't be bypassed by changing an asset's kind later.

**Lock order**
- Lock order across advisory classes 65, 69, 70, 85, 114 and 115 and row locks:
  - an accession save (114 exclusive, then foreign-key `KEY SHARE`) can't deadlock with a publish or edit, which takes `NO KEY UPDATE` or `SHARE` and then 114 shared;
  - a deletion (`FOR UPDATE`) never takes 114 or 115;
  - the purge takes 70 then 69, and the attach takes the record row then 69;
  - storage takes 115 then foreign-key `KEY SHARE`.
- Single-key (bigint) and two-key advisory locks live in separate spaces (`objsubid` 1 and 2).

**Files**
- Every check runs again under the 70 and 69 locks.
- A step's rename followed by a crash before COMMIT is put back on the next run.
- An upload brings a trashed copy back.
- `stored_content_kept` protects infected contents.
- The scan queue uses a lease and one generation per content.
- The sweep never touches stored copies.
- Timers are unref'd and cleared on close.
- The Subjects pass and the scan queue are stopped before the pools close.
- In-memory maps (rate limits, thumbnail budgets, download streams) are bounded.

**Backups**
- The manifest is read in pg_dump's snapshot.
- Restore goes only into an empty database, by a plain role, and is verified afterwards.

**Updates**
- An update makes a backup, migrates, grants and switches, and refuses a rollback after the database changed.

**Tests**
- Unloaded, `vocabularies` paging and both second-factor deadlock tests pass (0.1–1.3 s). Their failures are timeouts (M4), not logic.

## Scratch cleanup
- The throwaway PostgreSQL (PID 17736, under `/tmp/t053b-tmp/oculus-pg-*`) was stopped by PID. Its launcher's SIGTERM didn't stop it, so it was killed directly; no `t053b` process is left.
- `/tmp/t053b-work` (the scratch repo copy, PoC scripts and migrations) and `/tmp/t053b-tmp` were deleted.
- Nothing in the review worktree (`git status` is clean), `/home/claude/oculus`, other worktrees or any files folder was changed.
- Nothing was committed.
