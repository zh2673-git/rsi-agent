"""技能使用率与退役候选（Phase 3）。

数据来源：账本轻索引（work）+ 技能目录 state.json + 最近一次评测结果。
退役只是候选；`--apply` 必须同时给 `--yes`，批量退役前请先看输出。
退役可恢复：`skill_state.py transition --name X --to draft`。

用法：
    python scripts/usage_report.py
    python scripts/usage_report.py --apply --yes
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger import load_index  # noqa: E402
from rsi_common import RSI_ROOT, emit, load_config, read_json  # noqa: E402
from skillkit import read_state  # noqa: E402

import os  # noqa: E402


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts))
        return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _skills_root() -> Path:
    return Path(os.environ.get("SKILLS_DIR") or (RSI_ROOT / "skills"))


def _latest_card(skill_dir: Path) -> dict:
    results = skill_dir / "evals" / "results"
    if not results.is_dir():
        return {}
    files = sorted(results.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return read_json(files[0]) if files else {}


def _usage(entries: list[dict], name: str) -> dict:
    rows = [e for e in entries if name in (e.get("skills") or [])]
    rows.sort(key=lambda e: e.get("created_at") or "")
    outcome_counts = {"success": 0, "fail": 0, "partial": 0, "blocked": 0}
    for e in rows:
        outcome = e.get("outcome")
        if outcome in outcome_counts:
            outcome_counts[outcome] += 1
    streak = 0
    for e in reversed(rows):
        if e.get("outcome") == "fail":
            streak += 1
        else:
            break
    uses = len(rows)
    success_rate = round(outcome_counts["success"] / uses, 4) if uses else None
    last_used = rows[-1].get("created_at") if rows else None
    return {
        "uses": uses,
        "outcomes": outcome_counts,
        "success_rate": success_rate,
        "fail_streak": streak,
        "last_used": last_used,
        "last_task": rows[-1].get("task") if rows else None,
    }


def build_report() -> dict:
    cfg = load_config()["retire"]
    entries = load_index()
    now = _now()
    skills = []
    for skill_dir in sorted(p for p in _skills_root().iterdir() if p.is_dir()):
        state = read_state(skill_dir)
        contract = state["contract"]
        usage = _usage(entries, skill_dir.name)
        card = _latest_card(skill_dir)
        last_eval = {
            "version": card.get("version"),
            "pass_rate": (card.get("summary") or {}).get("pass_rate"),
            "promotion_eligible": (card.get("promotion") or {}).get("eligible"),
            "evaluated_at": card.get("evaluated_at"),
            "regressions": card.get("regressions") or [],
        }
        ref = _parse(usage["last_used"]) or _parse(contract.get("created_at"))
        idle_days = round((now - ref).days, 1) if ref else None
        reasons = []
        if state["status"] == "active":
            if (usage["uses"] >= int(cfg.get("min_uses", 5))
                    and usage["success_rate"] is not None
                    and usage["success_rate"] < float(cfg.get("min_success_rate", 0.5))):
                reasons.append(f"成功率 {usage['success_rate']} 低于 {cfg.get('min_success_rate')}（{usage['uses']} 次使用）")
            if idle_days is not None and idle_days >= float(cfg.get("idle_days", 30)):
                reasons.append(f"闲置 {idle_days} 天 ≥ {cfg.get('idle_days')} 天")
            if usage["fail_streak"] >= int(cfg.get("fail_streak", 2)):
                reasons.append(f"连续失败 {usage['fail_streak']} 次 ≥ {cfg.get('fail_streak')}")
            if last_eval["regressions"]:
                reasons.append(f"评测旧案例退化: {last_eval['regressions']}")
        skills.append({
            "name": skill_dir.name,
            "status": state["status"],
            "verification": state["verification"],
            "legacy": state["legacy"],
            "version": contract.get("version"),
            "usage": usage,
            "idle_days": idle_days,
            "last_eval": last_eval,
            "retire_candidate": bool(reasons),
            "retire_reasons": reasons,
        })
    candidates = [s for s in skills if s["retire_candidate"]]
    return {
        "ok": True,
        "generated_at": _now().astimezone().isoformat(timespec="seconds"),
        "skills": skills,
        "summary": {
            "total": len(skills),
            "active": len([s for s in skills if s["status"] == "active"]),
            "retire_candidates": len(candidates),
        },
        "candidates": [s["name"] for s in candidates],
        "recoverable": "退役后可用 skill_state.py transition --to draft 恢复",
    }


def apply_retire(result: dict) -> dict:
    from skill_state import retire

    applied, failed = [], []
    for s in result["skills"]:
        if not s["retire_candidate"]:
            continue
        out = retire(_skills_root() / s["name"], "; ".join(s["retire_reasons"]))
        (applied if out.get("ok") else failed).append(
            {"skill": s["name"], "result": out if out.get("ok") else out.get("errors") or out})
    return {"ok": not failed, "applied": applied, "failed": failed}


def main() -> int:
    ap = argparse.ArgumentParser(description="技能使用率与退役候选")
    ap.add_argument("--apply", action="store_true", help="对候选执行退役")
    ap.add_argument("--yes", action="store_true", help="确认批量退役（--apply 必带）")
    args = ap.parse_args()

    result = build_report()
    if args.apply:
        if not args.yes:
            result["ok"] = False
            result["error"] = {"code": "E_CONFIRM", "message": "批量退役需 --apply --yes"}
            emit(result)
            return 2
        result["retire"] = apply_retire(result)
        if not result["retire"]["ok"]:
            result["ok"] = False
    emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
