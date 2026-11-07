#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""paper_render — 把论文 Markdown 渲染成可直接阅读的 HTML（自包含单文件）与 DOCX。

协议：stdin 收 {"args": {...}}，stdout 回 {"ok": true, "result": {...}}。
args:
  path   必填，论文 Markdown 路径
  out    可选，输出路径（.html / .docx），省略则与源文件同目录同名
  fmt    可选，html|docx|both（默认 both）
  title  可选，文档标题，省略取首个 H1

设计取舍：
  - HTML 把图片内联成 base64 → 单个 .html 可移动、可发人、可 Ctrl+P 存 PDF，不依赖 figures/ 目录。
  - DOCX 用 python-docx 手写块级解析（标题/段落/列表/表格/图/题注），不用 pandoc（本机无）。
  - 表格题注（**表 N：…**）单独识别成 caption 段落，不混进正文。
"""
from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|<u>.*?</u>)")
CAPTION = re.compile(r"^\*\*(图|表|Figure|Table)\s+[0-9B]+[：:.].*", re.S)
IMG = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)\)\s*$")
OL = re.compile(r"^(\d+)\.\s+(.*)$")
UL = re.compile(r"^[-*+]\s+(.*)$")
HR = re.compile(r"^(?:---|\*\*\*|___)\s*$")
FENCE = re.compile(r"^```")

BODY_EA = "宋体"
HEAD_EA = "微软雅黑"
MONO = "Consolas"


# ---------------------------------------------------------------- 块级解析
def parse_blocks(text: str) -> list[dict]:
    lines = text.replace("\r\n", "\n").split("\n")
    blocks: list[dict] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1
            continue
        if FENCE.match(s):
            i += 1
            buf = []
            while i < len(lines) and not FENCE.match(lines[i].strip()):
                buf.append(lines[i])
                i += 1
            i += 1
            blocks.append({"t": "code", "text": "\n".join(buf)})
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            blocks.append({"t": "h", "lvl": len(m.group(1)), "text": m.group(2).strip()})
            i += 1
            continue
        if HR.match(s):
            blocks.append({"t": "hr"})
            i += 1
            continue
        m = IMG.match(s)
        if m:
            blocks.append({"t": "img", "alt": m.group(1), "src": m.group(2)})
            i += 1
            continue
        if s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                raw = lines[i].strip()
                if re.match(r"^\|[\s:|-]+\|$", raw):
                    i += 1
                    continue
                cells = [c.strip() for c in raw.strip("|").split("|")]
                rows.append(cells)
                i += 1
            if rows:
                blocks.append({"t": "table", "rows": rows})
            continue
        if UL.match(s):
            items = []
            while i < len(lines) and UL.match(lines[i].strip()):
                items.append(UL.match(lines[i].strip()).group(1))
                i += 1
            blocks.append({"t": "ul", "items": items})
            continue
        if OL.match(s):
            items = []
            while i < len(lines) and OL.match(lines[i].strip()):
                items.append(OL.match(lines[i].strip()).group(2))
                i += 1
            blocks.append({"t": "ol", "items": items})
            continue
        if CAPTION.match(s):
            blocks.append({"t": "caption", "text": s.strip("*")})
            i += 1
            continue
        # 普通段落：吃到空行或块级起始
        buf = [s]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if (not nxt or nxt.startswith(("#", "|", "!", ">"))
                    or UL.match(nxt) or OL.match(nxt) or HR.match(nxt) or FENCE.match(nxt)):
                break
            buf.append(nxt)
            i += 1
        blocks.append({"t": "p", "text": " ".join(buf)})
    return blocks


def strip_tags(s: str) -> str:
    return re.sub(r"</?u>", "", s)


# ---------------------------------------------------------------- HTML
CSS = """
:root{--ink:#1a1a1a;--mut:#666;--line:#e2e2e2;--accent:#1c4e80;--bg:#fff;--soft:#f7f8fa}
*{box-sizing:border-box}
body{margin:0;background:var(--soft);color:var(--ink);
 font-family:"-apple-system",BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
 font-size:16px;line-height:1.8;-webkit-font-smoothing:antialiased}
.page{max-width:860px;margin:0 auto;background:var(--bg);padding:56px 64px 88px;
 box-shadow:0 1px 3px rgba(0,0,0,.07)}
h1{font-size:1.85em;line-height:1.35;margin:0 0 .5em;letter-spacing:-.01em}
h2{font-size:1.32em;margin:2.4em 0 .7em;padding-bottom:.35em;border-bottom:1px solid var(--line)}
h3{font-size:1.08em;margin:1.8em 0 .55em;color:#222}
p{margin:.85em 0;text-align:justify}
strong{font-weight:600}
code{font-family:ui-monospace,Consolas,monospace;font-size:.88em;background:#f2f3f5;
 padding:.1em .35em;border-radius:3px;color:#0f4c81}
hr{border:0;border-top:1px solid var(--line);margin:2.6em 0}
img{max-width:100%;height:auto;display:block;margin:1.4em auto}
table{border-collapse:collapse;width:100%;margin:.6em 0 1.6em;font-size:.9em;
 font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:.5em .7em;text-align:left;vertical-align:top}
thead th{border-top:2px solid #333;border-bottom:1.5px solid #333;background:#fafafa;font-weight:600}
tbody tr:last-child td{border-bottom:2px solid #333}
ul,ol{margin:.7em 0;padding-left:1.6em}
li{margin:.3em 0}
.cap{font-size:.86em;color:var(--mut);text-align:center;margin:-.6em 0 1.8em;line-height:1.6}
.toc{background:var(--soft);border:1px solid var(--line);border-radius:6px;
 padding:18px 26px;margin:2em 0 2.6em;font-size:.92em}
.toc-t{font-weight:600;margin-bottom:.6em;font-size:.95em;color:var(--mut);
 letter-spacing:.06em;text-transform:uppercase}
.toc ul{list-style:none;padding-left:0;margin:0}
.toc li{margin:.25em 0}
.toc li.l3{padding-left:1.5em;font-size:.95em;color:#444}
.toc a{color:var(--accent);text-decoration:none}
.toc a:hover{text-decoration:underline}
a{color:var(--accent)}
@media(max-width:760px){.page{padding:28px 20px 56px}}
@media print{body{background:#fff;font-size:11pt}.page{box-shadow:none;max-width:none;padding:0}
 .toc{background:#fff}img{page-break-inside:avoid}table{page-break-inside:avoid}}
"""


def to_html(md_path: Path, title: str | None) -> tuple[str, dict]:
    import markdown
    from bs4 import BeautifulSoup

    text = md_path.read_text(encoding="utf-8-sig")
    html = markdown.markdown(text, extensions=["tables", "toc", "sane_lists", "fenced_code"])
    soup = BeautifulSoup(html, "html.parser")

    # 图片内联 base64
    n_img = 0
    for img in soup.find_all("img"):
        src = img.get("src", "")
        p = (md_path.parent / src).resolve()
        if p.is_file():
            b64 = base64.b64encode(p.read_bytes()).decode()
            ext = p.suffix.lstrip(".").lower()
            mime = "image/svg+xml" if ext == "svg" else f"image/{'jpeg' if ext in ('jpg', 'jpeg') else ext}"
            img["src"] = f"data:{mime};base64,{b64}"
            n_img += 1
        else:
            print(f"[warn] 图片缺失: {src}", file=sys.stderr)

    # 题注段落（**表 N：…** / **图 N：…** 被渲染成 <p><strong>表 N：…</strong> 余下文</p>）
    n_cap = 0
    for p in soup.find_all("p"):
        st = p.find("strong")
        if st and re.match(r"^(图|表|Figure|Table)\s+[0-9B]+[：:.]", st.get_text(strip=True)):
            p["class"] = p.get("class", []) + ["cap"]
            n_cap += 1

    # 目录
    heads = soup.find_all(["h2", "h3"])
    toc_html = ""
    if heads:
        lis = []
        for h in heads:
            if not h.get("id"):
                continue
            cls = "l3" if h.name == "h3" else "l2"
            lis.append(f'<li class="{cls}"><a href="#{h["id"]}">{h.get_text(strip=True)}</a></li>')
        if lis:
            toc_html = ('<nav class="toc"><div class="toc-t">Contents</div><ul>'
                        + "".join(lis) + "</ul></nav>")

    # 首个 h1 后插入目录
    body = str(soup)
    if toc_html:
        m = re.search(r"</h1>", body)
        if m:
            body = body[:m.end()] + toc_html + body[m.end():]

    doc_title = title or (soup.find("h1").get_text(strip=True) if soup.find("h1") else md_path.stem)
    page = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{doc_title}</title><style>{CSS}</style></head>
<body><div class="page">
{body}
</div></body></html>"""
    return page, {"images_inlined": n_img, "captions": n_cap, "toc_items": len(heads)}


# ---------------------------------------------------------------- DOCX
def _set_run(run, ea=BODY_EA, latin="Calibri", mono=False, bold=None, italic=None,
             size=None, color=None):
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor
    run.font.name = MONO if mono else latin
    rPr = run._element.get_or_add_rPr()
    rf = rPr.find(qn("w:rFonts"))
    if rf is None:
        rf = rPr.makeelement(qn("w:rFonts"), {})
        rPr.append(rf)
    rf.set(qn("w:eastAsia"), ea)
    if mono:
        rf.set(qn("w:ascii"), MONO)
        rf.set(qn("w:hAnsi"), MONO)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if size:
        run.font.size = Pt(size)
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def _inline_runs(par, text: str, base_size=10.5, ea=BODY_EA):
    text = text.replace("<u>", "").replace("</u>", "")
    for tok in INLINE.split(text):
        if not tok:
            continue
        if tok.startswith("**") and tok.endswith("**") and len(tok) > 4:
            _set_run(par.add_run(tok[2:-2]), ea=ea, bold=True, size=base_size)
        elif tok.startswith("`") and tok.endswith("`") and len(tok) > 2:
            r = par.add_run(tok[1:-1])
            _set_run(r, ea=ea, mono=True, size=base_size - 0.5, color="0F4C81")
        elif tok.startswith("[") and "](" in tok:
            label, url = re.match(r"\[([^\]]+)\]\(([^)]+)\)", tok).groups()
            _set_run(par.add_run(label), ea=ea, size=base_size, color="1C4E80")
            if url.startswith("http"):
                _set_run(par.add_run(f" ({url})"), ea=ea, size=base_size - 1, color="1C4E80")
        else:
            _set_run(par.add_run(tok), ea=ea, size=base_size)


def _add_page_number(par):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    r = par.add_run()
    for tag, attr in (("w:fldChar", {"w:fldCharType": "begin"}),
                      ("w:instrText", {"xml:space": "preserve"}),
                      ("w:fldChar", {"w:fldCharType": "end"})):
        el = OxmlElement(tag)
        for k, v in attr.items():
            el.set(qn(k), v)
        if tag == "w:instrText":
            el.text = "PAGE"
        r._r.append(el)


def to_docx(md_path: Path, out: Path, title: str | None) -> dict:
    import docx
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm, Inches, Pt

    blocks = parse_blocks(md_path.read_text(encoding="utf-8-sig"))
    doc = docx.Document()

    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.5)
    sec.top_margin = sec.bottom_margin = Cm(2.4)

    st = doc.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(10.5)
    st.paragraph_format.line_spacing = 1.5
    st.paragraph_format.space_after = Pt(4)

    # 页脚页码
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _add_page_number(fp)

    try:
        from PIL import Image
    except ImportError:
        Image = None

    stats = {"headings": 0, "images": 0, "tables": 0, "captions": 0, "paragraphs": 0}
    usable = Inches(6.0)

    for b in blocks:
        t = b["t"]
        if t == "h":
            lvl = b["lvl"]
            style = {1: "Title", 2: "Heading 1", 3: "Heading 2"}.get(lvl, "Heading 3")
            try:
                par = doc.add_paragraph(style=style)
            except KeyError:
                par = doc.add_paragraph()
            size = {1: 18, 2: 14, 3: 12}.get(lvl, 11)
            _set_run(par.add_run(b["text"]), ea=HEAD_EA, bold=True, size=size,
                     color="111111" if lvl == 1 else "1C4E80" if lvl == 2 else "222222")
            if lvl == 1:
                par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            stats["headings"] += 1
        elif t == "p":
            par = doc.add_paragraph()
            par.paragraph_format.first_line_indent = Pt(0)
            _inline_runs(par, b["text"])
            stats["paragraphs"] += 1
        elif t == "caption":
            par = doc.add_paragraph()
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            par.paragraph_format.space_before = Pt(2)
            par.paragraph_format.space_after = Pt(10)
            _set_run(par.add_run(b["text"]), ea=BODY_EA, size=9, color="666666")
            stats["captions"] += 1
        elif t == "img":
            p_img = (md_path.parent / b["src"]).resolve()
            if not p_img.is_file():
                print(f"[warn] 图片缺失: {b['src']}", file=sys.stderr)
                continue
            width = usable
            if Image is not None:
                try:
                    with Image.open(p_img) as im:
                        w_px = im.width
                    width = min(usable, Inches(w_px / 160.0))
                except Exception:  # noqa: BLE001
                    pass
            par = doc.add_paragraph()
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            par.add_run().add_picture(str(p_img), width=width)
            stats["images"] += 1
        elif t == "table":
            rows = b["rows"]
            ncol = max(len(r) for r in rows)
            tbl = doc.add_table(rows=0, cols=ncol)
            try:
                tbl.style = "Table Grid"
            except KeyError:
                pass
            tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
            for ri, row in enumerate(rows):
                cells = tbl.add_row().cells
                for ci in range(ncol):
                    txt = row[ci] if ci < len(row) else ""
                    cp = cells[ci].paragraphs[0]
                    cp.paragraph_format.line_spacing = 1.15
                    cp.paragraph_format.space_after = Pt(0)
                    if ri == 0:
                        for tok in INLINE.split(strip_tags(txt)):
                            if tok.strip():
                                _set_run(cp.add_run(tok.strip("*").strip("`")),
                                         ea=HEAD_EA, bold=True, size=9)
                    else:
                        _inline_runs(cp, txt, base_size=9)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
            stats["tables"] += 1
        elif t in ("ul", "ol"):
            for it in b["items"]:
                style = "List Bullet" if t == "ul" else "List Number"
                try:
                    par = doc.add_paragraph(style=style)
                except KeyError:
                    par = doc.add_paragraph()
                par.paragraph_format.line_spacing = 1.5
                par.paragraph_format.space_after = Pt(2)
                _inline_runs(par, it)
        elif t == "hr":
            par = doc.add_paragraph()
            par.paragraph_format.space_before = Pt(6)
            par.paragraph_format.space_after = Pt(6)
            from docx.oxml import OxmlElement
            from docx.oxml.ns import qn
            pPr = par._p.get_or_add_pPr()
            bd = OxmlElement("w:pBdr")
            bot = OxmlElement("w:bottom")
            bot.set(qn("w:val"), "single")
            bot.set(qn("w:sz"), "6")
            bot.set(qn("w:color"), "CCCCCC")
            bd.append(bot)
            # OOXML CT_PPr 顺序固定：pBdr 必须排在 spacing/ind 之前，否则 Word 报损坏
            anchor = pPr.find(qn("w:spacing"))
            if anchor is not None:
                anchor.addprevious(bd)
            else:
                pPr.append(bd)

    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    return stats


# ---------------------------------------------------------------- 入口
def run(args: dict) -> dict:
    md_path = Path(args["path"])
    if not md_path.is_file():
        raise FileNotFoundError(f"找不到 {md_path}")
    fmt = (args.get("fmt") or "both").lower()
    title = args.get("title")
    out_arg = args.get("out")
    base = Path(out_arg).with_suffix("") if out_arg else md_path.with_suffix("")

    result = {"source": str(md_path), "title": title, "outputs": {}}
    if fmt in ("html", "both"):
        html, st = to_html(md_path, title)
        p = base.with_suffix(".html")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(html, encoding="utf-8")
        result["outputs"]["html"] = {"path": str(p), "bytes": p.stat().st_size, **st}
    if fmt in ("docx", "both"):
        p = base.with_suffix(".docx")
        st = to_docx(md_path, p, title)
        result["outputs"]["docx"] = {"path": str(p), "bytes": p.stat().st_size, **st}
    return {"ok": True, "result": result}


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": {"code": "E_BAD_INPUT", "message": str(exc)}}))
        return 2
    args = payload.get("args") or {}
    if not args.get("path"):
        print(json.dumps({"ok": False, "error": {"code": "E_ARGS", "message": "需要 args.path"}}))
        return 2
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001 - 工具需回结构化错误
        print(json.dumps({"ok": False, "error": {"code": "E_RUNTIME", "message": str(exc)}},
                         ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
