# Progress

One entry per run, newest at the top. Format: see [AUTOPILOT.md](AUTOPILOT.md).

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
