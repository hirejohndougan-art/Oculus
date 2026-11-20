# Progress

One entry per run, newest at the top. Format: see [AUTOPILOT.md](AUTOPILOT.md).

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
