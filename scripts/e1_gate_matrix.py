#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""E1 — 晋升闸门混淆矩阵。

主张（论文 A §6）：晋升闸门不是文档里的流程，是可执行判定；它必须拦住结构上
「看起来像好技能」但实质违规的样本，而放行真正合格的样本。

做法：造 8 个最小技能目录（6 坏 + 2 好），每个只在一个维度上坏，其余维度与好样本
逐字相同。然后**调用真实闸门函数** `skill_state.promote()` ——不重写判定逻辑，否则
测的是我的规则而不是系统的规则。

隔离：`RSI_LEDGER_DIR` 指向临时目录，快照与账本记录不落真实 `ledger/`。
输出：stdout JSON，含逐例 verdict/reasons 与混淆矩阵。

用法（仓库根）：
    python scripts/e1_gate_matrix.py            # 跑全部 8 例
    python scripts/e1_gate_matrix.py --keep     # 保留临时目录供排查
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

GOOD_SKILL = """---
name: {name}
description: 样例技能，用于验证晋升闸门在结构与证据上的判定是否成立。
origin: user
---

# {name}

## 何时用

收到样例任务时使用。

## 工序

1. 读取输入
2. 产出结果

## 验收

- [ ] 输出含输入关键词
"""

GOOD_CASE = {
    "id": "c1",
    "input": "把这段文本整理成要点",
    "expect": "输出三个要点",
    "rubric": "要点齐全",
    "weight": 1,
    "signal": "assert",
    "source": "样例",
    "check": {"kind": "contains", "value": ["要点"]},
}
GOOD_CONTRACT = {
    "name": "{name}",
    "version": "0.1.0",
    "status": "candidate",
    "description": "样例技能，用于验证晋升闸门在结构与证据上的判定是否成立。",
    "verification": "partial",
    "legacy": False,
}
GOOD_STATE = {
    "skill": "{name}",
    "status": "candidate",
    "verification": "partial",
    "active_version": None,
    "versions": [],
    "last_promoted_at": None,
    "retire_reason": None,
}
GOOD_SCORECARD = {
    "skill": "{name}",
    "version": "0.1.0",
    "summary": {"total": 3, "passed": 3, "decided": 3, "pass_rate": 1.0},
    "regressions": [],
    "degraded": False,
}


def build(root: Path, name: str, *, bad: str | None = None) -> Path:
    """造一个技能目录；bad 指定唯一被破坏的维度。"""
    d = root / name
    (d / "evals" / "results").mkdir(parents=True, exist_ok=True)

    skill_md = GOOD_SKILL.format(name=name)
    cases = [dict(GOOD_CASE, id=f"c{i}") for i in (1, 2, 3)]
    contract = json.loads(json.dumps(GOOD_CONTRACT))
    contract["name"] = name
    state = json.loads(json.dumps(GOOD_STATE))
    state["skill"] = name
    card = json.loads(json.dumps(GOOD_SCORECARD))
    card["skill"] = name

    # ---- 六种坏：每种只在单一维度上坏
    if bad == "no_frontmatter":
        # 结构坏：缺 frontmatter → 连技能都解析不出来
        skill_md = "# " + name + "\n\n没有 frontmatter 的技能文件。\n\n## 验收\n\n- [ ] x\n"
    elif bad == "dir_name_mismatch":
        # 契约坏：目录名与 name 不一致（装进去就会被当另一个技能）
        d = root / (name + "-actual")
        (d / "evals" / "results").mkdir(parents=True, exist_ok=True)
        contract["name"] = name  # frontmatter/契约名 ≠ 目录名
        state["skill"] = name
        card["skill"] = name
    elif bad in ("no_acceptance", "no_acceptance_named"):
        # 质量坏：无验收段。named 变体故意让技能名含 acceptance，
        # 用于探测 ACC_RE 是否被技能名本身喂中（真漏洞）。
        skill_md = ("---\nname: " + name + "\ndescription: 样例技能，用于验证晋升闸门在结构"
                    "与证据上的判定是否成立。\norigin: user\n---\n\n# " + name +
                    "\n\n## 工序\n\n1. 做事\n")
    elif bad == "cases_missing":
        # 证据坏：无案例 → 无决定性证据
        cases = []
    elif bad == "eval_missing":
        # 证据坏：无 scorecard
        card = None
    elif bad == "low_score":
        # 证据坏：总分低于 0.80 门槛
        card["summary"] = {"total": 3, "passed": 1, "decided": 3, "pass_rate": 0.33}
    elif bad == "regression":
        # 证据坏：旧案例退化
        card["regressions"] = ["c1"]
    elif bad == "self_eval_only":
        # 信号坏：案例 signal 只有 judge（= 另一模型/自身评判，非确定性），
        # 政策要求晋升需 E1/E2/E3 外部信号，此处仅提供判定型证据。
        cases = [dict(c, id=f"c{i}", signal="judge") for i, c in enumerate(cases, 1)]

    (d / "SKILL.md").write_text(skill_md, encoding="utf-8")
    if cases:
        (d / "evals" / "cases.jsonl").write_text(
            "\n".join(json.dumps(c, ensure_ascii=False) for c in cases) + "\n", encoding="utf-8")
    (d / "skill.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8")
    (d / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8")
    if card is not None:
        (d / "evals" / "results" / "0.1.0.json").write_text(
            json.dumps(card, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return d


SAMPLE = [
    # (标签, 期望, 坏维度)
    ("good-baseline", "allow", None),
    ("good-tools-no-human", "block", "tools_human"),
    ("bad-no-frontmatter", "block", "no_frontmatter"),
    ("bad-dir-name-mismatch", "block", "dir_name_mismatch"),
    ("bad-no-accept-seg", "block", "no_acceptance"),
    ("probe-name-acceptance", "block", "no_acceptance_named"),
    ("bad-cases-missing", "block", "cases_missing"),
    ("bad-eval-missing", "block", "eval_missing"),
    ("bad-low-score", "block", "low_score"),
    ("bad-regression", "block", "regression"),
    ("bad-self-eval-only", "block", "self_eval_only"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="e1-gate-"))
    os.environ["RSI_LEDGER_DIR"] = str(tmp / "ledger")

    from skill_state import promote  # 真实闸门

    rows = []
    for label, expect, bad in SAMPLE:
        human = bad == "tools_human"
        try:
            d = build(tmp, label, bad=bad)
            if bad == "tools_human":
                # 声明工具层 → 闸门要求人工确认；不带 --human 应拦（这是设计意图）
                (d / "tools.json").write_text(json.dumps([{
                    "name": "sample_tool",
                    "description": "样例工具，用于验证工具层改动需人工确认这一条闸门。",
                    "parameters": {"type": "object", "properties": {}, "required": []},
                    "exec": {"cmd": ["python", "tools/sample.py"]},
                }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                (d / "tools").mkdir(exist_ok=True)
                (d / "tools" / "sample.py").write_text("print('ok')\n", encoding="utf-8")
                res = promote(d, "E2", False)   # 无 --human → 应拦
                no_human_blocked = not res.get("ok")
                # 再验一次带 --human 是否放行，证明拦的是「缺授权」而非「坏技能」
                res2 = promote(d, "E2", True)
                with_human_ok = bool(res2.get("ok"))
                rows_note = {"no_human_blocked": no_human_blocked, "with_human_ok": with_human_ok}
            else:
                res = promote(d, "E2", human)
                rows_note = None
            ok = bool(res.get("ok"))
            reasons = [e.get("code") for e in res.get("errors", [])]
        except Exception as exc:  # noqa: BLE001 - 单例异常不应中断矩阵
            ok, reasons, rows_note = False, [f"EXC:{type(exc).__name__}"], None
        verdict = "allow" if ok else "block"
        row = {
            "sample": label,
            "expect": expect,
            "verdict": verdict,
            "correct": verdict == expect,
            "reasons": reasons,
        }
        if rows_note:
            row["paired"] = rows_note
            row["paired_ok"] = rows_note["no_human_blocked"] and rows_note["with_human_ok"]
        rows.append(row)

    tp = sum(1 for r in rows if r["expect"] == "block" and r["verdict"] == "block")
    fn = sum(1 for r in rows if r["expect"] == "block" and r["verdict"] == "allow")
    fp = sum(1 for r in rows if r["expect"] == "allow" and r["verdict"] == "block")
    tn = sum(1 for r in rows if r["expect"] == "allow" and r["verdict"] == "allow")
    n_bad = tp + fn
    n_good = fp + tn
    out = {
        "ok": True,
        "result": {
            "n": len(rows),
            "matrix": {"tp_block": tp, "fn_leak": fn, "fp_overblock": fp, "tn_allow": tn},
            "block_rate_on_bad": round(tp / n_bad, 4) if n_bad else None,
            "allow_rate_on_good": round(tn / n_good, 4) if n_good else None,
            "accuracy": round((tp + tn) / len(rows), 4),
            "all_correct": tp == n_bad and tn == n_good,
            "rows": rows,
            "ledger_isolated_to": os.environ["RSI_LEDGER_DIR"],
        },
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if not args.keep:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if out["result"]["all_correct"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
