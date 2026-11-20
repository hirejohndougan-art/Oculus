from core import *

def record():
    sp = Spec(); sp.toggle('pub', False)
    desc = card(grid(
        field('f-title', 'Title *', 'Dickinson Station and Park', span=True)
        + field('f-date', 'Date as written *', '1909')
        + field('f-edtf', 'Date for sorting (EDTF)', '1909', hint='1909~ means about 1909; 195X means the 1950s')
        + field('f-type', 'Type *', kind='select', options=['Photographs (LCGFT)', 'Documents', 'Maps', 'Sound recordings'])
        + field('f-class', 'Object classification', 'Photograph, Print (Nomenclature 4.0)')
        + field('f-creator', 'Creator', ph='[Photographer unknown]', hint='Linked to the Authorities list so one name is spelled one way')
        + field('f-desc', 'Description *', 'The GH&amp;H railroad depot and park in Dickinson, with passengers waiting on the platform, 1909.', span=True, kind='textarea')), 'Description')
    subj = card(
        '<div style="display: flex; flex-wrap: wrap; gap: 8px">' + ''.join(
            f'<button type="button" aria-label="Remove subject {s}" style="display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; background: #eef1f4; border: 1px solid #c4cbd3; border-radius: 999px; font-size: 14px; font-family: inherit; color: #2f3337; cursor: pointer">{s} <span aria-hidden="true">×</span></button>'
            for s in ['Railroad stations', 'Parks', 'Galveston, Houston and Henderson Railroad']) + '</div>'
        + field('f-subj', 'Add a subject', ph='Start typing; Library of Congress headings and your own list', hint='Suggested from similar records: Railroads--Texas; Dickinson (Tex.)--History')
        + grid(field('f-place', 'Place *', 'Dickinson (Tex.)') + '<div style="display: flex; align-items: flex-end"><span style="display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; background: #eef1f4; border-radius: 4px; font-size: 13px; width: 100%; box-sizing: border-box">Map pin: [lat], [lng] · <a href="#">Move pin</a></span></div>'), 'Subjects and place')
    ids = card('<p style="margin: 0; font-size: 14px">A record can carry as many ID numbers as it needs. The primary one shows on the public site and in citations.</p>'
               + table(['Type', 'Number', 'Primary', ''], [('Catalog ID', 'DHS-[0001]', 'Yes', '<a href="#">Edit</a>'), ('Accession no.', '2026.[012].[003]', '', '<a href="#">Edit</a>'),
                                                           ('Former Omeka ID', '[000] · old link redirects here', '', '<a href="#">Edit</a>'), ('Former PastPerfect no.', '[legacy number]', '', '<a href="#">Edit</a>')], minw=520)
               + '<a href="#" style="font-size: 14px; font-weight: 600">+ Add an ID number</a>', 'ID numbers')
    loc = card(grid(field('f-coll', 'Collection', 'Historic Railroad Center') + field('f-ser', 'Series › File', '1. Photographs › GH&amp;H Depot, 1902–1967')
                    + field('f-box', 'Shelf location', ph='Box [00], Folder [00]') + field('f-acc', 'Accession', '2026.[012] · [Donor name]')
                    + field('f-cond', 'Condition', kind='select', options=['Good', 'Fair', 'Needs conservation']) + field('f-fmt', 'Physical format', ph='[e.g. Gelatin silver print, 8 x 10 in.]')), 'Location and accession')
    rights = card(grid(field('f-rights', 'Rights statement *', kind='select', options=['[Choose a rightsstatements.org statement]', 'No Copyright – United States', 'Copyright Not Evaluated', 'In Copyright – Educational Use Permitted'])
                       + field('f-access', 'Who can see it', kind='select', options=['Public on the sites it is published to', 'Staff only', 'Description public, image staff only'])
                       + field('f-credit', 'Credit line', 'Courtesy of the Dickinson Historical Society', span=True)), 'Rights and access')
    hist = card(''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 12px; padding: 10px 0; border-bottom: 1px solid #eef1f4; font-size: 14px"><span style="flex: 0 0 150px; color: #4a5056">[date, time]</span><span style="flex: 1 1 260px"><strong>{w}</strong> {t}</span><a href="#">Compare</a></div>'
                        for w, t in [('John Dougan', 'edited Subjects'), ('[Volunteer]', 'added the access copy'), ('[Volunteer]', 'marked it ready for review'), ('Omeka import', 'created this record from Omeka item [000]')]), 'History')
    tabs = sp.tabbar('rec', [('desc', 'Description', desc + subj), ('ids', 'ID numbers', ids), ('loc', 'Location &amp; accession', loc), ('rights', 'Rights', rights), ('hist', 'History', hist)])
    status = ('<sc-if value="{{tg_pub}}" hint-placeholder-val="{{ false }}">' + pill('Published', 'green') + '</sc-if>'
              '<sc-if value="{{tgnot_pub}}" hint-placeholder-val="{{ true }}">' + pill('Draft', 'gray') + '</sc-if>')
    pubbtn = ('<sc-if value="{{tgnot_pub}}" hint-placeholder-val="{{ true }}">' + b_btn('Publish', 'p', 'tgflip_pub') + '</sc-if>'
              '<sc-if value="{{tg_pub}}" hint-placeholder-val="{{ false }}">' + b_btn('Unpublish', 's', 'tgflip_pub') + '</sc-if>')
    side = ('<aside style="flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 20px">'
            + card(ph_img('Depot and park, 1909 (access copy)', '180px') + dl([('Master', 'TIFF · [size] · [pixels]'), ('Access copy', 'JPEG, made automatically'), ('Fingerprint', 'SHA-256 matches · checked [date]'), ('OCR', 'Not needed')])
                   + '<button type="button" style="min-height: 44px; border: 1px dashed #8b939c; background: #f7f9fb; border-radius: 4px; font-family: inherit; font-size: 14px; font-weight: 600; color: #2f3337; cursor: pointer">Add files</button>', 'Media')
            + card('<label style="display: flex; align-items: center; gap: 10px; font-size: 14px"><input type="checkbox" checked style="width: 18px; height: 18px">Digital Archive</label>'
                   '<label style="display: flex; align-items: center; gap: 10px; font-size: 14px"><input type="checkbox" style="width: 18px; height: 18px">[Second site]</label>'
                   + note('<strong>Can’t publish yet:</strong> choose a rights statement on the Rights tab.'), 'Show on these sites')
            + card('<a href="#">Loading Strawberries (1909)</a><a href="#">Dickinson Depot Move (1967)</a><a href="EffectiveRecord.dc.html">See inherited fields (Effective Record)</a>', 'Related') + '</aside>')
    inner = (page_head('Dickinson Station and Park', '', status + a_btn('View on site', 'Item.dc.html', 's') + pubbtn,
                       crumb='<a href="Items.dc.html">Item Records</a> › <a href="Collections.dc.html">Historic Railroad Center</a> › Photographs')
             + '<span style="font-size: 13px; color: #4a5056">Saved [time] by John Dougan · DHS-[0001]</span>'
             + f'<div style="display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start"><div style="flex: 3 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 20px">{tabs}</div>{side}</div>')
    screen('AdminRecord', 'Record editor', inner, sp, h=1650)

def needs_sorting():
    rows = [(t, ty, a, a_btn('File it', 'WizCatalog.dc.html', 's')) for t, ty, a in [
        ('Gar Rodeo window sign, 1950s', 'Photograph', '2026.[009]'), ('Dunbar teachers in a classroom, 1950s', 'Photograph', '[none]'),
        ('Paying the poll tax', 'Photograph', '2026.[011]'), ('Early History of Dickinson (typescript, 1949)', 'Document', '[none]'),
        ('Oil well on Hughes Road, 1930s', 'Photograph', '[none]')]]
    inner = (page_head('Needs Sorting', 'Cataloged items that haven’t been filed into a Collection yet. The filing guide asks a few plain questions and suggests where each one belongs.',
                       a_btn('Sort them one by one', 'WizCatalog.dc.html', 'p'))
             + note('Not sure where something came from? That’s common, and it has a proper answer: it goes in the general collection, grouped by what it physically is.', 'blue')
             + table(['Item', 'Type', 'Accession', ''], rows, link='AdminRecord.dc.html', minw=640))
    screen('NeedsSorting', 'Needs Sorting', inner)

def ocr():
    sp = Spec()
    queue = ''.join(f'<a href="#" style="display: flex; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #eef1f4; text-decoration: none; color: #2f3337; background: {bg}">'
                    f'<span><strong style="color: #111111">{t}</strong><br><span style="font-size: 13px; color: #4a5056">{p}</span></span>{s}</a>'
                    for t, p, s, bg in [('Early History of Dickinson', '4 pages · typescript', pill('Review', 'blue'), '#fff7f0'),
                                        ('Dickinson Incorporation Timeline', '2 pages', pill('Done', 'green'), '#ffffff'),
                                        ('Baccalaureate Program, 1922', '1 page', pill('Queued', 'gray'), '#ffffff'),
                                        ('Historic Structures Report', '[N] pages', pill('Queued', 'gray'), '#ffffff')])
    text = ('EARLY HISTORY OF DICKINSON\n\n[The recognized text appears here, line for line, so you can correct it against the page image. '
            'Words the engine was unsure of are marked for review.]')
    inner = (page_head('OCR', 'Turns scanned pictures of text into searchable words, so a researcher can find a name or phrase inside a document. Review the text against the page before it is saved.',
                       b_btn('Run on [N] queued pages', 'p'))
             + '<div style="display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start">'
             + f'<section style="flex: 1 1 260px; min-width: 0; {CARD}; overflow: hidden"><h2 style="margin: 0; padding: 14px; {H6}; font-size: 16px; border-bottom: 1px solid #d7dce2">Queue</h2>{queue}</section>'
             + f'<section style="flex: 2 1 340px; min-width: 0; {CARD}; padding: 16px; display: flex; flex-direction: column; gap: 10px"><span style="font-weight: 600">Page 1 of 4</span>{ph_img("Page image: Early History of Dickinson, typewritten, page 1", "460px", True)}</section>'
             + f'<section style="flex: 2 1 340px; min-width: 0; {CARD}; padding: 16px; display: flex; flex-direction: column; gap: 10px">'
             + '<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px"><label for="ocrtext" style="font-weight: 600">Recognized text</label>' + pill('[N]% confidence', 'blue') + '</div>'
             + f'<textarea id="ocrtext" rows="16" style="padding: 12px; border: 1px solid #8b939c; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 13px; line-height: 1.6; resize: vertical; white-space: pre-wrap">{text}</textarea>'
             + '<div style="display: flex; flex-wrap: wrap; gap: 10px">' + b_btn('Accept and save', 'd') + b_btn('Run again', 's') + b_btn('Next page →', 's') + '</div></section></div>')
    screen('OCR', 'OCR', inner, sp)

def data_cleaning():
    sp = Spec(); sp.toggle('merged', False)
    groups = [('Blank dates', '[N] records', 'Records with no date at all. Even “undated” or a decade like 1950s helps researchers.', 'Fix [N] dates'),
              ('Rights unknown', '[N] records', 'These can’t go on a public site until a rights statement is chosen.', 'Review rights'),
              ('Missing place', '[N] records', 'No place means they don’t appear on the map or in place filters.', 'Add places')]
    cards = ''.join(card(f'<div style="display: flex; justify-content: space-between; gap: 10px; align-items: baseline"><span style="{H6}; font-size: 17px">{t}</span>{pill(n, "amber")}</div>'
                         f'<p style="margin: 0; font-size: 14px; line-height: 1.5">{d}</p><div>{a_btn(b, "Items.dc.html", "s")}</div>') for t, n, d, b in groups)
    dup = card('<p style="margin: 0; font-size: 14px">These creator names look like the same organization written two ways. Merging keeps one spelling everywhere and leaves the other as a “see” reference.</p>'
               + '<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center">'
               + '<span style="padding: 10px 14px; border: 1px solid #d7dce2; border-radius: 4px; background: #f7f9fb"><strong>Galveston, Houston and Henderson Railroad</strong><br><span style="font-size: 13px; color: #4a5056">[N] records</span></span>'
               + '<span aria-hidden="true">≈</span>'
               + '<span style="padding: 10px 14px; border: 1px solid #d7dce2; border-radius: 4px; background: #f7f9fb"><strong>GH&amp;H Railroad</strong><br><span style="font-size: 13px; color: #4a5056">[N] records</span></span></div>'
               + '<sc-if value="{{tgnot_merged}}" hint-placeholder-val="{{ true }}"><div style="display: flex; flex-wrap: wrap; gap: 10px">' + b_btn('Merge into the first name', 'd', 'tgflip_merged') + b_btn('They are different', 's') + '</div></sc-if>'
               + '<sc-if value="{{tg_merged}}" hint-placeholder-val="{{ false }}">' + note('Merged. [N] records now use “Galveston, Houston and Henderson Railroad”. <button type="button" onClick="{{tgflip_merged}}" style="border: 0; background: none; color: #1d4f73; text-decoration: underline; font-family: inherit; font-size: 14px; cursor: pointer">Undo</button>', 'green') + '</sc-if>',
               'Possible duplicate creators')
    inner = (page_head('Data Cleaning', 'Finds records with missing or inconsistent fields so you can fix them in one pass instead of one record at a time.', b_btn('Scan the catalog again', 's'))
             + f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px">{cards}</div>' + dup)
    screen('DataCleaning', 'Data Cleaning', inner, sp)

def authorities():
    rows = [('Galveston, Houston and Henderson Railroad', 'Organization', '1853–', '[N]', 'LCNAF'),
            ('Dickinson Historical Society', 'Organization', '[year]–', '[N]', 'Local'),
            ('Dickinson, John', 'Person', '[dates]', '[N]', 'Local'),
            ('Menotti, Fred', 'Person', '[dates]', '[N]', 'Local'),
            ('Dickinson Independent School District', 'Organization', '[year]–', '[N]', 'LCNAF'),
            ('[Family name] family', 'Family', '', '[N]', 'Local')]
    inner = (page_head('Authorities', 'The master list of people, families and organizations, so one creator is spelled the same way everywhere and a researcher can see everything connected to them.',
                       b_btn('+ Add a name', 'p') + a_btn('Find duplicates', 'DataCleaning.dc.html', 's'))
             + search_row('Name, alternate spelling', ['All', 'People', 'Families', 'Organizations'])
             + table(['Name (preferred form)', 'Type', 'Dates', 'Records', 'Source'], rows, minw=720))
    screen('Authorities', 'Authorities', inner)

def fonds():
    tree = (f'<section style="{CARD}; padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; font-size: 15px">'
            f'<h2 style="margin: 0 0 8px; {H6}; font-size: 18px">How it fits together</h2>'
            '<div><strong>F1 · Dickinson Historical Society</strong> <span style="color: #4a5056">(Fonds: whose records are these?)</span></div>'
            '<div style="padding-left: 22px">S1 · Photographs <span style="color: #4a5056">(Series: what kind of records?)</span></div>'
            '<div style="padding-left: 44px"><a href="Collections.dc.html">Historic Railroad Center</a> <span style="color: #4a5056">(Collection: the group each item is filed in)</span></div>'
            '<div style="padding-left: 44px"><a href="Collections.dc.html">Becoming a City</a></div>'
            '<div style="padding-left: 22px">S2 · Documents</div><div style="padding-left: 22px">S3 · Audiovisual</div>'
            '<div style="padding-left: 44px"><a href="Collections.dc.html">Spoken History</a></div>'
            '<div style="margin-top: 8px"><strong>F0 · General collection (unknown provenance)</strong></div>'
            '<div style="padding-left: 22px; color: #4a5056">Material with no donor record, grouped by what it physically is</div></section>')
    inner = (page_head('Fonds', 'The top level. One Fonds holds all the records from one creator: a family, a business, a church, a club. Ask “whose stuff is this?”', b_btn('+ New Fonds', 'p'))
             + table(['Code', 'Fonds', 'Dates', 'Series', 'Items'], [('F1', 'Dickinson Historical Society', '1844–2021', '[N]', '[N]'), ('F0', 'General collection (unknown provenance)', '1900–1979', '[N]', '[N]')], link='Series.dc.html', minw=600)
             + tree)
    screen('Fonds', 'Fonds', inner)

def series():
    rows = [('S1', 'Photographs', 'F1', '1900–2021', '[N]'), ('S2', 'Documents', 'F1', '1844–2018', '[N]'), ('S3', 'Audiovisual', 'F1', '2000–2020', '[N]'), ('S4', 'Maps', 'F1', '1849–1967', '[N]')]
    inner = (page_head('Series', 'Groups inside a Fonds by what the records are: correspondence, photographs, minutes, ledgers. Optional for small Fonds.', b_btn('+ New Series', 'p'))
             + table(['Number', 'Series', 'Fonds', 'Dates', 'Items'], rows, link='Collections.dc.html', minw=600))
    screen('Series', 'Series', inner)

def collections():
    rows = [('Historic Railroad Center', 'F1 › S1', '1909–2006', '[N]', pill('On Digital Archive', 'green')),
            ('Spoken History', 'F1 › S3', '2000–2020', '[N]', pill('On Digital Archive', 'green')),
            ('Becoming a City', 'F1 › S2', '1958–1980', '[N]', pill('On Digital Archive', 'green')),
            ('Dickinson City Cemetery Records', 'F1 › S2', '[dates]', '[N]', pill('Staff only', 'gray')),
            ('Unsorted', '—', '', '[N]', '<a href="NeedsSorting.dc.html">Sort them</a>')]
    inner = (page_head('Collections', 'The specific group each item is filed into: by topic, by event, or the way the creator kept it. Every item needs one.',
                       a_btn('+ New collection', 'WizCollection.dc.html', 'p'))
             + table(['Collection', 'Fonds › Series', 'Dates', 'Items', 'Public'], rows, link='FindingAidAdmin.dc.html', minw=760))
    screen('Collections', 'Collections', inner)

def finding_aid_admin():
    sp = Spec()
    left = ''.join(f'<a href="#" style="display: block; padding: 12px 14px; border-bottom: 1px solid #eef1f4; text-decoration: none; color: #2f3337; background: {bg}"><strong style="color: #111111">{t}</strong><br><span style="font-size: 13px; color: #4a5056">{d}</span></a>'
                   for t, d, bg in [('Historic Railroad Center', '3 series · [N] items', '#fff7f0'), ('Spoken History', '[N] items', '#ffffff'), ('Becoming a City', '[N] items', '#ffffff')])
    body = (dl([('Creator', 'Dickinson Historical Society'), ('Dates', '1909–2006'), ('Extent', '[Extent]'),
                ('Scope and content', 'Photographs, documents and video about the GH&amp;H railroad in Dickinson: the depot and park, strawberry shipping, the interurban, and the depot’s move and restoration.'),
                ('Arrangement', 'Three series by format.'), ('Access', '[Conditions governing access]')])
            + '<div style="display: flex; flex-direction: column; gap: 6px; font-size: 14px"><strong>Contents</strong><span>Series 1. Photographs, 1909–1972</span><span style="padding-left: 18px">File: GH&amp;H Depot, 1902–1967 · Box [00], Folder [00]</span><span style="padding-left: 18px">File: Freight and bridges · Box [00], Folder [00]</span><span>Series 2. Documents, 2006</span><span>Series 3. Audiovisual, 2000</span></div>')
    inner = (page_head('Finding Aids', 'The researcher-facing guide to each collection. It’s built from the arrangement and catalog, so it is never out of date. Print it for the reading-room binder or export EAD.',
                       a_btn('View on public site', 'FindingAid.dc.html', 's') + b_btn('Export EAD XML', 's') + b_btn('Print / PDF', 'd'))
             + f'<div style="display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start"><section style="flex: 1 1 260px; min-width: 0; {CARD}; overflow: hidden">{left}</section>'
             + f'<div style="flex: 3 1 520px; min-width: 0">' + card(body, 'Historic Railroad Center Collection') + '</div></div>')
    screen('FindingAidAdmin', 'Finding Aids', inner, sp)

def subjects():
    rows = [('Railroads', '[N]', 'LCSH', ''), ('Railroad stations', '[N]', 'LCSH', ''), ('Strawberry industry', '[N]', 'LCSH', ''),
            ('Dickinson (Tex.)--History', '[N]', 'LCSH', ''), ('Depot', '[N]', 'Local', pill('Merge with “Railroad stations”?', 'amber')),
            ('Hurricanes', '[N]', 'LCSH', ''), ('Oral histories', '[N]', 'LCGFT', '')]
    inner = (page_head('Subjects', 'Every subject in use across the catalog, with counts. Merge near-duplicates and see what topics you actually hold.', b_btn('Merge selected', 's'))
             + search_row('Subject', ['All', 'Library of Congress', 'Your own terms', 'Used once'])
             + table(['Subject', 'Records', 'Source', 'Suggestion'], rows, link='Items.dc.html', minw=600))
    screen('Subjects', 'Subjects', inner)

def effective():
    rows = [('Rights', 'Copyright Not Evaluated', 'Fonds F1'), ('Creator', 'Dickinson Historical Society', 'Fonds F1'),
            ('Access', 'Public', 'Collection: Historic Railroad Center'), ('Type', 'Photographs', 'Series S1'),
            ('Title', 'Dickinson Station and Park', 'This item'), ('Date', '1909', 'This item'), ('Credit line', 'Courtesy of the Dickinson Historical Society', 'Fonds F1')]
    rws = [(k, v, pill(src, 'gray' if src == 'This item' else 'blue')) for k, v, src in rows]
    inner = (page_head('Effective Record', 'What a record looks like after it inherits fields from its Collection, Series and Fonds. Rights set once at the top apply to every item below unless an item overrides them.')
             + grid(field('er-pick', 'Show the effective record for', 'Dickinson Station and Park') + '<div></div>')
             + '<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 14px">' + pill('Fonds F1', 'blue') + '→' + pill('Series S1 · Photographs', 'blue') + '→' + pill('Collection · Historic Railroad Center', 'blue') + '→' + pill('This item', 'gray') + '</div>'
             + table(['Field', 'Value the public sees', 'Comes from'], rws, minw=620))
    screen('EffectiveRecord', 'Effective Record', inner)
