# Oculus platform plan

**Status:** direction agreed (October 28, 2026). Name and license decided November 20, 2026. No application code yet.

## Goal

Build a general collections platform that runs on the web, one that any archive, museum or historical society could use. It grows out of Polybius, the Dickinson Historical Society's earlier desktop catalog, which becomes the staff admin. The public sites get a drag-and-drop site builder based on the editor from Blueprint, the WordPress page builder already used on the Society's websites. Together they replace Omeka S completely. Archives, museum objects and media live in one system, and there's no export/import step between the catalog and the website.

## Decisions

1. **Name:** the whole project is **Oculus** (D-018). Its parts are described plainly: the admin (staff back end) and the public sites. The earlier part names Polybius and Hermes are dropped.
2. **License:** MIT.
3. **One install can hold several organizations** (D-019, replacing "one organization per install"). The Dickinson Historical Society runs its archives and also hosts the library on a separate site. Each organization has its own catalog, ID number formats, rights settings, people and roles, and its own public site or sites (domain, theme, menus, pages and choice of collections). Each one behaves like a completely separate copy of Oculus: staff pick which one they are working in, and nothing is shared or searchable across them.
4. **Web only.** There's no desktop app and no offline mode.
5. **The public sites stand on their own.** Blueprint's editor moves out of WordPress, and nothing depends on WordPress.
6. **Built for organizations in general.** The Dickinson Historical Society's setup becomes one preset among several.

## Principles

- **One writer:** only the Oculus API writes to the catalog database. The public sites and the importers go through it, and the public sites read only what's published.
- Flag problems instead of making things up, and never automate changes silently.
- An optional human review step before edits or publishing go live.
- Full version history on every record, so any version can be restored.
- Trust the source code and the tests over notes.

## 1. Record model

- **Record types:** object, archival unit (collection > series > file > item, nested to any depth), digital asset, agent (person, organization or family), place and event. Admins can add more types.
- Field templates are edited in the admin screens, not in config files.
- **Standards presets:** DACS/ISAD(G) for archives and Spectrum-style procedures for museums (acquisition, location, loans, condition). Dublin Core is used for publishing. Vocabularies: Nomenclature, LCSH, LCNAF, LCGFT and GNIS.
- Collections (grouped by subject) and series (grouped by record type) stay independent of each other.
- Dates are stored in EDTF/ISO 8601, and rights as rightsstatements.org links.
- Write the TypeScript types for the general model, not for one organization.

## 2. ID numbers

- Every record gets one permanent internal ID (a UUID) that never changes and is never shown as "the number."
- A record can have any number of typed identifiers, such as accession number, object number, call number, barcode, legacy code, former Omeka ID or ARK.
- The organization defines its identifier types. Each type can have its own uniqueness rule, format and optional auto-numbering, and one identifier is marked as the main one shown.
- Old numbers stay searchable.

## 3. Users and permissions

- Logins with a password and optional two-factor, sessions and password reset.
- Roles: admin, cataloger, reviewer and read-only, with permissions down to the collection level.
- A log of every change: who, what and when.
- Protection so two people can't silently overwrite each other's edits.
- An optional approval step before changes are saved or published.

## 4. Media

- Uploads with automatic thumbnails and web-sized copies, image zoom, audio and video players, and PDF viewing.
- Preservation masters are kept separate from the public copies.
- Files go to S3-compatible storage, not the server disk.
- Checksums confirm the masters haven't changed.
- IIIF, at least the manifests, because larger organizations will expect it.

## 5. Public sites

- Bring over Blueprint's editor: the element tree (boxes, sections and columns, widgets), drafts vs. published versions, revisions, design system and responsive settings.
- **Collection widgets:** search box, faceted browse, item grid, item page template, finding-aid tree, exhibit, timeline, map, featured item and recent additions.
- Public pages are built on the server so they load fast and search engines can read them. Accessibility (WCAG 2.1 AA) is a requirement from the start.
- Each site has its own domain, theme, menus and collections.

## 6. Replacing Omeka S

- It needs to match Omeka on sites, pages, themes, search, item sets, the public API, linked data (JSON-LD) and CSV import.
- It goes beyond Omeka with the public hierarchy, museum objects, better media handling and live records on any page.
- An **Omeka S importer** maps identifiers and sets up **URL redirects**, so existing links to an archive keep working.

## 7. Working with other systems

EAD import and export, CSV import and export, OAI-PMH, JSON-LD and IIIF manifests. MARC and EAC-CPF can come later if needed.

## 8. Proposed technology

TypeScript throughout, a Node.js API and a PostgreSQL database (it has full-text search built in, and JSONB columns for the template-defined fields). Files go in S3-compatible storage. The admin and the page editor use React. It needs a VPS or managed cloud server, because shared web hosting won't be enough.

## 9. Installs by other organizations

That means building an installer, database migrations for upgrades, backup and restore tools, admin documentation, a release process and security updates. Plan for these from the start.

- **Updates:** a signed update package, verified with Node's built-in Ed25519 signing, with a safely kept private key and a backup key.
- **Upkeep:** a self-hosted web app needs operating system patches, Node and PostgreSQL updates, and attention to npm security alerts.

## 10. Phases

1. Record model and ID numbers, in TypeScript
2. Server: database, API, logins, roles and the change log; the admin screens move to the browser
3. Media handling
4. Public sites: the page editor and collection widgets
5. Multiple sites per install
6. Omeka S migration, and the Dickinson Historical Society's cutover (the Society stays on Omeka until here)
7. Connections to other systems (OAI-PMH, IIIF and so on)

Each phase has to be usable and tested before the next one starts. Realistically this is a multi-year project.

## Risks

- **Succession:** the biggest long-term risk. It needs documentation and a plan for who maintains it.
- **Security:** the public website and the private catalog share one platform, so they need strict separation. Plan for separate security reviews, automated scanning and, eventually, a professional penetration test.
- **Scope:** the catalog, media handling and the site builder are each a large product on their own.
- **Expectations:** people will compare the page builder with Squarespace and WordPress.

## Open questions

- Should the admin and the public sites be one combined server app, or two apps that share the database through the API?
- Where will the Historical Society host it, and what's the budget for hosting and storage? (One option looked at: shared-host Node plans support PostgreSQL but not WebSockets, and background jobs aren't confirmed.)
- Should the Society's other websites eventually move to Oculus?
