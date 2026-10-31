"""例行 RSI：外部信号扫描 → 复盘提案 → 审批队列（Phase 4）。

触发条件（config [review] 与 [retire]）：
- user_correction：用户修正（E1），最近 correction_days 天；
- consecutive_failures：同一技能连续失败 ≥ fail_streak 次（E3）；
- eval_regression：最近评测出现旧案例退化 / 分数低于基线（E2）；
- periodic：超过 interval_days 未扫描（E5，仅提醒，不构成晋升证据）。

提案分层：`knowledge`（SKILL.md/references/evals）可凭 E1/E2/E3 + eval 通过自动批准；
`tools` / `core` 必须 `approve --human`。批准只授权修改，实际改技能仍走
creat-skill → skill_validate → run_evals → skill_state promote。

用法：
    python scripts/rsi_routine.py scan --auto-propose
    python scripts/rsi_routine.py queue
    python scripts/rsi_routine.py approve --id prop-xxx
    python scripts/rsi_routine.py approve --id prop-xxx --human
    python scripts/rsi_routine.py deny --id prop-xxx --reason "证据不足"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger import load_index  # noqa: E402
from rsi_common import RSI_ROOT, dumps, emit, evidence_dir, ledger_dir, load_config, read_json  # noqa: E402
from skillkit import parse_frontmatter, read_state  # noqa: E402

SIGNAL_BY_KIND = {
    "user_correction": "E1",
    "eval_regression": "E2",
    "consecutive_failures": "E3",
    "periodic": "E5",
    "quota": "E5",
}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


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


def _events_path() -> Path:
    return ledger_dir() / "review" / "events.jsonl"


def _append_event(event: dict) -> None:
    path = _events_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": _now(), **event}, ensure_ascii=False) + "\n")


def _last_scan_at() -> datetime | None:
    path = _events_path()
    last = None
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if item.get("event") == "scan":
                last = item
    return _parse(last.get("at")) if last else None


def _layer(skill_dir: Path) -> str:
    meta = parse_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8")) or {}
    if (meta.get("tools") or "").strip() or (skill_dir / "tools.json").is_file():
        return "tools"
    return "knowledge"


def _latest_card(skill_dir: Path) -> dict:
    results = skill_dir / "evals" / "results"
    if not results.is_dir():
        return {}
    files = sorted(results.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return read_json(files[0]) if files else {}


def _trailing_failures(entries: list[dict], skill: str) -> int:
    rows = [e for e in entries if skill in (e.get("skills") or [])]
    rows.sort(key=lambda e: e.get("created_at") or "")
    streak = 0
    for e in reversed(rows):
        if e.get("outcome") == "fail":
            streak += 1
        else:
            break
    return streak


def scan(now: datetime | None = None) -> dict:
    cfg = load_config()
    review = cfg["review"]
    lookback = int(review.get("lookback_days", 30))
    correction_days = int(review.get("correction_days", 7))
    interval = int(review.get("interval_days", 30))
    fail_streak = int(cfg["retire"].get("fail_streak", 2))
    now = now or datetime.now(timezone.utc)
    horizon = now.timestamp() - lookback * 86400
    entries = load_index()
    triggers = []

    for entry in entries:
        ts = _parse(entry.get("created_at"))
        if not ts or ts.timestamp() < horizon:
            continue
        signals = entry.get("signals") or []
        if "user_correction" in signals:
            for skill in entry.get("skills") or []:
                triggers.append({
                    "kind": "user_correction", "skill": skill, "signal": "E1",
                    "work_id": entry.get("work_id"), "task": entry.get("task"),
                    "detail": "用户修正了输出",
                })

    skill_dirs = sorted(p for p in _skills_root().iterdir() if p.is_dir())
    active_count = 0
    for skill_dir in skill_dirs:
        if read_state(skill_dir)["status"] == "active":
            active_count += 1
        streak = _trailing_failures(entries, skill_dir.name)
        if streak >= fail_streak:
            triggers.append({"kind": "consecutive_failures", "skill": skill_dir.name,
                             "signal": "E3", "detail": f"连续失败 {streak} 次"})
        card = _latest_card(skill_dir)
        if card and (card.get("regressions") or card.get("degraded")):
            triggers.append({"kind": "eval_regression", "skill": skill_dir.name,
                             "signal": "E2",
                             "detail": f"退化案例: {card.get('regressions') or '总分低于基线'}"})

    quota_cfg = cfg["quota"]
    max_active = int(quota_cfg.get("max_active", 8))
    max_total = int(quota_cfg.get("max_total", 20))
    if active_count > max_active or len(skill_dirs) > max_total:
        triggers.append({
            "kind": "quota", "skill": "global", "signal": "E5",
            "detail": f"技能库超配额：active {active_count}/{max_active}，总数 {len(skill_dirs)}/{max_total}",
        })

    corrections = [t for t in triggers if t["kind"] == "user_correction"]
    # 用户修正只保留最近 correction_days 的记录
    recent = []
    for t in corrections:
        matched = next((e for e in entries if e.get("work_id") == t.get("work_id")), None)
        ts = _parse(matched.get("created_at")) if matched else None
        if ts and (now - ts).days <= correction_days:
            recent.append(t)
    if recent:
        triggers = [t for t in triggers if t["kind"] != "user_correction"] + recent

    last = _last_scan_at()
    if last is None or (now - last).days >= interval:
        triggers.append({"kind": "periodic", "skill": "global", "signal": "E5",
                         "detail": f"距上次复盘 ≥ {interval} 天"})

    result = {"ok": True, "scanned_at": _now(), "lookback_days": lookback,
              "triggers": triggers, "count": len(triggers)}
    _append_event({"event": "scan", "triggers": triggers, "count": len(triggers)})
    return result


def _proposal_id(trigger: dict, now: datetime | None = None) -> str:
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d")
    return f"prop-{trigger['skill']}-{trigger['kind']}-{stamp}"


def _rollback_point(skill: str) -> str | None:
    ev = evidence_dir() / skill
    if not ev.is_dir():
        return None
    candidates = [p for p in ev.iterdir() if p.is_dir() and p.name != "ab"]
    if not candidates:
        return None
    return str(sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0])


def propose(trigger: dict) -> dict:
    skill = trigger["skill"]
    pid = trigger.get("id") or _proposal_id(trigger)
    path = ledger_dir() / "proposals" / f"{pid}.json"
    if path.is_file():
        return read_json(path)
    layer = "knowledge"
    skill_dir = _skills_root() / skill
    if skill_dir.is_dir():
        layer = _layer(skill_dir)
    cfg = load_config()
    card = _latest_card(skill_dir) if skill_dir.is_dir() else {}
    scorecard = ""
    if card.get("version"):
        scorecard = str(skill_dir / "evals" / "results" / f"{card['version']}.json")
    proposal = {
        "id": pid,
        "skill": skill,
        "kind": trigger.get("kind"),
        "layer": layer,
        "signal": trigger.get("signal") or SIGNAL_BY_KIND.get(trigger.get("kind"), "E5"),
        "status": "pending",
        "requires_human": layer in ("tools", "core") or trigger.get("signal") not in cfg["promotion"]["external_signals"],
        "summary": trigger.get("detail"),
        "work_id": trigger.get("work_id"),
        "baseline": str(ledger_dir() / "baseline.json"),
        "scorecard": scorecard,
        "rollback_point": _rollback_point(skill),
        "created_at": _now(),
        "events": [{"status": "pending", "at": _now()}],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(proposal) + "\n", encoding="utf-8")
    _append_event({"event": "propose", "id": pid, "skill": skill, "layer": layer})
    return proposal


def _load_proposal(pid: str) -> tuple[dict, Path]:
    path = ledger_dir() / "proposals" / f"{pid}.json"
    return read_json(path), path


def approve(pid: str, human: bool) -> dict:
    card, path = _load_proposal(pid)
    if not card:
        return {"ok": False, "error": {"code": "E_PROPOSAL", "message": f"提案不存在: {pid}"}}
    if card.get("status") != "pending":
        return {"ok": False, "error": {"code": "E_PROPOSAL_STATE",
                "message": f"提案状态 {card.get('status')}，只有 pending 可审批"}}
    cfg = load_config()
    external = cfg["promotion"]["external_signals"]
    reasons = []
    if card.get("layer") in ("tools", "core") and not human:
        reasons.append("工具/核心层需人工确认（--human）")
    if card.get("signal") not in external and not human:
        reasons.append(f"无外部信号（{card.get('signal')}），需 --human 显式确认")
    scorecard_path = Path(card.get("scorecard") or "")
    sc = read_json(scorecard_path)
    if card.get("layer") == "knowledge" and card.get("signal") in external:
        if not sc:
            reasons.append("缺少 scorecard（先 run_evals）")
        elif not (sc.get("promotion") or {}).get("eligible"):
            reasons.append("scorecard promotion.eligible=false")
    if reasons:
        return {"ok": False, "id": pid, "errors": [{"code": "E_APPROVAL", "message": r} for r in reasons]}
    card["status"] = "approved"
    card.setdefault("events", []).append({"status": "approved", "at": _now(), "human": human})
    path.write_text(dumps(card) + "\n", encoding="utf-8")
    _append_event({"event": "approve", "id": pid, "skill": card.get("skill"), "human": human})
    return {"ok": True, "id": pid, "skill": card.get("skill"), "layer": card.get("layer"),
            "status": "approved", "advance": "下一步：creat-skill 改技能 → validate → run_evals → promote"}


def deny(pid: str, reason: str) -> dict:
    card, path = _load_proposal(pid)
    if not card:
        return {"ok": False, "error": {"code": "E_PROPOSAL", "message": f"提案不存在: {pid}"}}
    card["status"] = "denied"
    card["deny_reason"] = reason
    card.setdefault("events", []).append({"status": "denied", "at": _now(), "reason": reason})
    path.write_text(dumps(card) + "\n", encoding="utf-8")
    _append_event({"event": "deny", "id": pid, "skill": card.get("skill"), "reason": reason})
    return {"ok": True, "id": pid, "status": "denied"}


def queue() -> dict:
    root = ledger_dir() / "proposals"
    items = []
    if root.is_dir():
        for p in sorted(root.glob("*.json")):
            card = read_json(p)
            if card:
                items.append({k: card.get(k) for k in
                              ("id", "skill", "kind", "layer", "signal", "status", "summary", "created_at")})
    pending = [i for i in items if i["status"] == "pending"]
    return {"ok": True, "count": len(items), "pending": len(pending), "items": items}


def main() -> int:
    ap = argparse.ArgumentParser(description="例行 RSI：扫描触发、提案、审批")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_scan = sub.add_parser("scan")
    p_scan.add_argument("--auto-propose", action="store_true", help="为 E1/E2/E3 触发自动建提案")
    p_propose = sub.add_parser("propose")
    p_propose.add_argument("--skill", required=True)
    p_propose.add_argument("--kind", required=True, choices=sorted(SIGNAL_BY_KIND))
    p_propose.add_argument("--detail", default="")
    p_approve = sub.add_parser("approve")
    p_approve.add_argument("--id", required=True)
    p_approve.add_argument("--human", action="store_true")
    p_deny = sub.add_parser("deny")
    p_deny.add_argument("--id", required=True)
    p_deny.add_argument("--reason", default="")
    sub.add_parser("queue")
    args = ap.parse_args()

    if args.cmd == "scan":
        result = scan()
        if args.auto_propose:
            created = []
            for t in result["triggers"]:
                if t.get("signal") in ("E1", "E2", "E3"):
                    created.append(propose(t)["id"])
            result["proposed"] = created
    elif args.cmd == "propose":
        result = propose({"skill": args.skill, "kind": args.kind,
                          "signal": SIGNAL_BY_KIND[args.kind], "detail": args.detail})
    elif args.cmd == "approve":
        result = approve(args.id, args.human)
    elif args.cmd == "deny":
        result = deny(args.id, args.reason)
    else:
        result = queue()
    emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
