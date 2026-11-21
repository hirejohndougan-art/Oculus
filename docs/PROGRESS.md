# Progress

One entry per run, newest at the top. Format: see [AUTOPILOT.md](AUTOPILOT.md).

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
