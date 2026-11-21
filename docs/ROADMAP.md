# Roadmap

Phases follow [PLATFORM_PLAN.md](PLATFORM_PLAN.md) §10. Marks and procedure: [AUTOPILOT.md](AUTOPILOT.md).

## Waiting on John

These are never picked by a run. The weekly report repeats each question until John answers it.

- [ ] Q-1 One server app for Polybius and Hermes, or two apps sharing the database through the API? (needs John) Needed before Phase 2.
- [ ] Q-2 Hosting for the Historical Society, and the budget for hosting and storage. (needs John) Needed before Phase 2 deploys anywhere.
- [ ] Q-3 Should the Society's other websites move to Hermes eventually? (needs John) Not needed until Phase 5.

## Phase 1 — Record model and ID numbers

The data model in TypeScript, written for any archive or museum rather than one organization. There is no server or database yet: these are pure, tested modules in `packages/core`.

- [x] T-001 **Project scaffold and gate.**
  - An npm workspaces repo with `packages/core`: TypeScript in strict mode, ESLint, Prettier and Vitest.
  - `npm run gate` runs format, lint, typecheck, tests, build, `npm audit --audit-level=high` and a license check (MIT, BSD, ISC, Apache-2.0 or similarly permissive only).
  - `gate-baseline.json`, `.nvmrc` with the current Node LTS, and a GitHub Actions workflow that runs the gate on every push.
  - At least one real test, so the gate shows it is working.
- [ ] T-001a **Turn on GitHub security alerts.** (needs John)
  - Dependabot alerts are disabled on the repository and code scanning isn't reachable from the autopilot. John: enable Dependabot alerts and CodeQL default setup in the repo's Settings → Code security, so the security run can read them.
- [x] T-002 **Record types.** deps: T-001
  - Types and validators for object, archival unit (collection > series > file > item, nested to any depth), digital asset, agent (person, organization, family), place and event.
  - Every record has a permanent internal UUID.
  - Collections and series stay independent of each other (PLATFORM_PLAN.md §1).
- [x] T-003 **EDTF dates.** deps: T-001
  - Parse and validate Extended Date/Time Format (Library of Congress spec): levels 0 and 1, and the level 2 parts archives use.
  - Give every date a sort key and a clean sortable year.
  - Turn common free-text dates into EDTF ("about 1920" → `1920~`, "1950s" → `195X`, "late 1920s" → `192X` plus a note), and flag anything it can't read instead of guessing.
- [ ] T-003a **EDTF review follow-ups.** deps: T-003
  - Decide whether to accept a qualifier after more than one part (`2004?-06~-11`); the 2019 level 2 grammar may allow it. Check against the spec text.
  - Decide whether "1920-1925?" should put `?` on both ends (it does now) or be flagged.
  - Compare `parseEdtf` against the spec's full example list in a test, once the spec page can be read from the sandbox (this run's fetch was blocked).
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
- [ ] T-005a **Safe template changes.** deps: T-005 (risky)
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
- [ ] T-009a **Vocabulary follow-ups.** deps: T-009
  - Confirm the Nomenclature 4.0 and GNIS URI patterns from nomenclature.info and USGS once they can be reached, and tighten those checks.
  - A Data Cleaning report of LC-vocabulary terms with no URI.
- [ ] T-010 **Dublin Core and JSON-LD output.** deps: T-006, T-007, T-008
  - Turn a published record into Dublin Core and JSON-LD.
  - Unpublished and staff-only fields never appear in the output. (risky)
  - Fields not in the record's template (left over after a template edit) count as staff-only. Identifier types are staff-only unless marked public, and former-identifier notes are never published (from the T-004 review).
  - Build public output only from `publicView(effective)` and check it with `effectivePublishIssues` (D-013); never from `fields` or `record`.
  - Identifier fields publish only `value`, never `type`. The Dublin Core mapping doesn't check that a field's kind fits its term: handle each kind explicitly.
- [ ] T-011 **Phase 1 review.** deps: T-001 to T-010
  - Check the model against PLATFORM_PLAN.md §1–2 and the mockup screens.
  - Write the Phase 2 tasks, server and database, using whatever John has answered for Q-1 and Q-2 so far.

## Later phases: notes

- Phase 6 (Omeka migration): records with rights stored as a plain URI string need converting to `{ uri }`; add CC 1.0–3.0 licenses if the Omeka data uses them (D-011).

## Phase 2 — Server, database, logins, roles and change log
To be written by T-011.

## Phase 3 — Media
Tasks to be written when Phase 2 is done. Carried forward:
- [ ] M-001 **Serve active file types safely.** (risky) From the T-002 review: a digital asset's media type can be `text/html`, `image/svg+xml`, `application/xhtml+xml` or a script type, which is legitimate for born-digital files. When media is served, never send the stored media type as-is for these. Serve them as downloads (`Content-Disposition: attachment`), from a separate origin from the public sites, with a sandboxing Content-Security-Policy and `X-Content-Type-Options: nosniff`, and test that an uploaded HTML or SVG file can't run script on a Hermes site.

## Phases 4–7
Hermes public sites and editor; multiple sites; Omeka S migration and the Historical Society cutover; connections to other systems. See PLATFORM_PLAN.md §10.
