"""Per-theme layouts for the inner pages. Each theme carries its home page's signature."""
from pages import P, PAD, HEIGHTS

DS_TITLE = 'Aerial view of Dickinson, late 1920s'


class Base(P):
    item_layout = 'side'      # side stack article fullbleed split label postcard linear centered
    filters_kind = 'box'      # box rules chips links
    results_kind = 'list'     # list grid news register table drawer contact decades index minimal mapsplit board
    item_h = 1900

    # ---- data --------------------------------------------------------
    def ds(s): return s.t['idno'].startswith('DS')
    def title(s): return DS_TITLE if s.ds() else '[Item title]'
    def kind(s): return 'Photograph' if s.ds() else '[Type]'
    def date(s): return 'Late 1920s' if s.ds() else '[date]'

    def meta_pairs(s):
        t = s.t
        return [('ID number', s.idtxt(t['idno'])), ('Date', s.date()), ('Type', s.kind()),
                ('Collection', s.a('[Collection name]', 'collection')), ('Part of', s.a('[Series title]', 'findingaid')),
                ('Creator', s.a('[Creator name]', 'entity')), ('Place', s.a('[Place name]', 'entity')),
                ('Rights', '[Rights statement]')]

    def ritems(s, n=6):
        out = []
        for i in range(n):
            first = i == 0
            out.append(dict(title=s.title() if first else '[Item title]', type=s.kind() if first else '[Type]',
                            date=s.date() if first else '[date]', id=s.t['idno'] if first else '[ID number]',
                            snip='[A line from the record with the matching words.]'))
        return out

    def height(s):
        h = dict(HEIGHTS)
        h['item'] = s.item_h
        h['search'] = {'decades': 1900, 'mapsplit': 1500, 'contact': 1500, 'register': 1400, 'board': 1400,
                       'table': 1400, 'minimal': 1500, 'news': 1800, 'index': 1500, 'drawer': 1500}.get(s.results_kind, 1600)
        if s.band('search'):
            h['search'] += 140
        if s.band('collection'):
            h['collection'] += 140
        return h[s.key]

    # ---- hooks ---------------------------------------------------------
    def band(s, page): return ''
    def side(s, page): return ''
    def item_extra(s): return ''

    def subjects(s):
        t = s.t
        return (f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-size: {s.f(14)}; '
                f'color: {t["muted"]}">Subjects</div>{s.chips(["[Subject]", "[Subject]", "[Subject]"])}</div>')

    def actions(s):
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 10px">{s.btn("Cite this item", tag="button")}'
                f'{s.btn("Download", False, tag="button")}</div>{s.a("Ask the Society about this item")}')

    def description(s):
        return s.section(s.h2('About this item') +
                         s.p('[The description written by the cataloger: what the item shows or contains, who made it, '
                             'and why it matters to Dickinson. Two or three short paragraphs.]') +
                         s.p('[Notes on the original: size, condition, and anything written on the back.]', True))

    def where(s):
        t = s.t
        tree = [('Fonds', '[Fonds title]', 0), ('Series', '[Series title]', 1), ('File', '[File title]', 2), ('Item', s.title(), 3)]
        path = ''.join(f'<li style="margin-left: {d * 22}px; padding: 6px 0; font-size: {s.f(15)}"><span style="color: {t["muted"]}; '
                       f'font-size: {s.f(13)}; display: inline-block; min-width: 56px">{lv}</span> '
                       f'{s.a(lb, "findingaid") if d < 3 else "<strong>" + lb + "</strong>"}</li>' for lv, lb, d in tree)
        return s.section(s.h2('Where it sits in the archive') +
                         s.p('Archives keep things together in the groups they came in. This item belongs to:', True) +
                         f'<ol style="margin: 0; padding: 0; list-style: none">{path}</ol>', 12)

    def related(s):
        return s.section(s.h2('More like this') + s.cards(4))

    def collection_items(s):
        return s.cards(9)

    def info_block(s, with_title=True):
        head = (s.eyebrow(s.kind()) + s.h1(s.title())) if with_title else ''
        return (f'<div style="display: flex; flex-direction: column; gap: 16px">{head}'
                f'{s.rows(s.meta_pairs())}{s.subjects()}{s.actions()}{s.item_extra()}</div>')

    # ---- filters ---------------------------------------------------------
    def filters(s):
        t = s.t
        k = s.filters_kind
        if k == 'box':
            return s.facets()
        if k == 'rules':
            box = s.card_style("padding: 18px 18px 6px; align-self: flex-start; box-sizing: border-box;")
            return s.facets().replace(box, f'border-top: 2px solid {t["border"]}; padding: 14px 0 0; '
                                           f'align-self: flex-start; box-sizing: border-box;')
        if k == 'chips':
            opts = ['All', 'Photographs', 'Documents', 'Objects', 'Maps', 'Oral histories']
            bs = ''.join(f'<button type="button" aria-pressed="{"true" if i == 0 else "false"}" style="min-height: 40px; '
                         f'padding: 0 16px; font-family: inherit; font-size: {s.f(14)}; border-radius: {max(t["r"], 0)}px; '
                         f'border: 1px solid {t["ib"]}; background: {t["accent"] if i == 0 else "transparent"}; '
                         f'color: {t["onAccent"] if i == 0 else t["ink"]}">{o}</button>' for i, o in enumerate(opts))
            sels = ''.join(f'<div style="display: flex; align-items: center; gap: 8px; font-size: {s.f(14)}">'
                           f'<label for="{fid}{s.key}">{lab}</label><select id="{fid}{s.key}" style="{s.field_style()}; '
                           f'min-height: 40px"><option>Any</option></select></div>'
                           for fid, lab in [('dec', 'Decade'), ('sub', 'Subject')])
            return (f'<div role="group" aria-label="Narrow the results" style="display: flex; flex-wrap: wrap; gap: 10px 16px; '
                    f'align-items: center; width: 100%"><div style="display: flex; flex-wrap: wrap; gap: 8px">{bs}</div>{sels}</div>')
        # links: big, plain selects, one per line
        sels = ''.join(f'<div style="display: flex; flex-direction: column; gap: 6px; flex: 1 1 220px">'
                       f'<label for="{fid}{s.key}" style="font-weight: 700; font-size: {s.f(18)}">{lab}</label>'
                       f'<select id="{fid}{s.key}" style="{s.field_style()}; min-height: 56px"><option>Any</option></select></div>'
                       for fid, lab in [('typ', 'Type of item'), ('dec', 'Decade'), ('sub', 'Subject')])
        return (f'<div role="group" aria-label="Narrow the results" style="display: flex; flex-wrap: wrap; gap: 16px; '
                f'align-items: flex-end; width: 100%">{sels}{s.btn("Show results", tag="button")}</div>')

    def with_filters(s, inner_top, results):
        if s.filters_kind in ('box', 'rules'):
            return (f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{s.filters()}'
                    f'<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 20px">'
                    f'{inner_top}{results}{s.pager()}</div></div>')
        return (f'<div style="display: flex; flex-direction: column; gap: 20px">{s.filters()}{inner_top}{results}{s.pager()}</div>')

    # ---- results ---------------------------------------------------------
    def results(s):
        return getattr(s, 'res_' + s.results_kind)()

    def res_grid(s):
        return s.cards(9, minw=180, phh='170px')

    def res_list(s):
        t = s.t
        out = []
        for r in s.ritems():
            out.append(f'<a href="{s.href("item")}" style="{s.card_style("text-decoration: none; display: flex; flex-wrap: wrap; gap: 16px; padding: 14px; color: inherit;")}">'
                       f'<div style="flex: 0 0 120px">{s.ph("Photo", "90px")}</div>'
                       f'<div style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 4px">'
                       f'<span style="font-family: {t["hf"]}; font-weight: {t["hw"]}; font-size: {s.f(19)}; color: {t["link"]}; '
                       f'text-decoration: underline; text-transform: {t["case"]}">{r["title"]}</span>'
                       f'<span style="font-size: {s.f(14)}; color: {t["muted"]}">{r["type"]} · {r["date"]} · {s.idtxt(r["id"])}</span>'
                       f'<span style="font-size: {s.f(15)}">{r["snip"]}</span></div></a>')
        return f'<div style="display: flex; flex-direction: column; gap: 12px">{"".join(out)}</div>'

    def table(s, cols, rows, caption=''):
        t = s.t
        th = f'padding: 11px 14px; text-align: left; font-size: {s.f(13)}; border-bottom: 2px solid {t["border"]}'
        td = f'padding: 11px 14px; border-bottom: 1px solid {t["border"]}; font-size: {s.f(15)}; vertical-align: top'
        cap = f'<caption style="text-align: left; padding: 12px 14px; font-weight: 600">{caption}</caption>' if caption else ''
        head = ''.join(f'<th style="{th}">{c}</th>' for c in cols)
        body = ''.join('<tr>' + ''.join(f'<td style="{td}">{v}</td>' for v in r) + '</tr>' for r in rows)
        return (f'<div style="overflow-x: auto; {s.card_style()}"><table style="width: 100%; min-width: 560px; '
                f'border-collapse: collapse">{cap}<thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')

    def res_table(s):
        return s.table(['ID number', 'Title', 'Type', 'Date'],
                       [[s.idtxt(r['id']), s.a(r['title'], 'item'), r['type'], r['date']] for r in s.ritems(8)])

    # ---- shared pieces used by several themes ------------------------------
    def mapbox(s, h='480px', label='Map of Dickinson with pins where items were made or found'):
        pins = [('28%', '30%', False), ('55%', '48%', True), ('70%', '18%', False), ('42%', '70%', False), ('82%', '62%', False)]
        ps = ''.join(f'<a href="{s.href("search")}" aria-label="Items at this place" style="position: absolute; left: {x}; top: {y}; '
                     f'width: 44px; height: 44px; margin: -22px 0 0 -22px; display: flex; align-items: center; justify-content: center; '
                     f'text-decoration: none"><span style="width: 30px; height: 30px; border-radius: 50%; '
                     f'background: {"#7a2e12" if on else "#2d2a24"}; color: #ffffff; font-weight: 600; font-size: 12px; display: flex; '
                     f'align-items: center; justify-content: center; border: 2px solid #ffffff">[N]</span></a>' for x, y, on in pins)
        return (f'<div role="img" aria-label="{label}" style="position: relative; overflow: hidden; min-height: {h}; '
                f'background: #d9e2d0; border: 2px solid #2d2a24">'
                f'<div aria-hidden="true" style="position: absolute; left: -5%; top: 46%; width: 110%; height: 30px; background: #a9c4cf; transform: rotate(-9deg)"></div>'
                f'<div aria-hidden="true" style="position: absolute; left: 30%; top: -5%; width: 6px; height: 110%; background: #8c8676; transform: rotate(14deg)"></div>'
                f'<div aria-hidden="true" style="position: absolute; left: -5%; top: 22%; width: 110%; height: 4px; background: #ffffff"></div>'
                f'<div aria-hidden="true" style="position: absolute; left: 62%; top: -5%; width: 4px; height: 110%; background: #ffffff"></div>'
                f'{ps}<div style="position: absolute; left: 12px; bottom: 12px; background: #f1ecdf; border: 1px solid #2d2a24; '
                f'padding: 6px 10px; font-size: 12px; color: #2d2a24">Map placeholder · blue: the bayou · gray: the railroad</div></div>')

    # ---- pages -------------------------------------------------------------
    def wrap_side(s, page, body):
        sd = s.side(page)
        if not sd:
            return body
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start">{sd}'
                f'<div style="flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 36px">{body}</div></div>')

    def page_item(s):
        t = s.t
        cr = s.crumbs([('Home', 'home'), ('Collections', 'collection'), ('[Collection name]', 'collection'), (s.title(), '')])
        L = s.item_layout
        desc = s.description()
        if L == 'side':
            top = (f'<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">'
                   f'<div style="flex: 3 1 480px; min-width: 0">{s.viewer("520px")}</div>'
                   f'<div style="flex: 2 1 320px; min-width: 0">{s.info_block()}</div></div>{desc}')
        elif L in ('stack', 'fullbleed'):
            vh = 'clamp(320px, 50vw, 640px)' if L == 'fullbleed' else 'clamp(300px, 46vw, 600px)'
            top = (f'{s.viewer(vh)}<div style="display: flex; flex-wrap: wrap; gap: 40px; align-items: flex-start">'
                   f'<div style="flex: 2 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 16px">'
                   f'{s.eyebrow(s.kind())}{s.h1(s.title())}{desc}</div>'
                   f'<div style="flex: 1 1 300px; min-width: 0">{s.info_block(False)}</div></div>')
        elif L == 'linear':
            top = (f'<div style="max-width: 760px; display: flex; flex-direction: column; gap: 26px">'
                   f'{s.eyebrow(s.kind())}{s.h1(s.title())}{s.viewer("clamp(260px, 50vw, 480px)")}'
                   f'{s.info_block(False)}{desc}</div>')
        elif L == 'centered':
            grid = (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 32px">'
                    f'<div>{s.rows(s.meta_pairs()[:4])}</div><div>{s.rows(s.meta_pairs()[4:])}</div></div>')
            top = (f'<div style="max-width: 820px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; '
                   f'text-align: left">{s.viewer("clamp(280px, 48vw, 520px)")}'
                   f'<div style="display: flex; flex-direction: column; gap: 12px">{s.eyebrow(s.kind())}{s.h1(s.title())}</div>'
                   f'{grid}{s.subjects()}{s.actions()}{desc}</div>')
        else:
            top = getattr(s, 'layout_' + L)(desc)
        body = cr + top + ('' if s.side('item') else s.where()) + s.related()
        return s.band('item') + s.wrap_side('item', body)

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
        body = cr + banner + s.with_filters(bar, s.collection_items())
        return s.band('collection') + s.wrap_side('collection', body)

    def page_search(s):
        t = s.t
        top = (f'<div style="display: flex; flex-direction: column; gap: 16px">{s.h1("Search the archive")}'
               f'{s.searchform("q-" + s.key, "What are you looking for?")}'
               f'<div style="font-size: {s.f(14)}; color: {t["muted"]}">Tip: fewer words find more. You can also search by '
               f'ID number, like {s.idtxt(t["idno"])}.</div></div>')
        bar = (f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between">'
               f'<div role="status" style="font-size: {s.f(16)}; font-weight: 600">[N] results for “[search words]”</div>{s.sortsel("sort-s")}</div>')
        body = top + s.with_filters(bar, s.results())
        return s.band('search') + s.wrap_side('search', body)

    def page_entity(s):
        return s.band('entity') + s.wrap_side('entity', P.page_entity(s))


# ============================ the twenty themes ============================

class ReadingRoom(Base):
    pass


class Broadsheet(Base):
    item_layout = 'article'; filters_kind = 'rules'; results_kind = 'news'; item_h = 2000

    def layout_article(s, desc):
        t = s.t
        return (f'<div style="display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid {t["border"]}; padding-bottom: 20px">'
                f'{s.eyebrow(s.kind() + " · " + s.date())}{s.h("1", s.title(), "clamp(34px, 5vw, 64px)")}'
                f'<p style="margin: 0; font-size: {s.f(19)}; font-style: italic; color: {t["muted"]}">'
                f'[One-line summary of the item, written like a newspaper standfirst.]</p></div>'
                f'<div style="display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">'
                f'<div style="flex: 2 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 10px">{s.viewer("440px")}'
                f'<div style="font-size: {s.f(14)}; font-style: italic; color: {t["muted"]}">{s.kind()}, ID number {t["idno"]}. [Rights statement]</div>'
                f'<div style="columns: 260px 2; column-gap: 28px; font-size: {s.f(17)}; line-height: 1.7">'
                f'[The description written by the cataloger runs here in two columns, the way a story would on the front page: '
                f'what the item shows, who made it, and why it matters to Dickinson.]</div></div>'
                f'<aside style="flex: 1 1 280px; min-width: 0; border-left: 1px solid {t["border"]}; padding-left: 24px; '
                f'display: flex; flex-direction: column; gap: 16px">{s.eyebrow("The record")}{s.rows(s.meta_pairs())}'
                f'{s.subjects()}{s.actions()}</aside></div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        t = s.t
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; display: flex; flex-direction: column; gap: 8px; '
               f'border-top: 3px double {t["border"]}; padding-top: 12px">{s.ph("Photo", "120px")}'
               f'<div style="font-size: {s.f(12)}; letter-spacing: 1.5px; text-transform: uppercase; color: {t["hi"]}; font-weight: 600">{meta}</div>'
               f'<div style="font-family: {t["hf"]}; font-weight: 700; font-size: {s.f(20)}; line-height: 1.2; color: {t["ink"]}">{label}</div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 24px">{one * n}</div>')

    def res_news(s):
        t = s.t
        out = ''.join(f'<article style="display: flex; flex-wrap: wrap; gap: 18px; padding: 18px 0; border-top: 1px solid {t["border"]}">'
                      f'<div style="flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 6px">'
                      f'<div style="font-size: {s.f(12)}; letter-spacing: 1.5px; text-transform: uppercase; color: {t["hi"]}; font-weight: 600">{r["type"]} · {r["date"]}</div>'
                      f'<a href="{s.href("item")}" style="font-family: {t["hf"]}; font-weight: 700; font-size: {s.f(24)}; line-height: 1.2; color: {t["ink"]}">{r["title"]}</a>'
                      f'<p style="margin: 0; font-size: {s.f(16)}; line-height: 1.6">{r["snip"]}</p>'
                      f'<div style="font-size: {s.f(13)}; color: {t["muted"]}">{r["id"]}</div></div>'
                      f'<div style="flex: 0 0 170px">{s.ph("Photo", "120px")}</div></article>' for r in s.ritems())
        return f'<div style="border-bottom: 1px solid {t["border"]}">{out}</div>'


class CardCatalog(Base):
    results_kind = 'drawer'

    def rows(s, pairs):
        lines = ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 2px 14px; padding: 8px 0; border-bottom: 1px solid #c9d6e3">'
                        f'<div style="flex: 0 0 110px; font-size: 13px; text-transform: uppercase; letter-spacing: 1px">{k}</div>'
                        f'<div style="flex: 1 1 160px; font-size: 15px">{v}</div></div>' for k, v in pairs[1:])
        return (f'<div style="position: relative; background: #fffaf0; border: 1px solid #2b2118; box-shadow: 4px 4px 0 #2b2118; '
                f'padding: 18px 22px 40px">'
                f'<div style="font-family: \'Courier Prime\', monospace; font-weight: 700; font-size: 16px; padding-bottom: 8px; '
                f'border-bottom: 2px solid #b23a2e">{pairs[0][0]}: {pairs[0][1]}</div>{lines}'
                f'<div aria-hidden="true" style="position: absolute; left: 50%; bottom: 12px; width: 16px; height: 16px; margin-left: -8px; '
                f'border-radius: 50%; background: #5b4632"></div></div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; color: #2b2118; background: #fffaf0; border: 1px solid #2b2118; '
               f'box-shadow: 3px 3px 0 #2b2118; padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 8px">'
               f'<div style="font-size: 13px; border-bottom: 2px solid #b23a2e; padding-bottom: 4px">[ID number]</div>'
               f'{s.ph("Photo", "110px")}<div style="font-family: \'Zilla Slab\', serif; font-weight: 700; font-size: 18px">{label}</div>'
               f'<div style="font-size: 13px">{meta}</div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 20px">{one * n}</div>')

    def res_drawer(s):
        cards = ''.join(f'<a href="{s.href("item")}" style="text-decoration: none; color: #2b2118; background: #fffaf0; '
                        f'border: 1px solid #2b2118; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 6px">'
                        f'<div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px; border-bottom: 2px solid #b23a2e; padding-bottom: 4px">'
                        f'<span>{r["id"]}</span><span>{r["date"]}</span></div>'
                        f'<div style="font-family: \'Zilla Slab\', serif; font-weight: 700; font-size: 19px">{r["title"]}</div>'
                        f'<div style="font-size: 14px">{r["type"]}. {r["snip"]}</div></a>' for r in s.ritems(8))
        return (f'<div style="background: #8a6a45; border: 2px solid #2b2118; padding: 18px; display: grid; '
                f'grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 14px">{cards}</div>')


class GalleryWall(Base):
    item_layout = 'fullbleed'; filters_kind = 'chips'; results_kind = 'grid'; item_h = 2100

    def viewer(s, h):
        tools = ''.join(f'<button type="button" style="min-height: 44px; padding: 0 16px; background: rgba(0,0,0,0.72); color: #ffffff; '
                        f'border: 1px solid #8a8a8a; font-family: inherit; font-size: 14px">{x}</button>' for x in ['Zoom in', 'Zoom out', 'Full screen', 'Download'])
        return (f'<div style="position: relative; height: {h}; background: #3a3a3a; color: #d0d0d0; font-size: 13px; display: flex; '
                f'align-items: center; justify-content: center">Photo: Aerial view of Dickinson'
                f'<div style="position: absolute; left: 0; right: 0; bottom: 0; padding: 14px; display: flex; flex-wrap: wrap; gap: 8px; '
                f'justify-content: flex-end">{tools}</div></div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; height: 220px; background: #3a3a3a; display: flex; align-items: flex-end">'
               f'<div style="padding: 12px 14px; background: rgba(0,0,0,0.72); width: 100%; box-sizing: border-box">'
               f'<div style="font-weight: 500; font-size: 15px; color: #ffffff">{label}</div>'
               f'<div style="font-size: 13px; color: #d0d0d0">{meta}</div></div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 10px">{one * n}</div>')


class Bayou(Base):
    item_layout = 'split'; item_h = 2000

    def layout_split(s, desc):
        panel = (f'<div style="flex: 1 1 380px; min-width: 0; background: #12403a; color: #ffffff; padding: 36px 32px; box-sizing: border-box; '
                 f'display: flex; flex-direction: column; justify-content: center; gap: 14px; border-radius: 8px">'
                 f'<div style="font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: #a9d6c8; font-weight: 600">{s.kind()}</div>'
                 f'<h1 style="margin: 0; font-family: Fraunces, serif; font-weight: 700; font-size: clamp(30px, 3.6vw, 46px); line-height: 1.1">{s.title()}</h1>'
                 f'<div style="font-size: 17px; color: #dcebe6">{s.t["idno"]} · {s.date()}</div></div>')
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch">{panel}'
                f'<div style="flex: 2 1 480px; min-width: 0">{s.viewer("460px")}</div></div>'
                f'<div style="display: flex; flex-wrap: wrap; gap: 40px; align-items: flex-start">'
                f'<div style="flex: 2 1 420px; min-width: 0">{desc}</div>'
                f'<div style="flex: 1 1 300px; min-width: 0">{s.info_block(False)}</div></div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        t = s.t
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; display: flex; flex-direction: column; gap: 10px">'
               f'<div style="height: 180px; border-radius: 90px 90px 8px 8px; background: #c3d4cc"></div>'
               f'<div><div style="font-family: Fraunces, serif; font-weight: 700; font-size: 19px; color: #12403a">{label}</div>'
               f'<div style="font-size: 14px; color: #44574f">{meta}</div></div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 22px">{one * n}</div>')


class SwissGrid(Base):
    filters_kind = 'rules'; results_kind = 'index'

    def rows(s, pairs):
        r = ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 10px 0; border-top: 1px solid #111111">'
                    f'<div style="flex: 0 0 34px; font-weight: 800; color: #c8102e">{i + 1:02d}</div>'
                    f'<div style="flex: 0 0 110px; color: #4a4a4a; font-size: 14px">{k}</div>'
                    f'<div style="flex: 1 1 160px; font-weight: 600; font-size: 15px">{v}</div></div>' for i, (k, v) in enumerate(pairs))
        return f'<div style="border-top: 2px solid #111111; border-bottom: 2px solid #111111">{r}</div>'

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = ''.join(f'<a href="{s.href(page)}" style="text-decoration: none; display: flex; flex-direction: column; gap: 12px; '
                      f'border-top: 2px solid #111111; padding-top: 12px"><div style="font-weight: 800; font-size: 34px; color: #c8102e; '
                      f'line-height: 1">{i + 1:02d}</div>{s.ph("Photo", "130px", "border-radius: 0")}'
                      f'<div style="font-weight: 800; font-size: 18px">{label}</div><div style="font-size: 14px; color: #4a4a4a">{meta}</div></a>'
                      for i in range(n))
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 24px">{one}</div>')

    def res_index(s):
        out = ''.join(f'<a href="{s.href("item")}" style="display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; '
                      f'padding: 16px 0; border-top: 2px solid #111111; text-decoration: none">'
                      f'<span style="flex: 0 0 64px; font-weight: 800; font-size: 34px; color: #c8102e; line-height: 1">{i + 1:02d}</span>'
                      f'<span style="flex: 1 1 280px; min-width: 0"><span style="display: block; font-weight: 800; font-size: 22px">{r["title"]}</span>'
                      f'<span style="display: block; font-size: 15px; margin-top: 4px">{r["snip"]}</span></span>'
                      f'<span style="flex: 0 1 220px; font-size: 14px; color: #4a4a4a">{r["type"]}<br>{r["date"]}<br>{r["id"]}</span></a>'
                      for i, r in enumerate(s.ritems()))
        return f'<div style="border-bottom: 2px solid #111111">{out}</div>'


class FindingAidFirst(Base):
    results_kind = 'table'

    def side(s, page):
        if page == 'findingaid':
            return ''
        t = s.t
        tree = [('Fonds', '[Fonds title]', 0, False), ('Series', '[Series title]', 1, page in ('item', 'collection')),
                ('File', '[File title]', 2, False), ('Series', '[Series title]', 1, False), ('Fonds', '[Fonds title]', 0, False),
                ('Series', '[Series title]', 1, False), ('Fonds', '[Fonds title]', 0, False)]
        tl = ''.join(f'<a href="{s.href("findingaid")}"{" aria-current=\"true\"" if on else ""} style="display: flex; gap: 10px; '
                     f'min-height: 40px; align-items: center; padding: 0 10px; margin-left: {d * 16}px; border-radius: 3px; '
                     f'text-decoration: none; color: #23292f; {"background: #e3edf7;" if on else ""} font-size: 15px">'
                     f'<span style="flex: 0 0 48px; font-family: \'IBM Plex Mono\', monospace; font-size: 12px; color: #55606b">{lv}</span>'
                     f'<span style="font-weight: {600 if on or d == 0 else 400}">{lb}</span></a>' for lv, lb, d, on in tree)
        return (f'<nav aria-label="How the archive is arranged" style="flex: 1 1 260px; min-width: 0; align-self: flex-start; '
                f'{s.card_style("padding: 14px; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px;")}">'
                f'<div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: #55606b; '
                f'padding: 4px 10px 8px">How the archive is arranged</div>{tl}</nav>')

    def collection_items(s):
        return s.res_table()


class Timeline(Base):
    filters_kind = 'chips'; results_kind = 'decades'; item_h = 2000

    def band(s, page):
        if page not in ('item', 'collection', 'search', 'entity'):
            return ''
        cur = '1920s'
        ds = ['1880s', '1890s', '1900s', '1910s', '1920s', '1930s', '1940s', '1950s', '1960s']
        cells = ''.join(f'<a href="{s.href("search")}"{" aria-current=\"true\"" if d == cur else ""} style="flex: 1; text-decoration: none; '
                        f'text-align: center; padding: 12px 4px 14px; font-weight: 600; font-size: 16px; color: #1b2a4a; '
                        f'background: {"#e6c15a" if d == cur else "transparent"}; position: relative">{d}'
                        f'<span aria-hidden="true" style="position: absolute; left: 50%; bottom: -11px; width: 16px; height: 16px; margin-left: -8px; '
                        f'border-radius: 50%; background: {"#e6c15a" if d == cur else "#f7f4ec"}; border: 3px solid #1b2a4a; box-sizing: border-box"></span></a>'
                        for d in ds)
        lab = {'item': 'This item is from the 1920s', 'collection': 'This collection spans [date range]',
               'search': 'Narrow by decade', 'entity': 'Their years in Dickinson'}[page]
        return (f'<div style="display: flex; flex-direction: column; gap: 10px"><div style="font-size: 14px; font-weight: 600">{lab}</div>'
                f'<div style="overflow-x: auto; padding-bottom: 14px"><nav aria-label="Decades" style="display: flex; min-width: 820px; '
                f'border-bottom: 4px solid #1b2a4a">{cells}</nav></div></div>')

    def item_extra(s):
        links = ''.join(f'<li style="padding: 6px 0">{s.a("[Item title]", "item")} <span style="color: #4a5361">[date]</span></li>' for _ in range(3))
        return (f'<div style="border-top: 4px solid #1b2a4a; padding-top: 12px"><div style="font-weight: 800; font-size: 18px">Also from the 1920s</div>'
                f'<ul style="margin: 8px 0 0; padding: 0; list-style: none; font-size: 15px">{links}</ul></div>')

    def res_decades(s):
        out = ''
        for dec, items in [('1920s', s.ritems(3)), ('1930s', s.ritems(3)[1:])]:
            rows = ''.join(f'<a href="{s.href("item")}" style="{s.card_style("text-decoration: none; display: flex; gap: 14px; padding: 12px; align-items: center; color: inherit;")}">'
                           f'<div style="flex: 0 0 72px">{s.ph("", "56px")}</div><div><div style="font-weight: 600; font-size: 17px; color: #1b2a4a">{r["title"]}</div>'
                           f'<div style="font-size: 14px; color: #4a5361">{r["type"]} · {r["date"]} · {r["id"]}</div></div></a>' for r in items)
            out += (f'<div style="display: flex; flex-wrap: wrap; gap: 20px"><div style="flex: 0 0 140px; font-weight: 800; font-size: 40px; '
                    f'line-height: 1; color: #1b2a4a">{dec}</div><div style="flex: 1 1 360px; min-width: 0; display: flex; '
                    f'flex-direction: column; gap: 10px">{rows}</div></div>')
        return f'<div style="display: flex; flex-direction: column; gap: 32px">{out}</div>'


class MapRoom(Base):
    results_kind = 'mapsplit'; filters_kind = 'chips'

    def item_extra(s):
        return (f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="font-family: Bitter, serif; font-weight: 700; font-size: 18px">'
                f'Where it was made</div>{s.mapbox("220px", "Map showing where this item was made")}'
                f'{s.a("See everything from this place", "search")}</div>')

    def band(s, page):
        if page == 'entity':
            return s.section(s.h2('Places on the map') + s.mapbox('320px', 'Map of places connected to this person'), 12)
        return ''

    def res_mapsplit(s):
        rows = ''.join(f'<a href="{s.href("item")}" style="display: flex; gap: 14px; text-decoration: none; color: #2d2a24; padding: 10px 0; '
                       f'border-top: 1px solid #2d2a24"><div style="flex: 0 0 90px">{s.ph("Photo", "68px")}</div>'
                       f'<div><div style="font-family: Bitter, serif; font-weight: 700; font-size: 17px">{r["title"]}</div>'
                       f'<div style="font-size: 14px">{r["id"]} · {r["type"]} · {r["date"]}</div></div></a>' for r in s.ritems(5))
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start">'
                f'<div style="flex: 3 1 420px; min-width: 0">{s.mapbox("520px")}</div>'
                f'<div style="flex: 2 1 300px; min-width: 0"><div style="font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; '
                f'font-weight: 600; padding-bottom: 6px">At the selected pin</div>{rows}</div></div>')


class MuseumLabel(Base):
    item_layout = 'label'; filters_kind = 'chips'; results_kind = 'grid'; item_h = 2100

    def layout_label(s, desc):
        label = (f'<div style="flex: 1 1 300px; min-width: 0; align-self: flex-end; background: #ffffff; padding: 26px 26px 30px; '
                 f'box-shadow: 0 2px 6px rgba(0,0,0,0.1); display: flex; flex-direction: column; gap: 10px">'
                 f'{s.eyebrow(s.kind())}{s.h("1", "Aerial view of Dickinson" if s.ds() else "[Item title]", "clamp(28px, 3vw, 38px)")}'
                 f'<div style="font-size: 15px">{s.date()}<br>{s.kind()}<br>[Maker, if known]</div>'
                 f'<p style="margin: 0; font-size: 15px; line-height: 1.65; color: #3a3a3a">[The wall-label text: three or four plain sentences '
                 f'on what this is and why it matters.]</p>'
                 f'<div style="font-size: 13px; color: #5a5a5a; border-top: 1px solid #c9c7c0; padding-top: 10px">{s.t["idno"]} · [Rights statement]</div></div>')
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 48px; align-items: flex-end">'
                f'<div style="flex: 3 1 520px; min-width: 0">{s.viewer("600px")}</div>{label}</div>'
                f'<div style="display: flex; flex-wrap: wrap; gap: 48px; align-items: flex-start">'
                f'<div style="flex: 2 1 420px; min-width: 0">{desc}</div><div style="flex: 1 1 300px; min-width: 0">{s.info_block(False)}</div></div>')

    def viewer(s, h):
        return (f'<div style="display: flex; flex-direction: column; gap: 12px">'
                f'{s.ph("Photo: Aerial view of Dickinson" if s.ds() else "Photo", h, "box-shadow: 0 18px 40px rgba(0,0,0,0.14)")}'
                f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{"".join(s.btn(x, False, tag="button") for x in ["Zoom in", "Full screen", "Download"])}</div></div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; display: flex; flex-direction: column; gap: 12px">'
               f'{s.ph("", "170px", "box-shadow: 0 10px 24px rgba(0,0,0,0.12)")}<div style="font-size: 14px; line-height: 1.45">'
               f'<span style="font-family: \'Cormorant Garamond\', serif; font-weight: 700; font-size: 19px">{label}</span><br>'
               f'<span style="color: #5a5a5a">{meta}</span></div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 28px">{one * n}</div>')


class Ledger(Base):
    item_layout = 'stack'; results_kind = 'register'; item_h = 2100

    def rows(s, pairs):
        r = ''.join(f'<tr><td style="padding: 10px 12px; border-bottom: 1px solid #9fc0b0; font-family: \'IBM Plex Mono\', monospace; '
                    f'font-size: 12px; text-transform: uppercase; letter-spacing: 1px; width: 120px; vertical-align: top">{k}</td>'
                    f'<td style="padding: 10px 12px; border-bottom: 1px solid #9fc0b0; border-left: 1px solid #8a1c1c; font-size: 15px">{v}</td></tr>'
                    for k, v in pairs)
        return (f'<div style="background: #fbfdf7; border: 1px solid #1f3d2b; overflow-x: auto"><table style="width: 100%; border-collapse: collapse">'
                f'<tbody>{r}</tbody></table></div>')

    def res_register(s):
        return s.table(['No.', 'Entry', 'Date', 'Collection'],
                       [[s.idtxt(r['id']), s.a(r['title'], 'item') + f'<br><span style="font-size: 13px">{r["type"]}</span>', r['date'],
                         '[Collection name]'] for r in s.ritems(8)])

    def collection_items(s):
        return s.res_register()


class Depot(Base):
    results_kind = 'board'

    def rows(s, pairs):
        r = ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 2px 16px; padding: 10px 0; border-bottom: 1px solid #555555">'
                    f'<div style="flex: 0 0 120px; font-family: \'Barlow Condensed\', sans-serif; font-weight: 600; font-size: 15px; '
                    f'letter-spacing: 1.5px; text-transform: uppercase; color: #f4c430">{k}</div>'
                    f'<div style="flex: 1 1 160px; font-family: \'Barlow Condensed\', sans-serif; font-weight: 600; font-size: 20px; '
                    f'text-transform: uppercase; color: #ffffff">{v.replace("color: #111111", "color: #ffffff")}</div></div>' for k, v in pairs)
        return f'<div style="background: #111111; padding: 6px 20px 10px">{r}</div>'

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = ''.join(f'<a href="{s.href(page)}" style="text-decoration: none; border: 3px solid #111111; background: #ffffff; display: flex; flex-direction: column">'
                      f'<div style="background: #111111; color: #f4c430; padding: 6px 12px; font-family: \'Barlow Condensed\', sans-serif; '
                      f'font-weight: 600; font-size: 14px; letter-spacing: 2px; text-transform: uppercase">Platform {i + 1}</div>'
                      f'{s.ph("Photo", "130px", "border-radius: 0")}<div style="padding: 10px 12px 14px"><div style="font-family: \'Barlow Condensed\', sans-serif; '
                      f'font-weight: 800; font-size: 22px; text-transform: uppercase; color: #111111; line-height: 1.05">{label}</div>'
                      f'<div style="font-size: 14px; color: #444444; margin-top: 4px">{meta}</div></div></a>' for i in range(n))
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 18px">{one}</div>')

    def res_board(s):
        rows = ''.join(f'<a href="{s.href("item")}" style="display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 12px 0; border-bottom: 1px solid #555555; '
                       f'text-decoration: none; color: #ffffff; font-family: \'Barlow Condensed\', sans-serif; font-weight: 600; text-transform: uppercase">'
                       f'<span style="flex: 0 0 130px; color: #f4c430; font-size: 17px">{r["id"]}</span>'
                       f'<span style="flex: 1 1 260px; font-size: 24px; line-height: 1.1">{r["title"]}</span>'
                       f'<span style="flex: 0 0 150px; font-size: 17px">{r["type"]} · {r["date"]}</span></a>' for r in s.ritems(8))
        return (f'<div style="background: #111111; padding: 8px 20px 12px"><div style="display: flex; gap: 16px; padding: 8px 0; '
                f'border-bottom: 1px solid #555555; font-family: \'Barlow Condensed\', sans-serif; font-weight: 600; font-size: 14px; '
                f'letter-spacing: 2px; text-transform: uppercase; color: #f4c430"><span style="flex: 0 0 130px">ID number</span>'
                f'<span style="flex: 1">Item</span><span style="flex: 0 0 150px">Type · date</span></div>{rows}</div>')


class Blueprint(Base):
    def rows(s, pairs):
        cells = ''.join(f'<div style="border: 1px solid #ffffff; margin: -1px 0 0 -1px; padding: 10px 12px">'
                        f'<div style="font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #cfe0ff">{k}</div>'
                        f'<div style="font-size: 15px; margin-top: 4px">{v}</div></div>' for k, v in pairs)
        return (f'<div style="border: 2px solid #ffffff"><div style="padding: 8px 12px; border-bottom: 2px solid #ffffff; font-size: 12px; '
                f'letter-spacing: 2px">TITLE BLOCK · SHEET A-1</div><div style="display: grid; grid-template-columns: '
                f'repeat(auto-fit, minmax(min(100%, 170px), 1fr)); padding: 1px 0 0 1px">{cells}</div></div>')

    def viewer(s, h):
        return (f'<div style="display: flex; flex-direction: column; gap: 8px"><div style="border: 2px dashed #ffffff; padding: 10px">'
                f'{s.ph("Photo: Aerial view of Dickinson", h, "border-radius: 0")}</div>'
                f'<div style="display: flex; justify-content: space-between; gap: 12px; font-size: 12px; letter-spacing: 1.5px; color: #cfe0ff">'
                f'<span>[WIDTH] × [HEIGHT]</span><span>SCALE: AS SCANNED</span></div>'
                f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{"".join(s.btn(x, False, tag="button") for x in ["ZOOM IN", "ZOOM OUT", "DOWNLOAD"])}</div></div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = ''.join(f'<a href="{s.href(page)}" style="text-decoration: none; border: 2px solid #ffffff; display: flex; flex-direction: column; color: #ffffff">'
                      f'<div style="padding: 6px 10px; border-bottom: 2px solid #ffffff; font-size: 12px; letter-spacing: 1.5px">A-{i + 2}</div>'
                      f'<div style="padding: 10px">{s.ph("", "110px", "border-radius: 0")}</div>'
                      f'<div style="padding: 0 10px 14px"><div style="font-family: \'Space Grotesk\', sans-serif; font-weight: 700; font-size: 17px">{label}</div>'
                      f'<div style="font-size: 13px; color: #cfe0ff">{meta}</div></div></a>' for i in range(n))
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 18px">{one}</div>')


class Postcard(Base):
    item_layout = 'postcard'; filters_kind = 'chips'; results_kind = 'grid'; item_h = 2100

    def rows(s, pairs):
        return ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 2px 12px; padding: 8px 0; border-bottom: 1px solid #7d9794">'
                       f'<div style="flex: 0 0 100px; font-size: 13px; color: #3a5256">{k}</div><div style="flex: 1 1 160px; font-size: 15px">{v}</div></div>'
                       for k, v in pairs)

    def layout_postcard(s, desc):
        card = (f'<div style="background: #fffdf6; border: 1px solid #1f3336; box-shadow: 8px 8px 0 #0d5560; display: flex; flex-wrap: wrap">'
                f'<div style="flex: 3 1 420px; min-width: 0; padding: 16px; box-sizing: border-box">{s.viewer("400px")}</div>'
                f'<div style="flex: 2 1 320px; min-width: 0; padding: 24px; border-left: 2px dashed #7d9794; box-sizing: border-box; '
                f'display: flex; flex-direction: column; gap: 12px">'
                f'<div style="display: flex; justify-content: space-between; gap: 12px; align-items: flex-start">'
                f'<div style="font-size: 12px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; color: #a6321f">Post card · {s.kind()}</div>'
                f'<div aria-hidden="true" style="width: 60px; height: 72px; border: 2px dotted #a6321f; color: #a6321f; font-size: 11px; font-weight: 700; '
                f'display: flex; align-items: center; justify-content: center; text-align: center">DHS<br>ARCHIVE</div></div>'
                f'{s.h1(s.title())}{s.rows(s.meta_pairs())}{s.actions()}</div></div>')
        return card + f'<div style="display: flex; flex-wrap: wrap; gap: 40px"><div style="flex: 2 1 420px; min-width: 0">{desc}</div>' \
                      f'<div style="flex: 1 1 280px; min-width: 0">{s.subjects()}</div></div>'

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        tilt = ['-1.5deg', '1deg', '-0.5deg', '1.5deg']
        tone = ['#c7d6d3', '#e9d9b8', '#e3c2b6', '#c9d3e0']
        one = ''.join(f'<a href="{s.href(page)}" style="background: #fffdf6; border: 1px solid #1f3336; padding: 10px 10px 14px; text-decoration: none; '
                      f'transform: rotate({tilt[i % 4]}); display: flex; flex-direction: column; gap: 10px">'
                      f'<div style="height: {phh}; background: {tone[i % 4]}"></div><div><div style="font-family: \'DM Serif Display\', serif; '
                      f'font-size: 19px; color: #0d5560">{label}</div><div style="font-size: 14px; color: #3a5256">{meta}</div></div></a>' for i in range(n))
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 24px; padding: 6px">{one}</div>')


class PlainAccess(Base):
    item_layout = 'linear'; filters_kind = 'links'; item_h = 2500

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = (f'<li><a href="{s.href(page)}" style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 16px 0; '
               f'border-top: 2px solid #000000; color: #000000; text-decoration: none"><span style="flex: 0 0 120px">{s.ph("Photo", "90px")}</span>'
               f'<span style="flex: 1 1 220px"><span style="display: block; font-weight: 700; font-size: 22px; color: #00419e; text-decoration: underline">{label}</span>'
               f'<span style="display: block; font-size: 18px">{meta}</span></span></a></li>')
        return f'<ul style="margin: 0; padding: 0; list-style: none; border-bottom: 2px solid #000000">{one * n}</ul>'

    def res_list(s):
        return s.cards(6)


class Courthouse(Base):
    def rows(s, pairs):
        if pairs[0][0] not in ('ID number', 'Reference code'):
            pairs = [('Record', '')] + list(pairs)
        r = ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 2px 16px; padding: 10px 16px; border-top: 1px solid #b9c1cc">'
                    f'<div style="flex: 0 0 120px; font-size: 14px; color: #4a5462">{k}</div><div style="flex: 1 1 160px; font-size: 15px">{v}</div></div>'
                    for k, v in pairs[1:])
        return (f'<div style="background: #f1f3f6; border: 1px solid #b9c1cc; border-top: 4px solid #7a1f2b">'
                f'<div style="background: #14315c; color: #ffffff; padding: 10px 16px; font-family: Merriweather, serif; font-weight: 700; font-size: 16px">'
                f'Official record{" · No. " + pairs[0][1] if pairs[0][1] else ""}</div>{r}</div>')

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; border: 1px solid #b9c1cc; border-top: 4px solid #7a1f2b; display: flex; flex-direction: column">'
               f'{s.ph("Photo", "130px", "border-radius: 0")}<div style="padding: 12px 14px 16px"><div style="font-size: 12px; color: #4a5462">Record [ID number]</div>'
               f'<div style="font-family: Merriweather, serif; font-weight: 700; font-size: 17px; color: #14315c; margin-top: 4px">{label}</div>'
               f'<div style="font-size: 14px; color: #4a5462">{meta}</div></div></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 20px">{one * n}</div>')


class ContactSheet(Base):
    filters_kind = 'chips'; results_kind = 'contact'

    def viewer(s, h):
        frames = ''.join(f'<button type="button" aria-label="Show frame {i + 1}" style="flex: 0 0 96px; height: 72px; padding: 0; '
                         f'background: {["#5a5a5a", "#787878", "#444444", "#8c8c8c"][i % 4]}; border: 0; '
                         f'outline: {"3px solid #f2c94c" if i == 0 else "none"}; outline-offset: 2px"></button>' for i in range(8))
        return (f'<div style="display: flex; flex-direction: column; gap: 0">{s.ph("Photo: Aerial view of Dickinson", h, "border: 3px solid #b3261e")}'
                f'<div style="background: #161616; padding: 14px; display: flex; flex-direction: column; gap: 8px">'
                f'<div style="display: flex; justify-content: space-between; font-family: \'JetBrains Mono\', monospace; font-size: 12px; color: #f2c94c">'
                f'<span>ROLL · [Collection name]</span><span>FRAME 01 OF [N]</span></div>'
                f'<div style="display: flex; gap: 10px; overflow-x: auto; padding: 4px">{frames}</div></div></div>')

    def res_contact(s):
        tones = ['#5a5a5a', '#787878', '#444444', '#8c8c8c', '#666666', '#505050']
        fr = ''.join(f'<a href="{s.href("item")}" style="text-decoration: none; display: flex; flex-direction: column; gap: 6px">'
                     f'<div style="height: 110px; background: {tones[(i * 5) % 6]}"></div>'
                     f'<div style="font-family: \'JetBrains Mono\', monospace; font-size: 11px; color: #d6d6d6">{i + 1:02d} · [ID number]</div>'
                     f'<div style="font-size: 13px; color: #ffffff">[Item title]</div></a>' for i in range(12))
        return (f'<div style="background: #161616; padding: 18px"><div style="display: grid; grid-template-columns: '
                f'repeat(auto-fit, minmax(min(100%, 130px), 1fr)); gap: 12px">{fr}</div></div>')

    def collection_items(s):
        return s.res_contact()


class LibraryStacks(Base):
    def rows(s, pairs):
        if pairs[0][0] != 'ID number':
            return P.rows(s, pairs)
        r = ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 2px 16px; padding: 10px 0; border-top: 1px solid #c9bfb2">'
                    f'<div style="flex: 0 0 110px; font-size: 14px; color: #554c45">{k}</div><div style="flex: 1 1 160px; font-size: 15px">{v}</div></div>'
                    for k, v in pairs[1:])
        return (f'<div style="background: #ffffff; border: 1px solid #c9bfb2; border-radius: 8px; padding: 14px 18px">'
                f'<div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding-bottom: 10px">'
                f'<span style="padding: 4px 12px; background: #f1e3c4; color: #4a3508; font-weight: 700; font-size: 14px; border-radius: 14px">'
                f'{pairs[0][1]}</span><span style="font-size: 14px; color: #554c45">Library number</span></div>{r}</div>')

    def item_extra(s):
        return (f'<div style="background: #f1e3c4; border-radius: 8px; padding: 14px 18px; color: #2a2522">'
                f'<div style="font-family: Lora, serif; font-weight: 700; font-size: 18px">Find it on the shelf</div>'
                f'<div style="font-size: 15px; margin-top: 4px">[Shelf or room] · Ask at the desk for {s.t["idno"]}</div></div>')

    def related(s):
        sp = [('#6b1d2a', '#ffffff', '88%'), ('#1f3d4d', '#ffffff', '100%'), ('#c9a24a', '#2a2010', '92%'), ('#3f5a3a', '#ffffff', '74%'),
              ('#8a4a2a', '#ffffff', '96%'), ('#2b2b48', '#ffffff', '82%'), ('#d8cdb8', '#2a2522', '90%'), ('#6b1d2a', '#ffffff', '78%')]
        spines = ''.join(f'<a href="{s.href("item")}" style="flex: 1; min-width: 30px; height: {h}; background: {bg}; color: {fg}; text-decoration: none; '
                         f'border-radius: 3px 3px 0 0; display: flex; align-items: center; justify-content: center">'
                         f'<span style="writing-mode: vertical-rl; font-family: Lora, serif; font-weight: 700; font-size: 15px">[Item title]</span></a>' for bg, fg, h in sp)
        return s.section(s.h2('Nearby on the shelf') + f'<div><div style="display: flex; align-items: flex-end; gap: 6px; height: 240px; '
                         f'padding: 0 12px">{spines}</div><div style="height: 14px; background: #5b4636; border-radius: 2px"></div></div>')


class CoastalLight(Base):
    item_layout = 'centered'; filters_kind = 'chips'; results_kind = 'minimal'; item_h = 2200

    def res_minimal(s):
        out = ''.join(f'<a href="{s.href("item")}" style="display: block; padding: 20px 0; border-top: 1px solid #c4d0d7; text-decoration: none">'
                      f'<span style="display: block; font-family: Newsreader, serif; font-weight: 500; font-size: 24px; color: #1c2b33">{r["title"]}</span>'
                      f'<span style="display: block; font-size: 14px; color: #51636d; margin-top: 4px">{r["type"]} · {r["date"]} · {r["id"]}</span>'
                      f'<span style="display: block; font-size: 15px; color: #2b3a42; margin-top: 6px">{r["snip"]}</span></a>' for r in s.ritems())
        return f'<div style="max-width: 760px; border-bottom: 1px solid #c4d0d7">{out}</div>'

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        one = (f'<a href="{s.href(page)}" style="text-decoration: none; display: flex; flex-direction: column; gap: 10px">{s.ph("", "160px")}'
               f'<span style="font-family: Newsreader, serif; font-weight: 500; font-size: 20px; color: #1c2b33">{label}</span>'
               f'<span style="font-size: 14px; color: #51636d">{meta}</span></a>')
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 36px">{one * n}</div>')


class NightArchive(Base):
    def rows(s, pairs):
        tiles = ''.join(f'<div style="background: #171d26; border: 1px solid #323c4a; border-radius: 10px; padding: 12px 14px">'
                        f'<div style="font-size: 12px; color: #aab4c0">{k}</div><div style="font-size: 15px; color: #ffffff; margin-top: 4px">{v}</div></div>'
                        for k, v in pairs)
        return f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 10px">{tiles}</div>'

    def cards(s, n, label='[Item title]', meta='[Type] · [date]', page='item', minw=200, phh='150px'):
        dots = ['#ffb454', '#6fb8ff', '#8fd694', '#ff8f8f', '#c9a5ff', '#f2e08a']
        one = ''.join(f'<a href="{s.href(page)}" style="text-decoration: none; background: #171d26; border: 1px solid #323c4a; border-radius: 12px; '
                      f'overflow: hidden; display: flex; flex-direction: column">{s.ph("", "140px", "border-radius: 0")}'
                      f'<div style="padding: 12px 14px 16px; display: flex; justify-content: space-between; gap: 10px; align-items: flex-start">'
                      f'<span><span style="display: block; font-family: \'Space Grotesk\', sans-serif; font-weight: 500; font-size: 16px; color: #ffffff">{label}</span>'
                      f'<span style="display: block; font-size: 13px; color: #aab4c0">{meta}</span></span>'
                      f'<span aria-hidden="true" style="flex: 0 0 10px; height: 10px; margin-top: 6px; border-radius: 50%; background: {dots[i % 6]}"></span></div></a>'
                      for i in range(n))
        return (f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, {minw}px), 1fr)); gap: 14px">{one}</div>')


CLASSES = [ReadingRoom, Broadsheet, CardCatalog, GalleryWall, Bayou, SwissGrid, FindingAidFirst, Timeline, MapRoom, MuseumLabel,
           Ledger, Depot, Blueprint, Postcard, PlainAccess, Courthouse, ContactSheet, LibraryStacks, CoastalLight, NightArchive]
