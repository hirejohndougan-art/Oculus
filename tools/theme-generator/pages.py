import sys
from themes import THEMES

PAD = 'clamp(16px, 4vw, 40px)'
PAGES = [
    ('item', 'Item page'), ('collection', 'Collection page'), ('findingaid', 'Finding aid'),
    ('search', 'Search and browse'), ('entity', 'Person, group or place'),
    ('404', 'Page not found'), ('notpublic', 'Restricted area'), ('password', 'Password'),
]
HEIGHTS = {'item': 1800, 'collection': 1560, 'findingaid': 1640, 'search': 1560, 'entity': 1460,
           '404': 840, 'notpublic': 800, 'password': 800}


class P:
    def __init__(s, t, key):
        s.t, s.key = t, key

    def height(s):
        return HEIGHTS[s.key]

    def f(s, n):  # font size scaled to the theme's base size
        return f"{round(n * s.t['base'] / 16)}px"

    def href(s, page):
        st = s.t['stem']
        return f"{st}.dc.html" if page == 'home' else f"{st}-{page}.dc.html"

    # ---- small parts -------------------------------------------------
    def h(s, lvl, text, size):
        t = s.t
        return (f'<h{lvl} style="margin: 0; font-family: {t["hf"]}; font-weight: {t["hw"]}; font-size: {size}; '
                f'line-height: 1.15; color: {t["ink"]}; text-transform: {t["case"]}">{text}</h{lvl}>')

    def h1(s, text): return s.h(1, text, 'clamp(30px, 4vw, 48px)')
    def h2(s, text): return s.h(2, text, 'clamp(21px, 2.2vw, 27px)')

    def eyebrow(s, text):
        t = s.t
        return (f'<div style="font-size: {s.f(13)}; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; '
                f'color: {t["hi"]}">{text}</div>')

    def p(s, text, muted=False):
        t = s.t
        return (f'<p style="margin: 0; font-size: {s.f(16)}; line-height: 1.65; max-width: 70ch; '
                f'color: {t["muted"] if muted else t["text"]}">{text}</p>')

    def a(s, text, page='', extra=''):
        t = s.t
        return f'<a href="{s.href(page) if page else "#"}" style="color: {t["link"]}; font-weight: 600; {extra}">{text}</a>'

    def card_style(s, extra=''):
        t = s.t
        return (f'background: {t["surface"]}; border: {t["bw"]}px solid {t["border"]}; border-radius: {t["r"]}px; '
                f'{t["shadow"]} {extra}')

    def ph(s, label, h, extra=''):
        t = s.t
        return (f'<div style="height: {h}; background: {t["phbg"]}; color: {t["phtx"]}; font-size: 13px; '
                f'border-radius: {t["r"]}px; display: flex; align-items: center; justify-content: center; '
                f'text-align: center; padding: 8px; box-sizing: border-box; {extra}">{label}</div>')

    def btn(s, text, primary=True, page='', tag='a'):
        t = s.t
        if primary:
            look = f'background: {t["accent"]}; color: {t["onAccent"]}; border: {t["bw"]}px solid {t["accent"]};'
        else:
            look = f'background: transparent; color: {t["ink"]}; border: {t["bw"]}px solid {t["ib"]};'
        style = (f'display: inline-flex; align-items: center; justify-content: center; min-height: 46px; '
                 f'padding: 0 20px; {look} border-radius: {t["r"]}px; font-family: {t["hf"]}; font-weight: 700; '
                 f'font-size: {s.f(16)}; text-transform: {t["case"]}; text-decoration: none; box-sizing: border-box')
        if tag == 'button':
            return f'<button type="button" style="{style}">{text}</button>'
        return f'<a href="{s.href(page) if page else "#"}" style="{style}">{text}</a>'

    def field_style(s):
        t = s.t
        return (f'min-height: 48px; padding: 0 14px; font-size: {s.f(16)}; font-family: inherit; color: {t["ink"]}; '
                f'background: {t["inputBg"]}; border: {t["bw"]}px solid {t["ib"]}; border-radius: {t["r"]}px; '
                f'box-sizing: border-box')

    def searchform(s, fid, label='Search the archive', visible=True):
        lab = (f'<label for="{fid}" style="font-weight: 600; font-size: {s.f(15)}; width: 100%">{label}</label>'
               if visible else f'<label for="{fid}" style="position: absolute; left: -9999px">{label}</label>')
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 8px; width: 100%; max-width: 640px">{lab}'
                f'<input id="{fid}" type="search" placeholder="A name, a street, a year or an ID number" '
                f'style="flex: 1 1 260px; {s.field_style()}">{s.btn("Search", tag="button")}</div>')

    def crumbs(s, items):
        t = s.t
        parts = []
        for i, (label, page) in enumerate(items):
            if i == len(items) - 1:
                parts.append(f'<span aria-current="page">{label}</span>')
            else:
                parts.append(f'<a href="{s.href(page) if page else "#"}" style="color: {t["link"]}">{label}</a>')
        sep = f'<span aria-hidden="true" style="color: {t["muted"]}"> › </span>'
        return f'<nav aria-label="You are here" style="font-size: {s.f(14)}; color: {t["muted"]}">{sep.join(parts)}</nav>'

    def idtxt(s, v):
        m = s.t['mono']
        return f'<span style="font-family: {m}">{v}</span>' if m else v

    def rows(s, pairs):
        t = s.t
        out = []
        for k, v in pairs:
            out.append(f'<div style="display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 11px 0; '
                       f'border-top: 1px solid {t["border"]}"><div style="flex: 0 0 120px; color: {t["muted"]}; '
                       f'font-size: {s.f(14)}">{k}</div><div style="flex: 1 1 160px; font-size: {s.f(15)}">{v}</div></div>')
        return f'<div style="display: flex; flex-direction: column; border-bottom: 1px solid {t["border"]}">{"".join(out)}</div>'

    def chips(s, labels, page='entity'):
        t = s.t
        cs = ''.join(f'<a href="{s.href(page)}" style="display: inline-flex; align-items: center; min-height: 36px; '
                     f'padding: 0 12px; border: 1px solid {t["ib"]}; border-radius: {max(t["r"], 4) if t["r"] else 0}px; '
                     f'color: {t["ink"]}; text-decoration: none; font-size: {s.f(14)}">{l}</a>' for l in labels)
        return f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{cs}</div>'

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        t = s.t
        one = (f'<a href="{s.href(page)}" style="{s.card_style("text-decoration: none; display: flex; flex-direction: column; overflow: hidden;")}">'
               f'{s.ph("Photo", phh, "border-radius: 0")}<div style="padding: 12px 14px 16px">'
               f'<div style="font-family: {t["hf"]}; font-weight: {t["hw"]}; font-size: {s.f(17)}; color: {t["ink"]}; '
               f'line-height: 1.25; text-transform: {t["case"]}">{label}</div>'
               f'<div style="font-size: {s.f(14)}; color: {t["muted"]}; margin-top: 4px">{meta}</div></div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); '
                f'gap: 18px">{one * n}</div>')

    def facets(s):
        t = s.t
        groups = [('Type', ['Photograph', 'Document', 'Object', 'Map', 'Oral history']),
                  ('Decade', ['1900s', '1910s', '1920s', '1930s', '1940s']),
                  ('Subject', ['[Subject]', '[Subject]', '[Subject]'])]
        out = []
        k = 0
        for g, opts in groups:
            items = []
            for o in opts:
                k += 1
                fid = f'f{s.key}{k}'
                items.append(f'<div style="display: flex; align-items: center; gap: 10px; min-height: 40px">'
                             f'<input id="{fid}" type="checkbox" style="width: 20px; height: 20px; margin: 0; accent-color: {t["accent"]}">'
                             f'<label for="{fid}" style="flex: 1; font-size: {s.f(15)}">{o}</label>'
                             f'<span style="font-size: {s.f(13)}; color: {t["muted"]}">[N]</span></div>')
            out.append(f'<fieldset style="border: 0; margin: 0; padding: 0 0 14px; min-width: 0">'
                       f'<legend style="padding: 0 0 6px; font-family: {t["hf"]}; font-weight: {t["hw"]}; '
                       f'font-size: {s.f(16)}; color: {t["ink"]}; text-transform: {t["case"]}">{g}</legend>{"".join(items)}</fieldset>')
        return (f'<aside aria-label="Narrow the results" style="flex: 1 1 230px; min-width: 0; {s.card_style("padding: 18px 18px 6px; align-self: flex-start; box-sizing: border-box;")}">'
                f'{"".join(out)}</aside>')

    def pager(s):
        t = s.t
        def pg(label, cur=False):
            look = (f'background: {t["accent"]}; color: {t["onAccent"]}; border: 1px solid {t["accent"]}' if cur
                    else f'color: {t["ink"]}; border: 1px solid {t["ib"]}')
            cur_attr = ' aria-current="page"' if cur else ''
            return (f'<a href="#"{cur_attr} style="display: inline-flex; align-items: center; justify-content: center; '
                    f'min-width: 44px; min-height: 44px; padding: 0 12px; {look}; border-radius: {t["r"]}px; '
                    f'text-decoration: none; font-size: {s.f(15)}; box-sizing: border-box">{label}</a>')
        return (f'<nav aria-label="Pages" style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center">'
                f'{pg("Previous")}{pg("1", True)}{pg("2")}{pg("3")}<span style="color: {t["muted"]}">…</span>{pg("[N]")}{pg("Next")}</nav>')

    def sortsel(s, fid):
        return (f'<div style="display: flex; align-items: center; gap: 8px; font-size: {s.f(15)}">'
                f'<label for="{fid}">Sort by</label><select id="{fid}" style="{s.field_style()}; min-height: 44px">'
                f'<option>Best match</option><option>Oldest first</option><option>Newest first</option><option>Title A–Z</option></select></div>')

    def section(s, inner, gap=18):
        return f'<section style="display: flex; flex-direction: column; gap: {gap}px">{inner}</section>'

    # ---- shell -------------------------------------------------------
    def nav_items(s):
        return [('Home', 'home'), ('Collections', 'collection'), ('Browse', 'search'),
                ('Finding aids', 'findingaid'), ('People and places', 'entity')]

    def navlinks(s, vertical=False):
        t = s.t
        cur = {'collection': 'collection', 'search': 'search', 'findingaid': 'findingaid', 'entity': 'entity',
               'item': 'collection'}.get(s.key)
        up = 'text-transform: uppercase; letter-spacing: 1.2px; font-size: 13px;' if t['navUpper'] else f'font-size: {s.f(15)};'
        out = []
        for label, page in s.nav_items():
            on = page == cur
            if vertical:
                look = (f'background: #252e3b; border-left: 3px solid {t["accent"]}; color: #ffffff;' if on
                        else 'border-left: 3px solid transparent;')
                out.append(f'<a href="{s.href(page)}"{" aria-current=\"page\"" if on else ""} style="display: flex; '
                           f'align-items: center; min-height: 44px; padding: 0 14px; border-radius: 6px; color: {t["htx"]}; '
                           f'text-decoration: none; {look} font-size: {s.f(16)}">{label}</a>')
            else:
                line = f'border-bottom: 3px solid {t["htx"]};' if on else 'border-bottom: 3px solid transparent;'
                out.append(f'<a href="{s.href(page)}"{" aria-current=\"page\"" if on else ""} style="display: inline-flex; '
                           f'align-items: center; min-height: 44px; color: {t["htx"]}; text-decoration: none; font-weight: 600; '
                           f'{up} {line} box-sizing: border-box">{label}</a>')
        return ''.join(out)

    def sitename(s, size='20px'):
        t = s.t
        return (f'<a href="{s.href("home")}" style="font-family: {t["hf"]}; font-weight: {t["hw"]}; font-size: {size}; '
                f'color: {t["htitle"]}; text-decoration: none; text-transform: {t["case"]}">{t["site"]}</a>')

    def header(s):
        t = s.t
        if t['hdr'] == 'centered':
            return (f'<header style="background: {t["hbg"]}; padding: 20px {PAD} 0; text-align: center; {t["hrule"]}">'
                    f'{s.sitename("clamp(26px, 3.6vw, 42px)")}'
                    f'<nav aria-label="Main" style="margin-top: 14px; display: flex; flex-wrap: wrap; justify-content: center; '
                    f'gap: 0 26px; border-top: 3px double {t["border"]}; border-bottom: 3px double {t["border"]}">{s.navlinks()}</nav></header>')
        return (f'<header style="background: {t["hbg"]}; padding: 10px {PAD}; display: flex; flex-wrap: wrap; gap: 8px 24px; '
                f'align-items: center; justify-content: space-between; {t["hrule"]}">{s.sitename()}'
                f'<nav aria-label="Main" style="display: flex; flex-wrap: wrap; gap: 0 22px">{s.navlinks()}</nav></header>')

    def footer(s):
        t = s.t
        bt = f'border-top: {t["fborder"]};' if t['fborder'] else ''
        return (f'<footer style="background: {t["fbg"]}; color: {t["ftx"]}; padding: 24px {PAD}; font-size: 14px; {bt} '
                f'display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between">'
                f'<span>{t["site"]} · [Address] · [Phone]</span>'
                f'<span style="display: flex; flex-wrap: wrap; gap: 8px 20px"><a href="#" style="color: {t["ftx"]}">Accessibility</a>'
                f'<a href="#" style="color: {t["ftx"]}">Legal notices</a><a href="#" style="color: {t["ftx"]}">Contact</a></span></footer>')

    def shell(s, body, narrow=False):
        t = s.t
        maxw = '760px' if narrow else '1200px'
        skip = (f'<a href="#main-{s.key}" style="display: block; padding: 10px {PAD}; background: #ffe24d; color: #000000; '
                f'font-weight: 700; font-size: 17px">Skip to the main part of the page</a>') if t['skip'] else ''
        main = (f'<main id="main-{s.key}" style="background: {t["contentBg"]}; max-width: {maxw}; margin: 0 auto; '
                f'padding: 32px {PAD} 56px; box-sizing: border-box; display: flex; flex-direction: column; gap: 36px; '
                f'width: 100%">{body}</main>')
        root = (f'background: {t["pageBg"]}; {t["pageImg"]} font-family: {t["bf"]}; color: {t["text"]}; '
                f'font-size: {s.f(16)}; line-height: 1.5; min-height: {s.height() if not narrow else 800}px')
        if t['hdr'] == 'sidebar':
            aside = (f'<div style="flex: 1 1 220px; background: {t["hbg"]}; padding: 26px 20px; box-sizing: border-box; '
                     f'display: flex; flex-direction: column; gap: 22px">{s.sitename("19px")}'
                     f'<nav aria-label="Main" style="display: flex; flex-direction: column; gap: 4px">{s.navlinks(True)}</nav></div>')
            return (f'<div style="{root}; display: flex; flex-wrap: wrap">{aside}'
                    f'<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">{skip}{main}'
                    f'<div style="margin-top: auto">{s.footer()}</div></div></div>')
        return (f'<div style="{root}; display: flex; flex-direction: column">{skip}{s.header()}{main}'
                f'<div style="margin-top: auto">{s.footer()}</div></div>')

    # ---- pages -------------------------------------------------------
    def item_meta(s):
        t = s.t
        title = 'Aerial view of Dickinson, late 1920s' if t['idno'].startswith('DS') else '[Item title]'
        kind = 'Photograph' if t['idno'].startswith('DS') else '[Type]'
        date = 'Late 1920s' if t['idno'].startswith('DS') else '[date]'
        rows = s.rows([
            ('ID number', s.idtxt(t['idno'])), ('Date', date), ('Type', kind),
            ('Collection', s.a('[Collection name]', 'collection')),
            ('Part of', s.a('[Series title]', 'findingaid')),
            ('Creator', s.a('[Creator name]', 'entity')),
            ('Place', s.a('[Place name]', 'entity')),
            ('Rights', '[Rights statement]'),
        ])
        subj = f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-size: {s.f(14)}; color: {t["muted"]}">Subjects</div>{s.chips(["[Subject]", "[Subject]", "[Subject]"])}</div>'
        acts = (f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{s.btn("Cite this item", tag="button")}'
                f'{s.btn("Download", False, tag="button")}</div>{s.a("Ask the Society about this item")}')
        return title, kind, rows, subj, acts

    def viewer(s, h):
        t = s.t
        tools = ''.join(s.btn(x, False, tag='button') for x in ['Zoom in', 'Zoom out', 'Full screen'])
        thumbs = ''.join(f'<button type="button" aria-label="Show image {i} of 4" style="width: 72px; height: 56px; '
                         f'padding: 0; background: {t["phbg"]}; border: {"3px solid " + t["accent"] if i == 1 else "1px solid " + t["border"]}; '
                         f'border-radius: {t["r"]}px"></button>' for i in range(1, 5))
        label = 'Photo: Aerial view of Dickinson' if t['idno'].startswith('DS') else 'Scan of the item'
        return (f'<div style="display: flex; flex-direction: column; gap: 12px">{s.ph(label, h)}'
                f'<div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between">'
                f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{tools}</div>'
                f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{thumbs}</div></div></div>')

    def page_item(s):
        t = s.t
        title, kind, rows, subj, acts = s.item_meta()
        cr = s.crumbs([('Home', 'home'), ('Collections', 'collection'), ('[Collection name]', 'collection'), (title, '')])
        info = (f'<div style="display: flex; flex-direction: column; gap: 16px">{s.eyebrow(kind)}{s.h1(title)}'
                f'{rows}{subj}{acts}</div>')
        desc = s.section(s.h2('About this item') +
                         s.p('[The description written by the cataloger: what the item shows or contains, who made it, '
                             'and why it matters to Dickinson. Two or three short paragraphs.]') +
                         s.p('[Notes on the original: size, condition, and anything written on the back.]', True))
        if t['item'] == 'side':
            top = (f'<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">'
                   f'<div style="flex: 3 1 520px; min-width: 0">{s.viewer("520px")}</div>'
                   f'<div style="flex: 2 1 320px; min-width: 0">{info}</div></div>{desc}')
        else:
            top = (f'{s.viewer("clamp(300px, 46vw, 600px)")}<div style="display: flex; flex-wrap: wrap; gap: 40px; align-items: flex-start">'
                   f'<div style="flex: 2 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 16px">'
                   f'{s.eyebrow(kind)}{s.h1(title)}{desc}</div>'
                   f'<div style="flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 16px">{rows}{subj}{acts}</div></div>')
        tree = [('Fonds', '[Fonds title]', 0), ('Series', '[Series title]', 1), ('File', '[File title]', 2), ('Item', title, 3)]
        path = ''.join(f'<li style="margin-left: {d * 22}px; padding: 6px 0; font-size: {s.f(15)}"><span style="color: {t["muted"]}; '
                       f'font-size: {s.f(13)}; display: inline-block; min-width: 56px">{lv}</span> '
                       f'{s.a(lb, "findingaid") if d < 3 else "<strong>" + lb + "</strong>"}</li>' for lv, lb, d in tree)
        where = s.section(s.h2('Where it sits in the archive') +
                          s.p('Archives keep things together in the groups they came in. This item belongs to:', True) +
                          f'<ol style="margin: 0; padding: 0; list-style: none">{path}</ol>', 12)
        related = s.section(s.h2('More like this') + s.cards(4))
        return cr + top + where + related

    def page_collection(s):
        t = s.t
        cr = s.crumbs([('Home', 'home'), ('Collections', 'collection'), ('[Collection name]', '')])
        banner = (f'<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: center">'
                  f'<div style="flex: 3 1 460px; min-width: 0">{s.ph("Collection photo", "300px")}</div>'
                  f'<div style="flex: 2 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 14px">'
                  f'{s.eyebrow("Collection")}{s.h1("[Collection name]")}'
                  f'{s.p("[What this collection is, who gave it to the Society, and the years and places it covers.]")}'
                  f'<div style="display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: {s.f(15)}; color: {t["muted"]}">'
                  f'<span>[N] items</span><span>[date range]</span><span>[N] series</span></div>'
                  f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{s.btn("See the finding aid", False, "findingaid")}'
                  f'{s.btn("Search this collection", True, "search")}</div></div></div>')
        bar = (f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between">'
               f'<div style="font-size: {s.f(16)}; font-weight: 600">[N] items</div>{s.sortsel("sort-c")}</div>')
        body = (f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{s.facets()}'
                f'<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 22px">'
                f'{bar}{s.cards(9)}{s.pager()}</div></div>')
        return cr + banner + body

    def page_findingaid(s):
        t = s.t
        cr = s.crumbs([('Home', 'home'), ('Finding aids', 'findingaid'), ('[Fonds title]', '')])
        head = (f'<div style="display: flex; flex-direction: column; gap: 14px">{s.eyebrow("Finding aid")}{s.h1("[Fonds title]")}'
                f'{s.p("A finding aid is a guide to a group of records: what is in it, how it is arranged, and how to use it.", True)}'
                f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{s.btn("Download as PDF", False, tag="button")}'
                f'{s.btn("Ask about these records", False, tag="button")}</div></div>')
        facts = s.rows([('Reference code', s.idtxt('[Reference code]')), ('Dates', '[date range]'),
                        ('Extent', '[N] items in [N] boxes'), ('Creator', s.a('[Creator name]', 'entity')),
                        ('Language', '[Language]')])
        tree = [('Fonds', '[Fonds title]', 0, False), ('Series', '[Series title]', 1, True), ('File', '[File title]', 2, False),
                ('File', '[File title]', 2, False), ('Series', '[Series title]', 1, False), ('Series', '[Series title]', 1, False)]
        tl = ''.join(f'<a href="#"{" aria-current=\"true\"" if on else ""} style="display: flex; gap: 10px; min-height: 40px; '
                     f'align-items: center; padding: 0 10px; margin-left: {d * 16}px; border-radius: {t["r"]}px; '
                     f'text-decoration: none; color: {t["ink"]}; {"background: " + t["phbg"] + ";" if on else ""} '
                     f'font-size: {s.f(15)}"><span style="flex: 0 0 48px; font-size: {s.f(12)}; color: {t["muted"] if not on else t["phtx"]}">{lv}</span>'
                     f'<span style="font-weight: {700 if on or d == 0 else 400}">{lb}</span></a>' for lv, lb, d, on in tree)
        nav = (f'<nav aria-label="Arrangement" style="flex: 1 1 260px; min-width: 0; align-self: flex-start; '
               f'{s.card_style("padding: 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px;")}">'
               f'<div style="font-size: {s.f(13)}; font-weight: 600; text-transform: uppercase; letter-spacing: 1.2px; '
               f'color: {t["muted"]}; padding: 4px 10px 8px">How it is arranged</div>{tl}</nav>')
        th = f'padding: 11px 14px; text-align: left; font-size: {s.f(14)}; border-bottom: 2px solid {t["border"]}'
        td = f'padding: 11px 14px; border-bottom: 1px solid {t["border"]}; font-size: {s.f(15)}'
        rowsx = [(t['idno'], 'Aerial view of Dickinson, late 1920s' if t['idno'].startswith('DS') else '[Item title]', '[date]',
                  'Photograph' if t['idno'].startswith('DS') else '[Type]')] + [('[ID number]', '[Item title]', '[date]', '[Type]')] * 4
        trs = ''.join(f'<tr><td style="{td}">{s.idtxt(a_)}</td><td style="{td}">{s.a(b, "item")}</td><td style="{td}">{c}</td>'
                      f'<td style="{td}">{d}</td></tr>' for a_, b, c, d in rowsx)
        table = (f'<div style="overflow-x: auto; {s.card_style()}"><table style="width: 100%; min-width: 560px; border-collapse: collapse">'
                 f'<caption style="text-align: left; padding: 12px 14px; font-weight: 600">Contents of [Series title]</caption>'
                 f'<thead><tr><th style="{th}">ID number</th><th style="{th}">Title</th><th style="{th}">Date</th><th style="{th}">Type</th></tr></thead>'
                 f'<tbody>{trs}</tbody></table></div>')
        content = (f'<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 28px">'
                   + s.section(s.h2('What is in it') + s.p('[Scope and contents note: the kinds of records, the people and places they cover, and the years.]'), 10)
                   + s.section(s.h2('How it is arranged') + s.p('[How the records are grouped into series and files, and why.]'), 10)
                   + s.section(s.h2('Using these records') + s.p('[Who can see them, how to ask for copies, and the rights statement that applies.]'), 10)
                   + table + '</div>')
        return (cr + f'<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">'
                f'<div style="flex: 3 1 420px; min-width: 0">{head}</div><div style="flex: 2 1 320px; min-width: 0">{facts}</div></div>'
                + f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{nav}{content}</div>')

    def page_search(s):
        t = s.t
        top = (f'<div style="display: flex; flex-direction: column; gap: 16px">{s.h1("Search the archive")}'
               f'{s.searchform("q-" + s.key, "What are you looking for?")}'
               f'<div style="font-size: {s.f(14)}; color: {t["muted"]}">Tip: fewer words find more. You can also search by ID number, like {s.idtxt(t["idno"])}.</div></div>')
        bar = (f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between">'
               f'<div role="status" style="font-size: {s.f(16)}; font-weight: 600">[N] results for “[search words]”</div>{s.sortsel("sort-s")}</div>')
        if t['results'] == 'grid':
            res = s.cards(9, minw=180, phh='170px')
        else:
            one = (f'<a href="{s.href("item")}" style="{s.card_style("text-decoration: none; display: flex; flex-wrap: wrap; gap: 16px; padding: 14px; color: inherit;")}">'
                   f'<div style="flex: 0 0 120px">{s.ph("Photo", "90px")}</div>'
                   f'<div style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 4px">'
                   f'<span style="font-family: {t["hf"]}; font-weight: {t["hw"]}; font-size: {s.f(19)}; color: {t["link"]}; '
                   f'text-decoration: underline; text-transform: {t["case"]}">[Item title]</span>'
                   f'<span style="font-size: {s.f(14)}; color: {t["muted"]}">[Type] · [date] · {s.idtxt("[ID number]")}</span>'
                   f'<span style="font-size: {s.f(15)}">[A line from the record with the matching words.]</span></div></a>')
            res = f'<div style="display: flex; flex-direction: column; gap: 12px">{one * 6}</div>'
        body = (f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{s.facets()}'
                f'<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 20px">{bar}{res}{s.pager()}</div></div>')
        return top + body

    def page_entity(s):
        t = s.t
        cr = s.crumbs([('Home', 'home'), ('People and places', 'entity'), ('[Person name]', '')])
        top = (f'<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">'
               f'<div style="flex: 1 1 260px; min-width: 0; max-width: 360px">{s.ph("Portrait, if the archive has one", "340px")}</div>'
               f'<div style="flex: 2 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 14px">'
               f'{s.eyebrow("Person")}{s.h1("[Person name]")}'
               f'<div style="font-size: {s.f(17)}; color: {t["muted"]}">[Birth year]–[Death year]</div>'
               f'{s.p("[A short life story written by the Society: who they were and their part in Dickinson history.]")}'
               + s.rows([('Also known as', '[Other names]'), ('Places', s.a('[Place name]', 'entity') + ', ' + s.a('[Place name]', 'entity')),
                         ('Groups', s.a('[Group name]', 'entity')), ('Records', s.a('[N] items', 'search'))])
               + '</div></div>')
        items = s.section(s.h2('Items about [Person name]') + s.cards(4))
        rel = s.section(s.h2('Related people, groups and places') + s.chips(['[Person name]', '[Group name]', '[Place name]', '[Person name]', '[Place name]']), 14)
        return cr + top + items + rel

    def centered(s, inner):
        t = s.t
        return (f'<div style="{s.card_style("padding: clamp(24px, 5vw, 48px); display: flex; flex-direction: column; gap: 18px; margin: 24px 0;")}">'
                f'{inner}</div>')

    def page_404(s):
        t = s.t
        links = ' '.join(s.btn(l, False, p_) for l, p_ in [('Home', 'home'), ('Collections', 'collection'), ('Browse', 'search')])
        return s.centered(s.eyebrow('Page not found') + s.h1("We can't find that page") +
                          s.p('The link may be old, or the page may have moved. Try a search, or start from one of these:') +
                          s.searchform('q404-' + s.key, 'Search the archive', False) +
                          f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{links}</div>')

    def page_notpublic(s):
        # Used only for a restricted site or area. A private or unpublished record
        # gets the ordinary 404 page instead, so its address reveals nothing.
        return s.centered(s.eyebrow('Restricted area') + s.h1('This part of the site is restricted') +
                          s.p('The Society has limited who can see this area. If you think you should have access, '
                              'ask the Society and a volunteer will get back to you.') +
                          f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{s.btn("Ask the Society", True, tag="button")}'
                          f'{s.btn("Back to the home page", False, "home")}</div>')

    def page_password(s):
        t = s.t
        fid = 'pw-' + s.key
        return s.centered(s.eyebrow('Private site') + s.h1('This site needs a password') +
                          s.p(f'{t["site"]} shares this site with a small group of people. Enter the password you were given.') +
                          f'<div style="display: flex; flex-direction: column; gap: 8px; max-width: 420px">'
                          f'<label for="{fid}" style="font-weight: 600; font-size: {s.f(15)}">Password</label>'
                          f'<input id="{fid}" type="password" autocomplete="current-password" style="{s.field_style()}">'
                          f'</div><div>{s.btn("Open the site", tag="button")}</div>'
                          + s.p("Don't have it? Contact [contact name] at [email].", True))

    def render(s):
        t = s.t
        body = getattr(s, 'page_' + s.key)()
        narrow = s.key in ('404', 'notpublic', 'password')
        label = dict(PAGES)[s.key]
        w = 1280
        h = s.height()
        return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{t["name"]} theme: {label}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family={t["fonts"]}&display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{t["link"]}}}
</style>
</helmet>
{s.shell(body, narrow)}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''


def phone_wrapper(t, stem, h):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{t["name"]} theme: Item page, phone</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body{{margin:0}}
</style>
</helmet>
<div style="width: 100%">
<dc-import name="{stem}" hint-size="100%,{h}px"></dc-import>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":390,"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''
