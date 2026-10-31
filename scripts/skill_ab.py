"""A/B 对比：同一 suite 的两份 scorecard 逐案例比较，给出晋升/拒绝/保持结论。

设计（docs/07 Phase 3）：
- A = 当前 active（基线），B = candidate；
- 判分盲评：judge 只收 {case, output}，不接收版本标签（run_evals 已保证）；
- 结论规则：出现旧案例退化或分数低于容差 → reject；修复案例 ≥1 且无退化 → promote；
  其余 hold。触发测试门槛见 config [eval].trigger_threshold（需单独跑触发集）。

用法：
    python scripts/skill_ab.py --skill rsi-steward --a 0.1.0 --b 0.2.0
    python scripts/skill_ab.py --skill rsi-steward --a-card a.json --b-card b.json
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import dumps, emit, evidence_dir, load_config, read_json, resolve_skill  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def load_card(skill: str, version: str | None, path: str | None) -> tuple[dict, Path | None]:
    if path:
        p = Path(path)
        return read_json(p), p
    if not version:
        return {}, None
    candidates = [
        evidence_dir() / skill / version / "scorecard.json",
        resolve_skill(skill) / "evals" / "results" / f"{version}.json",
    ]
    for p in candidates:
        if p.is_file():
            return read_json(p), p
    return {}, None


def _cases(card: dict) -> dict:
    return {c["id"]: c for c in (card.get("cases") or []) if c.get("id")}


def compare(skill: str, a_card: dict, b_card: dict, a_path: Path | None, b_path: Path | None) -> dict:
    cfg = load_config()
    tol = float(cfg["ab"].get("tolerance", 0.05))
    min_fixed = int(cfg["ab"].get("min_fixed", 1))
    a_cases, b_cases = _cases(a_card), _cases(b_card)
    ids = sorted(set(a_cases) | set(b_cases))
    diff = []
    for cid in ids:
        a, b = a_cases.get(cid), b_cases.get(cid)
        if not a or not b:
            diff.append({"id": cid, "status": "missing", "a": a, "b": b})
            continue
        if a.get("pass") is None or b.get("pass") is None:
            status = "pending"
        elif a["pass"] and b["pass"]:
            status = "still_passing"
        elif not a["pass"] and b["pass"]:
            status = "fixed"
        elif a["pass"] and not b["pass"]:
            status = "regressed"
        else:
            status = "still_failing"
        diff.append({"id": cid, "status": status,
                     "a": {"pass": a.get("pass"), "score": a.get("score")},
                     "b": {"pass": b.get("pass"), "score": b.get("score")},
                     "reason": b.get("reason")})
    fixed = [d["id"] for d in diff if d["status"] == "fixed"]
    regressed = [d["id"] for d in diff if d["status"] == "regressed"]
    a_rate = float((a_card.get("summary") or {}).get("pass_rate") or 0)
    b_rate = float((b_card.get("summary") or {}).get("pass_rate") or 0)
    b_eligible = bool((b_card.get("promotion") or {}).get("eligible"))
    reasons = []
    if regressed:
        reasons.append(f"旧案例退化: {regressed}")
    if b_rate < a_rate - tol:
        reasons.append(f"B 分数 {b_rate} 低于 A {a_rate} - {tol}")
    if len(fixed) < min_fixed:
        reasons.append(f"修复案例不足: {len(fixed)} < {min_fixed}")
    if not b_eligible:
        reasons.append("B 的 promotion.eligible=false")
    if regressed or b_rate < a_rate - tol:
        verdict = "reject"
    elif fixed and b_eligible:
        verdict = "promote"
    elif b_eligible and b_rate > a_rate:
        verdict = "promote"
    else:
        verdict = "hold"
    if verdict == "hold" and not reasons:
        reasons.append("无可见修复且分数未提升")
    result = {
        "ok": True,
        "skill": skill,
        "a": {"version": a_card.get("version"), "path": str(a_path) if a_path else None,
              "pass_rate": a_rate, "suite": a_card.get("suite")},
        "b": {"version": b_card.get("version"), "path": str(b_path) if b_path else None,
              "pass_rate": b_rate, "suite": b_card.get("suite")},
        "cases": diff,
        "summary": {"total": len(ids), "fixed": len(fixed), "regressed": len(regressed),
                    "still_failing": len([d for d in diff if d["status"] == "still_failing"]),
                    "pending": len([d for d in diff if d["status"] == "pending"])},
        "verdict": verdict,
        "reasons": reasons,
        "blind": "judge 只接收 case/output，不接收版本标签",
        "evaluated_at": _now(),
    }
    if a_card.get("suite") and b_card.get("suite") and a_card["suite"] != b_card["suite"]:
        result["warnings"] = ["A/B 使用了不同 suite，结论不可直接用于晋升"]
        result["verdict"] = "hold"
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="技能 A/B 对比（同 suite、逐案例 diff）")
    ap.add_argument("--skill", required=True, help="技能名或目录")
    ap.add_argument("--a", default=None, help="A（active）版本号")
    ap.add_argument("--b", default=None, help="B（candidate）版本号")
    ap.add_argument("--a-card", default=None, help="直接指定 A 的 scorecard JSON")
    ap.add_argument("--b-card", default=None, help="直接指定 B 的 scorecard JSON")
    ap.add_argument("--out", default=None, help="对比结果路径（默认 ledger/evidence/<skill>/ab/<a>-vs-<b>.json）")
    args = ap.parse_args()

    skill = Path(args.skill).name if Path(args.skill).is_dir() else args.skill
    a_card, a_path = load_card(skill, args.a, args.a_card)
    b_card, b_path = load_card(skill, args.b, args.b_card)
    if not a_card or not b_card:
        emit({"ok": False, "error": {"code": "E_CARD_MISSING",
              "message": "缺少 A/B scorecard（先 run_evals 或传 --a-card/--b-card）"}})
        return 2
    result = compare(skill, a_card, b_card, a_path, b_path)
    if args.out:
        out = Path(args.out)
    else:
        a_v = a_card.get("version") or "A"
        b_v = b_card.get("version") or "B"
        out = evidence_dir() / skill / "ab" / f"{a_v}-vs-{b_v}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dumps(result) + "\n", encoding="utf-8")
    result["out"] = str(out)
    emit(result)
    return 0 if result["verdict"] == "promote" else 1


if __name__ == "__main__":
    raise SystemExit(main())
