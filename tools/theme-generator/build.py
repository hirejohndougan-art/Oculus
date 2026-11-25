"""Regenerate the generated pages of the public-site theme canvas.

    python3 tools/theme-generator/build.py

Writes into design/public-site-themes/canvas/:
- the 8 inner pages of each of the 20 themes (<stem>-<page>.dc.html)
- the phone view of each item page (<stem>-item-phone.dc.html)
- the 6 admin screens (Admin-*.dc.html)

It never touches the 20 home pages, their -tablet/-phone wrappers, or canvas.json.
Those were written by hand; change them directly.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import admin  # noqa: E402
import motifs  # noqa: E402
import pages  # noqa: E402
from themes import THEMES  # noqa: E402

OUT = os.path.join(HERE, '..', '..', 'design', 'public-site-themes', 'canvas')
PHONE_TALL = {'PlainAccess', 'MuseumLabel', 'Postcard', 'GalleryWall', 'Broadsheet'}
ADMIN_HEIGHTS = {'themes': 1150, 'settings': 1500, 'templates': 1350, 'publish': 1100, 'browse': 1100, 'editing': 1250}


def write(name, text):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        f.write(text)


def main():
    n = 0
    for theme, cls in zip(THEMES, motifs.CLASSES):
        stem = theme['stem']
        for key, _ in pages.PAGES:
            write(f'{stem}-{key}.dc.html', cls(theme, key).render())
            n += 1
        ph = 4400 if cls.__name__ in PHONE_TALL else 3900
        write(f'{stem}-item-phone.dc.html', pages.phone_wrapper(theme, f'{stem}-item', ph))
        n += 1
    for key, title, fn in admin.SCREENS:
        out = admin.render(key, title, fn).replace('"height":1100', f'"height":{ADMIN_HEIGHTS[key]}')
        write(admin.FILES[key], out)
        n += 1
    print(f'wrote {n} files to {os.path.normpath(OUT)}')
    print('If a page height changed, update its h in canvas.json by hand.')


if __name__ == '__main__':
    main()
