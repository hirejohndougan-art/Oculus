# Progress

One entry per run, newest at the top. Format: see [AUTOPILOT.md](AUTOPILOT.md).

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
