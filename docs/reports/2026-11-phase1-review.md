# Phase 1 review (T-011), November 2026

Phase 1 was to build the record model and ID numbers as plain, tested TypeScript in `packages/core`, with no server or database. This review checks what was built (T-001 to T-010, 1,194 passing tests) against PLATFORM_PLAN.md §1–2 and the 41 mockup screens, and sets up Phase 2.

**In short:** the core is strong where it was aimed: dates, rights, identifiers, templates, inheritance and safe public output are careful and heavily tested. But Phase 1 is not finished against §1. Three plan items are missing (organization-defined record types, Spectrum loans and condition, links from records to the Authorities list), records don't say which template they use, and ID numbers can live in two places. These are new Phase 1 tasks T-012 to T-018.

## 1. Section 1 (record model), item by item

| Plan item | State |
|---|---|
| Six record types: object, archival unit (nested to any depth), digital asset, agent, place, event | **Done** (T-002, D-007). Levels fonds › series › collection › file › item, levels can be skipped, up to 64 deep. |
| "Admins can add more types" | **Not done.** The six kinds are a fixed list in `records.ts`. Nothing lets an organization add "Oral history" or "Map". New task T-013. |
| Field templates as data | **Done** as a model (T-005, D-010): nine field kinds, required/repeatable/visibility/inherited stated explicitly. **Not done:** editing them in admin screens (Phase 2), and checking that a template edit is safe (T-005a, still open). Records also don't store which template they use; callers pass a lookup. New task T-012. |
| Standards presets: DACS/ISAD(G), Spectrum-style procedures (acquisition, location, loans, condition), Dublin Core for publishing | **Partly done** (T-006, D-012). DACS, Spectrum cataloguing and digital-asset presets exist, plus the Dublin Core mapping. Spectrum *procedures* aren't modelled: acquisition and location are only free-text fields on the object template, and loans and condition aren't there at all. ISAD(G) isn't cited separately (DACS covers it in practice). New tasks T-016 to T-018. |
| Vocabularies: Nomenclature, LCSH, LCNAF, LCGFT, GNIS | **Done as a model** (T-009, D-014): terms as label plus URI, strict LC URI rules, near-duplicate detection. Nomenclature and GNIS URI forms are unconfirmed (T-009a). No vocabulary data and no term lookup yet. |
| Collections and series independent | **Done** (D-007), by letting levels be skipped. |
| Dates in EDTF; rights as rightsstatements.org links | **Done** (T-003, D-008; T-007, D-011). Three EDTF judgement calls are open (T-003a). |
| General TypeScript types, not one organization's | **Done.** The Society's setup appears only as preset choices. |
| Dublin Core and JSON-LD output | **Done** (T-010, D-016), but "published" is still the caller's word, and the DCMI details were written from memory, not checked against the specs (T-010a). |

## 2. Section 2 (ID numbers), item by item

| Plan item | State |
|---|---|
| Permanent UUID per record, never shown as the number | **Done** (`record-id.ts`). |
| Any number of typed identifiers per record | **Done** (T-004, D-009). |
| Organization-defined types with a uniqueness rule, format and optional auto-numbering | **Done**, with a safe format language (no admin-written regexes). Uniqueness and the next number can only be made safe against two people saving at once by the database (Phase 2). |
| One identifier marked as the main one | **Done.** |
| Old numbers stay searchable | **Done** as a lookup over current and former identifiers. Real search is Phase 2. |
| Gap | Numbers have **two homes**: the `RecordIdentifiers` model in `identifiers.ts`, and template fields of kind `identifier` (`reference_code`, `object_number`). Nothing says which is the truth, and identifier types have no "public" flag, so it's unclear how the primary number reaches the public site. New task T-014. |

## 3. What the mockup screens need that the model lacks

| Screen(s) | What's missing | Where it belongs |
|---|---|---|
| Accessions, Deeds, Donors, Submissions, accession wizard | An accession (source, date, materials, deed status, the records it produced) and the rule "no signed deed, not on the public site". Donor contact details are private data. | Phase 1 model (T-016); deed PDFs Phase 3; submission form Phase 4 |
| Storage, Whereabouts, record "Shelf location" | Configurable storage levels (Room › Shelf › Box › Folder), containers, normal and current location, moves with a reason and return date | Phase 1 model (T-017); label printing and QR codes later |
| Whereabouts, Conservators, record "Condition" | Loans in and out, and condition checks | Phase 1 model (T-018) |
| Authorities, record "Creator", "Related" | Values that link to agent, place or event records | Phase 1 model (T-015) |
| Record editor, Items, Reports | Draft / Ready for review / Published / Needs rights states; history with Compare; the audit trail | Phase 2 |
| Settings: People & roles | The roles shown (Administrator, Cataloger, Scanner, Viewer, and a "Donor relations" role) don't match the plan (admin, cataloger, reviewer, read-only) | Phase 2, with a question for John |
| Record "Show on these sites", Sites, site editor, Exhibits | Publishing per site; exhibits | Phase 2 shapes publish state for it; Phase 4–5 |
| Researchers, Checkouts | Reading-room researchers and checkouts | **No phase in the plan yet.** Researchers are private data about real people. Suggest placing it at a monthly review. |
| Finding Aids | Printable finding aid built from the arrangement; EAD export | Phase 4 (public tree), Phase 7 (EAD) |
| Scan Inbox, Needs Scanning, Preservation, OCR | Uploads, placeholders, fixity checks, OCR | Phase 3. **OCR may conflict with D-004:** common OCR engines ship trained models. |
| Data Cleaning, Subjects, Needs Sorting | Reports, term merges, filing suggestions | Building blocks exist (T-009). Screens come later, and suggestions must stay classical (D-004). |
| Setup and import wizards, Backups | Installer, backups, Omeka import | §9 and Phase 6. Backup tools are in Phase 2 (T-052). |

## 4. Open follow-ups already on the roadmap

- **T-001a** (needs John): turn on Dependabot alerts and CodeQL. Security runs can't see GitHub's alerts until he does.
- **T-003a**: EDTF qualifier edge cases, and a check against the spec's examples.
- **T-005a** (risky): safe template changes. This **must** land before templates can be edited in the browser, because switching a field from staff to public would publish existing staff data. Phase 2's template screen depends on it.
- **T-009a**: confirm the Nomenclature and GNIS URI forms; report LC terms with no URI.
- **T-010a**: check public output against the DCMI, OAI-PMH and XML specs. Its "real publish state" part moves to Phase 2 (T-034).
- **M-001** (Phase 3, risky): serve HTML and SVG uploads so they can't run script.

## 5. Risks

1. **Phase 2 is the security-heavy phase, and autopilot merges without a person.** Logins, sessions, password reset, roles and the public/private line are all built here. Independent reviews help, but nobody should deploy before a person reviews it, and ideally a professional test (plan, "Security").
2. **Hosting is unknown (Q-2).** It decides email for password reset, background jobs and WebSockets. Phase 2 tasks avoid needing WebSockets (edit conflicts use version numbers), and mark email and deployment `deps: Q-2`.
3. **One app or two is unknown (Q-1).** The database, the service layer and the API don't depend on it. How Hermes reads published data does (T-050).
4. **The core works on whole snapshots in memory** (`indexRecords` checks every record it's given, up to 1,000,000). The server must load only the records a call needs, such as a record's chain of ancestors, or saves will slow as the catalog grows.
5. **Specs written from memory.** EDTF, DCMI, Nomenclature and GNIS details couldn't be checked from the sandbox (T-003a, T-009a, T-010a).
6. **Private data.** Donors, researchers and users are real people. The public repo must keep using invented test data, and donor contact details need tighter access than "staff".
7. **Succession and size.** Several modules are about 1,000 lines (`identifiers.ts`, `templates.ts`, `public-output.ts`). They are well commented, but large for one person to maintain.

## 6. Questions for John (for the weekly report)

- **Q-1** and **Q-2** are still open. Phase 2 can do schema, auth and API work without them, but can't deploy.
- **Roles:** the plan says admin, cataloger, reviewer and read-only. The mockup also shows Scanner and a Donor relations role that alone sees donor contact details. Should Phase 2 add those two?
- **OCR and D-004:** is an OCR engine that ships trained recognition models allowed, or should OCR be left out or done outside Oculus?
