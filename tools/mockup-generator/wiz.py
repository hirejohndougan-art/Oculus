from core import *

def wizard(file, name, steps, cancel_href, finish_label, finish_href, spec, h=1000, intro=''):
    """steps: list of (title, prose, body_html). Builds a full-page, step-by-step wizard."""
    spec.wiz = [t for t, _, _ in steps]
    rail = ('<nav aria-label="Steps" style="flex: 1 1 250px; max-width: 290px; background: #26292c; padding: 22px 14px; display: flex; flex-direction: column; gap: 4px; box-sizing: border-box">'
            f'<span style="padding: 0 10px 12px; font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #aeb4ba">{name}</span>'
            f'<sc-for list="{{{{rail}}}}" as="r" hint-placeholder-count="{len(steps)}">'
            '<button type="button" aria-current="{{r.cur}}" onClick="{{r.pick}}" style="display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 6px 10px; border: 0; border-radius: 4px; '
            'background: {{r.bg}}; color: {{r.fg}}; font-family: inherit; font-size: 14px; text-align: left; cursor: pointer">'
            '<span style="flex: 0 0 26px; height: 26px; border-radius: 50%; border: 1px solid #6b7178; background: {{r.numBg}}; color: {{r.numFg}}; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; box-sizing: border-box">{{r.n}}</span>'
            '<span>{{r.title}}</span></button></sc-for></nav>')
    blocks = ''
    for i, (title, prose, body) in enumerate(steps):
        p = f'<p style="margin: 0; font-size: 16px; line-height: 1.6; color: #3a3f44; max-width: 720px">{prose}</p>' if prose else ''
        blocks += (f'<sc-if value="{{{{st_{i}}}}}" hint-placeholder-val="{{{{ {"true" if i == 0 else "false"} }}}}">'
                   f'<div style="display: flex; flex-direction: column; gap: 20px"><h1 style="margin: 0; {H}; font-size: 30px; line-height: 1.2">{title}</h1>{p}{body}</div></sc-if>')
    footer = ('<div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding-top: 20px; border-top: 1px solid #d7dce2">'
              f'<sc-if value="{{{{isFirst}}}}" hint-placeholder-val="{{{{ true }}}}">{a_btn("Cancel", cancel_href, "s")}</sc-if>'
              f'<sc-if value="{{{{notFirst}}}}" hint-placeholder-val="{{{{ false }}}}">{b_btn("← Back", "s", "goBack")}</sc-if>'
              '<span style="font-size: 13px; color: #4a5056">Answers save as a draft after every step.</span>'
              f'<sc-if value="{{{{notLast}}}}" hint-placeholder-val="{{{{ true }}}}">{b_btn("Next →", "p", "goNext")}</sc-if>'
              f'<sc-if value="{{{{isLast}}}}" hint-placeholder-val="{{{{ false }}}}">{a_btn(finish_label, finish_href, "p")}</sc-if></div>')
    html = ('<div style="font-family: \'Open Sans\', system-ui, sans-serif; color: #2f3337; background: #f3f5f8; min-height: 100vh; display: flex; flex-direction: column">'
            '<header style="background: #1d2023; color: #ffffff; padding: 12px 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 16px">'
            '<span style="font-family: Roboto, sans-serif; font-weight: 700; font-size: 18px">Polybius</span>'
            f'<span style="font-size: 15px; color: #dfe3e7">{name}</span>'
            '<span style="margin-left: auto; font-size: 14px; color: #dfe3e7">Step {{stepNum}} of {{stepCount}}</span>'
            f'<a href="{cancel_href}" style="display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; color: #ffffff; border: 1px solid #6b7178; border-radius: 4px; text-decoration: none; font-size: 14px">Save draft &amp; close</a></header>'
            '<div role="progressbar" aria-label="Progress" style="height: 5px; background: #3c4044"><div style="height: 100%; width: {{pct}}; background: {{accent}}"></div></div>'
            '<div style="flex: 1; display: flex; flex-wrap: wrap; align-items: stretch">' + rail +
            '<main style="flex: 999 1 560px; min-width: 0; padding: 40px 48px 48px; box-sizing: border-box; display: flex; justify-content: center">'
            f'<div style="width: 100%; max-width: 900px; display: flex; flex-direction: column; gap: 28px">{intro}{blocks}{footer}</div></main></div></div>')
    write(file + '.dc.html', name, html, spec, h=h)

def opt(label, sub='', note=''):
    d = {'label': label}
    if sub: d['sub'] = sub
    if note: d['note'] = note
    return d

def summary(rows):
    """rows: (label, value, step index to jump back to)."""
    inner = ''.join(
        f'<div style="display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid #eef1f4">'
        f'<span style="flex: 0 0 180px; font-weight: 600; font-size: 14px; color: #222222">{k}</span><span style="flex: 1 1 280px; font-size: 14px; line-height: 1.5">{v}</span>'
        f'<button type="button" onClick="{{{{go_{i}}}}}" style="min-height: 36px; padding: 0 12px; background: transparent; border: 1px solid #b7bec7; border-radius: 4px; font-family: inherit; font-size: 13px; color: #1d4f73; cursor: pointer">Edit</button></div>'
        for k, v, i in rows)
    return f'<div style="{CARD}; padding: 4px 20px">{inner}</div>'
