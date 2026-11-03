#!/usr/bin/env python
"""trace_query —— 免写脚本的 trace 查询（固定子命令，只读）。

协议：命令行子命令 + `--trace`，stdout 输出单个 JSON 对象。
  {"ok":true,"trace":"<path>","<sub>":...} | {"ok":false,"error":{"code","message"}}

存在的理由：以前每次分析 trace 都要先 write_file 一个临时脚本再跑（落进 outputs/_scratch_*.py），
既污染产物目录又多两次工具调用。这里把那些脚本固化成子命令，一条 bash 单行即可。

子命令：summary / toolmix / writes / errors / multiline / calls
边界：只读、不做全量 json.loads（逐行流式）、容忍字段缺失（.get() + 默认值）。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
from pathlib import Path

OUTPUT_HEAD = 80          # errors 子命令里输出片段保留字符数
CALLS_ARG_CHARS = 60      # calls 子命令里参数摘要字符数
TOP_N = 20                # toolmix 的 bash 细分保留项数


def _ws() -> Path:
    return Path(os.environ.get("WORKSPACE_ROOT") or os.getcwd())


def _traces_dir() -> Path:
    env = os.environ.get("MEMORY_DATA_DIR")
    base = Path(env) if env else _ws() / "plugins" / "memory" / "data"
    return base / "traces"


def _resolve_trace(spec: str | None) -> Path:
    """三形态解析：会话 id / 相对或绝对路径 / 缺省取最新。不可达即抛 FileNotFoundError。"""
    if not spec:
        d = _traces_dir()
        if not d.is_dir():
            raise FileNotFoundError(f"traces 目录不存在: {d}")
        cands = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
        if not cands:
            raise FileNotFoundError(f"traces 目录下没有 .jsonl: {d}")
        return cands[-1]
    p = Path(spec)
    if p.is_file():
        return p
    name = spec if spec.endswith(".jsonl") else f"{spec}.jsonl"
    for cand in (Path(name), _traces_dir() / name, _ws() / name):
        if cand.is_file():
            return cand
    raise FileNotFoundError(f"trace 不可达: {spec}（已试: 原样 / traces 目录 / 工作区根）")


def _iter_events(path: Path):
    """逐行流式读取；坏行跳过（不因单行损坏丢掉整份 trace）。"""
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if isinstance(ev, dict):
                yield ev


def _inner(ev: dict) -> dict:
    """tool_result 的 result_truncated 是「字符串形式的 JSON」；解析失败按原串处理。"""
    raw = ev.get("result_truncated") or ev.get("result")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        v = json.loads(raw)
    except ValueError:
        return {"raw": raw}
    return v if isinstance(v, dict) else {"raw": raw}


def _cmd_summary(events) -> dict:
    rows = []
    for ev in events:
        if ev.get("type") != "chat_summary":
            continue
        tk = ev.get("tokens") or {}
        rows.append({
            "ts": ev.get("ts"),
            "rounds": ev.get("rounds"),
            "calls": ev.get("calls"),
            "steps": ev.get("steps"),
            "llm_calls": ev.get("llm_calls"),
            "failures": ev.get("failures"),
            "failure_rate": ev.get("failure_rate"),
            "stopped_by": ev.get("stopped_by"),
            "tokens_in": tk.get("input_tokens"),
            "tokens_out": tk.get("output_tokens"),
            "reasoning_tokens": tk.get("reasoning_tokens"),
        })
    return {"ok": True, "chats": len(rows), "rows": rows}


def _cmd_toolmix(events) -> dict:
    names = collections.Counter()
    bash_first = collections.Counter()
    for ev in events:
        if ev.get("type") != "tool_call":
            continue
        name = ev.get("name") or "?"
        names[name] += 1
        if name == "bash":
            cmd = str((ev.get("args") or {}).get("command") or "").strip()
            head = cmd.split()[0].lower() if cmd.split() else "(empty)"
            head = head.split("\\")[-1].split("/")[-1]
            bash_first[head] += 1
    return {
        "ok": True,
        "total_calls": sum(names.values()),
        "tools": dict(names.most_common()),
        "bash_first_token": dict(bash_first.most_common(TOP_N)),
    }


def _cmd_writes(events) -> dict:
    paths, dirs, by_tool = [], collections.Counter(), collections.Counter()
    for ev in events:
        t = ev.get("type")
        if t not in ("file_change", "artifact"):
            continue
        p = str(ev.get("path") or "")
        if not p:
            continue
        paths.append(p)
        top = p.replace("\\", "/").split("/")[0] if "/" in p or "\\" in p else "(root)"
        dirs[top] += 1
        by_tool[ev.get("tool") or ev.get("op") or t] += 1
    out_dir = os.environ.get("AGENT_OUTPUT_DIR") or "outputs"
    in_out = sum(1 for p in paths if p.replace("\\", "/").startswith(out_dir.replace("\\", "/")))
    return {
        "ok": True,
        "total": len(paths),
        "by_top_dir": dict(dirs.most_common()),
        "by_tool": dict(by_tool.most_common()),
        "outputs_share": in_out,
        "paths": paths,
    }


def _cmd_errors(events) -> dict:
    calls = {ev.get("id"): ev for ev in events if ev.get("type") == "tool_call"}
    bad = []
    for ev in events:
        if ev.get("type") != "tool_result":
            continue
        inner = _inner(ev)
        if not inner:
            continue
        res = inner.get("result") if isinstance(inner.get("result"), dict) else {}
        failed = inner.get("ok") is False
        exit_code = res.get("exit_code")
        if not failed and exit_code in (None, 0):
            continue
        call = calls.get(ev.get("id")) or {}
        args = call.get("args") or {}
        bad.append({
            "round": ev.get("round") or call.get("round"),
            "tool": ev.get("name") or call.get("name"),
            "ok": inner.get("ok"),
            "exit_code": exit_code,
            "code": ((inner.get("error") or {}) if isinstance(inner.get("error"), dict) else {}).get("code"),
            "arg": str(args.get("command") or args.get("path") or "")[:CALLS_ARG_CHARS],
            "output_head": str(res.get("output") or inner.get("error") or "")[:OUTPUT_HEAD],
        })
    return {"ok": True, "failures": len(bad), "items": bad}


def _cmd_multiline(events) -> dict:
    hits = []
    for ev in events:
        if ev.get("type") != "tool_call" or ev.get("name") != "bash":
            continue
        cmd = str((ev.get("args") or {}).get("command") or "")
        if "\n" not in cmd and "\r" not in cmd:
            continue
        hits.append({
            "round": ev.get("round"),
            "lines": cmd.count("\n") + 1,
            "first_line": cmd.split("\n")[0][:CALLS_ARG_CHARS],
        })
    return {"ok": True, "count": len(hits), "items": hits}


# bash 首 token → 「本仓库内置工具即可替代」的映射（opencode/pi/codex/dsh 四家调研的本地化结论）。
# 口径：bash 应留给运行/构建/测试/git/进程与系统查询；文件读写、检索、列目录走专用工具。
REPLACEABLE = {
    "python": ("专用工具 / trace-analysis 技能", "trace 分析用 trace-analysis；其余 python -c 多为探针，应改用 read_file/grep 拿事实"),
    "chcp": ("无需调用", "代码页探测对模型无信息量；直接删掉这类调用"),
    "powershell": ("bash 单行 / tasklist", "进程与系统查询优先 tasklist；确需 powershell 则压成 -Command 单行"),
    "findstr": ("grep 工具", "内容搜索用 grep（regex/context/count 俱全），不要用 findstr"),
    "dir": ("list_dir 工具", "列目录用 list_dir（含大小/mtime/递归），不要用 dir /b"),
    "type": ("read_file 工具", "读文件用 read_file（行号、截断可控），不要用 type"),
    "cat": ("read_file 工具", "读文件用 read_file，不要用 cat"),
    "ls": ("list_dir 工具", "列目录用 list_dir，不要用 ls"),
    "echo": ("write_file 工具", "写文件用 write_file，不要 echo > / echo >>"),
}


def _cmd_substitutability(events) -> dict:
    """bash 调用按「内置工具可替代」细分：first_token 命中 REPLACEABLE 即计入。

    口径豁免：`python -m <module>`（pytest/unittest/pip 等模块运行）是 bash 本职，不计入可替代。
    """
    total = 0
    by_bucket = collections.Counter()
    samples = {k: [] for k in REPLACEABLE}
    for ev in events:
        if ev.get("type") != "tool_call" or ev.get("name") != "bash":
            continue
        total += 1
        cmd = str((ev.get("args") or {}).get("command") or "").strip()
        parts = cmd.split()
        if not parts:
            continue
        head = parts[0].lower()
        head = head.split("\\")[-1].split("/")[-1]
        if head == "python" and len(parts) > 1 and parts[1] == "-m":
            continue  # python -m pytest/unittest/pip：合法的运行类调用，不属「可替代」
        if head in REPLACEABLE:
            by_bucket[head] += 1
            if len(samples[head]) < 3:
                samples[head].append({"round": ev.get("round"), "cmd": cmd[:CALLS_ARG_CHARS]})
    replaceable = sum(by_bucket.values())
    return {
        "ok": True,
        "bash_calls": total,
        "replaceable": replaceable,
        "replaceable_ratio": round(replaceable / total, 3) if total else 0.0,
        "by_bucket": dict(by_bucket.most_common()),
        "samples": {k: v for k, v in samples.items() if v},
        "hints": REPLACEABLE,
    }


def _cmd_calls(events, only_round: int | None) -> dict:
    seq = []
    for ev in events:
        if ev.get("type") != "tool_call":
            continue
        rnd = ev.get("round")
        if only_round is not None and rnd != only_round:
            continue
        args = ev.get("args") or {}
        brief = args.get("command") or args.get("path") or args.get("query") or ""
        seq.append({
            "round": rnd,
            "tool": ev.get("name"),
            "arg": str(brief)[:CALLS_ARG_CHARS],
        })
    return {"ok": True, "count": len(seq), "items": seq}


def _err(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="trace 查询（只读、固定子命令）")
    ap.add_argument("sub", choices=("summary", "toolmix", "writes", "errors", "multiline", "calls", "substitutability"))
    ap.add_argument("--trace", default=None,
                    help="会话 id（s-xxx）/ 路径 / 省略或 --latest=取最新 .jsonl")
    ap.add_argument("--latest", action="store_true", help="取最新修改的 trace（与省略 --trace 等价）")
    ap.add_argument("--round", type=int, default=None, help="仅 calls 子命令：过滤轮次")
    ns = ap.parse_args(argv)

    try:
        path = _resolve_trace(ns.trace)
    except FileNotFoundError as exc:
        print(json.dumps(_err("TRACE_NOT_FOUND", str(exc)), ensure_ascii=False))
        return 1
    except OSError as exc:
        print(json.dumps(_err("TRACE_UNREADABLE", f"{type(exc).__name__}: {exc}"), ensure_ascii=False))
        return 1

    try:
        events = list(_iter_events(path))
        if ns.sub == "summary":
            body = _cmd_summary(events)
        elif ns.sub == "toolmix":
            body = _cmd_toolmix(events)
        elif ns.sub == "writes":
            body = _cmd_writes(events)
        elif ns.sub == "errors":
            body = _cmd_errors(events)
        elif ns.sub == "multiline":
            body = _cmd_multiline(events)
        elif ns.sub == "substitutability":
            body = _cmd_substitutability(events)
        else:
            body = _cmd_calls(events, ns.round)
    except OSError as exc:
        print(json.dumps(_err("TRACE_UNREADABLE", f"{type(exc).__name__}: {exc}"), ensure_ascii=False))
        return 1

    body["trace"] = str(path)
    body["events"] = len(events)
    print(json.dumps(body, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
