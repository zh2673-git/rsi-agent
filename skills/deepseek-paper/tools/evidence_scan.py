#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""evidence_scan — 扫项目目录，产出证据账本骨架（素材清单，不是结论）。

协议：stdin 收 {"args": {...}}，stdout 回 {"ok": true, "result": {...}}。
args:
  path    必填，项目根目录
  out     可选，账本 JSON 输出路径（默认 <path>/evidence-ledger.json）
  depth   可选，递归深度（默认 4）
  max     可选，最多扫文件数（默认 400）
  git     可选，是否读取 git log 摘要（默认 true）
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

NOISE = {".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build",
         ".idea", ".pytest_cache", ".mypy_cache", ".scratch"}
CODE_EXT = {".py", ".ts", ".tsx", ".js", ".rs", ".go", ".java", ".cpp", ".c", ".h", ".cu"}
DATA_EXT = {".json", ".jsonl", ".csv", ".tsv", ".log", ".txt", ".md", ".yaml", ".yml", ".toml"}
TEST_HINT = re.compile(r"(test|bench|eval|metric|result|report|trace|loss|score)", re.I)
CONFIG_HINT = re.compile(r"(config|settings|params?|hyper|env)", re.I)
DOC_HINT = re.compile(r"(plan|design|readme|spec|changelog|notes?|idea|实验|计划|方案)", re.I)
NUM = re.compile(r"-?\d+(?:\.\d+)?(?:e[-+]?\d+)?", re.I)


def walk(root: Path, depth: int, cap: int) -> list[Path]:
    out: list[Path] = []
    root = root.resolve()
    for p in sorted(root.rglob("*")):
        if len(out) >= cap:
            break
        if p.is_dir():
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        if any(part in NOISE for part in rel.parts) or len(rel.parts) > depth:
            continue
        out.append(p)
    return out


def classify(p: Path) -> str:
    name = p.name.lower()
    if TEST_HINT.search(name):
        return "measure"
    if CONFIG_HINT.search(name):
        return "config"
    if DOC_HINT.search(name):
        return "artifact"
    if p.suffix.lower() in DATA_EXT:
        return "measure"
    return "artifact"


def git_log(root: Path) -> list[str]:
    try:
        proc = subprocess.run(["git", "log", "--oneline", "-n", "30"], cwd=str(root),
                              capture_output=True, text=True, timeout=15)
        return [l for l in proc.stdout.splitlines() if l.strip()]
    except (OSError, subprocess.SubprocessError):
        return []


def heads_of(p: Path, n: int = 8) -> list[str]:
    try:
        with p.open("r", encoding="utf-8", errors="replace") as fh:
            lines = []
            for i, line in enumerate(fh, 1):
                if i > n:
                    break
                lines.append(f"L{i}: {line.rstrip()[:120]}")
            return lines
    except OSError:
        return []


def run(args: dict) -> dict:
    root = Path(args["path"])
    if not root.is_dir():
        return {"ok": False, "error": {"code": "E_NO_DIR", "message": f"目录不存在: {root}"}}
    depth = int(args.get("depth", 4))
    cap = int(args.get("max", 400))
    files = walk(root, depth, cap)
    ev, todo = [], []
    by_kind: dict[str, int] = {}
    for i, p in enumerate(files, 1):
        kind = classify(p)
        by_kind[kind] = by_kind.get(kind, 0) + 1
        rel = str(p.relative_to(root.resolve())).replace("\\", "/")
        has_num = False
        if p.stat().st_size < 2_000_000 and p.suffix.lower() in DATA_EXT | CODE_EXT:
            try:
                sample = p.read_text(encoding="utf-8", errors="replace")[:4000]
                has_num = bool(NUM.search(sample))
            except OSError:
                pass
        item = {
            "id": f"ev-{i:03d}",
            "kind": kind,
            "claim": "",
            "value": "",
            "unit": "",
            "scope": f"{p.suffix.lstrip('.') or 'file'}",
            "source": rel,
            "status": "todo",
            "verify": "",
            "used_in": "",
            "bytes": p.stat().st_size,
            "has_numbers": has_num,
            "heads": heads_of(p, 3) if kind in ("measure", "config") else [],
        }
        ev.append(item)
        todo.append({"id": item["id"], "source": rel,
                     "why": "缺 claim/value/口径，需人判定后才能进正文"})
    logs = git_log(root) if args.get("git", True) else []
    ledger = {
        "_generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "_note": "素材清单，不是结论。逐条把 status 改成 ok 并补齐 claim/value/scope 后才可进正文；判不出的置 dropped。",
        "root": str(root),
        "paper": {"title": "", "genre": "T", "model_name": "", "evidence": ev},
        "claims": [],
        "baselines": [],
        "costs": {"gpu_hours": None, "unit_price_assumption": "", "total_usd": None,
                  "tokens": "", "note": ""},
        "git_log": logs,
        "summary": {"files": len(files), "by_kind": by_kind, "todo": len(todo)},
    }
    out = Path(args["out"]) if args.get("out") else root / "evidence-ledger.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "result": {"written": str(out), "summary": ledger["summary"],
                                   "next": "逐条补 claim/value/scope/source，然后跑 paper_lint 交叉核对"}}


def main() -> int:
    raw = sys.stdin.read()
    try:
        args = (json.loads(raw) if raw.strip() else {}).get("args") or {}
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": {"code": "E_BAD_INPUT", "message": str(exc)}}))
        return 2
    if not args.get("path"):
        print(json.dumps({"ok": False, "error": {"code": "E_ARGS", "message": "需要 args.path"}}))
        return 2
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": {"code": "E_RUNTIME", "message": str(exc)}},
                         ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
