#!/usr/bin/env python3
"""Render a Markdown doc to a styled, readable HTML page for viewing.

Convention (project): docs are ARCHIVED as Markdown under `doc/`; when shown to
the user they are rendered to HTML under `.view/` for readability. This script
implements the render step. Source of truth stays the Markdown file.

Usage:
    python scripts/md2html.py <markdown-path> [--out <html-path>] [--open]

Default output: <repo>/.view/<markdown-stem>.html
Requires: markdown-it-py (pip install markdown-it-py)
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

try:
    from markdown_it import MarkdownIt
except ModuleNotFoundError:  # pragma: no cover
    sys.exit("missing dependency: pip install markdown-it-py")

CSS = """
:root{--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--bg:#fff;--code-bg:#f6f8fa;--accent:#0969da}
*{box-sizing:border-box}
body{margin:0;background:#f0f2f5;color:var(--fg);
  font-family:"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,-apple-system,sans-serif;
  font-size:16px;line-height:1.75;-webkit-font-smoothing:antialiased}
main{max-width:920px;margin:32px auto;background:var(--bg);padding:48px 56px;
  border-radius:14px;box-shadow:0 2px 16px rgba(31,35,40,.08)}
h1,h2,h3,h4{line-height:1.3;font-weight:650;margin:1.6em 0 .6em}
h1{font-size:1.9em;border-bottom:2px solid var(--border);padding-bottom:.3em;margin-top:0}
h2{font-size:1.45em;border-bottom:1px solid var(--border);padding-bottom:.25em}
h3{font-size:1.18em}
p{margin:.7em 0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{background:var(--code-bg);padding:.15em .4em;border-radius:5px;
  font-family:"Cascadia Code",Consolas,"Courier New",monospace;font-size:.9em}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;overflow:auto;line-height:1.55}
pre code{background:none;padding:0;font-size:.86em}
blockquote{margin:1em 0;padding:.4em 1em;border-left:4px solid var(--border);
  background:#fbfcfd;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.94em;display:block;overflow:auto}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--code-bg);font-weight:650}
tr:nth-child(even) td{background:#fafbfc}
hr{border:none;border-top:1px solid var(--border);margin:2em 0}
ul,ol{padding-left:1.6em;margin:.6em 0}
li{margin:.25em 0}
strong{font-weight:650}
li,td{word-break:break-word}
"""


def render(md_path: str, out_path: str, title: str) -> str:
    src = open(md_path, encoding="utf-8").read()
    try:
        md = MarkdownIt("gfm-like")
        md.disable("linkify")  # linkify-it-py is optional; not required for these docs
    except Exception:
        md = MarkdownIt("commonmark").enable(["table", "strikethrough"])
    body = md.render(src)
    html = (
        '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{title}</title>\n<style>{CSS}</style>\n</head>\n"
        f"<body><main>\n{body}\n</main></body>\n</html>\n"
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, "w", encoding="utf-8").write(html)
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="Render a Markdown doc to styled HTML.")
    ap.add_argument("markdown", help="path to the .md file")
    ap.add_argument("--out", default=None, help="output .html path")
    ap.add_argument("--open", action="store_true", help="open in the default browser")
    args = ap.parse_args()

    md_path = os.path.abspath(args.markdown)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    stem = os.path.splitext(os.path.basename(md_path))[0]
    out_path = args.out or os.path.join(repo, ".view", stem + ".html")
    title = stem

    render(md_path, out_path, title)
    print(out_path)
    if args.open:
        if sys.platform == "win32":
            os.startfile(out_path)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", out_path], check=False)
        else:
            subprocess.run(["xdg-open", out_path], check=False)


if __name__ == "__main__":
    main()
