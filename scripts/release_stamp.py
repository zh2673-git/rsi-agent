"""run.cmd release 启动的变更检测助手。

子命令：
  check <repo> <stamp>   stdout=1 表示需要重编，0 表示可复用现有 exe；exit 0
  stamp <repo> <stamp>   写入当前代码指纹（最新 mtime + 文件数）；exit 0

只扫描**代码文件**：crates/plugins/kernel 下的 .rs/.py/.toml/.ts/.js
以及根 Cargo.toml / Cargo.lock。刻意排除 session.index.json 等运行时数据，
否则每次运行都会写数据文件、导致误判「代码变了」而每次重编。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

CODE_EXTS = {".rs", ".py", ".toml", ".ts", ".js"}
SCAN_DIRS = ("crates", "plugins", "kernel")
ROOT_FILES = ("Cargo.toml", "Cargo.lock")


def _code_files(repo: Path) -> list[Path]:
    out: list[Path] = []
    for name in ROOT_FILES:
        p = repo / "runtime" / name
        if p.is_file():
            out.append(p)
    for d in SCAN_DIRS:
        base = repo / "runtime" / d
        if not base.exists():
            continue
        for root, dirs, files in os.walk(base):
            dirs[:] = [x for x in dirs if x not in {"target", "node_modules", "__pycache__", ".venv", "data"}]
            for f in files:
                if Path(f).suffix.lower() in CODE_EXTS:
                    out.append(Path(root) / f)
    return out


def _fingerprint(repo: Path) -> tuple[float, int]:
    files = _code_files(repo)
    if not files:
        return (0.0, 0)
    return (max(p.stat().st_mtime for p in files), len(files))


def _read_stamp(stamp: Path) -> tuple[float, int] | None:
    try:
        a, b = stamp.read_text(encoding="utf-8").strip().split()
        return (float(a), int(b))
    except Exception:
        return None


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print("usage: release_stamp.py check|stamp <repo> <stamp>", file=sys.stderr)
        return 2
    cmd, repo_s, stamp_s = argv[1], argv[2], Path(argv[3])
    repo = Path(repo_s)
    cur = _fingerprint(repo)
    if cmd == "stamp":
        stamp_s.parent.mkdir(parents=True, exist_ok=True)
        stamp_s.write_text(f"{cur[0]:.6f} {cur[1]}", encoding="utf-8")
        print(f"[rsi] code stamp saved ({cur[1]} files)")
        return 0
    if cmd == "check":
        old = _read_stamp(stamp_s)
        if old is None:
            print(1)
            return 0
        # 浮点写盘有 {:.6f} 舍入（微秒级），用 0.01s 容差避免永远判「变了」
        need = 1 if (cur[0] > old[0] + 0.01 or cur[1] != old[1]) else 0
        print(need)
        return 0
    print(f"unknown cmd: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
