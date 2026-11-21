# Oculus

**An open-source collections platform for archives, museums and historical societies.** One system to catalog what you hold, from intake to shelf to finding aid, and publish it live to one or more public websites.

> **Status: planning and design.** No application code yet. This repository holds the plan, the design guide and a click-through mockup. It's being built first for the Dickinson Historical Society in Dickinson, Texas, to replace its Omeka S archive.

An *oculus* is the round opening at the top of a dome, like the Pantheon's: a window for looking in. Here, a window onto the collection.

## The two halves

| Part | Who uses it | What it does |
|---|---|---|
| **Admin** (staff back end) | Staff and volunteers | Accessions and deeds of gift, cataloging, scans and OCR, authorities and subjects, arrangement (fonds › series › collection), physical storage, preservation checks, circulation, reports and an audit trail |
| **Public sites** | Visitors and researchers | Search and browse, item pages, finding aids, exhibits, timeline and map, built with a drag-and-drop page editor. One organization can run several sites. |

Records are published live: when you publish a record in the admin, it shows on the public sites chosen for it. There is no export/import step between the catalog and the website.

## What's here

| Path | What it is |
|---|---|
| [`docs/PLATFORM_PLAN.md`](docs/PLATFORM_PLAN.md) | The plan: goals, decisions, record model, ID numbers, users, media, public sites, replacing Omeka S, technology, phases, risks and open questions. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/DECISIONS.md`](docs/DECISIONS.md) | What's next, what's been done, and why. Oculus is built nightly by scheduled sessions that follow [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md). |
| [`design/DESIGN.md`](design/DESIGN.md) | The design guide: colors, type, spacing, layouts, components, behavior patterns, and a list of every screen and wizard. |
| [`design/tokens/`](design/tokens/) | The colors, fonts and sizes as CSS variables (`tokens.css`) and JSON (`tokens.json`). |
| [`mockup/`](mockup/) | The 41-screen click-through mockup: public site, back end and six step-by-step wizards. |
| [`tools/mockup-generator/`](tools/mockup-generator/) | The Python script that produces the mockup's back-end and wizard screens. |

## Planned technology

TypeScript throughout, a Node.js API, PostgreSQL, React for the admin and the page editor, and S3-compatible file storage. Standards: DACS, Spectrum, Dublin Core, EDTF dates, rightsstatements.org rights, with EAD, CSV, OAI-PMH, JSON-LD and IIIF for exchanging data. See the plan for details.

## License

[MIT](LICENSE).

## Development

Node 26 (see `.nvmrc`; 22 or later works). `npm install`, then `npm run gate` runs every check a change must pass: format, lint, type check, tests, build, `npm audit`, the license check and the test-count floor in `gate-baseline.json`. Code lives in `packages/`; `packages/core` is the record model.
