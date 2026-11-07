#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""paper_table — 按 DeepSeek 表格规范生成 booktabs LaTeX + Markdown 表。

协议：stdin 收 {"args": {...}}，stdout 回 {"ok": true, "result": {...}}。
args:
  data   必填，表数据文件（templates/05-图表数据.json 的 kind=table 段）或该 JSON 本身
  out    可选，输出 .tex 路径；省略则只返回文本
  fmt    可选，latex|markdown|both（默认 both）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

MISSING = {"", "-", "—", "n/a", "na", None}


def to_num(v):
    try:
        return float(str(v).replace("%", "").replace(",", ""))
    except (TypeError, ValueError):
        return None


def mark_cells(rows: list[list[str]], start_col: int, tol: float,
               best: bool, second: bool) -> tuple[list[list[str]], list[list[str]]]:
    """返回 (latex 单元格, markdown 单元格)。按**行内**比较：同一 benchmark 的不同模型列。"""
    ncol = max((len(r) for r in rows), default=0)
    ltx = [list(r) for r in rows]
    md = [list(r) for r in rows]
    for r, row in enumerate(rows):
        vals = []
        for c in range(start_col, ncol):
            if c < len(row) and str(row[c]) not in MISSING:
                n = to_num(row[c])
                if n is not None:
                    vals.append((n, c))
        if not vals:
            continue
        top = max(v for v, _ in vals)
        distinct = sorted({v for v, _ in vals}, reverse=True)
        for n, c in vals:
            cell = str(row[c])
            is_best = best and abs(n - top) < 1e-9
            # second-best 只在「与 best 差距 > 容差」时才标，避免同档误标
            is_second = (second and not is_best and len(distinct) > 1
                         and abs(n - distinct[1]) < 1e-9
                         and abs(top - n) > tol)
            if is_best:
                ltx[r][c] = "$\\mathbf{%s}$" % cell
                md[r][c] = f"**{cell}**"
            elif is_second:
                ltx[r][c] = "$\\underline{%s}$" % cell
                md[r][c] = f"<u>{cell}</u>"
    return ltx, md


def build_latex(d: dict, ltx_rows: list[list[str]]) -> str:
    cols = d["columns"]
    align = "ll" + "c" * max(0, len(cols) - 2)
    cap = (d.get("caption_lead", "") + " " + d.get("caption_tail", "")).strip()
    out = [
        r"\begin{table}[t]",
        r"\centering",
        r"\caption{%s}" % cap,
        r"\label{tab:%s}" % d.get("id", "main"),
        r"\begin{tabular}{%s}" % align,
        r"\toprule",
        " & ".join(r"\textbf{%s}" % c for c in cols) + r" \\",
        r"\midrule",
    ]
    prev_group = None
    gcol = d.get("group_column")
    for i, row in enumerate(ltx_rows):
        group = row[0] if gcol else None
        if gcol and i > 0 and group and group != prev_group:
            out.append(r"\midrule")
        prev_group = group or prev_group
        cells = ["" if str(c) in MISSING else str(c) for c in row]
        out.append(" & ".join(cells) + r" \\")
    out += [r"\bottomrule", r"\end{tabular}"]
    if d.get("footnotes"):
        out.append(r"\par\vspace{2pt}{\footnotesize %s}" % " ".join(d["footnotes"]))
    out.append(r"\end{table}")
    return "\n".join(out)


def build_md(d: dict, md_rows: list[list[str]]) -> str:
    cols = d["columns"]
    cap = (d.get("caption_lead", "") + " " + d.get("caption_tail", "")).strip()
    lines = [f"**Table: {cap}**", "",
             "| " + " | ".join(cols) + " |",
             "|" + "|".join(["---"] * len(cols)) + "|"]
    for row in md_rows:
        cells = ["" if str(c) in MISSING else str(c) for c in row]
        cells += [""] * (len(cols) - len(cells))
        lines.append("| " + " | ".join(cells) + " |")
    if d.get("footnotes"):
        lines += ["", " ".join(d["footnotes"])]
    return "\n".join(lines)


def run(args: dict) -> dict:
    raw = args.get("data")
    if isinstance(raw, dict):
        d = raw
    else:
        p = Path(str(raw))
        if not p.is_file():
            return {"ok": False, "error": {"code": "E_NO_DATA", "message": f"数据文件不存在: {p}"}}
        d = json.loads(p.read_text(encoding="utf-8"))
    if "table" in d and "columns" not in d:
        d = d["table"]
    rows = d.get("rows") or []
    if not d.get("columns") or not rows:
        return {"ok": False, "error": {"code": "E_SHAPE", "message": "需要 columns 与 rows"}}
    hl = d.get("highlight") or {}
    start = 1 if d.get("group_column") else 0
    # 数据列起点：默认假设「类别列 + benchmark 列」两个标签列；表没有 benchmark 列时必须显式给
    # data_start，否则 best 加粗会落到「越低越好」或非数值列上（如 Gates failed 被加粗成最高分）。
    data_start = d.get("data_start")
    if not isinstance(data_start, int) or data_start < 0:
        data_start = start + 2
    ltx_rows, md_rows = mark_cells(rows, data_start, float(hl.get("tolerance", 0.3)),
                                   hl.get("best", True), hl.get("second", True))
    fmt = (args.get("fmt") or "both").lower()
    latex = build_latex(d, ltx_rows)
    md = build_md(d, md_rows)
    written = None
    if args.get("out"):
        out = Path(args["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(latex + "\n", encoding="utf-8")
        written = str(out)
    return {
        "ok": True,
        "result": {
            "latex": latex if fmt in ("latex", "both") else "",
            "markdown": md if fmt in ("markdown", "both") else "",
            "written": written,
            "rows": len(rows), "cols": len(d["columns"]),
            "caption_ok": bool(d.get("caption_lead")) and bool(d.get("caption_tail")),
        },
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        args = (json.loads(raw) if raw.strip() else {}).get("args") or {}
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": {"code": "E_BAD_INPUT", "message": str(exc)}}))
        return 2
    if not args.get("data"):
        print(json.dumps({"ok": False, "error": {"code": "E_ARGS", "message": "需要 args.data"}}))
        return 2
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": {"code": "E_RUNTIME", "message": str(exc)}},
                         ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
