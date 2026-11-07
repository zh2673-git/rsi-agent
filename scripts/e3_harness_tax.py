#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""E3 — bash 契约税：`cd` 前缀率及其字符占比（论文 A §5 的数字）。

主张（论文 A §5）：冻结契约一旦对路径前缀含糊，代价以模型 token 支付——每次 bash 都要
带一段冗余 `cd /d <workspace> &&`。本脚本量化这段冗余。

口径（与论文附录 B 一致，勿改）：
- 统计对象：traces 中 type==tool_call 且 name==bash 的行，取其 args.command。
- cd 前缀：命令以 `cd <path> (&&|&) 或 cd /d <path> (&&|&)` 开头（正则见 CD_RE）。
- 前缀字符：匹配到的整段前缀（含 `&&`）的字符数；总字符为全部 bash 命令字符数。
- 失败率：无前缀命令中，对应 tool_result 的 ok==false 且输出无 `exit_code:0` 的比例。

快照：与 e7_fidelity.py 同机制，全部按每行 `ts` 过滤，钉死切点后结果永久确定。

用法（仓库根）：
    python scripts/e3_harness_tax.py
    python scripts/e3_harness_tax.py --as-of 2026-11-07T13:30
    python scripts/e3_harness_tax.py --as-of 2026-11-07T13:30 --json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "runtime" / "plugins" / "memory" / "data"

# 论文 A 使用的切点。改它就必须同步改论文 A 与账本 E-HARNESS-*。
PAPER_AS_OF = "2026-11-07T13:35:23"

# 前缀 = `cd ... &&` 连同其后的一个分隔空格。旧探针按此口径，故论文数字沿用；
# 若只取到 `&&` 为止，前缀字符会比记载少 3,760（= 前缀次数），占比 15.7% 而非 16.0%。
CD_RE = re.compile(r"^\s*cd\s+(?:/d\s+)?(\"[^\"]+\"|\S+)\s*(?:&&|&)[ \t]?")


def _parse_as_of(text: str | None) -> int | None:
    if not text:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(dt.datetime.strptime(text, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise SystemExit(f"--as-of 无法解析: {text}")


def _iter(path: Path, cutoff_ms: int | None):
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if not isinstance(ev, dict):
                continue
            if cutoff_ms is not None:
                ts = ev.get("ts")
                if not isinstance(ts, (int, float)) or ts > cutoff_ms:
                    continue
            yield ev


def _looks_failed(ev: dict) -> bool:
    """tool_result 的失败判定：ok==false 且输出里没有 exit_code:0。"""
    if ev.get("ok") is not False:
        return False
    body = str(ev.get("result_truncated") or "")
    return "exit_code:0" not in body


def collect(data_dir: Path, cutoff_ms: int | None) -> dict:
    traces_dir = data_dir / "traces"
    files = sorted(traces_dir.glob("*.jsonl")) if traces_dir.is_dir() else []

    bash_calls = 0
    cd_prefixed = 0
    prefix_chars = 0
    total_cmd_chars = 0
    no_prefix = 0
    no_prefix_failed = 0
    per_session: Counter = Counter()
    per_session_bash: Counter = Counter()

    for p in files:
        sid = p.stem
        pending: dict[str, bool] = {}
        for ev in _iter(p, cutoff_ms):
            etype = ev.get("type")
            if etype == "tool_call" and ev.get("name") == "bash":
                cmd = str((ev.get("args") or {}).get("command") or "")
                bash_calls += 1
                per_session_bash[sid] += 1
                total_cmd_chars += len(cmd)
                m = CD_RE.match(cmd)
                if m:
                    cd_prefixed += 1
                    per_session[sid] += 1
                    prefix_chars += m.end()
                else:
                    no_prefix += 1
                    tid = ev.get("id")
                    if isinstance(tid, str):
                        pending[tid] = True
            elif etype == "tool_result" and ev.get("name") == "bash":
                tid = ev.get("id")
                if isinstance(tid, str) and pending.pop(tid, False):
                    if _looks_failed(ev):
                        no_prefix_failed += 1

    worst = None
    if per_session_bash:
        sid, n = max(per_session.items(), key=lambda kv: kv[1]) if per_session else ("", 0)
        total = per_session_bash.get(sid, 0)
        if total:
            worst = {"session": sid, "bash": total, "cd_prefixed": n,
                     "ratio_pct": round(n / total * 100, 1)}

    return {
        "ok": True,
        "as_of": "full" if cutoff_ms is None else dt.datetime.fromtimestamp(cutoff_ms / 1000).strftime("%Y-%m-%dT%H:%M"),
        "sessions": len(files),
        "bash_calls": bash_calls,
        "cd_prefixed": cd_prefixed,
        "cd_ratio_pct": round(cd_prefixed / bash_calls * 100, 1) if bash_calls else 0.0,
        "prefix_chars": prefix_chars,
        "total_cmd_chars": total_cmd_chars,
        "prefix_share_pct": round(prefix_chars / total_cmd_chars * 100, 1) if total_cmd_chars else 0.0,
        "no_prefix": no_prefix,
        "no_prefix_failed": no_prefix_failed,
        "no_prefix_fail_pct": round(no_prefix_failed / no_prefix * 100, 1) if no_prefix else 0.0,
        "worst_session": worst,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="E3 bash 契约税")
    ap.add_argument("--data", default=str(DEFAULT_DATA), help="memory/data 目录")
    ap.add_argument("--as-of", default=None, help=f"事件 ts 切点；论文口径为 {PAPER_AS_OF}")
    ap.add_argument("--paper", action="store_true", help=f"等价于 --as-of {PAPER_AS_OF}")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    ns = ap.parse_args(argv)

    as_of = PAPER_AS_OF if ns.paper else ns.as_of
    r = collect(Path(ns.data), _parse_as_of(as_of))
    if ns.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0

    print(f"切点    {r['as_of']}（{r['sessions']} 个 trace）")
    print(f"bash    {r['bash_calls']:,} 次调用，{r['total_cmd_chars']:,} 命令字符")
    print(f"cd 前缀 {r['cd_prefixed']:,} 次 = {r['cd_ratio_pct']}%")
    print(f"前缀字符 {r['prefix_chars']:,} = {r['prefix_share_pct']}%")
    print(f"无前缀 {r['no_prefix']:,} 次，失败 {r['no_prefix_failed']:,} = {r['no_prefix_fail_pct']}%")
    if r["worst_session"]:
        w = r["worst_session"]
        print(f"单会话峰 {w['session']}：{w['cd_prefixed']}/{w['bash']} = {w['ratio_pct']}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
