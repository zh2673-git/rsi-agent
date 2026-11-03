#!/usr/bin/env python
"""git-ops 技能的只读仓库查询（免写探针命令）。

子命令白名单，全部只读、零网络：
    status      git status -sb + porcelain 清单
    diff_stat   git diff --stat HEAD（工作树+暂存 vs HEAD，即"将提交什么"）
    log         git log --oneline -10
    remote      git remote -v
    branch      当前分支 + 上游

CLI 用法：python skills/git-ops/repo_query.py <sub>
工具执行器用法：exec_query.py 从 stdin 读 {"args":{"query":"..."}}，stdout 回 JSON。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 白名单：值即完整 argv（只读命令，无用户可控插值 → 无注入面）
COMMANDS: dict[str, list[str]] = {
    "status": ["git", "status", "-sb", "--porcelain"],
    "diff_stat": ["git", "diff", "--stat", "HEAD"],
    "log": ["git", "log", "--oneline", "-10"],
    "remote": ["git", "remote", "-v"],
    "branch": ["git", "branch", "--show-current"],
}


def _run(argv: list[str]) -> str:
    proc = subprocess.run(
        argv,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} → exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    return proc.stdout


def query(sub: str) -> dict:
    if sub not in COMMANDS:
        raise ValueError(f"未知子命令 '{sub}'，可选：{' / '.join(COMMANDS)}")
    out: dict[str, object] = {"sub": sub}
    raw = _run(COMMANDS[sub])
    if sub == "status":
        lines = raw.splitlines()
        # 首行是 -sb 的分支行，其余为 porcelain 清单
        out["branch_line"] = lines[0] if lines else ""
        out["dirty"] = [ln for ln in lines[1:] if ln.strip()]
        out["clean"] = len(out["dirty"]) == 0
    elif sub == "branch":
        out["current"] = raw.strip()
        try:
            out["upstream"] = _run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).strip()
        except (RuntimeError, subprocess.TimeoutExpired):
            out["upstream"] = None
    else:
        out["output"] = raw.rstrip()
    return out


def main(argv: list[str]) -> int:
    try:
        sub = argv[0] if argv else "status"
        print(json.dumps({"ok": True, **query(sub)}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:  # 不抛 traceback，模型可直接读错误改参数
        print(json.dumps({"ok": False, "error": {"code": "REPO_QUERY_FAILED", "message": str(e)}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
