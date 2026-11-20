# Mockup generator

Builds the back-end and wizard screens of the [Oculus mockup](../../mockup/) from shared pieces, so the sidebar, top bar and wizard frame stay identical on every screen.

| File | What it holds |
|---|---|
| `core.py` | Colors and shared styles, small builders (field, card, table, pill, note), the sidebar and top bar, and the click behavior (tabs, choice cards, toggles, wizard steps). |
| `wiz.py` | The full-page wizard frame and the review summary. |
| `screens1.py`–`screens3.py` | The back-end screens. |
| `wizards.py` | The six wizards and their steps. |
| `build.py` | Runs everything, lays out `canvas.json` and checks that every link goes to a screen that exists. |

```bash
python3 build.py
```

It writes to `out/` next to the scripts, or to the folder in the `OCULUS_MOCKUP_OUT` environment variable. Every generated file is checked for unclosed tags as it's written. Copy the results into `mockup/screens/` and `mockup/canvas.json` when they look right.
