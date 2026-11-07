#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""paper_lint — DeepSeek 文体硬门禁机检（G1-G12）。

协议：stdin 收 {"args": {...}}，stdout 回 {"ok": true, "result": {...}}。
args:
  path    必填，论文正文文件（.md 或 .tex）
  genre   可选，T|M|A|S，默认 T
  ledger  可选，证据账本 JSON（用于 G12 交叉核对）
  strict  可选，true 时任一硬门禁失败即 ok=false（默认 true）
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FORBIDDEN = [
    "to the best of our knowledge",
    "it is well known that",
    "we argue that",
    "we claim",
]
SOTA = re.compile(r"state-of-the-art", re.I)
SOTA_SCOPE = re.compile(r"state-of-the-art[^.]{0,80}\b(among|in|on)\b", re.I)
NUM_ON_BENCH = re.compile(r"\d+(?:\.\d+)?\s*%?\s+(?:absolute\s+)?on\s+[A-Z][\w\-.]*")
GPU_HOURS = re.compile(r"\d+(?:\.\d+)?\s*[KMB]?\s*(?:H800|H100|A100|A800|GPU)\s*hours", re.I)
TOKENS = re.compile(r"\d+(?:\.\d+)?\s*[TBM]\s*(?:tokens|H800\s*GPU\s*hours)", re.I)
SEC_REF = re.compile(r"\(Section\s+(\d+)\)")
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
TEX_SEC = re.compile(r"\\(section|subsection)\*?\{([^}]*)\}")
CAPTION = re.compile(r"^(?:\*\*)?(Figure|Table)\s+(\d+)\s*[:.]", re.I)
CMP_VERB = re.compile(r"\b(outperform\w*|surpass\w*|significantly better)\b", re.I)
STYLE_WORDS = ["remarkably", "notably", "consistently", "meticulously", "substantial",
               "impressive", "top-tier", "Firstly", "Secondly", "Furthermore", "Moreover"]


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def sections(text: str) -> list[tuple[int, str]]:
    out = []
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            out.append((len(m.group(1)), m.group(2).strip()))
        else:
            m = TEX_SEC.search(line)
            if m:
                out.append((1 if m.group(1) == "section" else 2, m.group(2).strip()))
    return out


def slice_section(text: str, name_pat: str, level_max: int = 2) -> str:
    lines = text.splitlines()
    start, lvl = None, None
    for i, line in enumerate(lines):
        m = HEADING.match(line)
        if not m:
            continue
        if re.search(name_pat, m.group(2), re.I) and len(m.group(1)) <= level_max:
            start, lvl = i + 1, len(m.group(1))
            break
    if start is None:
        return ""
    out = []
    for line in lines[start:]:
        m = HEADING.match(line)
        if m and len(m.group(1)) <= lvl:
            break
        out.append(line)
    return "\n".join(out)


def sentences(s: str) -> int:
    return len([x for x in re.split(r"(?<=[.!?])\s+", s.strip()) if x.strip()])


def gate(gid: str, ok: bool, detail: str) -> dict:
    return {"id": gid, "pass": bool(ok), "detail": detail}


def run(args: dict) -> dict:
    path = Path(args["path"])
    if not path.is_file():
        return {"ok": False, "error": {"code": "E_NO_FILE", "message": f"文件不存在: {path}"}}
    genre = (args.get("genre") or "T").upper()
    text = load_text(path)
    low = text.lower()
    abstract = slice_section(text, r"abstract|摘要") or text[:3000]
    intro = slice_section(text, r"introduction|引言|背景") or text[:6000]
    secs = sections(text)
    body_no_caption = "\n".join(l for l in text.splitlines() if not CAPTION.match(l.strip()))
    gates: list[dict] = []

    # G1 摘要 ≥2 处 分数 on benchmark
    hits = NUM_ON_BENCH.findall(abstract)
    gates.append(gate("G1", len(hits) >= 2, f"摘要内『分数 on benchmark』{len(hits)} 处（需≥2）"))

    # G2 参数量成对
    has_total = "total parameters" in low or "总参数" in text
    has_act = bool(re.search(r"activat(ed|ion)", low)) or "激活参数" in text
    gates.append(gate("G2", has_total and has_act,
                      f"total parameters={has_total}, activated={has_act}"))

    # G3 成本 + 数据量
    g3a = bool(GPU_HOURS.search(text))
    g3b = bool(re.search(r"\d+(?:\.\d+)?\s*[TBM]\s*tokens", text, re.I))
    gates.append(gate("G3", g3a and g3b, f"GPU hours={g3a}, tokens={g3b}"))

    # G4 末句开源/链接
    tail = " ".join(re.split(r"(?<=[.!?])\s+", abstract.strip())[-2:]).lower()
    g4 = any(k in tail for k in ("github.com", "huggingface.co", "open-source", "open source",
                                 "release", "available at", "开源"))
    gates.append(gate("G4", g4, f"摘要末句含开源/链接={g4}"))

    # G5 贡献分组 + bullet
    marker = re.search(r"our main contribution includes:|our contributions are summarized as follows:",
                       low)
    groups, bullets = 0, 0
    if marker:
        block = text[marker.end(): marker.end() + 2500].splitlines()
        for line in block:
            s = line.strip()
            if not s:
                continue
            if re.match(r"^([-*•]|\d+\.)\s+", s):
                bullets += 1
            elif len(s) < 90 and ":" in s and not s.startswith(("Note", "We ", "In ")):
                # DeepSeek 分组小标题形如「阶段名: 目标口号」
                groups += 1
    gates.append(gate("G5", bool(marker) and bullets >= 2 and 2 <= groups <= 8,
                      f"标记={bool(marker)}, 分组={groups}(需2-8，形如『阶段: 口号』), bullet={bullets}"))

    # G6 章节导览 + (Section N) ≥3 且与实章一致
    nav = "in the remainder of this paper" in low
    refs = [int(x) for x in SEC_REF.findall(text)]
    max_sec = 0
    for lvl, name in secs:
        m = re.match(r"(\d+)(?:\.\d+)*\s", name + " ")
        if m and lvl <= 2:
            max_sec = max(max_sec, int(m.group(1)))
    g6 = nav and len(refs) >= 3 and (max_sec == 0 or max(refs) <= max_sec)
    gates.append(gate("G6", g6, f"导览段={nav}, Section 引用={len(refs)}次, 最大章号={max_sec}, 引用最大={max(refs) if refs else 0}"))

    # G7 Related Work / Limitations
    top_names = [n for lvl, n in secs if lvl <= 2]
    rw = [n for n in top_names if re.search(r"related work|相关工作", n, re.I)]
    concl = slice_section(text, r"conclusion|结论") or ""
    has_lim = bool(re.search(r"limitation", concl + text, re.I))
    g7 = (genre == "A" or not rw) and has_lim
    gates.append(gate("G7", g7, f"独立RelatedWork={rw or '无'}, Limitations={has_lim}, 体裁={genre}"))

    # G8 caption 三件套
    figs, tabs, bad_fig, good_tab = [], [], [], 0
    for line in text.splitlines():
        m = CAPTION.match(line.strip())
        if not m:
            continue
        cap = line.strip()
        if m.group(1).lower() == "figure":
            figs.append(m.group(2))
            if sentences(cap) < 2:
                bad_fig.append(m.group(2))
        else:
            tabs.append(m.group(2))
            if re.search(r"bold|same level|internal framework|加粗|同档", cap, re.I):
                good_tab += 1
    g8 = (not bad_fig) and (not tabs or good_tab >= 1)
    gates.append(gate("G8", g8,
                      f"图{len(figs)}张(短caption:{bad_fig or '无'}), 表{len(tabs)}个(带口径声明:{good_tab})"))

    # G9 失败申报 + 成本澄清
    fail_sig = any(k in low for k in ("unsuccessful", "does not", "did not", "fail", "无效", "失败"))
    cost_note = "aforementioned costs include only" in low or "note that the aforementioned" in low
    gates.append(gate("G9", fail_sig and cost_note,
                      f"失败申报={fail_sig}, 成本口径澄清={cost_note}"))

    # G10 禁用词 + 裸 SOTA
    bad = [w for w in FORBIDDEN if w in low] + (["novel"] if re.search(r"\bnovel\b", low) else [])
    sota_all = len(SOTA.findall(text))
    sota_scoped = len(SOTA_SCOPE.findall(text))
    g10 = not bad and sota_all == sota_scoped
    gates.append(gate("G10", g10,
                      f"禁用词={bad or '无'}, SOTA {sota_all} 处/带范围 {sota_scoped} 处"))

    # G11 图表被正文引用
    orphan = [f"Figure {i}" for i in figs if f"Figure {i}" not in body_no_caption]
    orphan += [f"Table {i}" for i in tabs if f"Table {i}" not in body_no_caption]
    gates.append(gate("G11", not orphan, f"未被正文引用: {orphan or '无'}"))

    # G12 比较级断言 vs 账本 compare 证据
    cmps = len(CMP_VERB.findall(text))
    if args.get("ledger"):
        try:
            led = json.loads(Path(args["ledger"]).read_text(encoding="utf-8"))
            ev = led.get("paper", {}).get("evidence", []) if "paper" in led else led.get("evidence", [])
            ncmp = len([e for e in ev if str(e.get("kind")) == "compare" and e.get("status") == "ok"])
        except (OSError, ValueError):
            ncmp = 0
        g12 = cmps <= ncmp
        detail = f"比较级断言 {cmps} 处, 账本 compare 证据 {ncmp} 条"
    else:
        g12 = True
        detail = f"比较级断言 {cmps} 处（未提供账本，跳过核对）"
    gates.append(gate("G12", g12, detail))

    style = {w: len(re.findall(re.escape(w), text, re.I)) for w in STYLE_WORDS}
    failed = [g["id"] for g in gates if not g["pass"]]
    strict = args.get("strict", True)
    return {
        "ok": True,
        "result": {
            "file": str(path),
            "genre": genre,
            "chars": len(text),
            "sections": [f"{lvl}:{n}" for lvl, n in secs][:30],
            "gates": gates,
            "failed": failed,
            "verdict": "PASS" if not failed else "FAIL",
            "style_fingerprint": style,
            "_strict": strict,
        },
    }


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
