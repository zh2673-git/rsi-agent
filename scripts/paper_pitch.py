#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""paper_pitch — 任务做完了，判断「够不够写成一篇」，并给出可直接采纳的提议（T-15 / I-20261109）。

## 为什么需要它（以及为什么不是「做完了就提议」）

用户的原话是「任务做完自动提议成稿」。但**每个 done 任务都提议一遍是噪音**：
改个错别字也弹「要不要写成论文」，人很快学会无视这条提示——提示一旦被无视，
就永远不会再被看见。

所以先立一道**够厚判据**（可机械检查，不靠感觉）：

| 条件 | 为什么是它 |
|---|---|
| `checks` 至少 1 条且 verdict=pass | 有可复现的验证证据，不是自述 |
| `outcomes.pro` 非空且 ≥80 字 | pro 是给 agent 的专业结论，是论文的原料 |
| 有可复现痕迹：`artifacts` 非空 **或** 有 cmd 型 check | 「怎么验证的」能写进正文 |
| `plan` 完成步数 ≥4 | 工序太少的事，展开不成章节 |

四条**同时**满足才算候选。这是有意的保守：漏掉一个该写的任务，
用户还可以自己开口；而提议太多会让提示本身失去信用。

## 产出形态：一句话选题 + 三个角度 + 明确问

提议不是「要不要写论文」这种空问题，而是把决定成本降到最低：
给出**具体标题**和**三条不同路线**，用户只需说「第二个」或「不用」。

## 用法

    python scripts/paper_pitch.py --task T-20261108-17     # 单任务评估
    python scripts/paper_pitch.py --status done            # 扫全部已完成
    python scripts/paper_pitch.py --task T-... --json

本命令**只评估与提议，不生成论文、不写任何文件**。用户点头后才 load
`deepseek-paper` 技能并把这里的 `evidence_seed` 喂给它的证据账本。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import board as B  # noqa: E402  同源读板

MIN_PRO_CHARS = 80
MIN_DONE_STEPS = 4

# 三个角度的选择依据：不同任务露出不同「最值钱的那一面」。
# 顺序固定，因为它模拟人选题的思考顺序：先问「有没有反直觉的发现」，
# 再问「有没有可对比的方法」，最后才是「能不能当教材」。
ANGLES = {
    "engineering": {
        "name": "工程复盘",
        "when": "有根因定位、有踩坑、有真实故障",
        "skeleton": "背景 → 故障现象 → 根因（分层）→ 修法取舍 → 防复发契约 → 验证数据",
    },
    "comparison": {
        "name": "方法对比",
        "when": "有对照/基线，或与既有做法有明确差异",
        "skeleton": "问题 → 两种做法 → 对照条件 → 数据 → 为什么这版更好",
    },
    "reproducible": {
        "name": "可复现实验",
        "when": "有 cmd 型 checks + 数字结果，别人能照着跑",
        "skeleton": "主张 → 环境 → 可执行步骤 → 观测数字 → 偏差范围",
    },
}


def _evidence(t: dict) -> dict:
    """把任务里的字段整理成「论文证据账本的种子」。

    只搬运，不加工：`deepseek-paper` 的工序 2 要求账本里的每条
    claim 都能追到 artifact，因此这里必须保留原始出处（task id / check id）。
    """
    return {
        "task": t.get("id"),
        "title": t.get("title"),
        "goal": t.get("goal"),
        "pro": (t.get("outcomes") or {}).get("pro"),
        "checks": [
            {"id": c.get("id"), "name": c.get("name"), "kind": c.get("kind"),
             "target": c.get("target"), "status": c.get("status")}
            for c in (t.get("checks") or [])
        ],
        "artifacts": t.get("artifacts") or [],
        "completed_steps": [p.get("step") for p in (t.get("plan") or [])
                            if p.get("status") == "completed"],
        "inspirations": t.get("inspirations") or [],
    }


def assess(t: dict) -> dict:
    """四条判据逐条判定，返回每条的通过情况与理由（不通过也要说清差什么）。"""
    checks = t.get("checks") or []
    passed = [c for c in checks if c.get("status") == "pass"]
    pro = str((t.get("outcomes") or {}).get("pro") or "").strip()
    artifacts = t.get("artifacts") or []
    has_cmd_check = any(c.get("kind") == "cmd" for c in checks)
    done_steps = [p for p in (t.get("plan") or []) if p.get("status") == "completed"]

    verdicts = [
        {
            "id": "verified",
            "ok": bool(passed),
            "detail": f"{len(passed)}/{len(checks)} 条 checks 通过",
        },
        {
            "id": "thick_pro",
            "ok": len(pro) >= MIN_PRO_CHARS,
            "detail": f"outcomes.pro {len(pro)} 字（需 ≥{MIN_PRO_CHARS}）",
        },
        {
            "id": "reproducible",
            "ok": bool(artifacts) or has_cmd_check,
            "detail": f"artifacts {len(artifacts)} 个, cmd 型 check {'有' if has_cmd_check else '无'}",
        },
        {
            "id": "enough_work",
            "ok": len(done_steps) >= MIN_DONE_STEPS,
            "detail": f"完成步骤 {len(done_steps)} 个（需 ≥{MIN_DONE_STEPS}）",
        },
    ]
    ok = all(v["ok"] for v in verdicts)
    return {"eligible": ok, "verdicts": verdicts,
            "missing": [v["detail"] for v in verdicts if not v["ok"]]}


def pick_angles(t: dict) -> list[dict]:
    """按任务特征挑出**可能成立**的角度；挑不出就全给（让人自己判断）。"""
    pro = str((t.get("outcomes") or {}).get("pro") or "")
    checks = t.get("checks") or []
    words = pro + " " + str(t.get("title") or "")

    hits: list[str] = []
    if re.search(r"(根因|真因|故障|事故|踩坑|教训|漂移|回归)", words):
        hits.append("engineering")
    if re.search(r"(对比|基线|相比|优于|取代|替代|vs|beforeafter)", words, re.I):
        hits.append("comparison")
    if any(c.get("kind") == "cmd" for c in checks) and re.search(r"\d", pro):
        hits.append("reproducible")
    return [{"key": k, **ANGLES[k]} for k in (hits or list(ANGLES))]


def pitch(t: dict) -> dict:
    """生成完整提议：一句话选题 + 三个角度 + 明确问要不要写。"""
    a = assess(t)
    title = str(t.get("title") or "")
    # 选题句：去掉「X 轮：」这类内部编号，把「修了什么」提到前面
    topic = re.sub(r"^\s*(?:\[[A-Za-z][\]】]|[A-Za-z]\s*轮[：:、]?|第\s*\d+\s*轮[：:、]?)\s*",
                   "", title).strip()
    return {
        "task": t.get("id"),
        "eligible": a["eligible"],
        "one_line": f"把这个任务写成一篇技术报告：{topic}" if a["eligible"] else "",
        "verdicts": a["verdicts"],
        "missing": a["missing"],
        "angles": pick_angles(t) if a["eligible"] else [],
        "ask": "要不要写？（回复角度编号即可；说「不用」就不再提这个任务）"
               if a["eligible"] else "",
        "evidence_seed": _evidence(t) if a["eligible"] else None,
        "next": "用户点头后 load deepseek-paper，把 evidence_seed 当证据账本骨架"
                if a["eligible"] else "还不够厚；先把上面的 missing 补上",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="任务够不够写成一篇：评估 + 提议（不生成论文）")
    ap.add_argument("--task", default=None)
    ap.add_argument("--status", default=None, help="批量评估某状态，如 done")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    board = B.load()
    tasks = list(board.get("tasks") or [])
    if a.task:
        tasks = [t for t in tasks if str(t.get("id")) == a.task]
        if not tasks:
            print(json.dumps({"ok": False, "error": f"任务不存在: {a.task}"},
                             ensure_ascii=False))
            return 1
    elif a.status:
        tasks = [t for t in tasks if str(t.get("status")) == a.status]

    pitches = [pitch(t) for t in tasks]
    eligible = [p for p in pitches if p["eligible"]]
    out = {
        "ok": True,
        "note": "只评估与提议；不生成论文、不写文件。点头后 load deepseek-paper。",
        "scanned": len(tasks),
        "eligible": len(eligible),
        "pitches": pitches,
    }
    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    print(f"评估 {len(tasks)} 个任务，{len(eligible)} 个够厚\n")
    for p in pitches:
        mark = "✔" if p["eligible"] else "·"
        print(f"{mark} {p['task']}")
        if not p["eligible"]:
            for m in p["missing"]:
                print(f"    差：{m}")
            continue
        print(f"    选题：{p['one_line']}")
        for i, ang in enumerate(p["angles"], 1):
            print(f"    {i}) {ang['name']}（{ang['when']}）")
            print(f"       {ang['skeleton']}")
        print(f"    {p['ask']}")
        print()
    if eligible:
        print("提醒：这些只是提议。用户点头后再 load deepseek-paper，"
              "把该任务的 evidence_seed 当证据账本骨架。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
