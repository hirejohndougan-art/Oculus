# Decisions

Newest at the bottom. Each entry gives the choice, what was rejected, and why.

## D-001 — Public repository (2026-11-20, John)
Oculus is developed in a public GitHub repository. Nothing private goes in it: no secrets, no private data about real people, and no code from John's private repositories (see D-002).

## D-002 — MIT license; permissive dependencies only (2026-11-20, John)
The code is MIT-licensed, so any archive, museum or historical society can use it. Dependencies must be MIT, BSD, ISC, Apache-2.0 or similarly permissive. GPL, AGPL and LGPL are not allowed, because they would change the terms for anyone installing Oculus. Code from John's private repositories (Polybius, Blueprint and others) may be brought in only by an entry here written by John.

## D-003 — Built by autopilot, no human approval (2026-11-20, John)
Three scheduled sessions each night (build, upkeep, security) do one task each, check it against the gate, and merge to `main` themselves. This is the same model as John's Blueprint, Argus and FerroJS projects. John can switch to pull requests he approves by changing step j of AUTOPILOT.md and recording it here.

## D-004 — No AI inside the product (carried over from the Polybius project)
Oculus contains no hosted AI, no AI SDKs and no pretrained models. Suggestion features use classical retrieval: BM25 plus a curated synonym list.

## D-005 — Platform name and parts (2026-11-20, John)
The platform is **Oculus**. Its staff back end is called **Polybius** and its public sites are called **Hermes**. These are names for parts of one product, not separate products.

## D-006 — Toolchain, Node version and the license allowlist (2026-11-20, autopilot T-001)
npm workspaces (`packages/*`), TypeScript 6.0 in strict mode (plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`), ESLint 10 with typescript-eslint's strict type-checked rules, Prettier 3 and Vitest 5. `.nvmrc` is Node 26, the Active LTS line ("Lithium", LTS from October 2026, supported to April 2029); `engines` allows Node 22 and later, because the build sandbox runs 22. ES modules only.
- TypeScript 7 (the native port) was rejected for now: typescript-eslint 8 supports only `<6.1`.
- Vite is pinned to 7 as a dev dependency. Vitest 5 accepts Vite 6–8, but Vite 8 requires `lightningcss`, which is MPL-2.0. MPL is file-level copyleft, so it is treated as not allowed under D-002, even for dev tools. Vite 7 has it only as an optional peer, so it is not installed.
- The license check (`scripts/check-licenses.mjs`) allows MIT, MIT-0, ISC, 0BSD, BSD-2/3-Clause, Apache-2.0, BlueOak-1.0.0, CC0-1.0, CC-BY-4.0 (data files), Unlicense, Python-2.0 and Zlib. It parses SPDX expressions (AND binds tighter than OR) and fails closed on anything else, including `WITH` exceptions and missing licenses. Adding a license to the list needs a decision entry.
- Prettier checks code and config only; the hand-written Markdown docs and the generated mockup are excluded so the gate doesn't rewrite them.
