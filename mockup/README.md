# Oculus mockup

A click-through mockup of the whole platform: 41 screens.

- **Public site, 4 screens:** home, search and browse, item page, finding aid.
- **Back end (admin), 31 screens:** sign-in, dashboard, intake, catalog, arrangement, storage, preservation, circulation, public sites and page editor, reports and settings.
- **Wizards, 6:** first-run setup, log an accession, catalog an item (14 steps, with the filing guide), new collection, import & reconcile, and new public site.

`canvas.json` lays the screens out in rows; `screens/` holds one file per screen.

## Opening the screens

The `.dc.html` files are Claude design-canvas pages, not plain web pages. A browser won't run their `{{…}}` placeholders and `<sc-if>` / `<sc-for>` tags. To click through them, upload this folder into a Claude design canvas. To read how a screen is built, open the file in a text editor: every style is inline, and the `<script type="text/x-dc">` block at the bottom holds the sample data and the click behavior.

## Notes

- **Images.** Five screens point at `/_blob/2e9e…` for one archive photograph (an aerial view of Dickinson, late 1920s). That image belongs to the Dickinson Historical Society and isn't included here, so those spots show nothing outside the canvas. All other images are gray placeholders that name the photo meant to go there.
- **Placeholders.** Counts, dates, private donor names, researchers and volunteers appear as `[N]`, `[date]`, `[Donor name]` and the like. Record titles, collections and dates come from the Society's public archive.
- **Generated screens.** The 30 back-end screens other than the page editor (`AdminSiteEditor`), plus the 6 wizards, come from [`../tools/mockup-generator`](../tools/mockup-generator/). Change the generator, not the files. The 4 public pages and the page editor were written by hand.
