"""Admin screens for themes and page templates, in the Oculus admin look (design/DESIGN.md)."""
FONTS = 'Roboto:wght@500;600;700&family=Open+Sans:wght@400;600'
INK, TEXT, MUTED, LABEL = '#111111', '#2f3337', '#4a5056', '#222222'
BORDER, BINPUT, SOFT, FILL = '#d7dce2', '#8b939c', '#f7f9fb', '#eef1f4'
ACCENT, WASH, LINK = '#f0792d', '#fff7f0', '#1d4f73'
H = "Roboto, sans-serif"

FILES = {'themes': 'Admin-themes.dc.html', 'settings': 'Admin-theme-settings.dc.html',
         'templates': 'Admin-page-templates.dc.html', 'publish': 'Admin-publish-check.dc.html',
         'browse': 'Admin-edit-bar.dc.html', 'editing': 'Admin-editing-page.dc.html'}


def btn(text, kind='primary', href=None, extra=''):
    look = {'primary': f'background: {ACCENT}; color: #1a1a1a; border: 1px solid {ACCENT};',
            'secondary': f'background: #ffffff; color: {INK}; border: 1px solid {BINPUT};',
            'dark': f'background: {INK}; color: #ffffff; border: 1px solid {INK};',
            'disabled': f'background: {FILL}; color: #3c434b; border: 1px solid {BORDER};'}[kind]
    st = (f'display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 18px; {look} '
          f'border-radius: 4px; font-family: {H}; font-weight: 600; font-size: 15px; text-decoration: none; box-sizing: border-box; {extra}')
    if href:
        return f'<a href="{href}" style="{st}">{text}</a>'
    dis = ' disabled aria-disabled="true"' if kind == 'disabled' else ''
    return f'<button type="button"{dis} style="{st}">{text}</button>'


def pill(text, tone):
    bg, fg = {'gray': ('#eef1f4', '#3c434b'), 'green': ('#dff1e3', '#1e5a2b'), 'amber': ('#fdf0dc', '#7a4a0b'),
              'red': ('#fbe3e1', '#8f2418'), 'blue': ('#e1edf8', '#1d4f73')}[tone]
    return (f'<span style="display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; background: {bg}; '
            f'color: {fg}; font-size: 13px; font-weight: 600; white-space: nowrap">{text}</span>')


def note(text, tone='blue'):
    bg, bd, fg = {'amber': ('#fdf3e6', '#f0c48f', '#5a3a12'), 'blue': ('#eaf2fa', '#a9c6e2', '#1d3b55'),
                  'green': ('#e8f5eb', '#a8d5b2', '#1e4a28'), 'red': ('#fbe3e1', '#e3a59d', '#6e1c12')}[tone]
    return (f'<div style="background: {bg}; border: 1px solid {bd}; color: {fg}; border-radius: 4px; padding: 12px 14px; '
            f'font-size: 14px; line-height: 1.5">{text}</div>')


def card(inner, extra=''):
    return f'<div style="background: #ffffff; border: 1px solid {BORDER}; border-radius: 6px; padding: 20px; {extra}">{inner}</div>'


def h2(t):
    return f'<h2 style="margin: 0; font-family: {H}; font-weight: 700; font-size: 19px; color: {INK}">{t}</h2>'


def ph(label, h, extra=''):
    return (f'<div style="height: {h}; background: #c9d0d8; color: #3c434b; font-size: 13px; display: flex; align-items: center; '
            f'justify-content: center; text-align: center; border-radius: 4px; padding: 6px; box-sizing: border-box; {extra}">{label}</div>')


def switch(label, on, sid, locked=False, help_=''):
    track = '#1e5a2b' if on else '#8b939c'
    knob = 'margin-left: 22px' if on else 'margin-left: 2px'
    state = 'Shown' if on else 'Hidden'
    if locked:
        ctl = f'<span style="font-size: 13px; color: {MUTED}">Staff only, never shown</span>'
    else:
        ctl = (f'<button type="button" role="switch" aria-checked="{"true" if on else "false"}" aria-labelledby="{sid}" '
               f'style="display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 6px; background: transparent; '
               f'border: 0; font-family: inherit; font-size: 14px; color: {TEXT}"><span aria-hidden="true" style="width: 46px; height: 26px; '
               f'border-radius: 999px; background: {track}; display: flex; align-items: center"><span style="width: 22px; height: 22px; '
               f'border-radius: 50%; background: #ffffff; {knob}"></span></span>{state}</button>')
    hp = f'<div style="font-size: 12px; color: {MUTED}">{help_}</div>' if help_ else ''
    return (f'<div style="display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; justify-content: space-between; '
            f'padding: 8px 0; border-top: 1px solid {FILL}"><div><div id="{sid}" style="font-size: 15px; font-weight: 600; '
            f'color: {LABEL if not locked else MUTED}">{label}</div>{hp}</div>{ctl}</div>')


def field(fid, label, value, help_=''):
    hp = f'<div style="font-size: 12px; color: {MUTED}">{help_}</div>' if help_ else ''
    return (f'<div style="display: flex; flex-direction: column; gap: 6px"><label for="{fid}" style="font-size: 14px; font-weight: 600; '
            f'color: {LABEL}">{label}</label>{value}{hp}</div>')


def sel(fid, opts):
    o = ''.join(f'<option>{x}</option>' for x in opts)
    return (f'<select id="{fid}" style="min-height: 44px; padding: 0 12px; font-size: 15px; font-family: inherit; border: 1px solid {BINPUT}; '
            f'border-radius: 4px; background: #ffffff">{o}</select>')


def choice(title, sub, selected):
    bd = f'2px solid {ACCENT}' if selected else f'1px solid {BORDER}'
    bg = WASH if selected else '#ffffff'
    dot = (f'<span aria-hidden="true" style="flex: 0 0 18px; height: 18px; border-radius: 50%; border: 2px solid {INK if selected else BINPUT}; '
           f'box-sizing: border-box; display: flex; align-items: center; justify-content: center">'
           f'{"<span style=\"width: 8px; height: 8px; border-radius: 50%; background: #111111\"></span>" if selected else ""}</span>')
    return (f'<button type="button" role="radio" aria-checked="{"true" if selected else "false"}" style="display: flex; gap: 12px; '
            f'align-items: flex-start; text-align: left; padding: 14px; border: {bd}; background: {bg}; border-radius: 6px; '
            f'font-family: inherit; cursor: pointer">{dot}<span><span style="display: block; font-weight: 600; font-size: 15px; color: {INK}">{title}</span>'
            f'<span style="display: block; font-size: 13px; color: {MUTED}; margin-top: 2px">{sub}</span></span></button>')


def tabs(cur):
    items = [('Menus', None), ('Pages', None), ('Themes', 'themes'), ('Theme settings', 'settings'),
             ('Page templates', 'templates'), ('Headers and footers', None)]
    out = ''
    for label, key in items:
        on = key == cur
        href = FILES[key] if key else '#'
        out += (f'<a href="{href}"{" aria-current=\"page\"" if on else ""} style="display: inline-flex; align-items: center; min-height: 46px; '
                f'padding: 0 14px; font-family: {H}; font-weight: 600; font-size: 15px; text-decoration: none; color: {INK if on else MUTED}; '
                f'border-bottom: 3px solid {ACCENT if on else "transparent"}; margin-bottom: -1px">{label}</a>')
    return f'<nav aria-label="Site design" style="display: flex; flex-wrap: wrap; border-bottom: 1px solid #cfd5dd">{out}</nav>'


def draftbar():
    return (f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; '
            f'background: {SOFT}; border: 1px solid {BORDER}; border-radius: 6px; padding: 12px 16px">'
            f'<div style="font-size: 14px">{pill("Draft", "gray")} <span style="margin-left: 8px">[N] changes not published yet. '
            f'Visitors still see the published site.</span></div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{btn("Preview draft", "secondary")}{btn("Review and publish", "primary", FILES["publish"])}</div></div>')


def shell(title, sentence, body, actions=''):
    groups = [('Catalog', ['Items', 'Collections', 'Finding aids', 'People and places']),
              ('Public sites', ['Site design', 'Exhibits', 'Public submissions']),
              ('Settings', ['Users and roles', 'System settings'])]
    nav = ''
    for g, items in groups:
        nav += (f'<div style="font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #aeb4ba; '
                f'padding: 14px 16px 6px">{g}</div>')
        for it in items:
            on = it == 'Site design'
            nav += (f'<a href="{FILES["themes"] if on else "#"}"{" aria-current=\"page\"" if on else ""} style="display: flex; align-items: center; '
                    f'min-height: 40px; padding: 0 16px 0 34px; color: #ffffff; text-decoration: none; font-size: 15px; '
                    f'{"background: #3c4044; box-shadow: inset 3px 0 0 " + ACCENT + ";" if on else ""}">{it}</a>')
    side = (f'<div style="flex: 1 1 236px; max-width: 100%; background: #26292c; color: #ffffff; padding: 20px 0 28px; box-sizing: border-box">'
            f'<div style="padding: 0 16px"><div style="font-family: {H}; font-weight: 700; font-size: 22px">Oculus</div>'
            f'<div style="font-size: 13px; color: #c9cdd1">Dickinson Historical Society</div>'
            f'<label for="site-pick-{title[:4]}" style="display: block; font-size: 12px; color: #c9cdd1; margin-top: 16px">Working in site</label>'
            f'<select id="site-pick-{title[:4]}" style="width: 100%; min-height: 44px; margin-top: 4px; padding: 0 10px; font-family: inherit; '
            f'font-size: 15px; border-radius: 4px; border: 1px solid #8b939c; background: #3c4044; color: #ffffff">'
            f'<option>Digital Archive</option><option>Dickinson Public Library</option></select></div>{nav}</div>')
    top = (f'<div style="background: #ffffff; border-bottom: 1px solid {BORDER}; padding: 10px 28px; display: flex; flex-wrap: wrap; gap: 10px; '
           f'align-items: center; justify-content: space-between"><label for="all-{title[:4]}" style="position: absolute; left: -9999px">Search everything</label>'
           f'<input id="all-{title[:4]}" type="search" placeholder="Search everything" style="flex: 0 1 380px; min-width: 0; min-height: 44px; '
           f'padding: 0 12px; font-size: 15px; font-family: inherit; border: 1px solid {BINPUT}; border-radius: 4px">'
           f'<div style="display: flex; gap: 8px; align-items: center">{btn("+ Catalog an item")}{btn("Log an accession", "secondary")}'
           f'<span aria-label="Your account" role="img" style="width: 40px; height: 40px; border-radius: 50%; background: #3c3c3c; color: #ffffff; '
           f'display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 14px">[AB]</span></div></div>')
    head = (f'<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between">'
            f'<div style="display: flex; flex-direction: column; gap: 6px"><h1 style="margin: 0; font-family: {H}; font-weight: 700; '
            f'font-size: 28px; color: {INK}">{title}</h1><p style="margin: 0; font-size: 15px; color: {MUTED}; max-width: 760px">{sentence}</p></div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{actions}</div></div>')
    main = (f'<div style="flex: 999 1 640px; min-width: 0; display: flex; flex-direction: column">{top}'
            f'<main style="padding: 28px; display: flex; flex-direction: column; gap: 22px">{head}{body}</main></div>')
    return (f'<div style="background: #f3f5f8; font-family: \'Open Sans\', sans-serif; color: {TEXT}; min-height: 1100px; '
            f'display: flex; flex-wrap: wrap">{side}{main}</div>')


# ---------------- screens ----------------
THEMES5 = [('Reading Room', 'Charcoal, white and one warm accent. The look of the Society\'s mockup.', True, '#3c3c3c', '#f0792d'),
           ('Library Stacks', 'Warm paper and maroon, with library numbers and shelf spines.', False, '#6b1d2a', '#c9a24a'),
           ('Plain Access', 'Large text and the highest contrast. Easiest to read.', False, '#000000', '#00419e'),
           ('Finding Aid First', 'The archive tree beside every page. For researchers.', False, '#23292f', '#0b4f8a'),
           ('Museum Label', 'Large pictures with wall labels. For exhibits and objects.', False, '#1a1a1a', '#c9c7c0')]


def scr_themes():
    cards = ''
    for name, sub, used, c1, c2 in THEMES5:
        sw = (f'<div aria-hidden="true" style="height: 150px; border-radius: 4px; overflow: hidden; display: flex; flex-direction: column; '
              f'border: 1px solid {BORDER}"><div style="height: 26px; background: {c1}"></div><div style="flex: 1; background: #f3f5f8; padding: 12px; '
              f'display: flex; flex-direction: column; gap: 8px"><div style="height: 12px; width: 60%; background: #c9d0d8"></div>'
              f'<div style="display: flex; gap: 8px; flex: 1"><div style="flex: 1; background: #c9d0d8"></div><div style="flex: 1; background: #c9d0d8"></div>'
              f'<div style="flex: 1; background: #c9d0d8"></div></div><div style="height: 16px; width: 30%; background: {c2}"></div></div></div>')
        acts = (pill('In use on this site', 'green') if used else btn('Use this theme', 'secondary'))
        cards += card(f'<div style="display: flex; flex-direction: column; gap: 12px">{sw}'
                      f'<div style="font-family: {H}; font-weight: 700; font-size: 18px; color: {INK}">{name}</div>'
                      f'<div style="font-size: 14px; color: {MUTED}; min-height: 40px">{sub}</div>'
                      f'<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center">{acts}{btn("Preview", "secondary")}</div></div>',
                      'padding: 14px;' + (f' border: 2px solid {ACCENT};' if used else ''))
    body = (tabs('themes') + draftbar() +
            note('You can choose among the themes installed on Oculus. Only system managers can install new ones. '
                 'Changing the theme keeps your menus, pages and content; only the look changes.') +
            f'<div role="radiogroup" aria-label="Themes" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 18px">{cards}</div>' +
            card(f'<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between">'
                 f'<div>{h2("Want to adjust the colours or fonts?")}<div style="font-size: 14px; color: {MUTED}; margin-top: 4px">'
                 f'Theme settings let you change this theme\'s named colours, fonts and logo.</div></div>'
                 f'{btn("Open theme settings", "dark", FILES["settings"])}</div>'))
    return shell('Site design', 'Choose how the Digital Archive looks to visitors. Nothing changes for visitors until you publish.', body)


def colour_row(i, name, hexv, ratio, ok, why):
    tone = 'green' if ok else 'red'
    res = (pill(f'Easy to read · {ratio} to 1', 'green') if ok else pill(f'Too hard to read · {ratio} to 1', 'red'))
    fid = f'col{i}'
    msg = '' if ok else f'<div style="font-size: 13px; color: #8f2418">{why}</div>'
    return (f'<div style="display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 12px 0; border-top: 1px solid {FILL}">'
            f'<span aria-hidden="true" style="width: 44px; height: 44px; border-radius: 4px; background: {hexv}; border: 1px solid {BINPUT}"></span>'
            f'<div style="flex: 1 1 200px; min-width: 0"><label for="{fid}" style="font-size: 15px; font-weight: 600; color: {LABEL}">{name}</label>{msg}</div>'
            f'<input id="{fid}" type="text" value="{hexv}" style="width: 120px; min-height: 44px; padding: 0 10px; font-size: 15px; '
            f'font-family: \'Open Sans\', sans-serif; border: 1px solid {"#8f2418" if not ok else BINPUT}; border-radius: 4px">{res}</div>')


def scr_settings():
    cols = [('Header and footer', '#3c3c3c', '11.9', True, ''), ('Accent (buttons and highlights)', '#f0792d', '8.6', True, ''),
            ('Page background', '#e5e9ef', '13.7', True, ''), ('Body text', '#3a3a3a', '9.6', True, ''),
            ('Links', '#7fa6c4', '2.4', False, 'Links in this colour are too pale on the page background. It needs at least 4.5 to 1. Try a darker blue, like #1d4f73.'),
            ('Small labels', '#8a4310', '5.9', True, '')]
    colours = ''.join(colour_row(i, *c) for i, c in enumerate(cols))
    left = (card(f'{h2("Colours")}<p style="margin: 6px 0 4px; font-size: 14px; color: {MUTED}">Each colour is checked against the colour it sits on. '
                 f'A colour that is too hard to read can\'t be saved.</p>{colours}', 'display: flex; flex-direction: column;') +
            card(f'<div style="display: flex; flex-direction: column; gap: 16px">{h2("Text")}'
                 f'<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 16px">'
                 f'{field("ff1", "Font for headings", sel("ff1", ["Roboto", "Lora", "Merriweather", "Atkinson Hyperlegible"]))}'
                 f'{field("ff2", "Font for body text", sel("ff2", ["Open Sans", "Source Serif 4", "Atkinson Hyperlegible"]))}'
                 f'{field("ff3", "Text size", sel("ff3", ["Standard", "Larger", "Largest"]), "Larger sizes help older visitors.")}</div></div>') +
            card(f'<div style="display: flex; flex-direction: column; gap: 14px">{h2("Logo and header")}'
                 f'<div style="border: 2px dashed {BINPUT}; background: {SOFT}; border-radius: 6px; padding: 22px; text-align: center; font-size: 14px">'
                 f'Drop your logo here, or {btn("Choose a file", "secondary")}<div style="font-size: 12px; color: {MUTED}; margin-top: 8px">'
                 f'SVG or PNG. Add a short text description for screen readers.</div></div>'
                 f'<div role="radiogroup" aria-label="Header style" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px">'
                 f'{choice("Dark bar", "Name and menu on the header colour", True)}{choice("Light", "Name and menu on the page background", False)}'
                 f'{choice("Centred", "Name centred, menu below", False)}</div></div>'))
    preview = card(f'<div style="display: flex; flex-direction: column; gap: 10px">{h2("Preview")}'
                   f'<div style="border: 1px solid {BORDER}; border-radius: 4px; overflow: hidden"><div style="background: #3c3c3c; color: #ffffff; '
                   f'padding: 12px 14px; font-family: {H}; font-weight: 700; font-size: 15px">Dickinson Historical Society</div>'
                   f'<div style="background: #e5e9ef; padding: 16px; display: flex; flex-direction: column; gap: 10px">'
                   f'<div style="font-family: {H}; font-weight: 700; font-size: 20px; color: #111111">Aerial view of Dickinson</div>'
                   f'<div style="font-size: 14px; color: #3a3a3a">Body text looks like this on the page background.</div>'
                   f'<div style="font-size: 14px; color: #7fa6c4; text-decoration: underline">A link in the colour you chose</div>'
                   f'<span style="align-self: flex-start; background: #f0792d; color: #1a1a1a; padding: 8px 14px; border-radius: 4px; font-weight: 600; '
                   f'font-size: 14px">Search</span></div></div>'
                   f'{note("Fix the link colour before saving. Everything else passes.", "amber")}</div>')
    body = (tabs('settings') + draftbar() +
            f'<div style="display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start"><div style="flex: 2 1 560px; min-width: 0; display: flex; '
            f'flex-direction: column; gap: 18px">{left}</div><div style="flex: 1 1 320px; min-width: 0">{preview}</div></div>')
    return shell('Theme settings: Reading Room', 'Change this theme\'s colours, fonts and logo for the Digital Archive. '
                 'Every colour is checked so text stays easy to read.', body,
                 btn('Undo all changes', 'secondary') + btn('Save', 'disabled'))


def scr_templates():
    pts = ['Item page', 'Collection page', 'Finding aid', 'Search and browse', 'Person, group or place', 'Page not found',
           'Restricted area', 'Password']
    lst = ''.join(f'<a href="#"{" aria-current=\"page\"" if i == 0 else ""} style="display: flex; align-items: center; min-height: 44px; '
                  f'padding: 0 14px; border-radius: 4px; text-decoration: none; color: {INK}; font-size: 15px; '
                  f'{"background: " + WASH + "; box-shadow: inset 3px 0 0 " + ACCENT + "; font-weight: 600;" if i == 0 else ""}">{p}</a>'
                  for i, p in enumerate(pts))
    left = card(f'<div style="font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: {MUTED}; '
                f'padding: 0 4px 8px">Page templates</div><nav aria-label="Page templates" style="display: flex; flex-direction: column; gap: 2px">{lst}</nav>',
                'flex: 1 1 240px; min-width: 0; padding: 14px; align-self: flex-start;')
    fields = [('Title', True, False, ''), ('ID number', True, False, ''), ('Date', True, False, ''),
              ('Creator', True, False, ''), ('Place', True, False, ''), ('Subjects', True, False, ''),
              ('Description', True, False, ''), ('Rights statement', True, False, 'Always shown when the item is published'),
              ('Physical size', False, False, 'Hidden on this site; still saved in the record'),
              ('Donor name', False, True, 'Marked staff only in the field template'),
              ('Storage location', False, True, 'Marked staff only in the field template')]
    sw = ''.join(switch(n, on, f'sw{i}', locked, hp) for i, (n, on, locked, hp) in enumerate(fields))
    lay = (f'<div role="radiogroup" aria-label="Layout" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px">'
           f'{choice("Side by side", "Picture on the left, details on the right", True)}'
           f'{choice("Picture on top", "Large picture, details below", False)}{choice("Wall label", "Large picture with a label card", False)}</div>')
    mid = (f'<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 18px">'
           + card(f'<div style="display: flex; flex-direction: column; gap: 12px">{h2("Layout")}{lay}</div>')
           + card(f'{h2("Which fields visitors see")}<p style="margin: 6px 0 8px; font-size: 14px; color: {MUTED}">Switch a field off to hide it on '
                  f'this site\'s item pages. Hiding never changes the record. Staff-only fields can\'t be switched on here.</p>{sw}')
           + note('These switches only hide things. A field marked staff only in its field template is never sent to the public site at all, '
                  'whatever this page says.') + '</div>')
    prev = card(f'<div style="display: flex; flex-direction: column; gap: 10px">{h2("Preview with a real record")}'
                f'{field("pv", "Record to preview", sel("pv", ["Aerial view of Dickinson, late 1920s", "[Item title]"]))}'
                f'{ph("Item page preview in the Reading Room theme", "360px")}</div>', 'flex: 1 1 300px; min-width: 0; align-self: flex-start;')
    body = tabs('templates') + draftbar() + f'<div style="display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start">{left}{mid}{prev}</div>'
    return shell('Page templates', 'Page templates decide how each kind of public page is laid out and which fields it shows. '
                 'They are different from field templates, which decide what a record holds.', body)


def scr_publish():
    def row(tone, title, where, act):
        icon = {'red': 'Serious', 'amber': 'Check', 'green': 'Passed'}[tone]
        return (f'<div style="display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 14px 0; border-top: 1px solid {FILL}">'
                f'{pill(icon, tone)}<div style="flex: 1 1 300px; min-width: 0"><div style="font-weight: 600; font-size: 15px; color: {INK}">{title}</div>'
                f'<div style="font-size: 13px; color: {MUTED}">{where}</div></div>{act}</div>')
    checks = (row('red', 'An image has no text description', 'Home page › Featured item. Screen-reader users won\'t know what it shows.', btn('Fix it', 'dark', FILES['editing']))
              + row('amber', 'A heading level is skipped', 'Page “Visit us”: a small heading comes straight after the page title.', btn('Show me', 'secondary'))
              + row('amber', 'Link text says only “click here”', 'Page “Donate”. Say where the link goes instead.', btn('Show me', 'secondary'))
              + row('green', 'Text colours are easy to read', 'All theme colours pass the 4.5 to 1 contrast check.', '')
              + row('green', 'Every page has a title', '[N] pages checked.', ''))
    changes = ''.join(f'<div style="display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 0; border-top: 1px solid {FILL}; font-size: 15px">'
                      f'<span style="flex: 0 0 150px; color: {MUTED}">{a}</span><span style="flex: 1 1 240px">{b}</span>'
                      f'<a href="{c}" style="color: {LINK}; font-weight: 600">Edit</a></div>'
                      for a, b, c in [('Theme settings', 'Link colour changed', FILES['settings']), ('Page templates', 'Item page: “Physical size” hidden', FILES['templates']),
                                      ('Pages', 'Home page: new featured item', FILES['editing'])])
    body = (tabs(None) +
            f'<div style="display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start"><div style="flex: 3 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 18px">'
            + card(f'{h2("Accessibility check")}<p style="margin: 6px 0 4px; font-size: 14px; color: {MUTED}">Serious problems stop publishing. '
                   f'The others are worth fixing but won\'t stop you.</p>{checks}')
            + '</div><div style="flex: 2 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 18px">'
            + card(f'{h2("What will change")}{changes}')
            + note('<strong>Can\'t publish yet:</strong> fix 1 serious problem. The image on the home page needs a text description.', 'red')
            + f'<div>{btn("Publish to the Digital Archive", "disabled")}</div></div></div>')
    return shell('Review and publish', 'Check your draft before visitors see it. Oculus runs an accessibility check every time.', body)


def public_home(editing=False):
    lock = (f'<div style="position: absolute; inset: 0; background: rgba(38,41,44,0.55); display: flex; align-items: center; justify-content: center">'
            f'<span style="background: #ffffff; color: {INK}; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600">'
            f'Locked. Edit under Headers and footers</span></div>') if editing else ''
    header = (f'<div style="position: relative; background: #3c3c3c; padding: 18px 40px; display: flex; flex-wrap: wrap; gap: 14px; justify-content: space-between; '
              f'align-items: center"><div style="font-family: {H}; font-weight: 700; font-size: 19px; color: #ffffff">Dickinson Historical Society '
              f'<span style="font-weight: 500; color: #c9cdd1">Digital Archive</span></div><div style="display: flex; flex-wrap: wrap; gap: 22px; '
              f'font-size: 15px; color: #ffffff"><span>Collections</span><span>Browse</span><span>Finding aids</span><span>About</span></div>{lock}</div>')
    def block(inner, sel_=False):
        if not editing:
            return inner
        if sel_:
            bar = (f'<div style="position: absolute; top: -46px; left: 0; display: flex; gap: 6px; background: #26292c; padding: 4px; border-radius: 4px">'
                   + ''.join(f'<button type="button" style="min-height: 36px; padding: 0 12px; background: transparent; color: #ffffff; border: 0; '
                             f'font-family: inherit; font-size: 13px">{x}</button>' for x in ['Featured item', 'Change item', 'Move up', 'Move down', 'Remove'])
                   + '</div>')
            return f'<div style="position: relative; outline: 3px solid {ACCENT}; outline-offset: 6px">{bar}{inner}</div>'
        return f'<div style="outline: 1px dashed {BINPUT}; outline-offset: 6px">{inner}</div>'
    hero = (f'<div style="text-align: center; display: flex; flex-direction: column; gap: 14px; align-items: center">'
            f'<div style="font-family: {H}; font-weight: 700; font-size: 40px; color: #111111">Search the Society\'s photographs, papers and objects</div>'
            f'<div style="width: 100%; max-width: 560px; height: 52px; background: #ffffff; border: 1px solid #8b939c; border-radius: 4px"></div></div>')
    feat = (f'<div style="background: #ffffff; border-radius: 6px; padding: 20px; display: flex; flex-wrap: wrap; gap: 20px; align-items: center">'
            f'{ph("Photo: Aerial view of Dickinson" + (" (needs a text description)" if editing else ""), "130px", "flex: 0 0 200px;")}'
            f'<div><div style="font-size: 13px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: #8a4310">Featured item</div>'
            f'<div style="font-family: {H}; font-weight: 700; font-size: 22px; color: #111111">Aerial view of Dickinson, late 1920s</div></div></div>')
    cards = ('<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 20px">'
             + ''.join(f'<div style="background: #ffffff; border-radius: 6px; overflow: hidden">{ph("Collection photo", "120px", "border-radius: 0")}'
                       f'<div style="padding: 14px; font-family: {H}; font-weight: 700; font-size: 17px; color: #111111">[Collection name]</div></div>' for _ in range(3))
             + '</div>')
    footer = (f'<div style="position: relative; background: #3c3c3c; color: #c9cdd1; padding: 22px 40px; font-size: 14px">Dickinson Historical Society · '
              f'Powered by Oculus · Staff sign in{lock}</div>')
    content = (f'<div style="max-width: 1100px; margin: 0 auto; padding: {64 if editing else 48}px 32px 48px; display: flex; flex-direction: column; gap: {56 if editing else 36}px">'
               f'{block(hero)}{block(feat, True)}{block(cards)}</div>')
    return f'<div style="background: #e5e9ef; font-family: \'Open Sans\', sans-serif">{header}{content}{footer}</div>'


def scr_browse():
    bar = (f'<div style="background: #1d2023; color: #ffffff; padding: 8px 20px; display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; '
           f'justify-content: space-between; font-size: 14px"><span><strong>Oculus</strong> · Signed in as [Name] · You\'re seeing the published site</span>'
           f'<span style="display: flex; flex-wrap: wrap; gap: 8px">{btn("Edit page", "primary", FILES["editing"])}'
           f'{btn("Site design", "secondary", FILES["themes"], "background: transparent; color: #ffffff; border-color: #8b939c;")}</span></div>')
    return f'<div style="min-height: 1000px; background: #e5e9ef">{bar}{public_home(False)}</div>'


def scr_editing():
    bar = (f'<div style="background: #1d2023; color: #ffffff; padding: 8px 20px; display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; '
           f'justify-content: space-between; font-size: 14px"><span>{pill("Editing", "amber")} <span style="margin-left: 8px">Home page · changes are saved as a draft</span></span>'
           f'<span style="display: flex; flex-wrap: wrap; gap: 8px">{btn("+ Add a block", "secondary", None, "background: transparent; color: #ffffff; border-color: #8b939c;")}'
           f'{btn("Done editing", "secondary", FILES["browse"], "background: transparent; color: #ffffff; border-color: #8b939c;")}'
           f'{btn("Review and publish", "primary", FILES["publish"])}</span></div>')
    panel = (f'<div style="background: #ffffff; border-left: 1px solid {BORDER}; padding: 20px; flex: 1 1 300px; min-width: 0; box-sizing: border-box; '
             f'display: flex; flex-direction: column; gap: 14px">{h2("Featured item")}'
             f'{field("fi1", "Item", sel("fi1", ["Aerial view of Dickinson, late 1920s"]))}'
             f'<div style="display: flex; flex-direction: column; gap: 6px"><label for="fi2" style="font-size: 14px; font-weight: 600; color: {LABEL}">'
             f'Text description of the image</label><textarea id="fi2" rows="3" style="font-family: inherit; font-size: 15px; padding: 10px; '
             f'border: 2px solid #8f2418; border-radius: 4px"></textarea><div style="font-size: 13px; color: #8f2418">Needed before you can publish. '
             f'Say what the photo shows, in a sentence.</div></div>'
             f'{note("Only this page changes in edit mode. The header and footer are edited under Headers and footers, so they look the same on every page.")}</div>')
    return (f'<div style="min-height: 1100px; background: #e5e9ef">{bar}<div style="display: flex; flex-wrap: wrap">'
            f'<div style="flex: 999 1 640px; min-width: 0">{public_home(True)}</div>{panel}</div></div>')


SCREENS = [('themes', 'Site design: choose a theme', scr_themes), ('settings', 'Theme settings with the contrast check', scr_settings),
           ('templates', 'Page templates: layout and field switches', scr_templates), ('publish', 'Review and publish: accessibility check', scr_publish),
           ('browse', 'Public site: the edit bar', scr_browse), ('editing', 'Public site: editing a page', scr_editing)]


def render(key, title, fn):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family={FONTS}&display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{LINK}}}
</style>
</helmet>
{fn()}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":1100}}}}'>
class Component extends DCLogic {{
renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
'''
