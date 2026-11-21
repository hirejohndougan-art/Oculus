# Progress

One entry per run, newest at the top. Format: see [AUTOPILOT.md](AUTOPILOT.md).

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
