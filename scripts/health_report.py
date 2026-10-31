"""月度技能库健康报告（Phase 4）。

汇总：技能状态分布、本月任务与失败、评测分、使用率、退役候选、提案队列。
输出 `ledger/reports/{YYYY-MM}.md` 与 `.json`，供人工复盘或看板引用。

用法：
    python scripts/health_report.py
    python scripts/health_report.py --month 2026-11
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger import load_index  # noqa: E402
from rsi_common import dumps, emit, ledger_dir, load_config, read_json  # noqa: E402
from usage_report import build_report  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _month_of(ts: str | None) -> str:
    return str(ts or "")[:7]


def _proposals() -> list[dict]:
    root = ledger_dir() / "proposals"
    if not root.is_dir():
        return []
    items = []
    for p in sorted(root.glob("*.json")):
        card = read_json(p)
        if card:
            items.append(card)
    return items


def build(month: str) -> dict:
    usage = build_report()
    entries = [e for e in load_index() if _month_of(e.get("created_at")) == month]
    outcomes = {"success": 0, "fail": 0, "partial": 0, "blocked": 0}
    per_skill = {}
    for e in entries:
        outcome = e.get("outcome")
        if outcome in outcomes:
            outcomes[outcome] += 1
        for skill in e.get("skills") or []:
            bucket = per_skill.setdefault(skill, {"uses": 0, "fail": 0})
            bucket["uses"] += 1
            if outcome == "fail":
                bucket["fail"] += 1
    status_counts = {}
    for s in usage["skills"]:
        status_counts[s["status"]] = status_counts.get(s["status"], 0) + 1
    proposals = _proposals()
    prop_status = {k: len([p for p in proposals if p.get("status") == k])
                   for k in ("pending", "approved", "denied")}
    failures = [e for e in entries if e.get("outcome") in ("fail", "partial", "blocked")]
    failures.sort(key=lambda e: e.get("created_at") or "", reverse=True)
    quota_cfg = load_config()["quota"]
    max_active = int(quota_cfg.get("max_active", 8))
    max_total = int(quota_cfg.get("max_total", 20))
    active = status_counts.get("active", 0)
    quota = {
        "max_active": max_active,
        "max_total": max_total,
        "active": active,
        "total": len(usage["skills"]),
        "violated": active > max_active or len(usage["skills"]) > max_total,
    }
    summary = {
        "month": month,
        "skills": len(usage["skills"]),
        "status": status_counts,
        "tasks": len(entries),
        "outcomes": outcomes,
        "retire_candidates": usage["candidates"],
        "proposals": prop_status,
        "quota": quota,
        "top_skills": sorted(per_skill.items(), key=lambda kv: kv[1]["uses"], reverse=True)[:5],
    }
    return {"ok": True, "generated_at": _now(), "summary": summary,
            "skills": usage["skills"], "failures": failures[:10], "proposals": proposals}


def render_markdown(data: dict) -> str:
    s = data["summary"]
    lines = [f"# RSI 技能库健康报告 · {s['month']}", "",
             f"生成于 {data['generated_at']}", "",
             "## 概览", "",
             f"- 技能 {s['skills']} 个：" + "，".join(f"{k} {v}" for k, v in s["status"].items()),
             f"- 本月任务 {s['tasks']} 个：成功 {s['outcomes']['success']}，失败 {s['outcomes']['fail']}，"
             f"部分完成 {s['outcomes']['partial']}，阻塞 {s['outcomes']['blocked']}",
             f"- 退役候选 {len(s['retire_candidates'])} 个：" +
             ("、".join(s["retire_candidates"]) or "无"),
             f"- 提案：待审 {s['proposals']['pending']}，已批准 {s['proposals']['approved']}，"
             f"已拒绝 {s['proposals']['denied']}",
             f"- 配额：active {s['quota']['active']}/{s['quota']['max_active']}，"
             f"总数 {s['quota']['total']}/{s['quota']['max_total']}"
             + ("（已超限，需退役或合并）" if s['quota']['violated'] else ""), "",
             "## 技能明细", "",
             "| 技能 | 状态 | 版本 | 验证 | 使用 | 成功率 | 闲置天 | 评测分 |",
             "|---|---|---|---|---|---|---|---|"]
    for sk in data["skills"]:
        ev = sk["last_eval"]
        rate = "—" if sk["usage"]["success_rate"] is None else sk["usage"]["success_rate"]
        idle = "—" if sk["idle_days"] is None else sk["idle_days"]
        score = "—" if ev["pass_rate"] is None else ev["pass_rate"]
        lines.append(
            f"| {sk['name']} | {sk['status']} | {sk['version']} | {sk['verification']} | "
            f"{sk['usage']['uses']} | {rate} | {idle} | {score} |"
        )
    lines += ["", "## 本月失败", ""]
    if data["failures"]:
        for f in data["failures"]:
            lines.append(f"- `{f.get('work_id')}` {f.get('task')}（{f.get('outcome')}；技能："
                         f"{'、'.join(f.get('skills') or []) or '无'}）")
    else:
        lines.append("- 无")
    lines += ["", "## 提案", ""]
    if data["proposals"]:
        for p in data["proposals"]:
            lines.append(f"- `{p.get('id')}` {p.get('skill')} / {p.get('layer')} / "
                         f"{p.get('status')}：{p.get('summary') or ''}")
    else:
        lines.append("- 无")
    lines += ["", "## 建议", ""]
    if s["retire_candidates"]:
        lines.append(f"- 复核退役候选：{'、'.join(s['retire_candidates'])}（`usage_report.py --apply --yes` 执行）")
    if s["proposals"]["pending"]:
        lines.append(f"- 处理待审提案：{s['proposals']['pending']} 个（`rsi_routine.py queue`）")
    if s["quota"]["violated"]:
        lines.append(f"- 技能库超配额（active {s['quota']['active']}/{s['quota']['max_active']}，"
                     f"总数 {s['quota']['total']}/{s['quota']['max_total']}）：先退役或合并，不自动删除")
    lines.append("- 月度复盘只提出动作，不自动改技能；改动仍走 validate + evals + promote。")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="月度技能库健康报告")
    ap.add_argument("--month", default=datetime.now().strftime("%Y-%m"), help="YYYY-MM")
    args = ap.parse_args()
    data = build(args.month)
    out_dir = ledger_dir() / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    md = out_dir / f"{args.month}.md"
    js = out_dir / f"{args.month}.json"
    md.write_text(render_markdown(data), encoding="utf-8")
    js.write_text(dumps(data) + "\n", encoding="utf-8")
    emit({"ok": True, "month": args.month, "markdown": str(md), "json": str(js),
          "summary": data["summary"]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
