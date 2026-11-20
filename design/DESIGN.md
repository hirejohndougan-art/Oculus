# Oculus design guide

The look and the screen patterns from the Oculus click-through mockup, made for the Dickinson Historical Society in October 2026. Use this guide to build the real screens so they match the mockup.

- **Polybius** is the staff back end: cataloging, intake, arrangement, storage, circulation, settings.
- **Hermes** is the public website it publishes to (the Digital Archive), plus the drag-and-drop page editor.

The mockup screens are in [`../mockup/`](../mockup/). Color and type values are in [`tokens/`](tokens/).

---

## 1. Character

- Plain, sturdy and quiet, like a well-kept reading room. Charcoal frame, white working surfaces, one warm orange accent.
- No gradients, no emoji, no decorative icons. Inline stroke icons appear only where they mean something: search, zoom, folder, map pin.
- Written for volunteers. Every screen opens with one plain sentence saying what it is for. Archival terms (Fonds, Series, accession, fixity) are always explained the first time they appear.
- Honest placeholders. Unknown values show as `[N]`, `[date]`, `[Donor name]`, never as invented numbers.

## 2. Color

| Token | Hex | Used for |
|---|---|---|
| `--frame-dark` | `#26292c` | Back-end sidebar, wizard step rail |
| `--frame-darker` | `#1d2023` | Wizard top bar |
| `--frame-charcoal` | `#3c3c3c` | Public site header and footer; dark buttons in tables |
| `--nav-active` | `#3c4044` | Selected sidebar item / current wizard step |
| `--nav-text-muted` | `#c9cdd1` | Sidebar subtitles, badges |
| `--nav-group-label` | `#aeb4ba` | Sidebar group headings (uppercase) |
| `--bg-admin` | `#f3f5f8` | Back-end page background |
| `--bg-public` | `#e5e9ef` | Public page background |
| `--surface` | `#ffffff` | Cards, tables, inputs |
| `--surface-soft` | `#f7f9fb` | Table header row, drop zones, lesson cards |
| `--fill-soft` | `#eef1f4` | Subject chips, row dividers, gray pills |
| `--border` | `#d7dce2` | Card and panel borders |
| `--border-strong` | `#cfd5dd` | Tab underline track, section rules |
| `--border-input` | `#8b939c` | Inputs, selects, secondary buttons |
| `--border-chip` | `#b7bec7` | Filter chips, pagination |
| `--ink` | `#111111` | Headings, primary dark buttons |
| `--text` | `#2f3337` | Back-end body text (public: `#3a3a3a`) |
| `--text-label` | `#222222` | Form labels, definition terms |
| `--text-muted` | `#4a5056` | Help text, secondary lines |
| `--link` / `--link-hover` | `#1d4f73` / `#0f2f47` | Links |
| `--placeholder-fill` / `--placeholder-text` | `#c9d0d8` / `#3c434b` | Image placeholders |
| `--accent` | `#f0792d` | Primary buttons, current tab underline, active nav bar, progress bar, timeline dots |
| `--accent-wash` | `#fff7f0` | Selected choice card, selected list row |
| `--eyebrow` | `#8a4310` | Small uppercase labels above headings (public) |

The accent is a single, switchable value. The mockup offers `#e0b341` (gold), `#4f9fd6` (blue) and `#7fb069` (green) as alternatives. Text on the accent is always `#1a1a1a`, never white.

**Status pills** (background / text):

| Tone | Background | Text | Example |
|---|---|---|---|
| gray | `#eef1f4` | `#3c434b` | Draft, Queued |
| green | `#dff1e3` | `#1e5a2b` | Published, Signed, All match |
| amber | `#fdf0dc` | `#7a4a0b` | Pending, Needs rights |
| red | `#fbe3e1` | `#8f2418` | Deed missing, Overdue, File changed |
| blue | `#e1edf8` | `#1d4f73` | Ready for review, Partly cataloged |

**Notes / callouts** (background, border, text): amber `#fdf3e6 / #f0c48f / #5a3a12` for warnings, blue `#eaf2fa / #a9c6e2 / #1d3b55` for explanations, green `#e8f5eb / #a8d5b2 / #1e4a28` for success.

**Dashboard "Needs attention" cards** get a 4 px colored top border: accent, `#c0392b`, `#4f6f8f`, `#e0b341`, `#7a6a9a`, `#3c7a5a`.

All text pairs above pass WCAG AA contrast (4.5:1) at their sizes.

## 3. Type

- **Headings and buttons:** Roboto 500 / 600 / 700.
- **Body:** Open Sans 400 / 600.
- Both come from Google Fonts: `family=Roboto:wght@500;600;700&family=Open+Sans:wght@400;600`.

| Role | Size / weight |
|---|---|
| Public hero heading | 52 px Roboto 700, line-height 1.1 |
| Public section heading | 32 px Roboto 700 |
| Back-end page title (h1), wizard question | 30 px Roboto 700 |
| Card / panel heading | 18–19 px Roboto 600 |
| Body | 15 px (back end), 16–18 px (public intro text), line-height 1.5–1.6 |
| Table and form text | 14 px |
| Help text, captions | 12–13 px, `--text-muted` |
| Eyebrow / group label | 11–14 px, 600, uppercase, letter-spacing 1.2–1.5 px |

## 4. Shape and spacing

- Corner radius: 4 px on controls and buttons, 6 px on cards and panels, 999 px on pills and chips.
- Controls are 44 px tall (the public search box is 52 px). Every clickable target is at least 44 × 44 px.
- Spacing steps: 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 48 px.
- Back-end cards are flat with a 1 px `--border`. Public cards have no border and a soft shadow, `0 1px 3px rgba(0,0,0,0.12)`.
- Public content is centered at a 1240 px max width with 32 px side padding. The back end fills the window: content padding is 28 px.

## 5. Layouts

### Back end: sidebar + content
- **Sidebar:** 236–260 px wide, `--frame-dark`.
  - The "Polybius" wordmark sits at 22 px with the organization name under it.
  - Menu groups have uppercase labels; the items under a group are indented 22 px.
  - The selected item gets a `--nav-active` fill and a 3 px accent bar on the left.
  - Badges (`[N]`) are right-aligned in `--nav-text-muted`.
- **Top bar:** white, with a "Search everything" field, "+ Catalog an item" (primary), "Log an accession" (secondary), and a round account button with initials.
- **Page header:** the h1, then one plain sentence about the screen (`--text-muted`, max 760 px wide), with action buttons aligned right. Lists add a filter field and filter chips under it.
- On a narrow screen the sidebar wraps above the content instead of shrinking it.

### Wizards: full page
- **Top bar:** dark, showing "Polybius · wizard name · Step X of N", plus a "Save draft & close" button.
- **Progress bar:** 5 px, accent fill.
- **Step rail:** dark, on the left. Each step is a 26 px numbered circle and its title: done steps show ✓, the current step is filled with the accent. Every step is clickable, so you can jump back.
- **Content:** max width 900 px. Each step is one plain question as the h1, a short explanation, then the inputs.
- **Footer:** "Cancel" on step 1, "← Back" after that, the note "Answers save as a draft after every step", then "Next →", or the finish button on the last step.
- **Last step:** always a review summary. Every line has an **Edit** button that jumps straight to its step.

### Public site (Hermes)
- **Header and footer:** charcoal, with "Dickinson Historical Society / DIGITAL ARCHIVE" on the left. The menu shows the current page with a 3 px accent underline, and Donate is an accent button. The footer ends with "Powered by Hermes + Polybius · Staff sign in".
- **Home page:** hero search with suggested searches, collection cards, a featured item, recent additions, a timeline, a map and exhibits.
- **Other pages:** search with filters in a left column (list or grid view), an item page with a media viewer, tabbed record details and a citation, and a finding aid as an expandable series › file › item tree.

## 6. Components

- **Buttons:**
  - **Primary:** accent background, `#1a1a1a` text, Roboto 600 15 px, 44 px tall, 4 px radius.
  - **Secondary:** white with a 1 px `--border-input` border.
  - **Dark:** `--ink` background with white text. Used for "Sign in", "Search" and "Print / PDF".
  - Links that look like buttons are `<a>` elements styled as buttons.
- **Text fields and selects:** label above (14 px 600 `--text-label`), 44 px control with a 1 px `--border-input` border and 4 px radius, help text below (12 px muted). Fields sit in an auto-fit grid with 260 px minimum columns; long fields span the full row.
- **Choice cards** (wizards): one bordered card per option. Each has a radio dot (or a square for multi-select), a bold label, and an optional gray explanation line.
  - **Selected:** 2 px accent border and `--accent-wash` background.
  - When an option has an explanation of its consequence, a blue note under the cards says what happens, for example "Then it belongs with everything else from that same source…".
- **Tabs:** 46 px tall Roboto 600 text buttons over a 1 px track; the current tab has a 3 px accent underline.
- **Tables:** in a bordered card that scrolls sideways when narrow. The header row is `--surface-soft` with 13 px muted text, rows are split by `--fill-soft` lines, and the first column links to the record.
- **Pills** for status and **chips** for subjects. Subject chips are `--fill-soft` with a × to remove.
- **Notes:** amber, blue and green callouts with a 1 px border, 14 px text and 4 px radius. They are used for "Can't publish yet: choose a rights statement" and similar messages.
- **Image placeholders:** `--placeholder-fill` boxes with a centered caption that names the photo that belongs there.
- **Progress / fullness bars:** an 8 px track in `#e4e8ec` with a `#3c3c3c` fill. The wizard progress bar uses the accent instead.
- **Review summary:** rows with the label (180 px), the value, and an "Edit" outline button.

## 7. Behavior patterns

- **Two-state actions** swap in place: Publish ↔ Unpublish (with the Draft/Published pill), merge → "Merged … Undo", approve submission → green confirmation with a link to the draft.
- **Blocked actions** explain themselves next to the control ("Can't publish yet: choose a rights statement on the Rights tab").
- **Queues have a "work through them" button:** "Catalog the ready files", "Sort them one by one".
- **Wizards never dead-end.** "Not sure" and "Unknown, needs review" are always offered as honest answers, with a sentence on what happens next.

## 8. Screen inventory

Each screen is listed with its mockup file name and the Polybius module it corresponds to (in `app/src/lib/ui/`).

| Screen | File | Polybius module |
|---|---|---|
| Sign in | `Login` | (new; web version) |
| Dashboard | `AdminDashboard` | `dashboard.jsx` |
| Accessions | `Accessions` | `intake.jsx` |
| Deeds of gift | `Deeds` | `deeds.jsx`, `itemDeedTab.jsx` |
| Donors | `Donors` | `donors.jsx` |
| Scan Inbox | `ScanInbox` | `scanInbox.jsx`, `inboxPanel.jsx` |
| Needs Scanning | `NeedsScanning` | `needsScanning.jsx` |
| Item Records | `Items` | `itemsView.jsx` |
| Record editor | `AdminRecord` | `itemDetail.jsx`, `itemForm.jsx`, `itemMediaPanel.jsx` |
| Needs Sorting | `NeedsSorting` | `guidedPlacement.jsx` |
| OCR | `OCR` | `ocrScreen.jsx`, `ocrPanel.jsx` |
| Data Cleaning | `DataCleaning` | `dataCleaning.jsx` |
| Authorities | `Authorities` | `authorities.jsx` |
| Fonds / Series / Collections | `Fonds`, `Series`, `Collections` | `hierarchyBuilder.jsx`, `arrangementViews.jsx` |
| Finding Aids | `FindingAidAdmin` | `findingAid.jsx` |
| Subjects | `Subjects` | `subjectInput.jsx`, `vocabularies.jsx` |
| Effective Record | `EffectiveRecord` | `effectiveRecord.jsx` |
| Physical Storage | `Storage` | `physicalStorage.jsx`, `labels.jsx` |
| Preservation | `Preservation` | `preservationScreen.jsx` |
| Checkouts, Whereabouts, Exhibits, Researchers, Conservators | `Checkouts`, `Whereabouts`, `ExhibitsAdmin`, `Researchers`, `Conservators` | `checkouts.jsx`, `whereabouts.jsx`, `exhibits.jsx`, `researchers.jsx`, `conservators.jsx` |
| Public sites | `Sites` | `hermesView.jsx` (reworked as site manager) |
| Hermes page editor | `AdminSiteEditor` | (new; Blueprint editor moved out of WordPress) |
| Public submissions | `Submissions` | `hermesView.jsx` (public intake review) |
| Audit & Reports | `Reports` | `reportsView.jsx`, `reportScreens.jsx` |
| Settings | `Settings` | `settingsView.jsx` |
| Public: home, browse, item, finding aid | `Main`, `Browse`, `Item`, `FindingAid` | (Hermes widgets) |

**Wizards:**

| Wizard | File | Steps | Polybius source |
|---|---|---|---|
| First-run setup | `WizSetup` | Welcome · Organization · Omeka site? · ID numbers · Description rights · Vocabularies · Review | `firstRun.jsx` |
| Log an accession | `WizAccession` | Donor · When and how · Materials · Copyright & rights · Restrictions · Review | `intake.jsx` |
| Catalog an item | `WizCatalog` | Item type · Scan/placeholder · Accession · Title · Creator · Date · Description · Subjects · Object class · Physical form · Rights · Placement (filing guide) · Storage · Review | `catalogingWizard.jsx` (`WIZARD_STEPS`), `guidedPlacement.jsx` (`TRIAGE_STEPS`) |
| New collection | `WizCollection` | Intro · Name · Placement · Scope · Dates · Source · Review | `collectionWizard.jsx` |
| Import & reconcile | `WizImport` | Source · Match columns · Omeka connection · Review matches · ID numbers · Done | `reconcileWizard.jsx` |
| New public site | `WizSite` | Name · Look · Template · What to show · Features · Review | (new) |

## 9. Decisions in the mockup worth keeping

- One organization can run several public sites. The catalog publishes live, with no export/import step.
- A record shows its publish state everywhere it appears, and is held back from public sites until it has a rights statement.
- Records can carry any number of typed ID numbers. Old Omeka and PastPerfect numbers are kept as "former" IDs, and old Omeka links redirect.
- Effective Record shows which fields a record inherits from its Fonds, Series and Collection.
- Approving a public submission creates both a draft record and an accession, so the chain of custody starts right away.
