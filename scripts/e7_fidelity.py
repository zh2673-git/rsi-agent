#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""E7 — 三层记忆数据的保真度（论文 B 的全部数字）。

主张（论文 B §4）：append-only 侧车（events）记录的内容，与重建压缩前模型可见上下文
所需的内容之间存在结构性缺口，量化为 events 载荷 / traces 载荷。

口径（与论文附录 B 逐条对应，勿改）：
- traces 载荷：逐行取 text / result_truncated / answer / reasoning / json(args) 的字符数之和。
- events 载荷：逐行取 preview / summary 的字符数之和。
- 保真度 = events 载荷 / traces 载荷。
- 压缩统计：events 中 kind==compaction 的行，读 tokens_before / kept / first_kept / len(summary)。
- 截断统计：traces 中 type==tool_result 的行，memory_truncated 为真的计数。

快照：trace 是活体追加的（每次对话都在长），若按文件 mtime 或「跑一遍就报数」，
论文数字每天都不一样、也就无法复算。因此**全部统计按每行的 `ts`（epoch 毫秒）过滤**：
给定 `--as-of`，结果对已写入的行永久确定，后续追加不影响。论文里的数字一律标注该切点。

用法（仓库根）：
    python scripts/e7_fidelity.py                        # 全量（会随后续对话漂移）
    python scripts/e7_fidelity.py --as-of 2026-11-07T18:45   # 论文口径：钉死的切点
    python scripts/e7_fidelity.py --as-of 2026-11-07T18:45 --json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "runtime" / "plugins" / "memory" / "data"

# 论文切点（本地时间）。两篇论文共用，改它必须同步改论文与账本 E-HARNESS-*/E-FIDELITY-*。
PAPER_AS_OF = "2026-11-07T13:35:24"


def _parse_as_of(text: str | None) -> int | None:
    """ISO/日期 → epoch 毫秒。不给则 None（全量）。"""
    if not text:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(dt.datetime.strptime(text, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise SystemExit(f"--as-of 无法解析: {text}（用 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM）")


def _iter(path: Path, cutoff_ms: int | None):
    """逐行流式读取；坏行跳过；按 ts 过滤。"""
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


def _arg_chars(args) -> int:
    if not args:
        return 0
    try:
        return len(json.dumps(args, ensure_ascii=False))
    except (TypeError, ValueError):
        return len(str(args))


def trace_payload(path: Path, cutoff_ms: int | None = None) -> dict:
    chars = 0
    tool_results = 0
    truncated = 0
    for ev in _iter(path, cutoff_ms):
        for key in ("text", "result_truncated", "answer", "reasoning"):
            v = ev.get(key)
            if isinstance(v, str):
                chars += len(v)
        chars += _arg_chars(ev.get("args"))
        if ev.get("type") == "tool_result":
            tool_results += 1
            if ev.get("memory_truncated") is True:
                truncated += 1
    return {"chars": chars, "tool_results": tool_results, "truncated": truncated}


def event_stats(path: Path, cutoff_ms: int | None = None) -> dict:
    chars = 0
    compactions: list[dict] = []
    rollbacks = 0
    for ev in _iter(path, cutoff_ms):
        for key in ("preview", "summary"):
            v = ev.get(key)
            if isinstance(v, str):
                chars += len(v)
        kind = ev.get("kind")
        if kind == "rollback":
            rollbacks += 1
        elif kind == "compaction":
            summary = ev.get("summary")
            compactions.append({
                "session": path.stem,
                "ts": ev.get("ts"),
                "tokens_before": ev.get("tokens_before"),
                "kept": ev.get("kept"),
                "first_kept": ev.get("first_kept"),
                "summary_chars": len(summary) if isinstance(summary, str) else 0,
            })
    return {"chars": chars, "compactions": compactions, "rollbacks": rollbacks}


def _row_metrics(ev: dict) -> tuple[int, int, int, int, int]:
    """单行的 (chars, tool_result_rows, truncated, compactions, rollbacks)。"""
    chars = 0
    for key in ("text", "result_truncated", "answer", "reasoning", "preview", "summary"):
        v = ev.get(key)
        if isinstance(v, str):
            chars += len(v)
    chars += _arg_chars(ev.get("args"))
    tr = 1 if ev.get("type") == "tool_result" else 0
    cut = 1 if ev.get("type") == "tool_result" and ev.get("memory_truncated") is True else 0
    comp = 1 if ev.get("kind") == "compaction" else 0
    roll = 1 if ev.get("kind") == "rollback" else 0
    return chars, tr, cut, comp, roll


def timeline(data_dir: Path, step_hours: int = 1) -> list[dict]:
    """按 ts 累积，逐时间桶给出各项累计值——用于选定论文切点、观察数字漂移。"""
    rows: list[tuple[int, int, int, int, int, int]] = []
    for sub in ("traces", "events"):
        d = data_dir / sub
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.jsonl")):
            for ev in _iter(p, None):
                ts = ev.get("ts")
                if not isinstance(ts, (int, float)):
                    continue
                rows.append((int(ts),) + _row_metrics(ev))
    rows.sort(key=lambda r: r[0])

    buckets: list[dict] = []
    step_ms = step_hours * 3600 * 1000
    bucket_start = None
    acc = [0, 0, 0, 0, 0]
    for r in rows:
        b = (r[0] // step_ms) * step_ms
        if bucket_start is not None and b > bucket_start:
            buckets.append({"ts": bucket_start, "iso": dt.datetime.fromtimestamp(bucket_start / 1000).strftime("%Y-%m-%dT%H:%M"),
                            "chars": acc[0], "tool_results": acc[1], "truncated": acc[2],
                            "compactions": acc[3], "rollbacks": acc[4]})
            bucket_start = b
        if bucket_start is None:
            bucket_start = b
        for i in range(5):
            acc[i] += r[i + 1]
    if bucket_start is not None:
        buckets.append({"ts": bucket_start, "iso": dt.datetime.fromtimestamp(bucket_start / 1000).strftime("%Y-%m-%dT%H:%M"),
                        "chars": acc[0], "tool_results": acc[1], "truncated": acc[2],
                        "compactions": acc[3], "rollbacks": acc[4]})
    return buckets


def collect(data_dir: Path, cutoff_ms: int | None) -> dict:
    traces_dir = data_dir / "traces"
    events_dir = data_dir / "events"

    per_trace: dict[str, dict] = {}
    for p in sorted(traces_dir.glob("*.jsonl")) if traces_dir.is_dir() else []:
        row = trace_payload(p, cutoff_ms)
        if row["chars"] or row["tool_results"]:
            per_trace[p.stem] = row

    events_chars = 0
    compactions: list[dict] = []
    rollbacks = 0
    event_files = 0
    for p in sorted(events_dir.glob("*.jsonl")) if events_dir.is_dir() else []:
        st = event_stats(p, cutoff_ms)
        if st["chars"] or st["compactions"] or st["rollbacks"]:
            event_files += 1
        events_chars += st["chars"]
        compactions.extend(st["compactions"])
        rollbacks += st["rollbacks"]

    traces_chars = sum(v["chars"] for v in per_trace.values())
    tool_results = sum(v["tool_results"] for v in per_trace.values())
    truncated = sum(v["truncated"] for v in per_trace.values())

    fidelity = round(events_chars / traces_chars * 100, 2) if traces_chars else 0.0

    def _ratio(c: dict) -> float:
        before = c.get("tokens_before") or 0
        size = c.get("summary_chars") or 1
        return before / size if size else 0.0

    worst = None
    if compactions:
        w = max(compactions, key=_ratio)
        worst = dict(w, ratio=round(_ratio(w), 1))

    summaries = [c["summary_chars"] for c in compactions]

    # 三个「峰值」口径分开报，别混用（论文 B 引的是压缩最重会话那一个）：
    def _rate(row: dict) -> float:
        return row.get("truncated", 0) / row["tool_results"] if row.get("tool_results") else 0.0

    by_count = max(per_trace.items(), key=lambda kv: kv[1]["tool_results"]) if per_trace else ("", {})
    by_rate = max(per_trace.items(), key=lambda kv: _rate(kv[1])) if per_trace else ("", {})

    # 压缩事件最多的会话——论文 B 表 1 与 §4.5 指的「最活跃会话」就是它。
    comp_by_session: dict[str, int] = {}
    for c in compactions:
        comp_by_session[c["session"]] = comp_by_session.get(c["session"], 0) + 1
    heaviest = max(comp_by_session.items(), key=lambda kv: kv[1])[0] if comp_by_session else ""
    heaviest_row = per_trace.get(heaviest, {})

    def _pack(sid: str, row: dict) -> dict:
        return {"session": sid, "tool_results": row.get("tool_results", 0),
                "truncated": row.get("truncated", 0),
                "truncated_pct": round(_rate(row) * 100, 1) if row else 0.0}

    return {
        "ok": True,
        "data_dir": str(data_dir),
        "sessions": len(per_trace),
        "event_files": event_files,
        "traces_chars": traces_chars,
        "events_chars": events_chars,
        "fidelity_pct": fidelity,
        "tool_result_rows": tool_results,
        "memory_truncated_hits": truncated,
        "compaction_events": len(compactions),
        "rollback_events": rollbacks,
        "compaction_summary_chars": {"min": min(summaries) if summaries else 0,
                                     "max": max(summaries) if summaries else 0},
        "worst_compression": worst,
        "peak_by_count": _pack(by_count[0], by_count[1]),
        "peak_by_rate": _pack(by_rate[0], by_rate[1]),
        "heaviest_compaction_session": _pack(heaviest, heaviest_row),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="E7 三层记忆保真度")
    ap.add_argument("--data", default=str(DEFAULT_DATA), help="memory/data 目录")
    ap.add_argument("--as-of", default=None, help=f"事件 ts 切点；论文口径为 {PAPER_AS_OF}")
    ap.add_argument("--paper", action="store_true", help=f"等价于 --as-of {PAPER_AS_OF}")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    ap.add_argument("--timeline", type=int, metavar="HOURS", help="按 HOURS 小时桶输出累计时间线（选切点用）")
    ns = ap.parse_args(argv)

    data_dir = Path(ns.data)
    if ns.timeline:
        for row in timeline(data_dir, ns.timeline):
            print(f"{row['iso']}  chars={row['chars']:>11,}  tr={row['tool_results']:>6,}"
                  f"  cut={row['truncated']:>5,}  comp={row['compactions']:>3}  roll={row['rollbacks']}")
        return 0

    as_of = PAPER_AS_OF if ns.paper else ns.as_of
    result = collect(Path(ns.data), _parse_as_of(as_of))
    result["as_of"] = as_of or "full"

    if ns.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"切点    {result['as_of']}")
    print(f"会话    {result['sessions']} 个 trace（events {result['event_files']} 文件）")
    print(f"载荷    traces {result['traces_chars']:,} 字符 / events {result['events_chars']:,} 字符")
    print(f"保真度  {result['fidelity_pct']}%")
    print(f"工具结果 {result['tool_result_rows']:,} 行，其中 memory_truncated {result['memory_truncated_hits']:,} 行")
    print(f"压缩事件 {result['compaction_events']}，回滚事件 {result['rollback_events']}"
          f"（摘要 {result['compaction_summary_chars']['min']}–{result['compaction_summary_chars']['max']} 字符）")
    if result["worst_compression"]:
        w = result["worst_compression"]
        print(f"最坏压缩 {w['tokens_before']:,} → {w['summary_chars']:,} 字符（{w['ratio']}:1，{w['session']}）")
    for label, key in (("截断最多", "peak_by_count"), ("截断率最高", "peak_by_rate"),
                       ("压缩最重", "heaviest_compaction_session")):
        b = result[key]
        if b["session"]:
            print(f"{label} {b['session']}：{b['truncated']}/{b['tool_results']} = {b['truncated_pct']}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
