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

Node 26 (see `.nvmrc`; 22 or later works). `npm install`, then `npm run gate` runs every check a change must pass: format, lint, type check, tests, build, `npm audit`, the license check and the test-count floor in `gate-baseline.json`. The tests need PostgreSQL 15 or newer: the gate starts a throwaway server from the binaries `pg_config --bindir` finds (or `PG_BIN`), or uses the server in `OCULUS_TEST_DATABASE_URL`. Even then, one backup test starts its own throwaway password-protected server, so `initdb` and `pg_ctl` (and `pg_dump`, `pg_restore` and `psql` at least as new as the server) must be in `PG_BIN` or found by `pg_config --bindir`. Code lives in `packages/`; `packages/core` is the record model and `packages/db` the database access and migrations (`OCULUS_DATABASE_URL=... npm run db:migrate`; every command connects to any host but this machine only with a verified TLS certificate, D-064; backups with `npm run db:backup -- <new file>` and `npm run db:restore -- <file>` into an empty database owned by a plain role; schedulers should build once and run `node packages/db/dist/backup-cli.js backup <file>` directly, D-064), `packages/service` the one writer of records and their identifiers, terms, versions and arrangement (connect it as its own login role given `grantWriterRole`, never as the owner, D-067), `packages/api` the HTTP layer (Fastify 5 with Oculus's own rules, D-051 and D-058) with the staff JSON API over the service (`staffApiRoutes`: records, the dry-run check, staff search, templates and identifier types, D-079; version history, restore, the workflow moves and the approval queue, D-082) and the sign-in routes (`signInRoutes`, D-081), and `packages/admin` the staff admin in the browser (React on Vite, D-073; see its README for running it and the manual accessibility checklist). To try Oculus on one computer, make an empty PostgreSQL database and run `OCULUS_DATABASE_URL=... npm run setup` (T-055): it applies the migrations and asks for the organization, the first site, and the first system admin's name, email and password (never shown or taken from the environment; the other answers can come from `OCULUS_SETUP_ORGANIZATION`, `OCULUS_SETUP_SITE`, `OCULUS_SETUP_NAME` and `OCULUS_SETUP_EMAIL`), then makes them with a starter `Item` template. It refuses to run on a database that already has people or organizations. Then `npm run build && npm run desktop` opens it in its own Edge or Chrome window on this computer (T-056, D-088); [docs/DESKTOP.md](docs/DESKTOP.md) is the step-by-step guide for Windows. `npm run build && npm run admin` starts the admin's server (`OCULUS_DATABASE_URL`, `OCULUS_ORIGINS`, `OCULUS_ADMIN_ORIGIN`, `OCULUS_SECRET_KEY`, `OCULUS_FILES_DIR` for uploaded files with the optional limits `OCULUS_FILE_MAX_MIB`, `OCULUS_FILES_TOTAL_MAX_MIB` and `OCULUS_FILES_MIN_FREE_MIB`, D-086; staff download, view and get thumbnails of files through the same API, D-095; in production also `OCULUS_TRUSTED_PROXY` or `OCULUS_CLIENT_ADDRESS=direct`, and SMTP for email: `OCULUS_SMTP_HOST`, `OCULUS_MAIL_FROM`, optionally `OCULUS_SMTP_PORT`, `OCULUS_SMTP_TLS`, `OCULUS_SMTP_USER` with `OCULUS_SMTP_PASSWORD` or `OCULUS_SMTP_PASSWORD_FILE`, `OCULUS_MAIL_FROM_NAME`; it refuses to start without them in production; in development without SMTP the development sender logs only each message's kind, and `OCULUS_DEV_MAIL_DIR` and `OCULUS_DEV_MAIL_SHOW_TOKENS=1` write messages to a folder and show their links; D-081, D-085). The gate's end-to-end step runs the built admin in a browser (`npm run e2e`; Playwright's own Chromium after `npx playwright install chromium`, a system Chrome at a usual path, or `OCULUS_E2E_BROWSER`).
