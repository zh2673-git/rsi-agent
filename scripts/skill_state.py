"""技能状态机与证据快照：迁移只走这里，不允许跳步。

命令：
    python scripts/skill_state.py show --name rsi-steward
    python scripts/skill_state.py transition --name rsi-steward --to candidate
    python scripts/skill_state.py snapshot --name rsi-steward
    python scripts/skill_state.py promote --name demo --signal E1 --human
    python scripts/skill_state.py rollback --name demo --version 0.1.0
    python scripts/skill_state.py retire --name demo --reason "连续失败"

晋升判据（docs/04 §6.2）：validate full 通过 + eval 不退化 + E1/E2/E3 外部信号；
legacy 技能与声明了工具的技能必须显式人工确认（--human）。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import (  # noqa: E402
    dumps, emit, evidence_dir, load_config, read_json, resolve_skill,
)
from skillkit import parse_frontmatter, read_state, set_state, validate_skill  # noqa: E402

SIGNAL_TO_LEDGER = {"E1": "user_confirm", "E2": "test", "E3": "real_result"}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _write_contract(skill_dir: Path, patch: dict) -> None:
    path = skill_dir / "skill.json"
    if not path.is_file():
        return
    contract = read_json(path)
    contract.update(patch)
    path.write_text(dumps(contract) + "\n", encoding="utf-8")


def show(skill_dir: Path) -> dict:
    state = read_state(skill_dir)
    contract = state["contract"]
    return {
        "ok": True,
        "skill": skill_dir.name,
        "status": state["status"],
        "verification": state["verification"],
        "legacy": state["legacy"],
        "version": contract.get("version"),
        "state": state["state"],
    }


def snapshot(skill_dir: Path, version: str | None = None) -> dict:
    contract = read_json(skill_dir / "skill.json")
    version = version or contract.get("version") or "0.1.0"
    dest = evidence_dir() / skill_dir.name / version
    dest.mkdir(parents=True, exist_ok=True)
    copied = []
    for rel in ("SKILL.md", "skill.json", "state.json", "tools.json",
                "evals/cases.jsonl", "evals/rubric.md"):
        src = skill_dir / rel
        if src.is_file():
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            copied.append(rel)
    meta = {
        "skill": skill_dir.name,
        "version": version,
        "status": read_state(skill_dir)["status"],
        "created_at": _now(),
        "files": copied,
    }
    (dest / "meta.json").write_text(dumps(meta) + "\n", encoding="utf-8")
    return {"ok": True, "skill": skill_dir.name, "version": version, "path": str(dest), "files": copied}


def transition(skill_dir: Path, dst: str) -> dict:
    result = set_state(skill_dir, dst)
    if result.get("ok"):
        _write_contract(skill_dir, {"status": dst})
    return result


def _eval_gate(skill_dir: Path, version: str) -> dict:
    cfg = load_config()
    path = skill_dir / "evals" / "results" / f"{version}.json"
    if not path.is_file():
        return {"ok": False, "code": "E_EVAL_MISSING", "path": str(path),
                "message": f"缺少 {version} 的评测结果（先跑 run_evals.py）"}
    card = read_json(path)
    summary = card.get("summary") or {}
    reasons = []
    if card.get("regressions"):
        reasons.append(f"旧案例退化: {card['regressions']}")
    if card.get("degraded"):
        reasons.append("总分低于基线")
    if (summary.get("decided") or 0) < int(cfg["lifecycle"].get("min_cases", 3)):
        reasons.append("决定案例不足")
    if float(summary.get("pass_rate") or 0) < float(cfg["eval"].get("pass_threshold", 0.8)):
        reasons.append("总分低于门槛")
    if reasons:
        return {"ok": False, "code": "E_EVAL_GATE", "path": str(path), "message": "; ".join(reasons),
                "pass_rate": summary.get("pass_rate")}
    return {"ok": True, "pass_rate": summary.get("pass_rate"), "path": str(path)}


def promote(skill_dir: Path, signal: str, human: bool) -> dict:
    cfg = load_config()
    allowed = cfg["promotion"].get("external_signals", ["E1", "E2", "E3"])
    state = read_state(skill_dir)
    status = state["status"]
    contract = state["contract"]
    version = contract.get("version") or "0.1.0"
    errors = []

    if status == "active":
        return {"ok": False, "error": {"code": "E_ALREADY_ACTIVE", "message": "技能已是 active"}}
    if status != "candidate":
        errors.append({"code": "E_NOT_CANDIDATE", "path": "state.json",
                       "message": f"只有 candidate 可晋升，当前 {status}（先 transition 到 candidate）"})
    if signal not in allowed:
        errors.append({"code": "E_SIGNAL", "path": "cli", "message": f"晋升信号必须是 {allowed}（E4/E5 不作数）"})

    validation = validate_skill(skill_dir, "full")
    if not validation.get("ok"):
        errors.append({"code": "E_VALIDATE", "path": "SKILL.md", "message": "validate full 未通过",
                       "details": validation.get("errors")})

    gate = _eval_gate(skill_dir, version)
    if not gate["ok"]:
        errors.append({"code": gate["code"], "path": gate["path"], "message": gate.get("message")})

    tools_decl = (parse_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8")) or {}).get("tools")
    risky = bool(tools_decl) or (skill_dir / "tools.json").is_file()
    if state["legacy"] and not human:
        errors.append({"code": "E_LEGACY_HUMAN", "path": "skill.json", "message": "legacy 技能不可自动晋升，需 --human 确认"})
    if risky and not human:
        errors.append({"code": "E_TOOLS_HUMAN", "path": "tools.json", "message": "改工具层需人工确认（--human）"})
    if errors:
        return {"ok": False, "skill": skill_dir.name, "from": status, "errors": errors}

    tr = set_state(skill_dir, "active")
    if not tr.get("ok"):
        return tr
    _write_contract(skill_dir, {"status": "active", "verification": "verified"})

    state_payload = tr["state"]
    versions = list(state_payload.get("versions") or [])
    versions.append({"version": version, "score": gate.get("pass_rate"), "signals": [signal], "at": _now()})
    state_payload.update({"active_version": version, "versions": versions, "last_promoted_at": _now()})
    (skill_dir / "state.json").write_text(dumps(state_payload) + "\n", encoding="utf-8")

    snap = snapshot(skill_dir, version)

    from ledger import append_work  # 同目录脚本，延迟导入避免循环

    record = {
        "task": f"晋升技能 {skill_dir.name} {version}",
        "task_type": "promotion",
        "keywords": [skill_dir.name, "promote", signal],
        "skills": [{"name": skill_dir.name, "version": version}],
        "outcome": "success",
        "signals": [{"type": SIGNAL_TO_LEDGER[signal]}, {"type": "assert", "value": True}],
        "decision": "promote",
        "lessons": [{"type": "decision", "summary": f"{signal} 成立，validate+eval 通过"}],
        "artifacts": [snap["path"], gate["path"]],
    }
    ledger_result = append_work(record)
    return {"ok": True, "skill": skill_dir.name, "from": status, "to": "active",
            "version": version, "signal": signal, "evidence": snap["path"],
            "ledger": ledger_result}


def rollback(skill_dir: Path, version: str) -> dict:
    src = evidence_dir() / skill_dir.name / version
    if not src.is_dir():
        return {"ok": False, "error": {"code": "E_EVIDENCE_MISSING", "path": str(src), "message": "找不到证据快照"}}
    restored = []
    for f in sorted(src.rglob("*")):
        if f.is_file() and f.name != "meta.json":
            rel = f.relative_to(src)
            target = skill_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)
            restored.append(str(rel))
    _write_contract(skill_dir, {"status": "active", "version": version})
    state = read_state(skill_dir)
    payload = dict(state["state"])
    payload.update({"skill": skill_dir.name, "status": "active", "updated_at": _now()})
    (skill_dir / "state.json").write_text(dumps(payload) + "\n", encoding="utf-8")
    from ledger import append_feedback

    fb = append_feedback({"work_id": "", "skill": skill_dir.name, "kind": "rollback",
                          "note": f"回退到 {version}", "created_at": _now()})
    return {"ok": True, "skill": skill_dir.name, "version": version,
            "restored": restored, "state": payload, "feedback": fb}


def retire(skill_dir: Path, reason: str) -> dict:
    tr = set_state(skill_dir, "retired")
    if not tr.get("ok"):
        return tr
    _write_contract(skill_dir, {"status": "retired"})
    state = read_json(skill_dir / "state.json")
    state["retire_reason"] = reason
    (skill_dir / "state.json").write_text(dumps(state) + "\n", encoding="utf-8")
    from ledger import append_feedback

    append_feedback({"work_id": "", "skill": skill_dir.name, "kind": "retire",
                     "note": reason[:200], "created_at": _now()})
    return {"ok": True, "skill": skill_dir.name, "to": "retired", "reason": reason}


def main() -> int:
    ap = argparse.ArgumentParser(description="技能状态机（show/transition/snapshot/promote/rollback/retire）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("show", "snapshot", "transition", "promote", "rollback", "retire"):
        p = sub.add_parser(name)
        p.add_argument("--name", required=True)
        if name == "transition":
            p.add_argument("--to", required=True)
        if name == "snapshot":
            p.add_argument("--version", default=None)
        if name == "promote":
            p.add_argument("--signal", required=True)
            p.add_argument("--human", action="store_true")
        if name == "rollback":
            p.add_argument("--version", required=True)
        if name == "retire":
            p.add_argument("--reason", default="")
    args = ap.parse_args()

    skill_dir = resolve_skill(args.name)
    if not skill_dir.is_dir():
        emit({"ok": False, "error": {"code": "E_SKILL_DIR", "message": f"目录不存在: {skill_dir}"}})
        return 2
    if args.cmd == "show":
        result = show(skill_dir)
    elif args.cmd == "snapshot":
        result = snapshot(skill_dir, args.version)
    elif args.cmd == "transition":
        result = transition(skill_dir, args.to)
    elif args.cmd == "promote":
        result = promote(skill_dir, args.signal, args.human)
    elif args.cmd == "rollback":
        result = rollback(skill_dir, args.version)
    else:
        result = retire(skill_dir, args.reason)
    emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
