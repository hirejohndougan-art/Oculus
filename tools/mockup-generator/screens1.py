from core import *

ITEMS = [
    ('Dickinson Station and Park', '1909', 'Photograph', 'Historic Railroad Center', 'Published'),
    ('Loading Strawberries', 'April 25, 1909', 'Photograph', 'Historic Railroad Center', 'Published'),
    ('Aerial View of Dickinson, Texas', 'late 1920s', 'Photograph', 'Becoming a City', 'Draft'),
    ('Souvenir of the Galveston Storm', '1900', 'Booklet', 'General collection', 'Published'),
    ('Dickinson High School Baccalaureate Program', 'May 14, 1922', 'Program', 'General collection', 'Ready for review'),
    ('Dickinson: Taller Than the Pines (manuscript)', '1979', 'Manuscript', 'Becoming a City', 'Published'),
    ('Spoken History: Fred Menotti', '2020', 'Oral history', 'Spoken History', 'Draft'),
    ('Interurban Bridge over Dickinson Bayou', '[Date]', 'Photograph', 'Historic Railroad Center', 'Published'),
    ('Dickinson Depot Move', '1967', 'Photograph', 'Historic Railroad Center', 'Published'),
    ('Village of Dickinson First Elected Officials', '1977', 'Photograph', 'Becoming a City', 'Published'),
    ('Depot Museum Exhibit Plan', '2006', 'Document', 'Historic Railroad Center', 'Needs rights'),
]
TONE = {'Published': 'green', 'Draft': 'gray', 'Ready for review': 'blue', 'Needs rights': 'amber'}

def login():
    html = ('<div style="font-family: \'Open Sans\', system-ui, sans-serif; color: #2f3337; background: #3c3c3c; min-height: 100vh; display: flex; flex-wrap: wrap">'
            f'<div style="flex: 1 1 520px; min-height: 420px; background: #2a2d30 url({AERIAL}) center / cover no-repeat; position: relative">'
            '<div style="position: absolute; left: 0; right: 0; bottom: 0; padding: 32px; background: linear-gradient(transparent, rgba(0,0,0,0.75)); color: #ffffff">'
            '<span style="font-size: 13px">Aerial view of Dickinson, Texas, late 1920s · Dickinson Historical Society</span></div></div>'
            '<main style="flex: 1 1 480px; background: #f3f5f8; display: flex; align-items: center; justify-content: center; padding: 48px 32px; box-sizing: border-box">'
            '<div style="width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 22px">'
            '<div style="display: flex; flex-direction: column; gap: 4px"><span style="font-family: Roboto, sans-serif; font-weight: 700; font-size: 34px; color: #111111">Oculus</span>'
            '<span style="font-size: 15px; color: #4a5056">Dickinson Historical Society · collections and archive</span></div>'
            f'<h1 style="margin: 0; {H}; font-size: 24px">Sign in</h1>'
            + field('em', 'Email', ph='you@example.org', kind='email') + field('pw', 'Password', kind='password') +
            '<label style="display: flex; align-items: center; gap: 10px; font-size: 14px"><input type="checkbox" style="width: 18px; height: 18px">Keep me signed in on this computer</label>'
            + a_btn('Sign in', 'AdminDashboard.dc.html', 'd') +
            '<div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; font-size: 14px"><a href="#">Forgot your password?</a><a href="WizSetup.dc.html">Setting up a new archive?</a></div>'
            + note('Volunteers sign in with the account an administrator made for them. Roles decide what each person can see and change.', 'blue') +
            '<a href="Main.dc.html" style="font-size: 14px">← Back to the public Digital Archive</a></div></main></div>')
    write('Login.dc.html', 'Sign in', html, Spec(), h=900)

def dashboard():
    sp = Spec(); sp.toggle('lessons', True)
    attn = [
        ('[N]', 'Accessions waiting to be processed', 'Logged arrivals not yet cataloged', 'Accessions', '{{accent}}'),
        ('[N]', 'Deeds of gift missing', 'Accessions with no signed deed on file', 'Deeds', '#c0392b'),
        ('[N]', 'Scans ready to catalog', 'Files waiting in the Scan Inbox', 'ScanInbox', '#4f6f8f'),
        ('[N]', 'Items need sorting', 'Cataloged but not filed into a Collection', 'NeedsSorting', '#e0b341'),
        ('[N]', 'Records to clean up', 'Blank dates, unknown rights, near-duplicates', 'DataCleaning', '#7a6a9a'),
        ('[N]', 'Public submissions', 'Sent in through the Digital Archive', 'Submissions', '#3c7a5a'),
    ]
    cards = ''.join(f'<a href="{h}.dc.html" style="display: flex; flex-direction: column; gap: 6px; padding: 16px 18px; {CARD}; border-top: 4px solid {c}; text-decoration: none; color: #2f3337">'
                    f'<span style="{H}; font-size: 28px">{n}</span><span style="font-weight: 600; font-size: 15px; color: #111111">{t}</span><span style="font-size: 13px; color: #4a5056">{d}</span></a>' for n, t, d, h, c in attn)
    lessons = ''.join(f'<a href="{h}" style="display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; background: #f7f9fb; border: 1px solid #d7dce2; border-radius: 6px; text-decoration: none; color: #2f3337">'
                      f'<span style="font-size: 12px; font-weight: 600; color: #8a4310">Lesson {i + 1} · [N] min</span><span style="font-weight: 600; color: #111111">{t}</span><span style="font-size: 13px; color: #4a5056">{d}</span></a>'
                      for i, (t, d, h) in enumerate([
                          ('Log a donation', 'Record a box of materials as an accession before cataloging what is inside.', 'WizAccession.dc.html'),
                          ('Catalog your first item', 'The cataloging guide asks one plain question at a time.', 'WizCatalog.dc.html'),
                          ('File it in the arrangement', 'Fonds, Series and Collections without the jargon.', 'Collections.dc.html'),
                          ('Publish to the website', 'Choose which records appear on your public site.', 'Sites.dc.html')]))
    quick = ''.join(a_btn(l, h, 's') for l, h in [('Catalog an item', 'WizCatalog.dc.html'), ('Log an accession', 'WizAccession.dc.html'),
                                                  ('New collection', 'WizCollection.dc.html'), ('Import a spreadsheet or Omeka', 'WizImport.dc.html'),
                                                  ('New public site', 'WizSite.dc.html'), ('Print box labels', 'Storage.dc.html')])
    activity = table(['Record', 'What happened', 'Who', 'When'], [
        ('Dickinson Station and Park', 'Subjects edited', 'John Dougan', '[time]'),
        ('Loading Strawberries', 'Access copy added', '[Volunteer]', '[time]'),
        ('Accession 2026.[000]', 'Logged; deed of gift drafted', '[Volunteer]', '[time]'),
        ('Spoken History: Fred Menotti', 'OCR and transcript attached', '[Volunteer]', '[time]'),
        ('Dickinson Depot Move', 'Published to Digital Archive', 'John Dougan', '[time]'),
    ], link='AdminRecord.dc.html')
    inner = (page_head('Good evening, John', 'What needs attention today, quick actions, and the state of the archive at a glance.',
                       a_btn('Audit &amp; Reports', 'Reports.dc.html', 's'))
             + '<sc-if value="{{tg_lessons}}" hint-placeholder-val="{{ true }}">'
             + card(f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px">{lessons}</div>'
                    + f'<div>{b_btn("Hide lessons", "s", "tgflip_lessons")}</div>', 'Learn the basics: 4 short lessons')
             + '</sc-if><sc-if value="{{tgnot_lessons}}" hint-placeholder-val="{{ false }}"><div>' + b_btn('Show the 4 short lessons again', 's', 'tgflip_lessons') + '</div></sc-if>'
             + f'<section style="display: flex; flex-direction: column; gap: 12px"><h2 style="margin: 0; {H6}; font-size: 19px">Needs attention</h2>'
             + f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px">{cards}</div></section>'
             + card(f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{quick}</div>', 'Quick actions')
             + '<div style="display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start">'
             + f'<div style="flex: 2 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 12px"><h2 style="margin: 0; {H6}; font-size: 19px">Recent activity</h2>{activity}</div>'
             + '<div style="flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 20px">'
             + card(dl([('Item records', '[N]'), ('Collections', '[N]'), ('Accessions', '[N]'), ('Boxes', '[N]'), ('Digital files', '[N] · [size] GB'), ('Last backup', '[date]')]), 'The archive at a glance')
             + card(f'<a href="Sites.dc.html" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; text-decoration: none; color: #2f3337"><span><strong style="color: #111111">Digital Archive</strong><br><span style="font-size: 13px; color: #4a5056">[N] records published</span></span>{pill("Live", "green")}</a>'
                    f'<a href="WizSite.dc.html" style="font-size: 14px; font-weight: 600">+ Add another public site</a>', 'Public sites')
             + '</div></div>')
    screen('AdminDashboard', 'Dashboard', inner, sp, h=1700)

def accessions():
    rows = [
        ('2026.[014]', '[Family name] family', '[date]', 'Spoken History interview recordings and release forms', pill('Pending', 'amber'), pill('Deed missing', 'red')),
        ('2026.[013]', 'Dickinson ISD Legacy Center (transfer)', '[date]', 'School programs and student body photographs, 1900–1922', pill('Partly cataloged', 'blue'), pill('Signed', 'green')),
        ('2026.[012]', '[Donor name]', '[date]', 'Railroad Center photographs and depot museum exhibit plan', pill('Cataloged', 'green'), pill('Signed', 'green')),
        ('2026.[011]', 'City of Dickinson (transfer)', '[date]', 'Incorporation papers and first-officials photographs, 1958–1980', pill('Cataloged', 'green'), pill('Not needed', 'gray')),
        ('2025.[040]', '[Donor name]', '[date]', 'Storm souvenir booklet, 1900', pill('Cataloged', 'green'), pill('Sent for signature', 'amber')),
    ]
    inner = (page_head('Accessions', 'Log new arrivals here first: a box of donated materials is one accession, before you catalog the individual items inside. It keeps the chain of custody from donor to shelf.',
                       a_btn('+ Log an accession', 'WizAccession.dc.html', 'p') + a_btn('Print accession register', 'Reports.dc.html', 's'))
             + search_row('Accession number, donor, materials', ['All', 'Pending', 'Partly cataloged', 'Deed missing'])
             + table(['Accession', 'Donor / source', 'Received', 'Materials', 'Status', 'Deed of gift'], rows, link='WizAccession.dc.html', minw=900))
    screen('Accessions', 'Accessions', inner)

def deeds():
    rows = [
        ('2026.[014]', '[Family name] family', pill('Missing', 'red'), 'Copyright transfers to DHS', a_btn('Generate deed', 'WizAccession.dc.html', 's')),
        ('2025.[040]', '[Donor name]', pill('Sent for signature', 'amber'), 'Donor keeps copyright; DHS may publish', '<a href="#">Mark as signed</a>'),
        ('2026.[013]', 'Dickinson ISD Legacy Center', pill('Signed', 'green'), 'Transfer agreement on file', '<a href="#">Open PDF</a>'),
        ('2026.[012]', '[Donor name]', pill('Signed', 'green'), 'Copyright transfers to DHS', '<a href="#">Open PDF</a>'),
    ]
    inner = (page_head('Deeds of gift', 'The legal record that a donor gave materials to the Society. Oculus drafts the deed from the accession, and you attach the signed copy when it comes back.',
                       a_btn('+ Log an accession', 'WizAccession.dc.html', 's'))
             + note('<strong>[N] accessions are missing a signed deed.</strong> Until one is on file, their items can be cataloged but are held back from the public site.', 'amber')
             + table(['Accession', 'Donor', 'Deed status', 'Rights recorded', ''], rows, minw=820))
    screen('Deeds', 'Deeds of gift', inner, h=1300)

def donors():
    rows = [
        ('[Family name] family', 'Family', '[N]', '[date]', '[email] · [phone]'),
        ('Dickinson ISD Legacy Center', 'Organization', '[N]', '[date]', '[contact name]'),
        ('City of Dickinson', 'Government', '[N]', '[date]', '[contact name]'),
        ('[Donor name]', 'Individual', '[N]', '[date]', '[email]'),
        ('Estate of [name]', 'Estate', '[N]', '[date]', 'Executor: [name]'),
    ]
    inner = (page_head('Donors', 'The people and organizations who have given materials to the Society, with every accession they made.',
                       b_btn('+ Add a donor', 'p') + a_btn('Thank-you letters', 'Reports.dc.html', 's'))
             + search_row('Name, email, organization', ['All', 'Individuals', 'Organizations', 'Estates'])
             + table(['Donor', 'Type', 'Accessions', 'Last gift', 'Contact'], rows, link='Accessions.dc.html', minw=760)
             + note('Contact details are visible to staff with the Donor relations role only.', 'blue'))
    screen('Donors', 'Donors', inner)

def scan_inbox():
    sp = Spec()
    tiles = (f'<div style="display: flex; flex-direction: column; gap: 8px; {CARD}; padding: 10px"><img src="{AERIAL}" alt="Scan of a labeled aerial photograph of Dickinson" style="width: 100%; height: 150px; object-fit: cover; border-radius: 4px">'
             f'<span style="font-weight: 600; font-size: 14px; color: #111111">dhs_scan_0412.tif</span><span style="font-size: 12px; color: #4a5056">[size] MB · 600 dpi · EXIF found</span>{pill("Ready", "green")}</div>')
    for f, t in [('dhs_scan_0413.tif', 'Ready'), ('dhs_scan_0414.tif', 'Ready'), ('dhs_scan_0415.tif', 'Ready'), ('menotti_tape2.wav', 'Ready'), ('dhs_scan_0416.pdf', 'Checking'), ('IMG_2231.jpg', 'Possible duplicate')]:
        tone = {'Ready': 'green', 'Checking': 'gray', 'Possible duplicate': 'amber'}[t]
        tiles += (f'<div style="display: flex; flex-direction: column; gap: 8px; {CARD}; padding: 10px">{ph_img("[Scan preview]", "150px")}'
                  f'<span style="font-weight: 600; font-size: 14px; color: #111111">{f}</span><span style="font-size: 12px; color: #4a5056">[size] MB</span>{pill(t, tone)}</div>')
    inner = (page_head('Scan Inbox', 'Scans land here from the scanner or an upload. Catalog them one after another: the cataloging guide opens with each file already attached and any embedded details filled in.',
                       a_btn('Catalog the [N] ready files', 'WizCatalog.dc.html', 'p') + b_btn('Upload files', 's'))
             + '<div style="display: flex; flex-wrap: wrap; gap: 14px; align-items: center; padding: 18px; border: 2px dashed #8b939c; border-radius: 6px; background: #ffffff">'
             + '<span style="font-weight: 600">Drop scans here</span><span style="font-size: 14px; color: #4a5056">TIFF, JPEG, PDF, WAV, MP3, MP4 · or point your scanner at the Oculus upload folder</span></div>'
             + f'<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px">{tiles}</div>')
    screen('ScanInbox', 'Scan Inbox', inner, sp, h=1300)

def needs_scanning():
    rows = [
        ('Dickinson Methodist Church', 'Photograph', 'Box [03], Folder [07]', 'Placeholder: photograph', a_btn('Attach scan', 'ScanInbox.dc.html', 's')),
        ('Gar Rodeo window sign', 'Photograph', 'Box [05], Folder [02]', 'Placeholder: photograph', a_btn('Attach scan', 'ScanInbox.dc.html', 's')),
        ('Historic Structures Report', 'Document', 'Shelf B, binder', 'Placeholder: document', a_btn('Attach scan', 'ScanInbox.dc.html', 's')),
        ('Spoken History tape [N]', 'Audio', 'Box [11]', 'Placeholder: cassette', a_btn('Attach scan', 'ScanInbox.dc.html', 's')),
    ]
    inner = (page_head('Needs Scanning', 'Items cataloged with a placeholder instead of a real scan. Work through this list when the scanner is free; the record keeps everything you already entered.')
             + table(['Item', 'Type', 'Where it is', 'Placeholder', ''], rows, link='AdminRecord.dc.html', minw=760))
    screen('NeedsScanning', 'Needs Scanning', inner, h=1300)

def items():
    sp = Spec()
    rows = [(t, f'DHS-[{i:04d}]', d, ty, c, pill(s, TONE[s])) for i, (t, d, ty, c, s) in enumerate(ITEMS, 1)]
    def tbl(filt):
        rs = [r for r in rows if filt(r)]
        return table(['Title', 'ID', 'Date', 'Type', 'Collection', 'Status'], rs, link='AdminRecord.dc.html', minw=880)
    tabs = sp.tabbar('items', [
        ('all', 'All records', tbl(lambda r: True)),
        ('photo', 'Photographs', tbl(lambda r: r[3] == 'Photograph')),
        ('docs', 'Documents', tbl(lambda r: r[3] in ('Booklet', 'Program', 'Manuscript', 'Document'))),
        ('av', 'Audio &amp; video', tbl(lambda r: r[3] == 'Oral history')),
        ('review', 'Ready for review', tbl(lambda r: 'review' in r[5] or 'rights' in r[5])),
    ])
    inner = (page_head('Item Records', 'Every individual thing in the archive: each photo, letter, map, recording and object. This is the main catalog list.',
                       a_btn('+ Catalog an item', 'WizCatalog.dc.html', 'p') + b_btn('Batch entry', 's') + a_btn('Export CSV', 'Reports.dc.html', 's'))
             + search_row('Title, ID, creator, subject, accession', ['Collection', 'Date range', 'Rights', 'Has scan'])
             + tabs)
    screen('Items', 'Item Records', inner, sp, h=1300)
