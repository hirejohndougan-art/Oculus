from core import *

def storage():
    sp = Spec()
    boxes = [('Box [001]', 'Archive room › Shelf A', 'Historic Railroad Center photographs', 80), ('Box [002]', 'Archive room › Shelf A', 'Railroad Center documents', 45),
             ('Box [003]', 'Archive room › Shelf B', 'Becoming a City', 95), ('Box [011]', 'Archive room › Shelf C', 'Spoken History cassettes', 30),
             ('Flat file [1]', 'Map room', 'Maps and land grants', 60)]
    rows = [(b, l, c, f'<div style="min-width: 120px">{bar(p, b + " fullness")}<span style="font-size: 12px; color: #4a5056">[N]% full</span></div>', '<a href="#">Contents</a> · <a href="#">Label</a>') for b, l, c, p in boxes]
    rooms = card(''.join(f'<div style="display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid #eef1f4; padding-left: {ind}px"><span>{t}</span><span style="font-size: 13px; color: #4a5056">{n}</span></div>'
                         for t, n, ind in [('Archive room', '[N] boxes', 0), ('Shelf A', '[N] boxes', 20), ('Shelf B', '[N] boxes', 20), ('Shelf C', '[N] boxes', 20), ('Map room', '[N] flat files', 0), ('Exhibit hall', 'Display cases', 0)]), 'Rooms and shelves')
    inner = (page_head('Physical Storage', 'Where things physically live: rooms, shelves, boxes and folders. Print box labels with a QR code, and see which boxes are nearly full.',
                       b_btn('+ Add a box', 'p') + b_btn('Print labels', 's') + b_btn('Shelf audit', 's'))
             + '<div style="display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start"><div style="flex: 1 1 260px; min-width: 0">' + rooms + '</div>'
             + '<div style="flex: 3 1 560px; min-width: 0">' + table(['Container', 'Location', 'Holds', 'Fullness', ''], rows, minw=760) + '</div></div>'
             + note('Scan a box label with a phone or barcode scanner to open its contents list.', 'blue'))
    screen('Storage', 'Physical Storage', inner, sp)

def preservation():
    rows = [('Full fixity check', '[date]', '[N] files', pill('All match', 'green')), ('Weekly sample check', '[date]', '[N] files', pill('All match', 'green')),
            ('Weekly sample check', '[date]', '[N] files', pill('1 changed', 'red'))]
    inner = (page_head('Preservation', 'Checks that the digital files haven’t been corrupted over time, by comparing each file’s fingerprint (checksum) with the one recorded when it arrived.',
                       b_btn('Run a full check now', 'p') + a_btn('Fixity report', 'Reports.dc.html', 's'))
             + grid(card(dl([('Files', '[N]'), ('Storage used', '[size] GB'), ('Masters kept', 'TIFF, WAV, PDF/A')]), 'What’s stored')
                    + card(dl([('Last full check', '[date]'), ('Next check', '[date]'), ('Schedule', 'Sample weekly, full monthly')]), 'Schedule')
                    + card(dl([('Copies', '2'), ('Off-site copy', '[provider]'), ('Last backup', '[date]')]), 'Backups'))
             + note('<strong>1 file changed since it was stored:</strong> dhs_scan_0218.tif (Interurban Bridge). Restore it from the backup copy, then re-run the check. <a href="AdminRecord.dc.html">Open the record</a>', 'amber')
             + table(['Check', 'Ran', 'Files', 'Result'], rows, minw=560))
    screen('Preservation', 'Preservation', inner)

def simple(file, title, desc, actions, cols, rows, link=None, extra='', minw=760):
    inner = page_head(title, desc, actions) + extra + table(cols, rows, link=link, minw=minw)
    screen(file, title, inner)

def circulation():
    simple('Checkouts', 'Checkouts', 'Items a researcher has out in the reading room, with due-back times and overdue flags.', b_btn('+ Check out an item', 'p') + b_btn('Scan a label', 's'),
           ['Item', 'Researcher', 'Out since', 'Due back', 'Status'],
           [('Becoming a City, Box [003]', '[Researcher]', '[time]', '[time]', pill('In reading room', 'blue')),
            ('Historic Structures Report', '[Researcher]', '[date]', '[date]', pill('Overdue', 'red'))], link='AdminRecord.dc.html')
    simple('Whereabouts', 'Whereabouts', 'Items temporarily away from their shelf: on loan to another institution, at a conservator, or in a display case, and when they are due back.', b_btn('+ Record a move', 'p'),
           ['Item', 'Where it is', 'Why', 'Expected back'],
           [('Dickinson Depot Move (print)', 'Exhibit hall, case 2', 'Exhibit: Saving the Dickinson Depot', '[date]'),
            ('1849 Nicholstone land transfer', '[Conservator]', 'Flattening and rehousing', '[date]'),
            ('Railroad Restoration Video (tape)', '[Vendor]', 'Digitization', '[date]')], link='AdminRecord.dc.html')
    simple('ExhibitsAdmin', 'Exhibits', 'Displays you’ve put together, which items are in each, and when they open and close. An exhibit can be physical, online, or both.', b_btn('+ New exhibit', 'p'),
           ['Exhibit', 'Where', 'Items', 'Dates', 'Status'],
           [('Saving the Dickinson Depot', 'Exhibit hall + Digital Archive', '[N]', '[dates]', pill('Open', 'green')),
            ('Becoming a City, 1958–1980', 'Digital Archive', '[N]', '[dates]', pill('Open', 'green')),
            ('Here They Rest: Magnolia Cemetery', 'Digital Archive', '[N]', '[dates]', pill('Draft', 'gray'))], link='AdminSiteEditor.dc.html')
    simple('Researchers', 'Researchers', 'People who visit or contact the archive to use its materials, with their reading-room forms and a record of each visit.', b_btn('+ Register a researcher', 'p') + b_btn('Reading-room form', 's'),
           ['Researcher', 'Topic', 'Visits', 'Last visit', 'Form on file'],
           [('[Researcher]', 'GH&amp;H railroad history', '[N]', '[date]', pill('Yes', 'green')), ('[Researcher]', 'Family history', '[N]', '[date]', pill('Yes', 'green')),
            ('[Researcher]', 'Dickinson ISD history', '[N]', '[date]', pill('Missing', 'amber'))])
    simple('Conservators', 'Conservators', 'Specialists who repair and preserve fragile materials, and a record of what work was done on each item.', b_btn('+ Add a conservator', 'p'),
           ['Conservator', 'Specialty', 'Items with them now', 'Last job'],
           [('[Conservator]', 'Paper and maps', '[N]', '[date]'), ('[Vendor]', 'Audio and video digitization', '[N]', '[date]')])

def sites():
    site = lambda name, addr, st, tone, pages: card(
        f'<div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center"><span><strong style="{H6}; font-size: 18px">{name}</strong><br><span style="font-size: 14px; color: #4a5056">{addr}</span></span>{pill(st, tone)}</div>'
        + table(['Page', 'Kind', 'Last edited'], pages, link='AdminSiteEditor.dc.html', minw=480)
        + '<div style="display: flex; flex-wrap: wrap; gap: 10px">' + a_btn('Edit pages', 'AdminSiteEditor.dc.html', 'p') + a_btn('View site', 'Main.dc.html', 's') + b_btn('Site settings', 's') + '</div>')
    inner = (page_head('Public sites', 'Hermes publishes the catalog live: one organization can run several public sites, each with its own look and its own choice of what to show. There is no export or import step.',
                       a_btn('+ New public site', 'WizSite.dc.html', 'p'))
             + site('Digital Archive', '[archive address]', 'Live', 'green', [('Home', 'Page', '[date]'), ('Browse', 'Template', '[date]'), ('Item page', 'Template', '[date]'), ('Finding aid', 'Template', '[date]'), ('Saving the Dickinson Depot', 'Exhibit', '[date]')])
             + site('[Second site]', '[address]', 'Draft', 'gray', [('Home', 'Page', '[date]')]))
    screen('Sites', 'Public sites', inner, h=1400)

def submissions():
    sp = Spec()
    subs = [('a1', 'Photo: Gar Rodeo, 1950s', '[Submitter]', 'A family photo of the Gar Rodeo weigh-in. Sent with permission to publish.'),
            ('a2', 'Letter from a GH&amp;H conductor', '[Submitter]', 'Scan of a letter, about 1915, found in a family Bible.'),
            ('a3', 'Memory: the Hollywood Theatre', '[Submitter]', 'A written memory of Saturday matinees in the 1950s.')]
    for k, *_ in subs:
        sp.toggle(k, False)
    cards = ''
    for k, t, who, d in subs:
        cards += card(f'<div style="display: flex; flex-wrap: wrap; gap: 16px">{ph_img("[Submitted image]", "120px", extra="; flex: 0 0 160px")}'
                      f'<div style="flex: 1 1 300px; display: flex; flex-direction: column; gap: 6px"><strong style="{H6}; font-size: 17px">{t}</strong><span style="font-size: 13px; color: #4a5056">From {who} · [date] · rights: donor grants permission</span><span style="font-size: 14px">{d}</span></div></div>'
                      f'<sc-if value="{{{{tgnot_{k}}}}}" hint-placeholder-val="{{{{ true }}}}"><div style="display: flex; flex-wrap: wrap; gap: 10px">' + b_btn('Approve as a draft record', 'd', f'tgflip_{k}') + b_btn('Ask a question', 's') + b_btn('Decline', 's') + '</div></sc-if>'
                      f'<sc-if value="{{{{tg_{k}}}}}" hint-placeholder-val="{{{{ false }}}}">' + note('Approved. A draft record and an accession were created. <a href="AdminRecord.dc.html">Open the draft</a>', 'green') + '</sc-if>')
    inner = (page_head('Public submissions', 'Photos, documents and memories people send in through the “Share your history” form on the public site. Approving one creates a draft record and an accession, so the chain of custody starts right away.')
             + cards)
    screen('Submissions', 'Public submissions', inner, sp, h=1300)

def reports():
    reps = [('Inventory', 'Every item with its location, by collection or box'), ('Accession register', 'All accessions in date order, with deed status'),
            ('Donor list', 'Donors and what each gave, for thank-you letters'), ('Storage', 'Boxes, fullness and contents'),
            ('Rights audit', 'Records by rights statement; what can be published'), ('Fixity report', 'Results of every preservation check')]
    rc = ''.join(f'<a href="#" style="display: flex; flex-direction: column; gap: 6px; padding: 16px; {CARD}; text-decoration: none; color: #2f3337"><strong style="color: #111111">{t}</strong><span style="font-size: 13px; color: #4a5056">{d}</span><span style="font-size: 13px; font-weight: 600; color: #1d4f73">Print · PDF · CSV</span></a>' for t, d in reps)
    log = table(['When', 'Who', 'Record', 'Change'], [('[time]', 'John Dougan', 'Dickinson Station and Park', 'Subjects: added “Parks”'),
                                                     ('[time]', '[Volunteer]', 'Loading Strawberries', 'Media: access copy added'),
                                                     ('[time]', 'Omeka import', '[N] records', 'Created from Omeka S'),
                                                     ('[time]', 'John Dougan', 'Settings', 'Role changed: [Volunteer] → Cataloger')], minw=640)
    inner = (page_head('Audit &amp; Reports', 'Printable reports, and the audit trail of who changed what and when. Every change can be compared and undone.', a_btn('Export the whole catalog', 'WizImport.dc.html', 's'))
             + f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px">{rc}</div>'
             + f'<h2 style="margin: 0; {H6}; font-size: 19px">Audit trail</h2>' + search_row('Person, record, field', ['Today', 'This week', 'Imports']) + log)
    screen('Reports', 'Audit &amp; Reports', inner, h=1400)

def settings():
    sp = Spec()
    org = card(grid(field('s-name', 'Organization name', 'Dickinson Historical Society') + field('s-short', 'Short name', 'DHS') + field('s-city', 'City and state', 'Dickinson, Texas')
                    + field('s-type', 'Kind of organization', kind='select', options=['Historical society', 'Museum', 'Archive', 'Library special collection'])), 'Organization')
    ids = card('<p style="margin: 0; font-size: 14px">How new catalog ID numbers are built. Existing numbers never change.</p>'
               + grid(field('s-prefix', 'Prefix', 'DHS-') + field('s-digits', 'Digits', '4') + field('s-next', 'Next number', 'DHS-[0000]'))
               + '<p style="margin: 0; font-size: 14px">Accession numbers: <strong>year.number</strong>, for example 2026.[015]</p>', 'ID numbers')
    rights = card(field('s-crights', 'Rights for the catalog descriptions themselves', kind='select', options=['CC0: anyone may reuse the descriptions', 'CC BY: reuse with credit', 'All rights reserved'])
                  + field('s-default', 'Default rights statement for new records', kind='select', options=['Copyright Not Evaluated', 'No Copyright – United States', 'In Copyright']), 'Rights')
    vocab = card(''.join(f'<label style="display: flex; align-items: center; gap: 10px; font-size: 15px; min-height: 32px"><input type="checkbox"{" checked" if c else ""} style="width: 18px; height: 18px">{t}</label>'
                         for t, c in [('Nomenclature for Museum Cataloging 4.0', True), ('LC Genre/Form Terms (LCGFT)', True), ('LC Subject Headings &amp; Name Authorities (LCSH / LCNAF)', True), ('Your own local terms', True)]), 'Controlled vocabularies')
    levels = card(grid(field('s-l1', 'Level 1', 'Room') + field('s-l2', 'Level 2', 'Shelf') + field('s-l3', 'Level 3', 'Box') + field('s-l4', 'Level 4', 'Folder')), 'Physical storage levels')
    people = card(table(['Person', 'Role', 'Last signed in'], [('John Dougan', 'Administrator', '[time]'), ('[Volunteer]', 'Cataloger', '[date]'), ('[Volunteer]', 'Scanner', '[date]'), ('[Board member]', 'Viewer', '[date]')], minw=480)
                  + '<div>' + b_btn('+ Invite someone', 'p') + '</div>' + note('Catalogers can add and edit records; only Reviewers and Administrators can publish.', 'blue'), 'People &amp; roles')
    backup = card(dl([('Automatic backups', 'Every night'), ('Kept for', '30 days'), ('Off-site copy', '[provider]'), ('Last backup', '[date] · verified')])
                  + '<div style="display: flex; flex-wrap: wrap; gap: 10px">' + b_btn('Back up now', 's') + b_btn('Restore from a backup', 's') + '</div>', 'Backups')
    tabs = sp.tabbar('set', [('org', 'Organization', org), ('ids', 'ID numbers', ids), ('rights', 'Rights', rights), ('vocab', 'Vocabularies', vocab),
                             ('storage', 'Storage levels', levels), ('people', 'People &amp; roles', people), ('backup', 'Backups', backup)])
    inner = page_head('Settings', 'Set once and forget: these were chosen during first-run setup and can be changed here.', a_btn('Run setup again', 'WizSetup.dc.html', 's')) + tabs
    screen('Settings', 'Settings', inner, sp)
