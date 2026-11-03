#!/usr/bin/env python
"""trace_query 的工具执行器（协议适配层）。

协议：stdin 读 {"args":{...}}，stdout 回单个 JSON：
  {"ok":true,"result":<trace_query 的输出>} | {"ok":false,"error":{"code","message"}}

存在理由：tools.json 的 exec.cmd 是静态 argv，不接受自由文本参数；这里把
args.query（"<sub> [--trace <id>] [--round N]"）拆成 argv 转发给 trace_query.py，
并做子命令白名单校验（防注入 / 防误用）。
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
from pathlib import Path

ALLOWED_SUBS = ("summary", "toolmix", "writes", "errors", "multiline", "calls", "substitutability")
TIMEOUT_SECS = 60


def _fail(code: str, message: str) -> None:
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        _fail("BAD_INPUT", "stdin 不是合法 JSON")
        return 1
    args = payload.get("args") or {}
    query = str(args.get("query") or "").strip()
    if not query:
        query = "summary"  # 缺省给概览；冒烟（{"args":{}}）也走这条路
    try:
        parts = shlex.split(query)
    except ValueError as exc:
        _fail("BAD_QUERY", f"query 无法解析: {exc}")
        return 1
    if not parts or parts[0] not in ALLOWED_SUBS:
        _fail("BAD_SUB", f"子命令必须是 {'|'.join(ALLOWED_SUBS)} 之一，收到: {parts[:1]}")
        return 1
    try:
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("trace_query.py")), *parts],
            capture_output=True, text=True, timeout=TIMEOUT_SECS,
            cwd=str(Path(__file__).parent), encoding="utf-8",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        _fail("EXEC_FAILED", f"{type(exc).__name__}: {exc}")
        return 1
    lines = (proc.stdout or "").strip().splitlines()
    try:
        body = json.loads(lines[-1]) if lines else {}
    except ValueError:
        _fail("NOT_JSON", (proc.stderr or proc.stdout or "")[-200:])
        return 1
    if not isinstance(body, dict):
        _fail("NOT_JSON", "trace_query 输出不是 JSON 对象")
        return 1
    if body.get("ok") is True:
        print(json.dumps({"ok": True, "result": body}, ensure_ascii=False))
    else:
        # trace_query 自己的错误协议（ok:false + error）原样透传
        print(json.dumps(body, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
