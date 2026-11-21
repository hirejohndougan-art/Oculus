from core import *
from wiz import wizard, opt, summary

def chk2(items):
    out = '<div style="display: flex; flex-direction: column; gap: 4px">'
    for t, d, c in items:
        sub = f'<br><span style="font-size: 13px; color: #4a5056">{d}</span>' if d else ''
        out += (f'<label style="display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; font-size: 15px"><input type="checkbox"{" checked" if c else ""} style="width: 20px; height: 20px; margin-top: 1px; flex: 0 0 20px">'
                f'<span><strong>{t}</strong>{sub}</span></label>')
    return out + '</div>'

def setup():
    sp = Spec()
    steps = [
        ('Welcome to Oculus', 'Oculus keeps your whole archive in one place: what came in, what it is, where it sits on the shelf, and what the public can see. Setup takes about ten minutes, and you can change every answer later in Settings.',
         note('You’ll set up your organization, how ID numbers look, the rights for your catalog descriptions, and which standard word lists to use. If you have an Omeka site, you can bring it in at the end.', 'blue')),
        ('Your organization', 'This name appears on finding aids, labels, deeds of gift and your public site.',
         card(grid(field('o-name', 'Organization name', 'Dickinson Historical Society') + field('o-short', 'Short name or initials', 'DHS', hint='Used on box labels and ID numbers')
                   + field('o-city', 'City and state', 'Dickinson, Texas') + field('o-kind', 'Kind of organization', kind='select', options=['Historical society', 'Museum', 'Archive', 'Library special collection']))
              + field('o-email', 'Contact email for researchers', ph='[email]'))),
        ('Do you have an Omeka site?', 'Oculus can bring in an existing Omeka S site: items, item sets, files and links. Old Omeka addresses keep working because each one redirects to the new record.',
         sp.choice('omeka', [opt('Yes, import it after setup', 'You’ll connect it in Import &amp; export. Nothing changes on the Omeka site.', 'Good. After setup, open Import &amp; export and choose “Omeka S site”. The Historical Society stays live on Omeka until you switch over.'),
                             opt('Yes, but not now', 'Start fresh; you can import any time.'), opt('No Omeka site', 'Start with an empty catalog.')], init=0)),
        ('How should ID numbers look?', 'Every record gets a catalog ID. Pick a pattern; existing numbers from an import are kept as “former” IDs.',
         sp.choice('scheme', [opt('Prefix and number', 'DHS-0001, DHS-0002 …', 'New records will be numbered DHS-0001 upward. Accession numbers stay year-based (2026.015).'),
                              opt('Year-based', '2026.001.001: accession, then item', 'Each item takes its accession number plus its own number, so the donor trail is in the ID itself.'),
                              opt('Keep the numbers I already use', 'Type your own for each record', 'Oculus will ask for an ID on every new record and warn you about duplicates.')], init=0)),
        ('Catalog description rights', 'Separate from the rights in your photos and documents: may other people reuse the descriptions you write?',
         sp.choice('crights', [opt('CC0: anyone may reuse them', 'Recommended. Lets libraries, Wikipedia and search engines use your records freely.'),
                               opt('CC BY: reuse with credit'), opt('All rights reserved')], init=0)),
        ('Controlled vocabularies', 'Standard word lists keep subjects and object names consistent, and let people find your records alongside other archives. You can add your own terms too.',
         chk2([('Nomenclature for Museum Cataloging 4.0', 'What an object is: a chair, a plow, a photograph', True), ('LC Genre/Form Terms (LCGFT)', 'What kind of document or image it is', True),
               ('LC Subject Headings &amp; Name Authorities (LCSH / LCNAF)', 'What it is about, and who', True), ('Your own local terms', 'Place names and topics only your community uses', True)])),
        ('Ready to create your archive', 'Here’s what you chose. Click Edit on any line to change it.',
         summary([('Organization', 'Dickinson Historical Society (DHS), Dickinson, Texas', 1), ('Omeka', '{{ch_omeka_chosen}}', 2), ('ID numbers', '{{ch_scheme_chosen}}', 3),
                  ('Description rights', '{{ch_crights_chosen}}', 4), ('Vocabularies', 'Nomenclature 4.0, LCGFT, LCSH / LCNAF, local terms', 5)])),
    ]
    wizard('WizSetup', 'First-run setup', steps, 'Login.dc.html', 'Create the archive', 'AdminDashboard.dc.html', sp, h=1000)

def accession():
    sp = Spec()
    steps = [
        ('Who is donating?', 'Find someone who has given before, or add a new donor.',
         field('d-find', 'Search donors', ph='Name, email or organization') + note('No match for that name? Fill in the new donor below.', 'blue')
         + card(grid(field('d-name', 'Donor name', ph='[Donor name]') + field('d-contact', 'Email or phone', ph='[contact]')))
         + sp.choice('dkind', [opt('Individual'), opt('Family'), opt('Organization'), opt('Estate')], init=1, cols=160, compact=True)),
        ('When and how?', 'When the materials arrived, and on what terms.',
         grid(field('w-date', 'Date received', ph='[date]', kind='text') + field('w-by', 'Received by', 'John Dougan'))
         + sp.choice('method', [opt('Gift', 'Ownership passes to the Society'), opt('Transfer', 'From another organization, like a school or city'),
                                opt('Purchase'), opt('Loan', 'Comes back to the owner; tracked under Whereabouts')], init=0, cols=200)),
        ('What’s being received?', 'Describe the whole group as it arrived. You’ll catalog the individual items later.',
         field('m-desc', 'Description of the materials', 'Interview recordings for the Spoken History project, with signed release forms.', kind='textarea')
         + grid(field('m-extent', 'Extent', ph='[e.g. 1 box, 0.5 linear feet]') + field('m-count', 'Approximate number of items', ph='[N]'))
         + chk2([('Photographs', '', False), ('Documents', '', True), ('Audio or video', '', True), ('Objects', '', False), ('Digital files', '', True)])),
        ('Copyright &amp; rights', 'Who owns the copyright decides what you can put online. If you’re not sure, say so; it can be settled later.',
         sp.choice('copy', [opt('The donor transfers copyright to the Society', '', 'The deed of gift will include a copyright transfer, and items can be published once cataloged.'),
                            opt('The donor keeps copyright but lets the Society publish', '', 'The deed will grant a non-exclusive license to publish online.'),
                            opt('Someone else holds the copyright', '', 'Items will be marked In Copyright and kept off the public site until permission is recorded.'),
                            opt('Unknown, needs review', '', 'That’s an honest answer. Items will be marked Copyright Not Evaluated and flagged in Data Cleaning.')], init=0, cols=320)),
        ('Any restrictions?', 'Anything the donor asked for: keep closed for a time, staff only, no reproductions.',
         sp.choice('restr', [opt('No restrictions'), opt('Closed until a date', '', 'Choose the date below. Nothing from this accession will be published before then.'),
                             opt('Staff and researchers only', 'Not on the public site'), opt('Other condition')], init=0, cols=220)
         + field('r-note', 'Notes about restrictions', ph='[Anything the donor asked for, in their words]', kind='textarea')),
        ('Review &amp; save', 'Oculus will assign the accession number and draft the deed of gift for signature.',
         summary([('Donor', '[Donor name] ({{ch_dkind_chosen}})', 0), ('Received', '[date] · {{ch_method_chosen}}', 1), ('Materials', 'Interview recordings with release forms · [extent]', 2),
                  ('Copyright', '{{ch_copy_chosen}}', 3), ('Restrictions', '{{ch_restr_chosen}}', 4)])
         + note('Accession number <strong>2026.[015]</strong> will be assigned, and a deed of gift will be drafted in Deeds.', 'green')),
    ]
    wizard('WizAccession', 'Log an accession', steps, 'Accessions.dc.html', 'Save accession', 'Deeds.dc.html', sp)

def catalog():
    sp = Spec()
    types = [opt(t) for t in ['Photograph', 'Letter / correspondence', 'Document (other)', 'Oral history / interview', 'Audio recording', 'Video / film', 'Map',
                              'Newspaper / clipping', 'Object / artifact', 'Artwork', 'Other']]
    media = ('<div style="display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start">'
             f'<img src="{AERIAL}" alt="Labeled aerial photograph of Dickinson, late 1920s" style="flex: 1 1 320px; min-width: 0; max-width: 460px; height: 300px; object-fit: cover; border-radius: 6px">'
             '<div style="flex: 1 1 260px; display: flex; flex-direction: column; gap: 12px"><strong>dhs_scan_0412.tif</strong>'
             + dl([('Size', '[size] MB · 600 dpi'), ('Embedded details', 'Scanner model, scan date'), ('Fingerprint', 'Recorded on arrival')])
             + note('Filled in from the file: none of the descriptive fields. The handwriting on the photo will help with the title and date.', 'blue')
             + '<div style="display: flex; flex-wrap: wrap; gap: 10px">' + b_btn('Replace file', 's') + b_btn('Use a placeholder instead', 's') + '</div></div></div>')
    steps = [
        ('What kind of item is this?', 'Pick the option that best fits. This shapes the wording of later questions.', sp.choice('type', types, init=0, cols=200, compact=True)),
        ('Attach a scan or pick a placeholder', 'If you have a digital scan, attach it and Oculus pulls any embedded details it can find. No scan yet? Pick a placeholder and the item goes on the Needs Scanning list.', media),
        ('Which donation did this come from?', 'Linking the accession keeps the chain of custody from donor to shelf. Not from a logged accession, or not sure? Skip it.',
         sp.choice('acc', [opt('2026.[011] · City of Dickinson', 'Incorporation papers and photographs, 1958–1980'), opt('2026.[012] · [Donor name]', 'Railroad Center photographs'),
                           opt('Not from a logged accession'), opt('I’m not sure')], init=3, cols=300)),
        ('What is it called?', 'If there’s no official title, describe it briefly. Archivists call that a “supplied title” and put it in square brackets.',
         field('c-title', 'Title', 'Aerial View of Dickinson, Texas', hint='Taken from the label written on the photograph.')),
        ('Who made it?', 'The person or organization mainly responsible. Use “Last, First” for people when you can.',
         field('c-creator', 'Creator', ph='[Photographer unknown]') + '<div style="display: flex; flex-direction: column; gap: 6px; font-size: 14px"><strong>Names already in Authorities</strong>'
         + ''.join(f'<span style="padding: 8px 12px; border: 1px solid #d7dce2; border-radius: 4px; background: #ffffff">{n}</span>' for n in ['Dickinson Historical Society', 'Galveston, Houston and Henderson Railroad']) + '</div>'),
        ('When was it made?', 'Type a date any way you like: “August 1920”, “around 1920”, “1920s”. Leave it blank if it’s truly unknown.',
         field('c-date', 'Date', 'late 1920s', hint='As written on the photograph.') + note('Oculus reads this as <strong>192X</strong> (the 1920s, leaning late) for sorting and the timeline. It still shows “late 1920s” to visitors.', 'green')),
        ('Describe what you see.', 'Write for someone who can’t see the item. Describe what’s actually in it, plainly and in order, so the words alone paint the picture. Don’t interpret or guess.',
         field('c-desc', 'Description', 'Black-and-white aerial photograph of downtown Dickinson taken from the top of the school building. Hand-lettered paper labels point to Parks/Dees Home, Pilastrini Grocery, Lukens Home, Dees Garage, the hotel, the post office, Benson Feed Store, Lucy Home, the railroad depot and Old First Methodist. 45th Street (1997) runs across the foreground.', kind='textarea', rows=6)),
        ('What topics or themes does this cover?', 'Subjects help researchers find this item. Pick suggestions or type your own.',
         '<div style="display: flex; flex-wrap: wrap; gap: 8px">' + ''.join(f'<span style="display: inline-flex; align-items: center; min-height: 36px; padding: 0 12px; background: #eef1f4; border: 1px solid #c4cbd3; border-radius: 999px; font-size: 14px">{s} ×</span>' for s in ['Aerial photographs', 'Dickinson (Tex.)--History', 'Downtowns']) + '</div>'
         + field('c-subj', 'Add a subject', ph='Start typing') + '<span style="font-size: 14px; color: #4a5056">Suggested: Railroad stations · Churches · Commercial buildings</span>'),
        ('What kind of object is it?', 'The “what is it” classification from Nomenclature 4.0, separate from what it’s about. Optional, but it makes searching consistent across archives.',
         field('c-nom', 'Search Nomenclature', 'photograph') + sp.choice('nom', [opt('Photograph, Print', 'Category 8: Communication Artifacts › Documentary Artifact'), opt('Photograph, Aerial'), opt('Postcard')], init=1, cols=260)),
        ('What’s the physical form?', 'For physical items, the medium and size. For born-digital files, the format.',
         grid(field('c-med', 'Medium', 'Gelatin silver print') + field('c-dim', 'Size', ph='[e.g. 8 x 10 in.]') + field('c-cond', 'Condition', kind='select', options=['Good', 'Fair: foxing visible', 'Needs conservation']))),
        ('What rights apply?', 'What can people do with this item? “Unknown, needs review” is a perfectly honest answer.',
         sp.choice('rights', [opt('No Copyright – United States', 'Published before 1931 or otherwise public domain'), opt('Copyright Not Evaluated', 'Unknown, needs review'),
                              opt('In Copyright – Educational Use Permitted'), opt('In Copyright')], init=1, cols=260)),
        ('Where does it belong?', 'Time to file it. One plain question at a time, no archival jargon. Do you know where this came from?',
         sp.choice('triage', [
             opt('Yes, I know who gave it to us', 'Their name is on a deed or accession record, or you remember it.', 'Then it belongs with everything else from that same source. Pick them below, or start a new one if they’re not listed yet.'),
             opt('No, but it came as part of a group', 'A scrapbook, a filing cabinet, one box kept together.', 'The fact these were kept together is itself evidence, so archivists keep that grouping. It will be filed under unknown provenance, and you can make a series for that group next.'),
             opt('No idea, it was just here', 'No donor record, no note, nothing to go on.', 'That’s extremely common and it has a proper answer: it goes in the general collection, grouped by what it physically is, rather than inventing an origin that might be wrong.')], init=-1, cols=260)
         + field('c-coll', 'Collection', kind='select', options=['Becoming a City', 'Historic Railroad Center', 'General collection › Photographs', '+ New collection…'])),
        ('Where will it be stored?', 'The physical spot: which box and folder. Skip it if you’re not sure yet.',
         grid(field('c-box', 'Box', kind='select', options=['Box [003] · Archive room › Shelf B (95% full)', 'Box [002] · Archive room › Shelf A', '+ New box…']) + field('c-folder', 'Folder', ph='[00]'))
         + note('Box [003] is nearly full. Oculus will remind you when it’s time to start a new one.', 'amber')),
        ('Review and save', 'Here’s the record that will be created. Click Edit on any line to go back to it.',
         summary([('Type', '{{ch_type_chosen}}', 0), ('File', 'dhs_scan_0412.tif', 1), ('Accession', '{{ch_acc_chosen}}', 2), ('Title', 'Aerial View of Dickinson, Texas', 3),
                  ('Creator', '[Photographer unknown]', 4), ('Date', 'late 1920s (192X)', 5), ('Subjects', 'Aerial photographs; Dickinson (Tex.)--History; Downtowns', 7),
                  ('Classification', '{{ch_nom_chosen}}', 8), ('Rights', '{{ch_rights_chosen}}', 10), ('Filed in', 'Becoming a City', 11), ('Shelf', 'Box [003], Folder [00]', 12)])),
    ]
    wizard('WizCatalog', 'Catalog an item', steps, 'ScanInbox.dc.html', 'Save record', 'AdminRecord.dc.html', sp, h=1250,
           intro='<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; color: #4a5056">' + pill('From the Scan Inbox: file 1 of [N]', 'blue') + '<span>Skip this file · Save and start the next</span></div>')

def collection():
    sp = Spec()
    steps = [
        ('Set up a new Collection', 'A Collection is the group each item is filed into: by topic, by event, or the way the creator kept it. This takes about two minutes.',
         note('Example: “Historic Railroad Center” holds the photographs, documents and video about the GH&amp;H railroad in Dickinson.', 'blue')),
        ('What is the Collection called?', '', grid(field('k-name', 'Name', 'Dickinson City Cemetery Records') + field('k-code', 'Short code', 'C-[05]', hint='Used on box labels and in citations'))),
        ('Where does it sit in the hierarchy?', 'Which Fonds (whose records) and, if you use them, which Series (what kind of records).',
         grid(field('k-fonds', 'Fonds', kind='select', options=['F1 · Dickinson Historical Society', 'F0 · General collection (unknown provenance)', '+ New Fonds…'])
              + field('k-series', 'Series (optional)', kind='select', options=['S2 · Documents', 'S1 · Photographs', 'No series', '+ New Series…']))),
        ('What’s in the Collection?', 'A few sentences for the finding aid: what kinds of material, what it covers, and why it matters.',
         field('k-scope', 'Scope and content', 'Burial records, plot maps and correspondence for Dickinson City Cemetery, being digitized now.', kind='textarea', rows=4)),
        ('When do the materials span?', '', grid(field('k-from', 'Earliest', ph='[year]') + field('k-to', 'Latest', ph='[year]'))),
        ('Where did it come from?', 'Link the accession or donor, so researchers can see the provenance.',
         sp.choice('src', [opt('From an accession', 'Pick it from the list'), opt('Created by the Society itself'), opt('Unknown')], init=1, cols=220)),
        ('Review and create', '', summary([('Name', 'Dickinson City Cemetery Records (C-[05])', 1), ('Placement', 'F1 › S2 · Documents', 2), ('Scope', 'Burial records, plot maps and correspondence…', 3),
                                           ('Dates', '[year]–[year]', 4), ('Source', '{{ch_src_chosen}}', 5)])),
    ]
    wizard('WizCollection', 'New collection', steps, 'Collections.dc.html', 'Create collection', 'Collections.dc.html', sp, h=950)

def importer():
    sp = Spec()
    mapping = table(['Column in your file', 'Example', 'Oculus field'], [
        ('Title', 'Dickinson Station and Park', f'<select aria-label="Field for Title" style="{SEL}; min-width: 200px"><option>Title</option></select>'),
        ('Date', '1909', f'<select aria-label="Field for Date" style="{SEL}; min-width: 200px"><option>Date as written</option></select>'),
        ('Item Type', 'Still Image', f'<select aria-label="Field for Item Type" style="{SEL}; min-width: 200px"><option>Type</option></select>'),
        ('Subject', 'Railroads; Depots', f'<select aria-label="Field for Subject" style="{SEL}; min-width: 200px"><option>Subjects (split on ;)</option></select>'),
        ('Box', '12', f'<select aria-label="Field for Box" style="{SEL}; min-width: 200px"><option>Shelf location</option></select>'),
        ('Notes2', '[text]', f'<select aria-label="Field for Notes2" style="{SEL}; min-width: 200px"><option>Don’t import</option></select>')], minw=640)
    review = table(['Your row', 'Match in Oculus', 'What will happen'], [
        ('Dickinson Station and Park', 'DHS-[0001] (same title, same date)', pill('Update', 'blue')),
        ('Loading Strawberries', 'No match', pill('New record', 'green')),
        ('Depot move 1967', 'Dickinson Depot Move (1967)?', pill('Check: possible match', 'amber')),
        ('[Untitled]', 'No title', pill('Skip', 'gray'))], minw=640)
    steps = [
        ('What are you bringing in?', 'Oculus can read a spreadsheet (CSV or Excel) or an Omeka S site, and matches what it finds against records you already have so nothing is doubled.',
         sp.choice('src', [opt('A spreadsheet', 'CSV or Excel, from PastPerfect, a volunteer’s list, anything'), opt('An Omeka S site', 'Items, item sets, files and links')], init=1, cols=280)
         + '<div style="padding: 22px; border: 2px dashed #8b939c; border-radius: 6px; background: #ffffff; font-size: 14px"><strong>Drop a spreadsheet here</strong> or choose a file</div>'),
        ('Match your columns', 'Tell Oculus which column goes into which field. It guessed the obvious ones.', mapping),
        ('Connect your Omeka site', 'Oculus reads the site; it never changes anything on it. Each old Omeka address will redirect to the new record, so links in emails and on other sites keep working.',
         grid(field('i-url', 'Omeka S address', ph='[archive address]') + field('i-key', 'API key identity', ph='[key identity]') + field('i-cred', 'API key credential', ph='[credential]', kind='password'))
         + note('Found [N] items in [N] item sets, and [N] files ([size] GB).', 'green')),
        ('Review the matches', 'Check anything marked as a possible match before importing. You can undo the whole import afterward.', review),
        ('ID numbers for imported records', 'Imported records need catalog IDs too.',
         sp.choice('ids', [opt('Give them new DHS numbers, keep the old ones as former IDs', 'Recommended', 'Old Omeka IDs and spreadsheet numbers stay searchable and show under ID numbers.'),
                           opt('Use the numbers from the file as the catalog ID')], init=0, cols=320)),
        ('Import complete', '', note('<strong>[N] records created, [N] updated, [N] skipped.</strong> [N] Omeka addresses now redirect to their new records.', 'green')
         + '<div style="display: flex; flex-wrap: wrap; gap: 10px">' + a_btn('See what changed', 'Reports.dc.html', 's') + b_btn('Undo this import', 's') + '</div>'),
    ]
    wizard('WizImport', 'Import &amp; reconcile', steps, 'AdminDashboard.dc.html', 'Go to Item Records', 'Items.dc.html', sp, h=1000)

def newsite():
    sp = Spec()
    steps = [
        ('Name and address', 'A public site shows records you choose, live from the catalog. You can run several, for example the Digital Archive and a separate exhibit site.',
         grid(field('n-name', 'Site name', 'Railroad Center') + field('n-addr', 'Address', ph='[address]', hint='Use your own domain or a free Oculus address'))),
        ('Pick a look', 'Start from a look, then change colors and fonts in the editor.',
         sp.choice('look', [opt('Match the Historical Society website', 'Charcoal, white and orange; Roboto and Open Sans'), opt('Plain and quiet', 'Lots of white space, serif headings'),
                            opt('Dark gallery', 'For image-heavy exhibits')], init=0, cols=240)),
        ('Start from', 'Pages you can rearrange and edit with the drag-and-drop editor.',
         sp.choice('tpl', [opt('Archive', 'Home, search and browse, item pages, finding aids'), opt('Exhibit', 'A story told in sections, with items along the way'), opt('Blank', 'One empty page')], init=1, cols=240)),
        ('What should it show?', 'Only records marked public are ever shown. Narrow it further here.',
         sp.choice('scope', [opt('Everything that is public'), opt('Only some collections', '', 'Choose the collections below.')], init=1, cols=280)
         + chk2([('Historic Railroad Center', '[N] public records', True), ('Becoming a City', '[N] public records', False), ('Spoken History', '[N] public records', False)])),
        ('Features', '', chk2([('Search and filters', '', True), ('Map of places', 'Records with a map pin', True), ('Timeline', '', True), ('Finding aids', '', False),
                               ('“Share your history” form', 'Sends to Public submissions for review', True), ('Zoomable images (IIIF)', '', True)])),
        ('Review', '', summary([('Name', 'Railroad Center', 0), ('Look', '{{ch_look_chosen}}', 1), ('Starts from', '{{ch_tpl_chosen}}', 2), ('Shows', '{{ch_scope_chosen}}', 3), ('Features', 'Search, map, timeline, submissions, IIIF', 4)])
         + note('The site starts as a draft. Nothing is public until you press Publish in the editor.', 'blue')),
    ]
    wizard('WizSite', 'New public site', steps, 'Sites.dc.html', 'Create and open the editor', 'AdminSiteEditor.dc.html', sp, h=950)
