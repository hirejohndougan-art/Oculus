"""Shared building blocks for the Polybius back-end mockup artboards."""
import json, os, re

OUT = os.environ.get('OCULUS_MOCKUP_OUT', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out'))
AERIAL = '/_blob/2e9e77821dec3d46d57a32fdc4e99dbc'
FILES = {}  # file -> (title, w, h)

# ---------- style tokens ----------
INK = '#111111'; TXT = '#2f3337'; MUTED = '#4a5056'; LINE = '#d7dce2'; SOFT = '#eef1f4'
FIELD = 'height: 44px; padding: 0 12px; border: 1px solid #8b939c; border-radius: 4px; font-size: 15px; font-family: inherit; background: #ffffff; box-sizing: border-box; width: 100%'
SEL = 'height: 44px; padding: 0 10px; border: 1px solid #8b939c; border-radius: 4px; font-size: 15px; font-family: inherit; background: #ffffff; box-sizing: border-box; width: 100%'
CARD = 'background: #ffffff; border: 1px solid #d7dce2; border-radius: 6px'
H = "font-family: Roboto, sans-serif; font-weight: 700; color: #111111"
H6 = "font-family: Roboto, sans-serif; font-weight: 600; color: #111111"
BTN = "display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px; text-decoration: none; font-family: Roboto, sans-serif; font-weight: 600; font-size: 15px; border-radius: 4px; box-sizing: border-box"
BTN_P = BTN + "; background: {{accent}}; color: #1a1a1a; border: 0"
BTN_S = BTN + "; background: #ffffff; color: #111111; border: 1px solid #8b939c"
BTN_D = BTN + "; background: #111111; color: #ffffff; border: 0"

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def a_btn(label, href, kind='s'):
    st = {'p': BTN_P, 's': BTN_S, 'd': BTN_D}[kind]
    return f'<a href="{href}" style="{st}">{label}</a>'

def b_btn(label, kind='s', on=None, extra=''):
    st = {'p': BTN_P, 's': BTN_S, 'd': BTN_D}[kind]
    oc = f' onClick="{{{{{on}}}}}"' if on else ''
    return f'<button type="button"{oc} style="{st}; cursor: pointer{extra}">{label}</button>'

def field(id_, label, value='', ph='', hint='', span=False, kind='input', rows=3, options=None):
    sp = 'grid-column: 1 / -1; ' if span else ''
    v = f' value="{value}"' if value else ''
    p = f' placeholder="{ph}"' if ph else ''
    if kind == 'textarea':
        ctl = f'<textarea id="{id_}" rows="{rows}"{p} style="padding: 10px 12px; border: 1px solid #8b939c; border-radius: 4px; font-size: 15px; font-family: inherit; line-height: 1.5; resize: vertical; box-sizing: border-box; width: 100%">{value}</textarea>'
    elif kind == 'select':
        ctl = f'<select id="{id_}" style="{SEL}">' + ''.join(f'<option>{o}</option>' for o in options) + '</select>'
    else:
        ctl = f'<input id="{id_}" type="{kind}"{v}{p} style="{FIELD}">'
    h = f'<span style="font-size: 12px; color: #4a5056; line-height: 1.4">{hint}</span>' if hint else ''
    return f'<div style="{sp}display: flex; flex-direction: column; gap: 6px; min-width: 0"><label for="{id_}" style="font-size: 14px; font-weight: 600; color: #222222">{label}</label>{ctl}{h}</div>'

def grid(inner, minw=260, gap=18):
    return f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax({minw}px, 1fr)); gap: {gap}px">{inner}</div>'

def card(inner, title=None, pad=20, extra=''):
    t = f'<h2 style="margin: 0; {H6}; font-size: 18px">{title}</h2>' if title else ''
    return f'<section style="{CARD}; padding: {pad}px; display: flex; flex-direction: column; gap: 14px{extra}">{t}{inner}</section>'

def pill(text, tone='gray'):
    c = {'gray': ('#eef1f4', '#3c434b'), 'green': ('#dff1e3', '#1e5a2b'), 'amber': ('#fdf0dc', '#7a4a0b'),
         'red': ('#fbe3e1', '#8f2418'), 'blue': ('#e1edf8', '#1d4f73')}[tone]
    return f'<span style="display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: {c[0]}; color: {c[1]}; white-space: nowrap">{text}</span>'

def table(cols, rows, link=None, minw=640):
    th = ''.join(f'<th scope="col" style="padding: 10px 14px; font-weight: 600; text-align: left; white-space: nowrap">{c}</th>' for c in cols)
    body = ''
    for r in rows:
        cells = ''
        for i, c in enumerate(r):
            if i == 0 and link:
                c = f'<a href="{link}" style="font-weight: 600">{c}</a>'
            cells += f'<td style="padding: 12px 14px; vertical-align: top">{c}</td>'
        body += f'<tr style="border-top: 1px solid #eef1f4">{cells}</tr>'
    return (f'<div style="{CARD}; overflow-x: auto"><table style="width: 100%; border-collapse: collapse; font-size: 14px; min-width: {minw}px">'
            f'<thead><tr style="color: #4a5056; font-size: 13px; background: #f7f9fb">{th}</tr></thead><tbody>{body}</tbody></table></div>')

def dl(pairs, cols='max-content 1fr'):
    inner = ''.join(f'<dt style="font-weight: 600; color: #222222">{k}</dt><dd style="margin: 0">{v}</dd>' for k, v in pairs)
    return f'<dl style="margin: 0; display: grid; grid-template-columns: {cols}; gap: 8px 18px; font-size: 14px">{inner}</dl>'

def ph_img(label, h='120px', dark=False, extra=''):
    bg, fg = ('#5a5f64', '#eeeeee') if dark else ('#c9d0d8', '#3c434b')
    return f'<div style="height: {h}; background: {bg}; border-radius: 4px; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 12px; color: {fg}; font-size: 12px; font-weight: 600{extra}">{label}</div>'

def bar(pct, label):
    return (f'<div style="display: flex; flex-direction: column; gap: 4px"><div role="progressbar" aria-label="{label}" aria-valuenow="{pct}" aria-valuemin="0" aria-valuemax="100" '
            f'style="height: 8px; background: #e4e8ec; border-radius: 999px; overflow: hidden"><div style="height: 100%; width: {pct}%; background: #3c3c3c"></div></div></div>')

def note(text, tone='amber'):
    c = {'amber': ('#fdf3e6', '#f0c48f', '#5a3a12'), 'blue': ('#eaf2fa', '#a9c6e2', '#1d3b55'), 'green': ('#e8f5eb', '#a8d5b2', '#1e4a28')}[tone]
    return f'<div style="padding: 12px 14px; background: {c[0]}; border: 1px solid {c[1]}; border-radius: 4px; font-size: 14px; line-height: 1.5; color: {c[2]}">{text}</div>'

# ---------- interactive helpers (state lives in the component) ----------
class Spec:
    def __init__(self):
        self.tabs = {}; self.choices = {}; self.toggles = {}; self.wiz = None
    def tabbar(self, name, tabs, blocks=True):
        """tabs: list of (id, label, html). Returns tablist + blocks."""
        self.tabs[name] = [t[0] for t in tabs]
        btns = ''.join(
            f'<button type="button" role="tab" aria-selected="{{{{tabsel_{name}_{i}}}}}" onClick="{{{{tabpick_{name}_{i}}}}}" '
            f'style="min-height: 46px; padding: 0 16px; background: transparent; border: 0; border-bottom: 3px solid {{{{tabline_{name}_{i}}}}}; '
            f'font-family: Roboto, sans-serif; font-weight: 600; font-size: 15px; color: #222222; cursor: pointer">{lab}</button>' for i, lab, _ in tabs)
        out = f'<div role="tablist" style="display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #cfd5dd">{btns}</div>'
        if blocks:
            for k, (i, _, html) in enumerate(tabs):
                out += f'<sc-if value="{{{{tabon_{name}_{i}}}}}" hint-placeholder-val="{{{{ {"true" if k == 0 else "false"} }}}}">{html}</sc-if>'
        return out
    def choice(self, name, opts, init=-1, multi=False, cols=240, compact=False):
        """opts: list of dicts label/sub/note. Returns choice cards + note box."""
        self.choices[name] = {'opts': opts, 'init': init, 'multi': multi}
        pad = '12px 14px' if compact else '16px 18px'
        cards = (f'<sc-for list="{{{{ch_{name}}}}}" as="o" hint-placeholder-count="{len(opts)}">'
                 f'<button type="button" aria-pressed="{{{{o.on}}}}" onClick="{{{{o.pick}}}}" style="display: flex; gap: 12px; align-items: flex-start; text-align: left; padding: {pad}; '
                 f'background: {{{{o.bg}}}}; border: 2px solid {{{{o.ring}}}}; border-radius: 6px; font-family: inherit; color: #2f3337; cursor: pointer">'
                 f'<span aria-hidden="true" style="flex: 0 0 18px; height: 18px; margin-top: 2px; border-radius: {{{{o.shape}}}}; border: 2px solid #3c3c3c; background: {{{{o.dot}}}}; box-sizing: border-box"></span>'
                 f'<span style="display: flex; flex-direction: column; gap: 4px"><span style="font-weight: 600; font-size: 15px; color: #111111">{{{{o.label}}}}</span>'
                 f'<sc-if value="{{{{o.hasSub}}}}" hint-placeholder-val="{{{{ true }}}}"><span style="font-size: 13px; line-height: 1.45; color: #4a5056">{{{{o.sub}}}}</span></sc-if></span>'
                 f'</button></sc-for>')
        out = f'<div role="group" style="display: grid; grid-template-columns: repeat(auto-fill, minmax({cols}px, 1fr)); gap: 12px">{cards}</div>'
        if any(o.get('note') for o in opts):
            out += (f'<sc-if value="{{{{ch_{name}_hasnote}}}}" hint-placeholder-val="{{{{ false }}}}">'
                    f'<div style="padding: 14px 16px; background: #eaf2fa; border: 1px solid #a9c6e2; border-radius: 4px; font-size: 14px; line-height: 1.55; color: #1d3b55">{{{{ch_{name}_note}}}}</div></sc-if>')
        return out
    def toggle(self, name, init=False):
        self.toggles[name] = init
        return name
    def js(self):
        spec = {'tabs': self.tabs, 'choices': self.choices, 'toggles': self.toggles, 'wiz': self.wiz}
        return json.dumps(spec, ensure_ascii=False).replace('</', '<\\/')

JS = r'''
class Component extends DCLogic {
  spec() { return __SPEC__; }
  constructor(props) {
    super(props);
    const s = this.spec();
    const tabs = {}; Object.keys(s.tabs).forEach((n) => { tabs[n] = s.tabs[n][0]; });
    const ch = {}; Object.keys(s.choices).forEach((n) => { const c = s.choices[n]; ch[n] = c.multi ? (c.init === -1 ? [] : [].concat(c.init)) : c.init; });
    this.state = { tabs, ch, tg: Object.assign({}, s.toggles), step: 0 };
  }
  renderVals() {
    const accent = this.props.accent ?? '#f0792d';
    const s = this.spec();
    const v = { accent };
    Object.keys(s.tabs).forEach((n) => {
      s.tabs[n].forEach((id) => {
        const on = this.state.tabs[n] === id;
        v['tabsel_' + n + '_' + id] = on;
        v['tabon_' + n + '_' + id] = on;
        v['tabline_' + n + '_' + id] = on ? accent : 'transparent';
        v['tabpick_' + n + '_' + id] = () => this.setState({ tabs: Object.assign({}, this.state.tabs, { [n]: id }) });
      });
    });
    Object.keys(s.choices).forEach((n) => {
      const c = s.choices[n];
      const cur = this.state.ch[n];
      const isOn = (i) => (c.multi ? cur.indexOf(i) >= 0 : cur === i);
      v['ch_' + n] = c.opts.map((o, i) => ({
        label: o.label, sub: o.sub || '', hasSub: !!o.sub, on: isOn(i),
        ring: isOn(i) ? accent : '#d7dce2', bg: isOn(i) ? '#fff7f0' : '#ffffff',
        dot: isOn(i) ? '#3c3c3c' : '#ffffff', shape: c.multi ? '3px' : '50%',
        pick: () => {
          let next;
          if (c.multi) { next = isOn(i) ? cur.filter((x) => x !== i) : cur.concat([i]); } else { next = i; }
          this.setState({ ch: Object.assign({}, this.state.ch, { [n]: next }) });
        },
      }));
      const sel = c.multi ? null : c.opts[cur];
      v['ch_' + n + '_hasnote'] = !!(sel && sel.note);
      v['ch_' + n + '_note'] = sel && sel.note ? sel.note : '';
      v['ch_' + n + '_chosen'] = sel ? sel.label : '';
      c.opts.forEach((o, i) => { v['chis_' + n + '_' + i] = isOn(i); });
    });
    Object.keys(s.toggles).forEach((n) => {
      const on = !!this.state.tg[n];
      v['tg_' + n] = on; v['tgnot_' + n] = !on;
      v['tgflip_' + n] = () => this.setState({ tg: Object.assign({}, this.state.tg, { [n]: !on }) });
    });
    if (s.wiz) {
      const st = this.state.step; const n = s.wiz.length;
      const go = (i) => () => this.setState({ step: i });
      s.wiz.forEach((t, i) => { v['st_' + i] = st === i; v['go_' + i] = go(i); });
      v.rail = s.wiz.map((t, i) => ({
        n: i < st ? '✓' : String(i + 1), title: t, pick: go(i),
        bg: i === st ? '#3c4044' : 'transparent', numBg: i === st ? accent : (i < st ? '#5a6168' : 'transparent'),
        numFg: i === st ? '#1a1a1a' : '#ffffff', fg: i === st ? '#ffffff' : (i < st ? '#dfe3e7' : '#aeb4ba'),
        cur: i === st ? 'step' : 'false',
      }));
      v.stepNum = st + 1; v.stepCount = n; v.pct = Math.round(((st + 1) / n) * 100) + '%';
      v.isFirst = st === 0; v.notFirst = st > 0; v.isLast = st === n - 1; v.notLast = st < n - 1;
      v.goBack = go(Math.max(st - 1, 0)); v.goNext = go(Math.min(st + 1, n - 1));
    }
    return v;
  }
}
'''

HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@500;600;700&amp;family=Open+Sans:wght@400;600&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:#1d4f73}}a:hover{{color:#0f2f47}}
</style>
</helmet>
'''

def write(file, title, html, spec, w=1440, h=1300):
    props = '{"accent":{"editor":"color","default":"#f0792d","options":["#f0792d","#e0b341","#4f9fd6","#7fb069"]},"$preview":{"width":%d,"height":%d}}' % (w, h)
    js = JS.replace('__SPEC__', spec.js())
    doc = HEAD.format(title=title) + html + f'\n</x-dc>\n<script type="text/x-dc" data-dc-script data-props=\'{props}\'>{js}</script>\n</body>\n</html>\n'
    check_balance(file, doc)
    with open(os.path.join(OUT, file), 'w') as f:
        f.write(doc)
    FILES[file] = (title, w, h)

VOID = {'input', 'img', 'br', 'meta', 'link', 'hr'}
def check_balance(file, doc):
    body = doc.split('<x-dc>', 1)[1].split('</x-dc>', 1)[0]
    stack = []
    for m in re.finditer(r'<(/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>', body):
        close, tag, rest = m.group(1), m.group(2).lower(), m.group(3)
        if tag in VOID or rest.endswith('/'):
            continue
        if close:
            if not stack or stack[-1] != tag:
                raise SystemExit(f'{file}: unbalanced </{tag}> near …{body[max(0, m.start()-120):m.start()+20]}… stack={stack[-5:]}')
            stack.pop()
        else:
            stack.append(tag)
    if stack:
        raise SystemExit(f'{file}: unclosed {stack[-5:]}')

# ---------- back-end chrome ----------
NAV = [
    ('Dashboard', 'AdminDashboard', None),
    ('Intake', None, [('Accessions', 'Accessions', '[N]'), ('Deeds', 'Deeds', '[N]'), ('Donors', 'Donors', None),
                      ('Scan Inbox', 'ScanInbox', '[N]'), ('Needs Scanning', 'NeedsScanning', None)]),
    ('Catalog', None, [('Item Records', 'Items', None), ('Needs Sorting', 'NeedsSorting', '[N]'), ('OCR', 'OCR', None),
                       ('Data Cleaning', 'DataCleaning', '[N]'), ('Authorities', 'Authorities', None)]),
    ('Arrange &amp; Describe', None, [('Fonds', 'Fonds', None), ('Series', 'Series', None), ('Collections', 'Collections', None),
                                      ('Finding Aids', 'FindingAidAdmin', None), ('Subjects', 'Subjects', None), ('Effective Record', 'EffectiveRecord', None)]),
    ('Physical Storage', 'Storage', None),
    ('Preservation', 'Preservation', None),
    ('Circulation', None, [('Checkouts', 'Checkouts', None), ('Whereabouts', 'Whereabouts', None), ('Exhibits', 'ExhibitsAdmin', None),
                           ('Researchers', 'Researchers', None), ('Conservators', 'Conservators', None)]),
    ('Public sites (Hermes)', None, [('Sites &amp; pages', 'Sites', None), ('Public submissions', 'Submissions', '[N]')]),
    ('Import &amp; export', 'WizImport', None),
    ('Audit &amp; Reports', 'Reports', None),
    ('Settings', 'Settings', None),
]

def nav_link(label, target, badge, active, sub):
    on = target == active
    bg = '#3c4044' if on else 'transparent'
    line = '{{accent}}' if on else 'transparent'
    pad = '0 10px 0 22px' if sub else '0 10px'
    cur = ' aria-current="page"' if on else ''
    b = f'<span style="font-size: 12px; color: #c9cdd1">{badge}</span>' if badge else ''
    return (f'<a href="{target}.dc.html"{cur} style="display: flex; align-items: center; justify-content: space-between; min-height: 36px; padding: {pad}; '
            f'border-radius: 4px; text-decoration: none; color: #ffffff; font-size: 14px; background: {bg}; border-left: 3px solid {line}">{label}{b}</a>')

def sidebar(active):
    out = ('<nav aria-label="Polybius" style="flex: 1 1 236px; max-width: 260px; background: #26292c; color: #ffffff; display: flex; flex-direction: column; padding: 18px 12px 24px; gap: 2px; box-sizing: border-box">'
           '<a href="AdminDashboard.dc.html" style="display: flex; flex-direction: column; gap: 2px; padding: 4px 10px 16px; text-decoration: none; color: #ffffff">'
           '<span style="font-family: Roboto, sans-serif; font-weight: 700; font-size: 22px">Polybius</span>'
           '<span style="font-size: 13px; color: #c9cdd1">Dickinson Historical Society</span></a>')
    for label, target, kids in NAV:
        if kids:
            out += f'<span style="padding: 14px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #aeb4ba">{label}</span>'
            for kl, kt, kb in kids:
                out += nav_link(kl, kt, kb, active, True)
        else:
            out += nav_link(label, target, None, active, False)
    out += '<a href="Main.dc.html" style="margin-top: 18px; padding: 0 10px; font-size: 13px; color: #c9cdd1">View public site →</a></nav>'
    return out

def topbar():
    return ('<header style="background: #ffffff; border-bottom: 1px solid #d7dce2; padding: 12px 28px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px">'
            '<div style="flex: 1 1 320px; display: flex; flex-direction: column; gap: 4px; max-width: 560px">'
            '<label for="gsearch" style="font-size: 12px; font-weight: 600; color: #4a5056">Search everything</label>'
            f'<input id="gsearch" type="search" placeholder="Title, ID number, accession, donor, subject" style="{FIELD}"></div>'
            '<div style="margin-left: auto; display: flex; flex-wrap: wrap; gap: 10px; align-items: center">'
            + a_btn('+ Catalog an item', 'WizCatalog.dc.html', 'p') + a_btn('Log an accession', 'WizAccession.dc.html', 's') +
            '<a href="Login.dc.html" aria-label="Signed in as John Dougan. Sign out" style="width: 44px; height: 44px; border-radius: 50%; background: #3c3c3c; color: #ffffff; '
            'display: inline-flex; align-items: center; justify-content: center; text-decoration: none; font-family: Roboto, sans-serif; font-weight: 600">JD</a></div></header>')

def page_head(title, desc='', actions='', crumb=''):
    c = f'<nav aria-label="Breadcrumb" style="font-size: 13px">{crumb}</nav>' if crumb else ''
    d = f'<p style="margin: 0; font-size: 15px; line-height: 1.55; color: #4a5056; max-width: 760px">{desc}</p>' if desc else ''
    acts = f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{actions}</div>' if actions else ''
    return (f'<div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px">'
            f'<div style="display: flex; flex-direction: column; gap: 8px; flex: 1 1 480px">{c}<h1 style="margin: 0; {H}; font-size: 30px">{title}</h1>{d}</div>{acts}</div>')

def shell(active, inner):
    return ('<div style="font-family: \'Open Sans\', system-ui, sans-serif; color: #2f3337; background: #f3f5f8; min-height: 100vh; display: flex; flex-wrap: wrap; align-items: stretch">'
            + sidebar(active) +
            '<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">' + topbar() +
            f'<main style="padding: 28px 28px 56px; display: flex; flex-direction: column; gap: 24px">{inner}</main></div></div>')

def screen(file, title, inner, spec=None, h=1300):
    spec = spec or Spec()
    write(file + '.dc.html', title, shell(file, inner), spec, h=h)

def search_row(ph, chips=()):
    ch = ''.join(f'<a href="#" style="display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border: 1px solid #b7bec7; border-radius: 999px; font-size: 14px; text-decoration: none; background: #ffffff">{c}</a>' for c in chips)
    return (f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end"><div style="flex: 1 1 320px; max-width: 460px; display: flex; flex-direction: column; gap: 4px">'
            f'<label for="lsearch" style="font-size: 13px; font-weight: 600">Filter this list</label><input id="lsearch" type="search" placeholder="{ph}" style="{FIELD}"></div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{ch}</div></div>')
