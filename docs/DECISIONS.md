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

## D-007 — Record kinds and the arrangement levels (2026-11-20, autopilot T-002)
Six record kinds: object, archival unit, digital asset, agent, place and event. An archival unit has a `level` (fonds, series, collection, file or item) and an optional `parentId`.
- **The levels follow how Polybius works today:** Fonds (whose records) › Series (what kind of records) › Collection (the group items are filed in, by topic or how the creator kept them) › File › Item. A unit can be filed under any higher level, so levels can be skipped: a collection can sit straight in a fonds, and an item straight in a collection. That keeps collections and series independent (PLATFORM_PLAN.md §1). Series and files can contain more of their own level (sub-series, sub-files), so the tree goes as deep as needed, up to a safety limit of 64.
- **A unit with no parent is allowed.** It's either a top-level fonds or collection, or something not filed yet (the "Needs Sorting" list).
- **Rejected: ISAD(G)'s level list as-is** (fonds, subfonds, series, subseries, file, item). It has no "collection" level between series and file, which is where Polybius files items today. Subfonds can be added later as a level if an organization needs it.
- **Rejected: collections as a separate many-to-many grouping outside the tree.** That would mean two ways to file the same item, which is harder to explain to volunteers and to show in a finding aid. A topical grouping that cuts across the tree can come later, as exhibits or tags.
- **Validation is strict.** Unknown properties, untrimmed titles, control characters, non-JSON field values and the keys `__proto__`, `constructor` and `prototype` are all reported. Nothing is fixed silently.

## D-008 — How dates are stored, bounded and sorted (2026-11-20, autopilot T-003)
Dates are stored as EDTF text (Library of Congress EDTF, 2019; ISO 8601-2). `parseEdtf` derives everything else from that text, so nothing derived is stored as the truth.
- **Supported:** levels 0 and 1 in full, and from level 2: qualifiers on single parts, X digits anywhere, sub-year groupings 25–41 and sets. **Rejected:** exponential years and significant digits (geological and astronomical time, not collections). Each part takes one qualifier and a date takes one trailing qualifier; that is stricter than some readings of the level 2 grammar, and can be loosened later without breaking stored data.
- **Bounds hold every possible day, and can be wider.** `earliest`/`latest` are for search and filtering, so leaving out a real possibility is worse than being wide. Seasons 21–24 don't name a hemisphere, so they cover both; winter covers December of the year before to February of the year after. `~` and `?` don't widen bounds: inventing a "± N years" range would be making things up.
- **Sort key** is `year*10000 + month*100 + day` of the earliest day (latest when the start is open). It's an exact integer up to year 999,999,999 and orders BCE years correctly. Dates whose year starts with X get no sort key and sort last, rather than as year 0.
- **Free text is converted only when the reading is safe.** Two-way forms ("1900s", "6/5/1920", "1920-25", "1901-05", "c1920", a leading dash, "'50s") are flagged, not guessed. Where EDTF can't say all the text said ("late 1920s" → `192X`, centuries), the result keeps the original words as a note.
- **Rejected: an EDTF package from npm** (such as edtf.js). The parser is small enough to own and test here, and owning it keeps the bounds, sorting and flag-don't-guess rules exactly as above. It can be compared against edtf.js in tests later if useful.

## D-009 — Typed identifiers: safe formats, comparison keys, uniqueness and numbering (2026-11-20, autopilot T-004)
Each identifier type has a key, a label, an optional format, a uniqueness rule (`none`, `current` or `all_time`) and optional auto-numbering: `year` (`2026.015`) or `prefix` (`DHS-0001`). A record has current identifiers, exactly one of them primary, and former ones. Former identifiers are history: they are never checked against today's format and may name a type that has since been removed.
- **Formats are a small language of our own, not regexes.** `#` is a digit, `@` an ASCII letter, `*` either, `{n}`/`{n,m}` repeats, `\` escapes. A format compiles to at most 200 single-character slots, and matching tracks every reachable slot at once, so it never backtracks. *Rejected:* compiling admin-written regexes (ReDoS) and regex "safety" checkers (incomplete).
- **Values are stored exactly as typed and compared by a key.** The key applies NFKC, maps Cyrillic, Greek and Armenian letters that look Latin and all dashes to `-`, folds case, and removes spaces and invisible characters. It errs towards calling identifiers the same. `0`/`O` and `1`/`l` stay distinct. *Rejected:* changing stored values, and the full Unicode TR39 confusables table (large; not read, so nothing claims to follow it).
- **The next number is the highest in use + 1,** counting former values, so retired numbers are never reused and gaps are not filled. Numbers the type's format could never produce are ignored. The caller supplies the year.

## D-010 — Field templates: field definitions, value shapes and the checker hook (2026-11-20, autopilot T-005)
A template is untrusted data: `{ key, label, description?, appliesTo: RecordKind[], fields }`, checked by `validateTemplate`, and checked again inside `checkRecordAgainstTemplate`, which fails closed with `invalid_template`. Each field definition holds `key`, `label`, `help?`, `kind`, `required`, `repeatable`, `visibility` (`public` or `staff`), `inherited`, `standards?` (`{standard, element, uri?}`) and kind-specific `options`, `vocabularies`, `identifierTypes` or `maxLength`. The flags and `visibility` must always be stated, with no defaults, so a field can never become public by being left out.
- **Value shapes:** text (one trimmed line), long_text, date (EDTF, checked with `parseEdtf`), list (one option value; several choices means a repeatable list), controlled_term `{label, uri?, vocabulary?}`, identifier `{type, value}`, link `{url, label?}`, rights `{uri, note?}`, place `{label, uri?, recordId?}`. A repeatable field stores a non-empty list. An empty value is left out, never stored as null, "" or []. URLs must be http or https with no user name, password or backslash; this checks what is stored and is not a guard against server-side requests.
- **Kind-specific checks plug in** through `options.checkers[kind]`, a function `(value, field, record) => FieldProblem[]`. A checker that throws or returns something malformed makes the value fail.
- **Hardening:** optional settings are read as own properties only; template keys and codes refuse `constructor` and `prototype`. Limits: 200 fields, 500 options per list, 10,000 options per template.
- **Rejected:** defaults for `visibility` and the other flags (a missing value could make a field public by mistake); `link` as a link to another record (a separate relationship feature, since publishing it could reveal unpublished records); requiring a vocabulary on every term (T-009 decides that).

## D-011 — How rights are stored and the publish rule (2026-11-20, autopilot T-007)
A record's rights are one canonical URI in the template field `rights`. Accepted values are the 12 rightsstatements.org 1.0 statements, the six Creative Commons 4.0 International licenses, CC0 1.0 and the Public Domain Mark 1.0. Either a statement or a CC tool meets the rule that a record needs rights before it can be published.
- **The rule covers the kinds that hold copyrightable content:** object, archival unit and digital asset. Agent, place and event records can be published without rights. A record whose kind is missing or unknown is checked anyway.
- **What the check reads:** only own, enumerable data properties of the exact frozen record being published. Getters, hidden properties and Proxies are reported as unreadable.
- **Canonical forms are the ones each issuer publishes.** rightsstatements.org uses `http://`, the `/vocab/` path and a trailing slash (its technical requirements v1.2.2 say `/page/` URLs "MUST NOT be used" in metadata). Creative Commons uses `https://creativecommons.org/licenses/by/4.0/`.
- **Variants are fixed only through `normalizeRightsUri`, which lists every change** (http/https, `/page/`, trailing slash, `deed`/`legalcode` endings, `www.`, a query or fragment, spaces). Stored values that aren't canonical are refused with `not_canonical`.
- **Rejected for now:** CC versions 1.0 to 3.0 and national ports (reported as `unsupported_version`; the full list couldn't be confirmed and none is current; add them if the Omeka migration needs them); CC's "Certification 1.0 US" (not a current tool); several rights values per record (`edm:rights` takes one).
