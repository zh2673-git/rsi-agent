"""只读看板：技能状态 / 分数 / 使用率 / 最近失败 / 待审提案（Phase 3）。

生成静态 HTML（标准库 only），数据全部来自账本与技能目录，不启动服务、不写技能。
默认输出 `rsi-agent/dashboard/index.html`。

用法：
    python scripts/dashboard.py
    python scripts/dashboard.py --out outputs/rsi-dashboard.html
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger import load_index  # noqa: E402
from rsi_common import RSI_ROOT, dumps, ledger_dir, read_json  # noqa: E402
from usage_report import build_report  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _esc(value) -> str:
    return html.escape("—" if value is None else str(value))


def _recent_failures(limit: int = 10) -> list[dict]:
    rows = [e for e in load_index() if e.get("outcome") in ("fail", "partial", "blocked")]
    rows.sort(key=lambda e: e.get("created_at") or "", reverse=True)
    return rows[:limit]


def _proposals() -> list[dict]:
    root = ledger_dir() / "proposals"
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.glob("*.json")):
        card = read_json(p)
        if card:
            out.append(card)
    return out


def _last_scan() -> dict:
    path = ledger_dir() / "review" / "events.jsonl"
    last = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                last = json.loads(line)
            except ValueError:
                continue
    return last


def _skill_rows(report: dict) -> str:
    rows = []
    for s in report["skills"]:
        ev = s["last_eval"]
        usage = s["usage"]
        badge = "warn" if s["retire_candidate"] else s["status"]
        rows.append(
            "<tr>"
            f"<td>{_esc(s['name'])}</td>"
            f"<td><span class='badge {badge}'>{_esc(s['status'])}</span></td>"
            f"<td>{_esc(s['version'])}</td>"
            f"<td>{_esc(s['verification'])}</td>"
            f"<td>{'是' if s['legacy'] else '否'}</td>"
            f"<td>{_esc(usage['uses'])}</td>"
            f"<td>{_esc(usage['success_rate'])}</td>"
            f"<td>{_esc(s['idle_days'])}</td>"
            f"<td>{_esc(ev['pass_rate'])}</td>"
            f"<td>{_esc(ev['version'])}</td>"
            f"<td>{_esc('; '.join(s['retire_reasons']) or '—')}</td>"
            "</tr>"
        )
    return "\n".join(rows)


def _failure_rows(failures: list[dict]) -> str:
    if not failures:
        return "<tr><td colspan='4'>暂无失败记录</td></tr>"
    out = []
    for e in failures:
        out.append(
            "<tr>"
            f"<td>{_esc(e.get('created_at'))}</td>"
            f"<td>{_esc(e.get('outcome'))}</td>"
            f"<td>{_esc(e.get('task'))}</td>"
            f"<td>{_esc(', '.join(e.get('skills') or []))}</td>"
            "</tr>"
        )
    return "\n".join(out)


def _proposal_rows(proposals: list[dict]) -> str:
    if not proposals:
        return "<tr><td colspan='5'>暂无提案</td></tr>"
    out = []
    for p in proposals:
        out.append(
            "<tr>"
            f"<td>{_esc(p.get('id'))}</td>"
            f"<td>{_esc(p.get('skill'))}</td>"
            f"<td>{_esc(p.get('layer'))}</td>"
            f"<td><span class='badge {_esc(p.get('status'))}'>{_esc(p.get('status'))}</span></td>"
            f"<td>{_esc(p.get('summary'))}</td>"
            "</tr>"
        )
    return "\n".join(out)


def render(report: dict) -> str:
    summary = report["summary"]
    scan = _last_scan()
    triggers = scan.get("triggers") or []
    proposals = _proposals()
    failures = _recent_failures()
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>RSI 技能看板</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; padding: 32px; background: #0f1115; color: #e6e8ec;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }}
  h2 {{ font-size: 16px; margin: 32px 0 12px; color: #9aa4b2; font-weight: 600; }}
  .meta {{ color: #6b7280; font-size: 12px; }}
  .cards {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }}
  .card {{ background: #171a21; border: 1px solid #242936; border-radius: 10px; padding: 14px 16px; }}
  .card .num {{ font-size: 24px; font-weight: 700; }}
  .card .label {{ color: #8b93a1; font-size: 12px; margin-top: 2px; }}
  table {{ width: 100%; border-collapse: collapse; background: #141821;
           border: 1px solid #242936; border-radius: 10px; overflow: hidden; }}
  th, td {{ text-align: left; padding: 9px 12px; border-bottom: 1px solid #222734; vertical-align: top; }}
  th {{ color: #9aa4b2; font-weight: 600; background: #171b24; font-size: 12px; }}
  tr:last-child td {{ border-bottom: none; }}
  .badge {{ display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
            border: 1px solid #33405a; color: #9db4d6; }}
  .badge.active {{ border-color: #2f6f4f; color: #6ee7a8; }}
  .badge.retired {{ border-color: #5a3340; color: #f0a3b4; }}
  .badge.draft {{ border-color: #3c3f46; color: #b7bdc8; }}
  .badge.warn, .badge.pending {{ border-color: #7a5a24; color: #f3c777; }}
  .badge.approved {{ border-color: #2f6f4f; color: #6ee7a8; }}
  .triggers {{ color: #cbd5e1; }}
</style>
</head>
<body>
<h1>RSI 技能看板</h1>
<div class="meta">生成于 {_esc(report['generated_at'])} · 只读快照，数据来自 ledger/ 与 skills/</div>
<div class="cards">
  <div class="card"><div class="num">{summary['total']}</div><div class="label">技能总数</div></div>
  <div class="card"><div class="num">{summary['active']}</div><div class="label">active</div></div>
  <div class="card"><div class="num">{summary['retire_candidates']}</div><div class="label">退役候选</div></div>
  <div class="card"><div class="num">{len(proposals)}</div><div class="label">提案</div></div>
</div>
<h2>技能状态</h2>
<table>
<thead><tr><th>技能</th><th>状态</th><th>版本</th><th>验证</th><th>legacy</th>
<th>使用</th><th>成功率</th><th>闲置天</th><th>评测分</th><th>评测版本</th><th>退役理由</th></tr></thead>
<tbody>
{_skill_rows(report)}
</tbody>
</table>
<h2>最近失败</h2>
<table>
<thead><tr><th>时间</th><th>结果</th><th>任务</th><th>技能</th></tr></thead>
<tbody>
{_failure_rows(failures)}
</tbody>
</table>
<h2>待审提案与复盘触发</h2>
<table>
<thead><tr><th>ID</th><th>技能</th><th>层</th><th>状态</th><th>摘要</th></tr></thead>
<tbody>
{_proposal_rows(proposals)}
</tbody>
</table>
<p class="triggers">最近一次复盘触发：{_esc(', '.join(t.get('kind') + ':' + str(t.get('skill')) for t in triggers) or '无')}</p>
</body>
</html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 RSI 只读看板（静态 HTML）")
    ap.add_argument("--out", default=str(RSI_ROOT / "dashboard" / "index.html"), help="输出路径")
    args = ap.parse_args()
    report = build_report()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(report), encoding="utf-8")
    print(dumps({"ok": True, "out": str(out), "skills": report["summary"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
