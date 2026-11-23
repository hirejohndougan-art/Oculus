# Roadmap

Phases follow [PLATFORM_PLAN.md](PLATFORM_PLAN.md) §10. Marks and procedure: [AUTOPILOT.md](AUTOPILOT.md).

## Waiting on John

These are never picked by a run. The weekly report repeats each question until John answers it.

- [x] Q-1 One server app for the admin and the public sites, or two apps sharing the database through the API? John: one app (D-034).
- [x] Q-2 Hosting for the Historical Society, and the budget for hosting and storage. John: SiteGround for the Society, but any host must work (D-035).
- [x] Q-3 Should the Society's other websites move to Oculus eventually? John: no (D-032).
- [x] Q-4 Roles: the mockup shows "Scanner" and "Donor relations" roles that the plan doesn't have. Should Phase 2 add them? John: yes, and system managers can create custom roles (D-036).
- [x] Q-5 OCR: common OCR engines ship trained models. Does D-004 (no AI in the product) rule them out, or is classical OCR allowed? John: allow it for OCR, locally run and permissively licensed (D-033).

## Phase 1 — Record model and ID numbers

The data model in TypeScript, written for any archive or museum rather than one organization. There is no server or database yet: these are pure, tested modules in `packages/core`.

- [x] S-008 **Another organization's template keys revealed.** (risky, security run 2026-11-23) Done.
  - `templateOfRecord` compared or looked up a record's `templateKey` before checking the template's organization: `template_mismatch` quoted another organization's key, `unknown_template` vs `wrong_organization` told which keys another organization's registry holds, and `wrong_organization` named the key. Now the organization is checked first and the message names no key.
- [ ] S-009 **Identifier type creation reveals another organization's keys.** (risky, security run 2026-11-23)
  - `identifierTypeCreation` with another organization's `identifierTypes` gives `key_taken` when that organization has the key and `mixed_organizations` otherwise (`identifier-type-changes.ts` `readUse` with `listed=false`, before the check at about line 563). Check the organization first, as S-008 did for templates.
- [ ] S-010 **Kept views publish without re-checks by default.** (risky, security run 2026-11-23)
  - `publicOutput` re-checks a kept view against current records and templates only when the caller passes `records` and `templateFor`; without them a value whose field has since been made staff is still published, while the identifier check already fails closed. Make both required for a kept view (or have the service layer always build the view at publish time), with an attack test.
- [ ] S-011 **Link labels to unpublished or other organizations' records.** (risky, security run 2026-11-23)
  - A `record_link`'s label is published even when its target is unpublished or another organization's; only the ID is held back. If labels are filled from the target's title (e.g. a donor's name), that leaks. Decide: hold back labels of unpublished targets, or require staff-written labels and say so in `record-links.ts`; fix the module header's "never reveals that an unpublished record exists".
- [x] S-001 **Public output re-checks ancestors' templates.** (risky, security run 2026-11-21)
  - A view kept from earlier published a value inherited from a parent whose template had since made the field staff; `currentTemplate` compared only the record's own template. Fixed with `templateFor` (D-020).
- [x] S-001a **Stale ancestry in a kept view.** deps: S-001 (risky) Done: `records` option, `record_changed` (D-021).
  - `templateFor` re-checks the ancestors the view was built with. A record moved to another parent since, or a template chosen from record data that has changed, isn't caught. Compare the chain against current records too (e.g. an optional record lookup), or make kept views expire.
- [x] S-002 **Stored staff values published when their field turns public.** (risky) Done: `templateChanges` (D-023), the main part of T-005a.
  - A value entered while its field was staff is published silently once the field is made public or a removed staff key is reused by a new public field (e.g. DACS `notes`). T-005a's template comparison must report these records and require confirmation; consider refusing key reuse for a different field.
- [x] S-003 **Precomposed Greek and Cyrillic lookalikes in identifiers.** (risky) Done (D-024).
  - `identifierKey` misses `Ӧ`/`Ö`, `Ӓ`/`Ä`, `Ά`/`Á`, `έ`/`é`, `ό`/`ó`, `Ӑ`/`Ă` and others, because NFKC keeps them precomposed: two identical-looking identifiers pass the uniqueness check. Decompose before mapping, then recompose. Also treat U+2800 (Braille blank) like a space or refuse it.
- [x] S-004 **En and em dashes bypass the free-text date ambiguity guard.** (risky) Done; also a dash after "probably"/"maybe" is flagged.
  - `edtfFromText("1920–25")` returns `1920-25` (spring 1920) instead of flagging it like `"1920-25"`; the guard at `edtf-text.ts` checks only ASCII `-` before dashes are normalised. Normalise first, then check.
- [x] S-005 **Near-duplicate term detection over its time target.** (risky) Done: lossless prefilters, faster distance, same recall. One shape (44-letter keys from two letters) still takes ~3.1 s; see S-005a.
  - 50,000 labels of 6–7 short random words take about 3.6 s against the 2 s target (`term-duplicates.ts` `spelling`), because short keys are charged the 500-cell minimum. Tighten the budget or the blocking.
- [x] S-006 **Identifier types have no visibility.** (risky) Done: `public` flag, staff by default (D-022). Callers must pass `checkers.identifier` to `effectiveRecord` or identifiers aren't published.
  - A public `identifier` field with no `identifierTypes` publishes values of any type, including ones an organization treats as private. Decide whether types get a `public` flag (staff by default, as the T-004 review asked) and refuse unlisted types in public fields.
- [x] S-005a **Two-letter keys in near-duplicate detection.** deps: S-005
  - 50,000 keys of 44 letters drawn from two letters take ~3.1 s (target 2 s); about 0.7 s is the abbreviation pass. Needs a bit-parallel distance or faster abbreviation work, without losing pairs.
  - Done: 50,000 two-letter keys now take about 1.7–1.8 s (was 3.7–4.7 s): a diagonal bounded edit distance, pair visits kept as bits and cheaper abbreviation work, with tests that compare every hostile shape against the old algorithm.
- [x] S-006a **Inherited identifier lists with one staff-type number.** deps: S-006
  - A repeatable identifier list inherited through public fields is dropped whole from the child's effective record (staff side too) when one number is a staff type; staff see only a `not_valid_here` note. Keep the staff copy on the child. The checker's refusal message also names the staff type's label.


  - Done: the inherited value is kept as the child's staff value (D-041); no message names the staff type or quotes its number.
- [x] T-001 **Project scaffold and gate.**
  - An npm workspaces repo with `packages/core`: TypeScript in strict mode, ESLint, Prettier and Vitest.
  - `npm run gate` runs format, lint, typecheck, tests, build, `npm audit --audit-level=high` and a license check (MIT, BSD, ISC, Apache-2.0 or similarly permissive only).
  - `gate-baseline.json`, `.nvmrc` with the current Node LTS, and a GitHub Actions workflow that runs the gate on every push.
  - At least one real test, so the gate shows it is working.
- [ ] T-001a **Turn on GitHub security alerts.** (needs John)
  - Dependabot alerts are disabled on the repository and code scanning isn't reachable from the autopilot. John: enable Dependabot alerts and CodeQL default setup in the repo's Settings → Code security, so the security run can read them.
- [ ] T-001b **Revisit TypeScript 7 and Vite 8.**
  - Both majors were turned down in D-006 and the upkeep run of 2026-11-21 found the reasons still hold: typescript-eslint 8.73 supports only TypeScript `<6.1`, and Vite 8 still depends on MPL-2.0 `lightningcss`. Move when typescript-eslint supports TypeScript 7, or when Vite drops `lightningcss` as a required dependency; each move gets its own decision entry.
- [x] U-001 **Direct tests for the shared helpers.** (upkeep)
  - `readPlainData`, `textProblem`, `isPlainObject`, `IssueList`, the kind and level guards, `isLeapYear` and `patternMismatchMessage` had no tests of their own (`plain-data.test.ts`, `helpers.test.ts`).
- [x] U-002 **Direct tests for the organization helpers.** (upkeep)
  - `oneOrganization`, `organizationIdOf`, `mixedOrganizationsIssue` (used by every module that keeps organizations apart) and the public `isIdentifierTypeKey` had no tests of their own (`organization-helpers.test.ts`).
- [x] T-002 **Record types.** deps: T-001
  - Types and validators for object, archival unit (collection > series > file > item, nested to any depth), digital asset, agent (person, organization, family), place and event.
  - Every record has a permanent internal UUID.
  - Collections and series stay independent of each other (PLATFORM_PLAN.md §1).
- [x] T-003 **EDTF dates.** deps: T-001
  - Parse and validate Extended Date/Time Format (Library of Congress spec): levels 0 and 1, and the level 2 parts archives use.
  - Give every date a sort key and a clean sortable year.
  - Turn common free-text dates into EDTF ("about 1920" → `1920~`, "1950s" → `195X`, "late 1920s" → `192X` plus a note), and flag anything it can't read instead of guessing.
- [x] T-003a **EDTF review follow-ups.** deps: T-003
  - Decide whether to accept a qualifier after more than one part (`2004?-06~-11`); the 2019 level 2 grammar may allow it. Check against the spec text.
  - Decide whether "1920-1925?" should put `?` on both ends (it does now) or be flagged.
  - Compare `parseEdtf` against the spec's full example list in a test, once the spec page can be read from the sandbox (this run's fetch was blocked).
  - Done: the spec page was read; every example is tested (`edtf.spec-examples.test.ts`). `2004?-06~-11` isn't a spec example and stays refused, with the prefix form (`%2004-~06-11`) in the error. A trailing `?` after a free-text range is flagged. See D-017.
- [x] T-004 **Typed identifiers.** deps: T-002
  - Identifier types defined by the organization, each with a format pattern, a uniqueness rule and optional auto-numbering (year-based `2026.015`, or prefix plus digits `DHS-0001`).
  - Any number of identifiers per record, one of them marked primary.
  - Former IDs kept and searchable.
- [x] T-005 **Field templates.** deps: T-002
  - Field templates as data: field kinds (text, long text, date, list, controlled term, identifier, link, rights, place).
  - Rules for required fields and repeatable fields.
  - Validation of a record against its template.
- [x] T-007a **Wire the field kinds to their modules.** deps: T-004, T-005, T-007
  - Ready-made checkers for the template `identifier` kind (T-004 identifier types) and `rights` kind (T-007 `validateRightsUri`), so `checkRecordAgainstTemplate` uses them by default.
- [x] T-005a **Safe template changes.** deps: T-005 (risky)
  - Done: `templateChanges` for field templates (S-002, D-023); `identifierTypeChanges`, `identifierTypeDeletion`, `identifierTypeCreation` and `legacyTemplateIssues`, and one key rule for identifier types (D-031).
  - Compare a new version of a template with the old one before it's saved. Switching a field from `staff` to `public` would publish existing staff data, so it must be reported for confirmation. Renaming or removing a key, changing its kind or `repeatable`, or dropping a list option must report the records affected rather than strand their data.
  - The same check for identifier types (T-004): editing or deleting a type checks existing records first.
  - Template `identifierTypes` codes allow hyphens but identifier type keys don't; align them.
- [x] T-006 **Standards presets.** deps: T-005
  - Starting templates for DACS (archival units), Spectrum-style museum objects and digital assets.
  - A Dublin Core mapping for publishing.
  - Each field cites the standard element it maps to.
- [x] T-007 **Rights.** deps: T-002
  - rightsstatements.org statements (the 12 URIs, with labels) and Creative Commons licenses.
  - The rule from the design: a record without a rights statement can't be published.
- [x] T-008 **Effective record.** deps: T-002, T-007 (risky)
  - Fields inherited down the hierarchy (fonds → series → collection → item), with the item's own value winning.
  - It reports where each value came from, matching the mockup's Effective Record screen.
  - From the T-005 review: visibility belongs to each template's field, and records in one hierarchy can use different templates. A value from a `staff` field must never become `public` by being inherited into a child whose template marks the same key `public`: keep the strictest visibility along the chain.
- [x] T-009 **Controlled vocabularies.** deps: T-005
  - A vocabulary and term model (LCSH, LCNAF, LCGFT, Nomenclature 4.0, GNIS and local terms), stored as URIs plus labels.
  - Near-duplicate detection for local terms, to feed Data Cleaning.
  - No downloaded vocabulary data yet.
- [~] T-009a **Vocabulary follow-ups.** deps: T-009
  - Confirm the Nomenclature 4.0 and GNIS URI patterns from nomenclature.info and USGS once they can be reached, and tighten those checks.
  - A Data Cleaning report of LC-vocabulary terms with no URI.
  - Done: `findLcTermsWithoutUri`, the Data Cleaning report of LC terms with no URI. Still open: the Nomenclature 4.0 and GNIS URI forms (nomenclature.info and the USGS pages couldn't be read on 2026-11-23).
- [x] T-010 **Dublin Core and JSON-LD output.** deps: T-006, T-007, T-008
  - Turn a published record into Dublin Core and JSON-LD.
  - Unpublished and staff-only fields never appear in the output. (risky)
  - Fields not in the record's template (left over after a template edit) count as staff-only. Identifier types are staff-only unless marked public, and former-identifier notes are never published (from the T-004 review).
  - Build public output only from `publicView(effective)` and check it with `effectivePublishIssues` (D-013); never from `fields` or `record`.
  - Identifier fields publish only `value`, never `type`. The Dublin Core mapping doesn't check that a field's kind fits its term: handle each kind explicitly.
- [x] T-010a **Check public output against the specs.** deps: T-010
  - DCMI term ranges, the DCMI Type URIs, the oai_dc namespace and schema location and the XML 1.0 Char rule were written from knowledge, because dublincore.org, openarchives.org and w3.org couldn't be reached. Check them against the specs when they can be read, and add a JSON-LD processor check in a test if a permissive dev dependency is acceptable (decision entry).
  - Records need a real publish state (Phase 2); `published` is the caller's word until then.
  - Done: checked against DCMI Terms, OAI-PMH 2.0, XML 1.0 and JSON-LD 1.1 (D-042); `dcterms:type` now has no range, and a test runs the output through a JSON-LD processor. The publish-state part moves to T-034.
- [x] T-011 **Phase 1 review.** deps: T-001 to T-010
  - Check the model against PLATFORM_PLAN.md §1–2 and the mockup screens.
  - Write the Phase 2 tasks, server and database, using whatever John has answered for Q-1 and Q-2 so far.
  - Done: [reports/2026-11-phase1-review.md](reports/2026-11-phase1-review.md). Q-1 and Q-2 were unanswered, so the Phase 2 tasks that need them say so. The gaps it found are T-012 to T-018.
- [x] T-012 **Records name their template.** deps: T-005, T-008 Done: `templateKey` on records, `indexTemplates` registry, mismatches refused; no version pin (D-029).
  - Each record stores the key of the template it follows, so the checks and `effectiveRecord` find the template from the record instead of from a lookup the caller supplies. Decide whether a record also pins a template version (decision entry). The database schema (T-025) needs this.
- [x] T-013 **Organization-defined record types.** deps: T-012
  - Record types carry a required `organizationId` and are refused across organizations, like templates (D-030, T-019a).
  - PLATFORM_PLAN.md §1 says "admins can add more types", but the six kinds are a fixed list. Decide between new kinds and organization-defined types built on the six (say "Oral history" as a kind of digital asset, with its own default template), then build the type definition and its validator (decision entry).
  - Done: D-037: organization record types on the six kinds, with a registry, defaults and `recordTypeTemplateIssues`.
- [x] T-014 **One home for identifiers, and public identifier types.** deps: T-004, T-010 (risky)
  - Numbers can live both in `RecordIdentifiers` (identifiers.ts) and in template fields of kind `identifier` (`reference_code`, `object_number`). Pick one source of truth (decision entry) and add a `public` flag to identifier types, so a primary number reaches public output only when its type is public.
  - Done: D-038: numbers live in `RecordIdentifiers`; fields point at a current identifier; `publicOutput` requires the identifier sets and refuses numbers no longer held.
- [x] T-015 **Links between records.** deps: T-012 (risky)
  - Values that point at agent, place or event records: a creator linked to the Authorities list (mockup Authorities, record "Creator"), and related records. Public output follows the D-016 rule: a link to an unpublished record goes out as its label only, never its ID.
  - Done: D-039: a `record_link` kind and `makeRecordLinkChecker`; links name a record only when it is published and the organization's own; the public view holds no linked IDs.
- [x] T-016 **Accessions and deeds of gift.** deps: T-012, T-015 (risky)
  - An accession model (Spectrum acquisition and accessioning): its number (an identifier type), source agent, date received, method, materials, restrictions, deed status (missing, sent, signed, not needed) and the records it produced. A check that holds back from publishing any record whose accession needs a signed deed it doesn't have (mockup Deeds). Accessions and donor contact details are always staff-only.
  - Done: D-043: a staff-only accession register per organization; a deed check that refuses publishing held records and makes links to them labels.
- [x] T-017 **Storage locations and moves.** deps: T-012
  - Storage levels the organization names (Room › Shelf › Box › Folder, from Settings), containers, a record's normal and current location, and moves with a reason and an expected return date (Spectrum location and movement control; mockup Storage and Whereabouts). Staff-only.
  - Done: D-040: storage levels, locations and a move log as the only truth, staff-only, per organization (`storage.ts`).
- [x] T-018 **Loans and condition checks.** deps: T-017
  - Spectrum loans in and out (lender or borrower agent, dates, items, status) and condition checks (date, who checked, condition, notes), as dated entries on objects and archival units (mockup Whereabouts, Conservators, record "Condition"). Staff-only.
  - Done: D-044: loans in and out that point at moves, condition checks and fit to move, and a `departure` move reason; overdue loans can't be hidden.
- [ ] T-016a **Structured restrictions on accessions.** deps: T-016 (risky)
  - Restrictions are free text today and hold nothing back. Add structured ones (closed until a date; staff and researchers only, as in the Log an accession mockup) that hold records back like an unsigned deed.
- [ ] T-018a **Loan follow-ups.** deps: T-018, T-016
  - A borrowed item that becomes the organization's (bought or given) needs a link from an accession to close its loan in. Link a condition check's `loanId` to the loan book and warn when a loan out goes without a recent fit check. Valuation, insurance and authoriser fields.
- [ ] T-013a **Record type edits checked against records.** deps: T-013
  - Editing a record type's kind or key, or deleting it, should list the records that use it first, as `templateChanges` does for templates; optionally a `recordTypes` input on `templateChanges`.
- [ ] T-015a **Link follow-ups.** deps: T-015
  - `templateChanges` should report a narrowed `recordKinds` with the records whose links no longer fit; a report of link labels that no longer match the linked record's name.
- [ ] S-007 **Messages in `publicOutput` issues.** (risky) deps: T-014
  - From the integration review: `publicOutput` passes the template check's problems through as they are, and the identifier checker's `unknown_type` and `format_mismatch` messages quote a type key or a number. Decide whether `publicOutput` issues are staff-only (and say so) or replace those messages with fixed text.
- [ ] U-003 **Small hardening and test speed.**
  - `template-changes.ts` reads `record.templateKey` without checking it is the record's own property; read it as an own data property. The wall-clock tests in `vocabularies.attacks`, `identifiers.attacks`, `term-duplicates` and `effective` fail when the 2-CPU machine is busy: measure relative to a baseline run in the same process, or move the heaviest behind a separate script that the gate still runs.

## Later phases: notes

- Phase 6 (Omeka migration): records with rights stored as a plain URI string need converting to `{ uri }`; add CC 1.0–3.0 licenses if the Omeka data uses them (D-011).
- Not yet in any phase (T-011 review): reading-room researchers and checkouts (mockup Researchers, Checkouts). Researchers are private data about real people. Place it at a monthly review.
- Phase 3: OCR (mockup OCR) may use an engine with trained models, run locally and permissively licensed (D-033). Choosing the engine is a decision task when Phase 3 is planned.
- Later: looking up LCSH, LCNAF and LCGFT terms while cataloging needs either downloaded vocabulary data or live requests to id.loc.gov (outbound requests, a security review). Printable reports (mockup Reports), Data Cleaning and Subjects screens, and box labels with QR codes still need a phase.

## Phase 2 — Server, database, logins, roles and change log

Written by T-011 ([review](reports/2026-11-phase1-review.md)). Q-1 (one app or two) and Q-2 (hosting and budget) were unanswered, so tasks that need either say `deps: Q-1` or `deps: Q-2` and wait. Everything else is written so it works whatever John answers: one PostgreSQL database, the service layer as the only writer, and an HTTP API in its own package. Library choices are decision tasks. Each choice must be permissively licensed (D-002), actively maintained (a release in the last 12 months and more than one maintainer, or a foundation behind it), free of AI features and SDKs (D-004), with a small dependency tree, and must pass `npm audit` and the license check.

Decisions first:
- [ ] T-020 **Decision: PostgreSQL version and database tests.** deps: T-011
  - Choose the PostgreSQL major versions Oculus supports (community-supported releases only), and how the gate runs database tests: locally (the sandbox has PostgreSQL 16) and in GitHub Actions (a service container). The gate must stay one command and must not get weaker. The decision entry says Q-2 may narrow the version range later.
- [ ] T-021 **Decision: database access and migrations.** deps: T-020
  - Compare a plain driver with hand-written SQL, a query builder and an ORM (for example `pg`, `postgres`, Kysely, Drizzle; check each license and release history yourself). Pick one, plus a migration approach, against the Phase 2 criteria and these: parameterized queries only, JSONB and full-text search usable without raw-string building, migrations a person can read as SQL, and TypeScript types. Decision entry.
- [ ] T-022 **Decision: Node HTTP framework.** deps: T-011
  - Compare Node's built-in `http` with maintained frameworks (for example Fastify, Hono, Express 5) against the Phase 2 criteria and these: its security record (GitHub advisories), request size limits, cookie handling, and no need for WebSockets (a host may not allow them, Q-2). Decision entry.
- [ ] T-023 **Decision: passwords, two-factor and sessions.** deps: T-011
  - Choose password hashing (OWASP Password Storage Cheat Sheet: Argon2id, or Node's built-in scrypt), the second factor (TOTP per RFC 6238, with recovery codes; WebAuthn later or now), and server-side sessions in PostgreSQL versus signed tokens, against OWASP ASVS and the Phase 2 criteria. Prefer `node:crypto` where it is enough. Decision entry.

Database:
- [ ] T-024 **Migrations tooling and the empty schema.** deps: T-020, T-021 (risky)
  - A `packages/db` package with the chosen tool, `npm run db:migrate` that applies migrations forwards to the database named in an environment variable (no password in the repo, not even for tests), and a test that runs every migration on a fresh database. The gate and the CI workflow start a test database as T-020 decided.
- [~] T-019 **Decision and model: organizations in one install.** deps: T-011 (risky)
  - D-019 (John): one install holds several organizations, each with its own records, templates, identifier types, rights settings, people, roles and sites. Example: the Historical Society's archives number items like `DS5C740001`; the library it hosts numbers them `DPL1`, `DPL2`, `DPL3`. Add an organization to the core model and scope every record, template, identifier type and vocabulary to one. Identifier uniqueness is per organization, so two organizations can hold the same number. Separation is complete, as if each were its own copy of Oculus (D-019): nothing is shared, including templates, vocabularies and people lists. One person can have access to several organizations with separate roles in each and switch between them; a session always works in exactly one. Tests try to read or write across organizations through every core function and fail. Also from D-019: a site can be password protected (an extra check on top of sign-in and roles; decide how the site password is stored and rate-limited, with the security review), and System settings cover the whole install, set only by system admins. Users are managed for all sites in one place, and after sign-in a person sees only the sites they have a role on (D-019). The schema (T-025 onward) and roles (T-041) build on this. Check that the identifier format language (D-009) covers both examples, including unpadded auto-numbers (`DPL#{1,9}`).
  - Done (D-030): `Organization` and `Site` types; records, identifier types and identifier sets carry a required `organizationId`; every function taking a set refuses mixed or unowned entries and reads its input once; identifier checkers are tied to their organization.
- [x] T-019a **Organizations on templates and record types.** deps: T-019 (risky)
  - `organizationId` on templates (and record types, T-013); `effectiveRecord`, `templateChanges` and `publicOutput` refuse another organization's template; `indexTemplates` refuses a mixed registry.
  - Done (D-030 "Templates"): templates carry a required `organizationId`; every path that picks a record's template refuses another organization's; presets stay organization-free and `templateFromPreset` makes an organization's copy. Record types get theirs in T-013.
- [ ] T-019b **Organizations on vocabularies, terms, rights settings and Dublin Core mappings.** deps: T-019 (risky)
  - From the T-019a review: a Dublin Core mapping is matched to a template by key only, so one organization's mapping passes for another's template with the same key. Nothing private can be published that way (every entry must be a public field of the target template), but mappings should carry an `organizationId` like everything else.
- [ ] T-019d **Site passwords.** deps: T-019, T-023 (risky)
  - How a password-protected site (D-019) stores its password and rate-limits attempts; needs the Phase 2 password decision.
- [ ] T-012a **Follow-ups from T-012 and T-005a.** deps: T-012, T-005a
  - `made_staff` and `templateChanges` pick records by `templateKey`; compare the two templates when a record moves to another template; `nextIdentifier` also counts numbers held in template identifier fields; remove the lookup-function path once every record has a key.
- [ ] T-025 **Schema: records, templates and record types.** deps: T-024, T-012, T-013, T-019 (risky)
  - Tables for records (UUID key, kind, record type, template key, title, level, parent, JSONB `fields`, timestamps), plus templates and record types stored as validated JSON with versions. Check constraints and foreign keys back up the core rules. Tests round-trip every preset and invented sample records through the core validators.
- [ ] T-026 **Schema: identifiers, with uniqueness the database enforces.** deps: T-025, T-014 (risky)
  - Tables for identifier types and current and former identifiers. Each value is stored with its `identifierKey` beside it, and unique indexes enforce the `current` and `all_time` rules, so two saves at the same moment can't take the same number. The next auto-number is given out inside a transaction. Tests race two saves.
- [ ] T-027 **Schema: vocabularies and terms.** deps: T-025
  - Tables for local terms and stored authority terms (vocabulary, URI, label), and an index of which records use which terms, so the Subjects counts and Data Cleaning can be worked out without scanning every record.
- [ ] T-028 **Staff search.** deps: T-025, T-026 (risky)
  - PostgreSQL full-text search over titles and text fields, and lookup by current or former identifier through the comparison key (§2 "old numbers stay searchable"), with ranking and accent-insensitive matching. This is staff search only. A public search (Phase 4) must index only published public views, and this index must never be used for it.
- [ ] T-052 **Backup and restore tools.** deps: T-024 (risky)
  - A script that backs up the database to a file and one that restores it into an empty database, with a test that restores a backup and finds every record and version. Backups are a command any scheduler can run (D-035); where the copies go is set up in T-051.

Change log and versions:
- [ ] T-029 **Change log and version history.** deps: T-025 (risky)
  - Every write stores a full new version of the record (who, when, which fields changed, an optional reason) in an append-only table, in the same transaction as the change. The database role the app uses can't update or delete versions. This feeds the mockup's History tab and Audit trail.
- [ ] T-030 **Compare and restore versions.** deps: T-029 (risky)
  - Compare any two versions field by field. Restoring writes a new version equal to an old one, never deleting history, and runs today's template, identifier uniqueness and rights checks first, reporting anything the old version no longer passes instead of saving it.
- [ ] T-031 **Edit-conflict protection.** deps: T-029 (risky)
  - Every update names the version it started from. A save based on an older version is refused with a list of what changed since, so two people can't silently overwrite each other's work. No locks or WebSockets are needed.

The writer:
- [ ] T-032 **The service layer: one writer.** deps: T-026, T-029, T-031 (risky)
  - A `packages/service` service, with no HTTP yet, that holds the only database role allowed to write. Every save validates the record, checks it against its template (with the identifier checker), re-checks identifier uniqueness inside the transaction, and writes the version and change log. Tests try to write around it with every other role and fail.
- [ ] T-034 **Workflow states and a real publish state.** deps: T-032, T-016 (risky)
  - Records get a stored state (draft, ready for review, published, withdrawn, as in the mockup), changed only through the service. Publishing runs `effectivePublishIssues` and the accession deed check at that moment. `publicOutput` takes published IDs from the database instead of the caller's `published` list (replacing that part of D-016, with a decision entry and closing the last part of T-010a). Shape it so publishing can later be per site (Phase 5, "Show on these sites") without a schema rewrite.

Logins and roles:
- [ ] T-036 **User accounts and password sign-in.** deps: T-023, T-024 (risky)
  - Users, passwords hashed as T-023 decided, sign-in with rate limiting and lockout per OWASP ASVS, and the same reply for a wrong user name as for a wrong password. Accounts are created by an admin's invitation; there is no public sign-up.
- [ ] T-037 **Sessions.** deps: T-036, T-022 (risky)
  - Server-side sessions with random IDs stored hashed, cookies with HttpOnly, Secure and SameSite, idle and absolute time limits, a new session ID at sign-in and on any role change, sign-out everywhere, and CSRF protection on every change.
- [ ] T-038 **Optional two-factor sign-in.** deps: T-037 (risky)
  - A user can turn on a second factor as T-023 decided, with single-use recovery codes. An admin can require it for admins. Tests cover replayed codes and brute force.
- [ ] T-039 **Password reset tokens.** deps: T-036 (risky)
  - Single-use, short-lived reset tokens, stored hashed. A reset ends every session for that user. Requests get the same reply whether or not the account exists. Sending the message goes through an interface with a test double, so this task doesn't need an email service.
- [ ] T-041 **Roles and collection-level permissions.** deps: T-036, T-032, T-019 (risky)
  - D-025 (John): system managers can do everything (sites, plugins, themes, users, System settings); site managers have full control of only their assigned sites and choose among installed plugins and themes. Below them, roles granted for the whole catalog or for chosen fonds or collections and the units below them. The service checks them on every read and write, and anything not granted is refused.
  - D-036 (John): roles are sets of permissions from a fixed list, and the service checks permissions, never role names. Built-in roles: cataloger, reviewer, read-only, Scanner (upload and attach scans only) and Donor relations (donors, accessions and deeds only). Only roles with the publish permission publish (reviewers and site managers by default; mockup Settings).
- [ ] T-041a **Custom roles.** deps: T-041 (risky)
  - D-036: system managers create, edit and delete roles from the permission list, each owned by one organization. No custom role can hold system-manager powers; built-in roles can't be deleted. Editing or deleting a role in use shows who is affected, deleting one in use needs those people moved, adding publish, donor-data or people permissions needs confirmation, and every change goes in the change log. Tests try to grant a system power through a custom role, use another organization's role, and keep a deleted role's access.
- [ ] T-035 **Optional approval step.** deps: T-034, T-041 (risky)
  - An organization setting that, when on, holds edits and publish requests as pending versions until a reviewer approves or rejects them, with both recorded in the change log. When it's off, saves go straight through as today.

The API:
- [ ] T-042 **HTTP API: records, templates and identifier types.** deps: T-022, T-032, T-037, T-041 (risky)
  - JSON endpoints in their own package (`packages/api`) that wrap the service layer for reading, creating and updating records, templates and identifier types. Request size limits, input checked with the core validators, errors without stack traces, and a test for each endpoint with no session, the wrong role and the wrong collection. How it is deployed alongside the public sites waits on Q-1 (T-050).
- [ ] T-043 **API: history, restore, approval and publishing.** deps: T-042, T-030, T-034, T-035 (risky)
  - Endpoints for versions, compare, restore, the change log, the approval queue and publish/unpublish, with the same permission tests as T-042.

Admin screens in the browser:
- [ ] T-044 **Decision: how the React admin is built.** deps: T-011
  - Choose how the admin is built and served in development: React with the already-pinned Vite 7 (D-006), routing, and how forms are generated from templates. Use the Phase 2 criteria, plus WCAG 2.1 AA support and DESIGN.md's tokens. Where it is served from in production waits on Q-1. Decision entry.
- [ ] T-045 **Admin: sign-in and the screen frame.** deps: T-044, T-042 (risky)
  - The Login screen, the sidebar and the top bar from DESIGN.md, wired to sign-in, two-factor and sign-out, and accessible (WCAG 2.1 AA, keyboard and screen reader tested).
- [ ] T-046 **Admin: item list and record editor.** deps: T-045, T-043 (risky)
  - The Item Records list and the Record editor (mockup Items, AdminRecord), with the form built from the record's template, ID numbers, the History tab with compare and restore, the edit-conflict message, and blocked actions that explain themselves ("Can't publish yet: choose a rights statement").
- [ ] T-047 **Admin: templates and identifier types.** deps: T-046, T-005a (risky)
  - Screens to edit field templates, record types and identifier types (Settings, ID numbers tab), which show T-005a's safe-change report and require confirmation before a staff field becomes public or records are affected.
- [ ] T-048 **Admin: people, roles and the audit trail.** deps: T-045, T-041, T-041a, T-043 (risky)
  - Settings › People & roles (invite, change role, grant collections, require two-factor) and the Audit trail on Audit & Reports, with search by person, record and date.
- [ ] T-049 **Admin: review queue.** deps: T-046, T-035 (risky)
  - A screen listing pending changes and records ready for review, with approve and reject, available to reviewers and admins only.

Server and deployment:
- [ ] T-050 **Server layout for the admin and the public sites.** deps: T-042 (risky)
  - One app (D-034). The public sites may read only published data, through a read-only path (its own database role or a public read API) that tests show can't reach staff fields or unpublished records.
- [ ] T-040 **Sending password reset email.** deps: T-039 (risky)
  - Deliver reset and invitation messages over SMTP (D-035), so any host's mail or a mail service works, with its credentials only in environment variables, and nothing about the account in the message beyond the link.
- [ ] T-051 **Deploy and run.** deps: T-050, T-052 (needs John) (risky)
  - Production setup for any host meeting D-035, with SiteGround as the first: confirm with John that his plan allows a long-running Node process, then TLS, secrets from the environment, scheduled backups and an off-site copy (T-052), session and token cleanup as commands a scheduler or cron can run, and a written runbook for updates and restore (§9). Never deploy without John.

- [ ] T-053 **Phase 2 review.** deps: T-020 to T-052
  - Check Phase 2 against PLATFORM_PLAN.md §3 and the "one writer" principle, get an independent security review of the whole of Phase 2, and write the Phase 3 tasks (including M-001).

## Phase 3 — Media
Tasks to be written when Phase 2 is done. Carried forward:
- [ ] M-001 **Serve active file types safely.** (risky) From the T-002 review: a digital asset's media type can be `text/html`, `image/svg+xml`, `application/xhtml+xml` or a script type, which is legitimate for born-digital files. When media is served, never send the stored media type as-is for these. Serve them as downloads (`Content-Disposition: attachment`), from a separate origin from the public sites, with a sandboxing Content-Security-Policy and `X-Content-Type-Options: nosniff`, and test that an uploaded HTML or SVG file can't run script on a public site.

## Phases 4–7
Plugins and themes (D-025, John: system managers install them, site managers choose among the installed ones). Before any plugin system: - [ ] P-001 **Decision: what a plugin may do and how it's checked before install.** (risky) Plugins run code on the server, so this needs a security model (permissions, signing like the update packages in PLATFORM_PLAN §9, the D-002 license rule).

Public sites and editor (John, 2026-11-21: each site gets a **Design** item in its menu, opening one page with tabs for Menus, Pages, Themes, Headers and Footers, all editable, with changes kept as a draft until published. **Later the same day (John):** the site editor also covers popups, global blocks (edit once, used everywhere), a dated notice bar; templates that every published record fills in (item page, finding aid, collection page, people/groups/places, search and browse, and system pages: 404, not public, password); exhibits and forms (contact, research requests, donation offers that feed Public submissions); and site-wide settings for site style (theme plus named colours and text styles), site media, search engines and sharing, redirects from old Omeka links, and legal pages. News and events belong to the site that creates them, each site keeping its own (John). Site managers can see other sites' published events and import copies, the one exception to D-019 (D-028). **Editing a page (John):** a signed-in editor viewing the public site sees a bar at the top with Edit page; until they choose it they browse the site normally. In edit mode only the page itself changes; the header and footer still show but are locked and are edited under Headers and Footers. Each site has exactly one header and one footer (John). Record page templates have a show/hide toggle per field, managed by system and site managers (D-026). Publishing runs a check: serious accessibility problems block, minor ones warn (D-027).); multiple sites; Omeka S migration and the Historical Society cutover; connections to other systems. See PLATFORM_PLAN.md §10.
