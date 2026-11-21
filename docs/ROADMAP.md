# Roadmap

Phases follow [PLATFORM_PLAN.md](PLATFORM_PLAN.md) §10. Marks and procedure: [AUTOPILOT.md](AUTOPILOT.md).

## Waiting on John

These are never picked by a run. The weekly report repeats each question until John answers it.

- [ ] Q-1 One server app for Polybius and Hermes, or two apps sharing the database through the API? (needs John) Needed before Phase 2.
- [ ] Q-2 Hosting for the Historical Society, and the budget for hosting and storage. (needs John) Needed before Phase 2 deploys anywhere.
- [ ] Q-3 Should the Society's other websites move to Hermes eventually? (needs John) Not needed until Phase 5.
- [ ] Q-4 Roles: the mockup shows "Scanner" and "Donor relations" roles that the plan doesn't have. Should Phase 2 add them? (needs John) Needed before T-041.
- [ ] Q-5 OCR: common OCR engines ship trained models. Does D-004 (no AI in the product) rule them out, or is classical OCR allowed? (needs John) Needed before OCR work.

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
- [x] T-010 **Dublin Core and JSON-LD output.** deps: T-006, T-007, T-008
  - Turn a published record into Dublin Core and JSON-LD.
  - Unpublished and staff-only fields never appear in the output. (risky)
  - Fields not in the record's template (left over after a template edit) count as staff-only. Identifier types are staff-only unless marked public, and former-identifier notes are never published (from the T-004 review).
  - Build public output only from `publicView(effective)` and check it with `effectivePublishIssues` (D-013); never from `fields` or `record`.
  - Identifier fields publish only `value`, never `type`. The Dublin Core mapping doesn't check that a field's kind fits its term: handle each kind explicitly.
- [ ] T-010a **Check public output against the specs.** deps: T-010
  - DCMI term ranges, the DCMI Type URIs, the oai_dc namespace and schema location and the XML 1.0 Char rule were written from knowledge, because dublincore.org, openarchives.org and w3.org couldn't be reached. Check them against the specs when they can be read, and add a JSON-LD processor check in a test if a permissive dev dependency is acceptable (decision entry).
  - Records need a real publish state (Phase 2); `published` is the caller's word until then.
- [x] T-011 **Phase 1 review.** deps: T-001 to T-010
  - Check the model against PLATFORM_PLAN.md §1–2 and the mockup screens.
  - Write the Phase 2 tasks, server and database, using whatever John has answered for Q-1 and Q-2 so far.
  - Done: [reports/2026-11-phase1-review.md](reports/2026-11-phase1-review.md). Q-1 and Q-2 were unanswered, so the Phase 2 tasks that need them say so. The gaps it found are T-012 to T-018.
- [ ] T-012 **Records name their template.** deps: T-005, T-008
  - Each record stores the key of the template it follows, so the checks and `effectiveRecord` find the template from the record instead of from a lookup the caller supplies. Decide whether a record also pins a template version (decision entry). The database schema (T-025) needs this.
- [ ] T-013 **Organization-defined record types.** deps: T-012
  - PLATFORM_PLAN.md §1 says "admins can add more types", but the six kinds are a fixed list. Decide between new kinds and organization-defined types built on the six (say "Oral history" as a kind of digital asset, with its own default template), then build the type definition and its validator (decision entry).
- [ ] T-014 **One home for identifiers, and public identifier types.** deps: T-004, T-010 (risky)
  - Numbers can live both in `RecordIdentifiers` (identifiers.ts) and in template fields of kind `identifier` (`reference_code`, `object_number`). Pick one source of truth (decision entry) and add a `public` flag to identifier types, so a primary number reaches public output only when its type is public.
- [ ] T-015 **Links between records.** deps: T-012 (risky)
  - Values that point at agent, place or event records: a creator linked to the Authorities list (mockup Authorities, record "Creator"), and related records. Public output follows the D-016 rule: a link to an unpublished record goes out as its label only, never its ID.
- [ ] T-016 **Accessions and deeds of gift.** deps: T-012, T-015 (risky)
  - An accession model (Spectrum acquisition and accessioning): its number (an identifier type), source agent, date received, method, materials, restrictions, deed status (missing, sent, signed, not needed) and the records it produced. A check that holds back from publishing any record whose accession needs a signed deed it doesn't have (mockup Deeds). Accessions and donor contact details are always staff-only.
- [ ] T-017 **Storage locations and moves.** deps: T-012
  - Storage levels the organization names (Room › Shelf › Box › Folder, from Settings), containers, a record's normal and current location, and moves with a reason and an expected return date (Spectrum location and movement control; mockup Storage and Whereabouts). Staff-only.
- [ ] T-018 **Loans and condition checks.** deps: T-017
  - Spectrum loans in and out (lender or borrower agent, dates, items, status) and condition checks (date, who checked, condition, notes), as dated entries on objects and archival units (mockup Whereabouts, Conservators, record "Condition"). Staff-only.

## Later phases: notes

- Phase 6 (Omeka migration): records with rights stored as a plain URI string need converting to `{ uri }`; add CC 1.0–3.0 licenses if the Omeka data uses them (D-011).
- Not yet in any phase (T-011 review): reading-room researchers and checkouts (mockup Researchers, Checkouts). Researchers are private data about real people. Place it at a monthly review.
- Phase 3: OCR (mockup OCR) may conflict with D-004 if the engine ships trained models. Ask John before planning it.
- Later: looking up LCSH, LCNAF and LCGFT terms while cataloging needs either downloaded vocabulary data or live requests to id.loc.gov (outbound requests, a security review). Printable reports (mockup Reports), Data Cleaning and Subjects screens, and box labels with QR codes still need a phase.

## Phase 2 — Server, database, logins, roles and change log

Written by T-011 ([review](reports/2026-11-phase1-review.md)). Q-1 (one app or two) and Q-2 (hosting and budget) were unanswered, so tasks that need either say `deps: Q-1` or `deps: Q-2` and wait. Everything else is written so it works whatever John answers: one PostgreSQL database, the Polybius service layer as the only writer, and an HTTP API in its own package. Library choices are decision tasks. Each choice must be permissively licensed (D-002), actively maintained (a release in the last 12 months and more than one maintainer, or a foundation behind it), free of AI features and SDKs (D-004), with a small dependency tree, and must pass `npm audit` and the license check.

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
- [ ] T-025 **Schema: records, templates and record types.** deps: T-024, T-012, T-013 (risky)
  - Tables for records (UUID key, kind, record type, template key, title, level, parent, JSONB `fields`, timestamps), plus templates and record types stored as validated JSON with versions. Check constraints and foreign keys back up the core rules. Tests round-trip every preset and invented sample records through the core validators.
- [ ] T-026 **Schema: identifiers, with uniqueness the database enforces.** deps: T-025, T-014 (risky)
  - Tables for identifier types and current and former identifiers. Each value is stored with its `identifierKey` beside it, and unique indexes enforce the `current` and `all_time` rules, so two saves at the same moment can't take the same number. The next auto-number is given out inside a transaction. Tests race two saves.
- [ ] T-027 **Schema: vocabularies and terms.** deps: T-025
  - Tables for local terms and stored authority terms (vocabulary, URI, label), and an index of which records use which terms, so the Subjects counts and Data Cleaning can be worked out without scanning every record.
- [ ] T-028 **Staff search.** deps: T-025, T-026 (risky)
  - PostgreSQL full-text search over titles and text fields, and lookup by current or former identifier through the comparison key (§2 "old numbers stay searchable"), with ranking and accent-insensitive matching. This is staff search only. A public search (Phase 4) must index only published public views, and this index must never be used for it.
- [ ] T-052 **Backup and restore tools.** deps: T-024 (risky)
  - A script that backs up the database to a file and one that restores it into an empty database, with a test that restores a backup and finds every record and version. When and where backups run waits on Q-2 (T-051).

Change log and versions:
- [ ] T-029 **Change log and version history.** deps: T-025 (risky)
  - Every write stores a full new version of the record (who, when, which fields changed, an optional reason) in an append-only table, in the same transaction as the change. The database role the app uses can't update or delete versions. This feeds the mockup's History tab and Audit trail.
- [ ] T-030 **Compare and restore versions.** deps: T-029 (risky)
  - Compare any two versions field by field. Restoring writes a new version equal to an old one, never deleting history, and runs today's template, identifier uniqueness and rights checks first, reporting anything the old version no longer passes instead of saving it.
- [ ] T-031 **Edit-conflict protection.** deps: T-029 (risky)
  - Every update names the version it started from. A save based on an older version is refused with a list of what changed since, so two people can't silently overwrite each other's work. No locks or WebSockets are needed.

The writer:
- [ ] T-032 **The Polybius service layer: one writer.** deps: T-026, T-029, T-031 (risky)
  - A `packages/polybius` service, with no HTTP yet, that holds the only database role allowed to write. Every save validates the record, checks it against its template (with the identifier checker), re-checks identifier uniqueness inside the transaction, and writes the version and change log. Tests try to write around it with every other role and fail.
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
- [ ] T-041 **Roles and collection-level permissions.** deps: T-036, T-032 (risky)
  - The four roles in the plan (admin, cataloger, reviewer, read-only), granted for the whole catalog or for chosen fonds or collections and the units below them. The service checks them on every read and write, and anything not granted is refused. Only reviewers and admins publish (mockup Settings). Whether to add the mockup's Scanner and Donor relations roles is a question for John; don't add them before he answers.
- [ ] T-035 **Optional approval step.** deps: T-034, T-041 (risky)
  - An organization setting that, when on, holds edits and publish requests as pending versions until a reviewer approves or rejects them, with both recorded in the change log. When it's off, saves go straight through as today.

The API:
- [ ] T-042 **Polybius HTTP API: records, templates and identifier types.** deps: T-022, T-032, T-037, T-041 (risky)
  - JSON endpoints in their own package (`packages/polybius-api`) that wrap the service layer for reading, creating and updating records, templates and identifier types. Request size limits, input checked with the core validators, errors without stack traces, and a test for each endpoint with no session, the wrong role and the wrong collection. How it is deployed alongside Hermes waits on Q-1 (T-050).
- [ ] T-043 **API: history, restore, approval and publishing.** deps: T-042, T-030, T-034, T-035 (risky)
  - Endpoints for versions, compare, restore, the change log, the approval queue and publish/unpublish, with the same permission tests as T-042.

Admin screens in the browser:
- [ ] T-044 **Decision: how the React admin is built.** deps: T-011
  - Choose how the Polybius admin is built and served in development: React with the already-pinned Vite 7 (D-006), routing, and how forms are generated from templates. Use the Phase 2 criteria, plus WCAG 2.1 AA support and DESIGN.md's tokens. Where it is served from in production waits on Q-1. Decision entry.
- [ ] T-045 **Admin: sign-in and the screen frame.** deps: T-044, T-042 (risky)
  - The Login screen, the sidebar and the top bar from DESIGN.md, wired to sign-in, two-factor and sign-out, and accessible (WCAG 2.1 AA, keyboard and screen reader tested).
- [ ] T-046 **Admin: item list and record editor.** deps: T-045, T-043 (risky)
  - The Item Records list and the Record editor (mockup Items, AdminRecord), with the form built from the record's template, ID numbers, the History tab with compare and restore, the edit-conflict message, and blocked actions that explain themselves ("Can't publish yet: choose a rights statement").
- [ ] T-047 **Admin: templates and identifier types.** deps: T-046, T-005a (risky)
  - Screens to edit field templates, record types and identifier types (Settings, ID numbers tab), which show T-005a's safe-change report and require confirmation before a staff field becomes public or records are affected.
- [ ] T-048 **Admin: people, roles and the audit trail.** deps: T-045, T-041, T-043 (risky)
  - Settings › People & roles (invite, change role, grant collections, require two-factor) and the Audit trail on Audit & Reports, with search by person, record and date.
- [ ] T-049 **Admin: review queue.** deps: T-046, T-035 (risky)
  - A screen listing pending changes and records ready for review, with approve and reject, available to reviewers and admins only.

Waiting on John:
- [ ] T-050 **Server layout for Polybius and Hermes.** deps: Q-1, T-042 (risky)
  - Set up the server the way John answers Q-1: one app, or two apps sharing the database through the API. Either way, Hermes may read only published data, through a read-only path (its own database role or a public read API) that tests show can't reach staff fields or unpublished records.
- [ ] T-040 **Sending password reset email.** deps: Q-2, T-039 (risky)
  - Deliver reset and invitation messages through the email service the hosting answer allows, with its credentials only in environment variables, and nothing about the account in the message beyond the link.
- [ ] T-051 **Deploy and run.** deps: Q-2, T-050, T-052 (risky)
  - Production setup for John's chosen host: TLS, secrets from the environment, scheduled backups and an off-site copy (T-052), session and token cleanup as a background job if the host allows one, and a written runbook for updates and restore (§9). Never deploy without John.

- [ ] T-053 **Phase 2 review.** deps: T-020 to T-052
  - Check Phase 2 against PLATFORM_PLAN.md §3 and the "one writer" principle, get an independent security review of the whole of Phase 2, and write the Phase 3 tasks (including M-001).

## Phase 3 — Media
Tasks to be written when Phase 2 is done. Carried forward:
- [ ] M-001 **Serve active file types safely.** (risky) From the T-002 review: a digital asset's media type can be `text/html`, `image/svg+xml`, `application/xhtml+xml` or a script type, which is legitimate for born-digital files. When media is served, never send the stored media type as-is for these. Serve them as downloads (`Content-Disposition: attachment`), from a separate origin from the public sites, with a sandboxing Content-Security-Policy and `X-Content-Type-Options: nosniff`, and test that an uploaded HTML or SVG file can't run script on a Hermes site.

## Phases 4–7
Hermes public sites and editor; multiple sites; Omeka S migration and the Historical Society cutover; connections to other systems. See PLATFORM_PLAN.md §10.
