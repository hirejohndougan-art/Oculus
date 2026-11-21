import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from core import FILES, OUT
os.makedirs(OUT, exist_ok=True)
REPO_CANVAS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'mockup', 'canvas.json')
import screens1, screens2, screens3, wizards

screens1.login(); screens1.dashboard(); screens1.accessions(); screens1.deeds(); screens1.donors(); screens1.scan_inbox(); screens1.needs_scanning(); screens1.items()
screens2.record(); screens2.needs_sorting(); screens2.ocr(); screens2.data_cleaning(); screens2.authorities()
screens2.fonds(); screens2.series(); screens2.collections(); screens2.finding_aid_admin(); screens2.subjects(); screens2.effective()
screens3.storage(); screens3.preservation(); screens3.circulation(); screens3.sites(); screens3.submissions(); screens3.reports(); screens3.settings()
wizards.setup(); wizards.accession(); wizards.catalog(); wizards.collection(); wizards.importer(); wizards.newsite()

# ---- canvas layout ----
_cp = os.path.join(OUT, 'canvas.json')
canvas = json.load(open(_cp if os.path.exists(_cp) else REPO_CANVAS))
canvas['title'] = 'Oculus mockup'
FILES['AdminSiteEditor.dc.html'] = ('Public site editor', 1440, 1000)
rows = [
    ('Oculus back end: sign in, dashboard and intake', ['Login', 'AdminDashboard', 'Accessions', 'Deeds', 'Donors', 'ScanInbox', 'NeedsScanning']),
    ('Catalog', ['Items', 'AdminRecord', 'NeedsSorting', 'OCR', 'DataCleaning', 'Authorities']),
    ('Arrange & describe, storage and preservation', ['Fonds', 'Series', 'Collections', 'FindingAidAdmin', 'Subjects', 'EffectiveRecord', 'Storage', 'Preservation']),
    ('Circulation, public sites, reports and settings', ['Checkouts', 'Whereabouts', 'ExhibitsAdmin', 'Researchers', 'Conservators', 'Sites', 'AdminSiteEditor', 'Submissions', 'Reports', 'Settings']),
    ('Wizards (click Next, Back, the step list, and the choices)', ['WizSetup', 'WizAccession', 'WizCatalog', 'WizCollection', 'WizImport', 'WizSite']),
]
boards = {k: v for k, v in canvas['boards'].items() if k in ('Main.dc.html', 'Browse.dc.html', 'Item.dc.html', 'FindingAid.dc.html')}
order = list(boards.keys())
notes = {'t1': canvas['notes']['t1']}
canvas['notes']['t1']['text'] = 'Public site: Dickinson Historical Society Digital Archive'
y = 3200 + 120 + 260
for ri, (title, names) in enumerate(rows):
    notes[f'r{ri}'] = {'x': 0, 'y': y - 260, 'text': title, 'kind': 'title1', 'maxW': 1520 * len(names) - 80}
    hmax = 0
    for ci, n in enumerate(names):
        f = n + '.dc.html'
        t, w, h = FILES[f]
        boards[f] = {'x': ci * 1520, 'y': y, 'w': w, 'h': h, 'title': re.sub('&amp;', '&', t), 'expand': 'fill', 'is_interactive': True}
        order.append(f)
        hmax = max(hmax, h)
    y += hmax + 120 + 260
canvas['boards'] = boards; canvas['order'] = order; canvas['notes'] = notes
json.dump(canvas, open(os.path.join(OUT, 'canvas.json'), 'w'), ensure_ascii=False)

# ---- link check ----
missing = set()
for f in order:
    p = os.path.join(OUT, f)
    if not os.path.exists(p): continue
    s = open(p).read()
    for h in re.findall(r'href="([A-Za-z]+\.dc\.html)', s):
        if h not in boards:
            missing.add((f, h))
print('files', len(order), 'missing links', sorted(missing))
