#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""profile_distill — 从任务看板「提炼」可进画像的结论（T-12 / I-20261108-10 归纳层①）。

## 这条命令解决什么

`profile.py` 的写通道早已完整（`section-add` 覆盖写 / `note` 追加 / 域切换），
但从没有「**内容从哪来**」的答案：记忆靠 agent 在对话里顺手写，于是
「这轮该记什么」全是即兴判断——记得好是运气，记漏了没人发现。

本命令补的是**提议**这一层：扫看板完成任务，产出候选结论（JSON），
再由人或 agent 逐条 `profile.py section-add / note` 落库。

## 为什么默认不自动写（这是设计，不是保守）

画像会进每轮 prompt，写错一条会**持续污染后续所有判断**。而自动提炼必然有
误判率（把一次性细节当长期偏好是最常见的错）。所以：

- `profile_distill` 只输出候选，**永不落库**；
- 每条候选必须带 `source`（任务 id / 灵感 id），可 `board.py link` 反查；
- 落库仍走 `profile.py`，谁的判断谁负责。

## 判据：什么值得进画像

| 层级 | 判据 | 落哪 |
|---|---|---|
| section | 跨任务仍成立（偏好 / 约定 / 模型怪癖 / 环境事实） | `profile.py section-add` |
| note | 单次事件但有复用价值（踩过的坑、验证过的数字） | `profile.py note` |
| 丢弃 | 只对本任务成立（进度、临时路径、一次性的谁做了什么） | 不输出 |

## 怎么用

    python scripts/profile_distill.py --since 2026-11-08          # 看候选
    python scripts/profile_distill.py --task T-20261108-17        # 单任务
    python scripts/profile_distill.py --json > cands.json         # 交给下游确认

输出每条形如：
    {"kind": "note"|"section", "text": "...", "source": "T-...", "why": "命中判据"}
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import board as B  # noqa: E402  与看板 CLI 同源，不重复实现读锁/路径

# ── 判据 ──────────────────────────────────────────────────────────────────────
# 这些模式表示「作者在陈述一条跨任务仍成立的结论」，而不是在报告进度。
# 每条都必须带理由，否则后来的人不知道为什么它在表里。
SECTION_SIGNALS = [
    (re.compile(r"(必须|只能|一律|禁止|永不|总是|从来)"), "强约束措辞：多半是长期纪律"),
    (re.compile(r"(约定|惯例|纪律|规范|原则)"), "自称约定/纪律：跨任务成立"),
    (re.compile(r"(不要|别再|切勿|避免)"), "否定式经验：踩过坑才会这么写"),
    (re.compile(r"(根因|真因|真正的原因|本质是)"), "根因判断：可复用到同类故障"),
]
NOTE_SIGNALS = [
    (re.compile(r"(实测|验证|确认|实测结果)"), "实测结论：有复用价值"),
    (re.compile(r"(教训|坑|事故|踩到)"), "教训：同类任务会再遇到"),
    (re.compile(r"\d+(\.\d+)?\s*(ms|s|行|行数|passed|个)"), "带可复现数字"),
]
# 绝不进画像的东西（安全与噪声）：密钥、绝对路径、纯进度
DENY = [
    re.compile(r"(?i)(api[_-]?key|token|password|secret|bearer)\s*[:=]", re.I),
    re.compile(r"[A-Za-z]:\\\\|/Users/|/home/"),          # 绝对路径
    re.compile(r"^\s*\d+/\d+\s*$"),                        # 纯进度 "4/8"
]


def _sentences(text: str) -> list[str]:
    """按中文/英文句末切句，但别把 `e.g.` `1.5` 切开。"""
    out, buf = [], ""
    for ch in text:
        buf += ch
        if ch in "。！？\n" or (ch == "." and not buf.rstrip().endswith(("e.g.", "i.e.", "etc."))):
            s = buf.strip()
            if len(s) >= 8:
                out.append(s)
            buf = ""
    if len(buf.strip()) >= 8:
        out.append(buf.strip())
    return out


def _fingerprint(s: str) -> str:
    """语义指纹：去掉标点/空白/连接符，用于识别「同一结论的两种写法」。

    为什么不能只比前 60 字（实测踩到）：同一个验证结论会在 `outcomes.pro` 与
    `plan[].step` 里各写一遍，措辞略不同（「A、B、C」vs「A + B + C」），
    前缀去重抓不住，于是候选表里同一件事出现两次，人去确认时白看一遍。
    """
    return re.sub(r"[\s，。、；：,.;:+=+（）()「」『』\-—_/]+", "", s)


def _too_similar(a: str, b: str) -> bool:
    """按字符 2-gram 重合率判「说的是同一件事」。

    为什么不用完全相等：同一结论的两次记录几乎总有一两个词不同
    （「补丁 dry-run」vs「补丁链」），等值判据永远抓不到。
    阈值 0.75 取的经验值：低于它时两条通常真的在讲不同方面（如「根因」与「修法」）。
    """
    def grams(s: str) -> set[str]:
        return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}

    ga, gb = grams(a), grams(b)
    if not ga or not gb:
        return False
    return len(ga & gb) / min(len(ga), len(gb)) >= 0.75


def _denied(s: str) -> bool:
    return any(p.search(s) for p in DENY)


def candidates_from_task(t: dict) -> list[dict]:
    """从一个任务抽出候选结论。来源优先级：outcomes.pro > notes > 已完成步骤。"""
    src = str(t.get("id", ""))
    out: list[dict] = []
    seen: set[str] = set()

    def add(kind: str, text: str, why: str) -> None:
        text = text.strip()
        if len(text) < 10 or _denied(text):
            return
        key = _fingerprint(text)
        if key in seen:
            return
        # 与已收录任一条「说的是同一件事」：保留先出现的（通常来自 pro，信息更全）
        if any(_too_similar(key, k) for k in seen):
            return
        seen.add(key)
        out.append({"kind": kind, "text": text, "source": src, "why": why})

    outcomes = t.get("outcomes") or {}
    # `pro` 是给 agent 看的专业结论，最可能含可复用判断
    for s in _sentences(str(outcomes.get("pro") or "")):
        for pat, why in SECTION_SIGNALS:
            if pat.search(s):
                add("section", s, why)
                break
        else:
            for pat, why in NOTE_SIGNALS:
                if pat.search(s):
                    add("note", s, why)
                    break

    # 已完成步骤里「带结论的」才有价值；「做了什么」没有
    for p in t.get("plan") or []:
        if p.get("status") != "completed":
            continue
        step = str(p.get("step") or "")
        for pat, why in SECTION_SIGNALS:
            if pat.search(step):
                add("section", step, "完成步骤含" + why)
                break
        else:
            for pat, why in NOTE_SIGNALS:
                if pat.search(step):
                    add("note", step, "完成步骤含" + why)
                    break
    return out


def candidates_from_inspiration(i: dict) -> list[dict]:
    """灵感的**原文是用户的话**，只能读、不能改写进画像——
    但「这条灵感被采纳成了什么」是 agent 自己的结论，可以提炼。"""
    out = []
    for t in i.get("tasks") or []:
        pass  # 任务侧已由 candidates_from_task 覆盖，不重复
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="从看板提炼画像候选（只提议，不落库）")
    ap.add_argument("--task", default=None, help="只看某个任务 id")
    ap.add_argument("--since", default=None, help="只看该日期之后更新的任务（YYYY-MM-DD）")
    ap.add_argument("--status", default="done", help="按状态过滤，默认 done；all=不过滤")
    ap.add_argument("--limit", type=int, default=40, help="最多输出多少条候选")
    ap.add_argument("--json", action="store_true", help="只输出 JSON（给下游消费）")
    a = ap.parse_args(argv)

    board = B.load()
    tasks = list(board.get("tasks") or [])
    if a.task:
        tasks = [t for t in tasks if str(t.get("id")) == a.task]
    if a.status and a.status != "all":
        tasks = [t for t in tasks if str(t.get("status")) == a.status]
    if a.since:
        tasks = [t for t in tasks if str(t.get("updated_at", "")) >= a.since]

    cands: list[dict] = []
    for t in tasks:
        cands.extend(candidates_from_task(t))
    cands = cands[: max(1, a.limit)]

    payload = {
        "ok": True,
        "note": "候选仅供确认；落库请用 profile.py section-add / note（本命令不写任何文件）",
        "scanned_tasks": len(tasks),
        "candidates": cands,
        "by_kind": {
            "section": sum(1 for c in cands if c["kind"] == "section"),
            "note": sum(1 for c in cands if c["kind"] == "note"),
        },
    }
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(f"扫描 {len(tasks)} 个任务，得到 {len(cands)} 条候选"
          f"（section {payload['by_kind']['section']} / note {payload['by_kind']['note']}）")
    print("提醒：这些只是**提议**，落库请用 profile.py；本命令不写任何文件。\n")
    for c in cands:
        tag = "SECTION" if c["kind"] == "section" else "note   "
        print(f"[{tag}] {c['source']}  ⟨{c['why']}⟩")
        print(f"         {c['text'][:160]}")
    if not cands:
        print("（没有候选。可能原因：任务 outcomes.pro 为空，或结论里没有可复用措辞）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
