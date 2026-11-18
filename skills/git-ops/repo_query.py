#!/usr/bin/env python
"""git-ops 技能的只读仓库查询（免写探针命令）。

子命令白名单，全部只读、零网络：
    state       一次查全：status + diff_stat + log + ahead（发布/提交前的标准第一查）
    status      git status -sb + porcelain 清单
    diff_stat   git diff --stat HEAD（工作树+暂存 vs HEAD，即"将提交什么"）
    log         git log --oneline -10
    ahead       尚未推送到上游的提交（git log @{u}..HEAD）
    branch      当前分支 + 上游
    remote      git remote -v
    tags        本地 tag（按版本序倒排）

所有命令统一带 `-c core.quotepath=false`：默认 setting 下 git 会把非 ASCII 文件名
转义成 `\\350\\275\\254` 这类八进制串，模型读不出中文，于是历史上每次查询都被迫套一层
`python -c "subprocess...encoding='utf-8'"` 再解一遍——实测一个发布会话里这类包装占 52/151
次调用。quotepath=false 直出 UTF-8 原名，那一层包装就整类消失了。

CLI 用法：python skills/git-ops/repo_query.py <sub>
工具执行器用法：exec_query.py 从 stdin 读 {"args":{"query":"..."}}，stdout 回 JSON。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 统一前缀：关闭路径转义，让中文文件名原样输出（见模块 docstring）。
GIT = ["git", "-c", "core.quotepath=false"]

# 白名单：值即完整 argv（只读命令，无用户可控插值 → 无注入面）
COMMANDS: dict[str, list[str]] = {
    "state": GIT + ["status", "-sb", "--porcelain"],
    "status": GIT + ["status", "-sb", "--porcelain"],
    "diff_stat": GIT + ["diff", "--stat", "HEAD"],
    "log": GIT + ["log", "--oneline", "-10"],
    "ahead": GIT + ["log", "--oneline", "@{u}..HEAD"],
    "branch": GIT + ["branch", "--show-current"],
    "remote": GIT + ["remote", "-v"],
    "tags": GIT + ["tag", "--sort=-v:refname"],
}


def _run(argv: list[str], allow_fail: bool = False) -> tuple[str, str]:
    """跑一条只读 git 命令；allow_fail=True 时非零退出回空串（用于「上游不存在」等情形）。"""
    proc = subprocess.run(
        argv,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if proc.returncode != 0 and not allow_fail:
        raise RuntimeError(f"{' '.join(argv)} → exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    return (proc.stdout if proc.returncode == 0 else ""), proc.stderr


def _status() -> dict:
    raw, _ = _run(COMMANDS["status"])
    lines = raw.splitlines()
    dirty = [ln for ln in lines[1:] if ln.strip()]
    return {
        "branch_line": lines[0] if lines else "",
        "dirty": dirty,
        "dirty_count": len(dirty),
        "clean": len(dirty) == 0,
    }


def _branch() -> dict:
    out: dict[str, object] = {"current": _run(COMMANDS["branch"])[0].strip()}
    up, _ = _run(GIT + ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], allow_fail=True)
    out["upstream"] = up.strip() or None
    return out


def query(sub: str) -> dict:
    if sub not in COMMANDS:
        raise ValueError(f"未知子命令 '{sub}'，可选：{' / '.join(COMMANDS)}")
    out: dict[str, object] = {"sub": sub}
    if sub == "state":
        # 发布前的标准第一查：四个视角一次拿全，避免「问一句查一次」的多轮往返。
        st = _status()
        diff, _ = _run(COMMANDS["diff_stat"])
        log, _ = _run(COMMANDS["log"])
        ahead, _ = _run(COMMANDS["ahead"], allow_fail=True)
        out.update(st)
        out["diff_stat"] = diff.rstrip()
        out["log"] = log.rstrip()
        out["ahead"] = [ln for ln in ahead.splitlines() if ln.strip()]
        out["upstream"] = _branch()["upstream"]
    elif sub == "status":
        out.update(_status())
    elif sub == "branch":
        out.update(_branch())
    elif sub == "tags":
        out["output"] = _run(COMMANDS["tags"])[0].rstrip()
        out["list"] = [t for t in out["output"].splitlines() if t.strip()]
    elif sub == "ahead":
        # 无上游（首次推送前）git 会 exit 128，那是正常状态而非错误：回空列表。
        out["output"] = _run(COMMANDS["ahead"], allow_fail=True)[0].rstrip()
        out["list"] = [ln for ln in out["output"].splitlines() if ln.strip()]
    else:
        out["output"] = _run(COMMANDS[sub])[0].rstrip()
    return out


def main(argv: list[str]) -> int:
    try:
        sub = argv[0] if argv else "state"
        print(json.dumps({"ok": True, **query(sub)}, ensure_ascii=False, indent=2))
        return 0
    except Exception as e:  # 不抛 traceback，模型可直接读错误改参数
        print(json.dumps({"ok": False, "error": {"code": "REPO_QUERY_FAILED", "message": str(e)}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
