# Public site themes: design work (not built)

Designs for Phase 4 (public sites and the page editor), made on 2026-11-24.

**Nothing here is code Oculus runs.** These are design-canvas pages to look at and react to. Phase 4 doesn't start until Phase 2 and Phase 3 (media) are done (PLATFORM_PLAN.md §10).

- Live canvas: https://claude.ai/artifact/VuqTQmDbDhJqpg48shocBF
- Project notes: `claude/oculus-public-site-designs.md` in the claude.ai project, which has the same decisions as below.

## What's here

`canvas/` holds the whole canvas: `canvas.json` plus 246 `.dc.html` pages. Each canvas page holds one theme, plus one page for the admin screens.

| Canvas page | What's on it |
|---|---|
| 00 Admin screens | Site design › Themes, Theme settings (with the contrast check), Page templates (layout and field switches), Review and publish (accessibility check), the public-site edit bar, and editing a page |
| 01–20, one per theme | The home page at desktop, tablet (820 px) and phone (390 px) sizes. Then 8 page templates: item, collection, finding aid, search and browse, person/group/place, page not found, restricted area, password. Then a phone view of the item page. |

The five chosen themes come first on the canvas: 01 Reading Room, 18 Library Stacks, 15 Plain Access, 07 Finding Aid First and 10 Museum Label.

### Opening it

The `.dc.html` files are Claude design-canvas pages, the same kind as `mockup/`. A browser won't run their `<sc-for>` / `{{…}}` parts. To click through them, open the live canvas link, or upload this `canvas/` folder into a Claude design canvas. Pages link to each other in Play.

### Which files are generated

- **Written by hand:**
  - the 20 home pages (`Main.dc.html`, `T02-Broadsheet.dc.html` … `T20-NightArchive.dc.html`)
  - their `-tablet` and `-phone` wrappers
  - `canvas.json`

  Edit these directly.
- **Generated:** every `<stem>-<page>.dc.html` page template, every `-item-phone` wrapper, and the six `Admin-*.dc.html` screens. They come from `tools/theme-generator/`:
  - `themes.py`: each theme's colours, fonts and header style
  - `pages.py`: the shared parts and the default page templates
  - `motifs.py`: each theme's own layouts, one class per theme
  - `admin.py`: the admin screens
  - `build.py`: writes them all. Run `python3 tools/theme-generator/build.py`. It never touches the hand-written files.

  Change the generator, not the generated files. If a page's height changes, update its `h` in `canvas.json` by hand.

## Decisions

The first decision is John's. He asked Claude to make the rest on his behalf, and he can overturn any of them. When Phase 4 is planned, each one needs a proper entry in `docs/DECISIONS.md`.

1. **Private or unpublished records show the ordinary 404 page** (John). A different page would show that something exists at that address. The restricted-area page is only for a whole site or area that has been deliberately restricted, and it never names a record.
2. **Phase 4 waits for Phase 2 and Phase 3.**
3. **Five starter themes:** Reading Room (default, the archive), Library Stacks (the library site), Plain Access (sets the accessibility floor), Finding Aid First (research archives), Museum Label (exhibits).
   - The other 15 become page-editor blocks rather than themes: the decade bar, the map with pins, the film strip, the departure-board list and the postcard feature.
4. **A theme is data, not code.** It's a package of named colours, text styles, spacing, a header style and a layout choice for each page template. It never runs code; anything that needs code is a plugin (P-001).
5. **Who controls themes.** System managers install themes. Site managers pick one and adjust its colours, fonts and logo. Saving runs a contrast check, and failing text colours can't be saved.
6. **"Page templates"** is the name for public layouts. "Templates" stays field templates.
7. **What public pages may show.** Page templates render only `publicOutput`'s public forms, never `staffWarnings`. The field switches only hide fields: a staff-only field is never sent to the public site.
8. **Image descriptions are required.** An image with no text description blocks publishing.

## Notes for working on it later

**Before Phase 4 starts**
- **Re-check the designs by eye.** None of these pages have been looked at rendered yet. Board heights in `canvas.json` are estimates, so some boards will have blank space at the bottom or cut off.
- **Check the phone and tablet wrappers.** They show the desktop page through `<dc-import>`. If a wrapper shows blank, swap it for a copy of the page.
- **Expect contrast fixes.** Colours were chosen to pass WCAG AA, but they haven't been measured. The contrast check (decision 5) will catch failures, so measure the five chosen themes first.
- **One colour is meant to fail.** The pale link colour on the Theme settings screen (`#7fa6c4`) deliberately shows a colour that fails the check. Don't copy it into a theme.

**When writing Phase 4 tasks**
- The draft job list is in the project notes (12 jobs). Number them above whatever is on `main` then, following the work-board rules.
- T-050 (how public sites are served) and Phase 3 media (M-003) come before the page templates.
- Item 1 of the decisions affects T-050's design: the public read path must answer a private record exactly like a missing one.

**Not designed yet**
- **The other Site design tabs:** Menus, Pages, and Headers and footers. The existing `mockup/screens/AdminSiteEditor.dc.html` covers much of this, so review it before designing more.
- **Exhibits and forms:** pages for exhibits, popups, global blocks, the dated notice bar, the forms that feed Public submissions, redirects from old Omeka links, and legal pages.
- **Library site settings:** the library site's own logo and the colours in Library Stacks need the library's input.

**Sample content**
- **Placeholders:** values like `[N]`, `[date]`, `[Collection name]` and `[Item title]` stand in for real data.
- **Real content:** the only real record shown is the aerial photo title, with the `DS5C740001` and `DPL` number formats.
- **Sample copy:** the headlines, shelf names and filter names are made up and can be changed.
