"""Build the static GitHub Pages demo: index.html, tracker.html and upload.html.

GitHub Pages can't run Flask or a database, so this renders the real templates once and
rewrites their links to relative files. static/demo-api.js then answers the pages' /api calls
in the browser from fictional sample data. No client data is read or written.

Run from this folder after changing a template:  python build_static.py
"""
import re
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import app as tracker  # noqa: E402

PAGES = {"/": "index.html", "/tracker": "tracker.html", "/upload": "upload.html"}
DEMO_COUNT = int(re.search(r"const DEMO_COUNT = (\d+);", (ROOT / "static" / "demo-api.js").read_text(encoding="utf-8")).group(1))
BANNER = (
    '<div class="notice warn demo-note" role="note"><strong>Demo with sample data.</strong> '
    "Every client, policy and number here is fictional. Edits reset when you reload, "
    "Excel downloads arrive as CSV, and importing is switched off.</div>"
)


class _Connection:
    def close(self):
        pass


def _render(path):
    app = tracker.app
    app.config["LOGIN_DISABLED"] = True
    with patch.object(tracker.db, "connect", lambda: _Connection()), \
            patch.object(tracker.db, "init_db", lambda: None), \
            patch.object(tracker.db, "get_meta", lambda *args, **kwargs: None), \
            patch.object(tracker.db, "count_renewals", lambda conn: DEMO_COUNT):
        response = app.test_client().get(path)
    assert response.status_code == 200, f"{path} returned {response.status_code}"
    return response.get_data(as_text=True)


def _to_static(html):
    html = re.sub(r'<details class="danger-zone">.*?</details>', "", html, flags=re.S)  # needs a database
    html = re.sub(r'<form method="post" action="/logout">.*?</form>', "", html, flags=re.S)  # no sign-in here
    for route, page in PAGES.items():
        html = html.replace(f'href="{route}"', f'href="{page}"')
    html = html.replace('action="/upload"', 'action="upload.html"').replace("/static/", "static/")
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">', 1)
    # Load the demo API first so every fetch the pages make is answered in the browser.
    html = html.replace('<script src="static/workspace.js', '<script src="static/demo-api.js"></script>\n<script src="static/workspace.js', 1)
    html = html.replace('<main id="main" tabindex="-1">', '<main id="main" tabindex="-1">\n' + BANNER, 1)
    leftovers = re.findall(r'(?:href|src|action)="/[^"]*"', html)
    assert not leftovers, f"absolute links left in page: {leftovers}"
    return html


def main():
    for route, page in PAGES.items():
        (ROOT / page).write_text(_to_static(_render(route)), encoding="utf-8")
        print("wrote", page)


if __name__ == "__main__":
    main()
