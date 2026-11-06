# -*- coding: utf-8 -*-
"""按编号应用 Q 轮外挂补丁，支持 --dry-run / --revert；与既有内置+13 个补丁互不干扰。

直接复用 scripts/apply-tool-patches.py 的 _read / _bak 语义；补丁集位于
scripts/patches/q-round/（避免影响历史补丁的幂等基线）。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDIR = ROOT / "scripts" / "patches" / "q-round"

spec = importlib.util.spec_from_file_location(
    "apply_tool_patches", ROOT / "scripts" / "apply-tool-patches.py"
)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def load(prefix: str = "") -> list[tuple[str, str, Path, str, str]]:
    out: list[tuple[str, str, Path, str, str]] = []
    for jf in sorted(PDIR.glob("*.json")):
        if prefix and not jf.name.startswith(prefix):
            continue
        d = json.loads(jf.read_text(encoding="utf-8"))
        if d.get("create"):
            continue
        # anchor / patch 可直接给短字符串，也可指向 blocks/ 下的纯文本块：
        # 长 JS/Rust 代码块无需 JSON 转义，降低锚点写错的概率。
        def field(key: str, file_key: str) -> str:
            if file_key in d:
                return (PDIR / str(d[file_key])).read_text(encoding="utf-8")
            return str(d[key])
        out.append((str(d["id"]), str(d.get("description", jf.stem)),
                    ROOT / str(d["file"]),
                    field("anchor", "anchor_file"), field("patch", "patch_file")))
    return out


def _qbak(path: Path) -> Path:
    # 与历史补丁的 .patchbak 区分：runtime/ 下已有前几轮遗留的 .patchbak，
    # 复用会让本轮「无备份」判断失真、revert 回到错误的历史态。
    return path.with_suffix(path.suffix + ".qpatchbak")


def apply(dry: bool, prefix: str = "") -> int:
    failed = 0
    for jf in sorted(PDIR.glob("*.json")):
        if prefix and not jf.name.startswith(prefix):
            continue
        import json
        d = json.loads(jf.read_text(encoding="utf-8"))
        if d.get("create"):
            path = ROOT / str(d["file"])
            content = (PDIR / str(d["content_file"])).read_text(encoding="utf-8")
            marker = str(d.get("create_marker", ""))
            if path.exists() and (marker in path.read_text(encoding="utf-8") if marker else path.read_text(encoding="utf-8") == content):
                print(f"[{d['id']}] OK   已创建（幂等跳过）: {d['description']}")
                continue
            if dry:
                print(f"[{d['id']}] DRY  将创建: {d['description']}  ({path.relative_to(ROOT)})")
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.encode("utf-8"))
            print(f"[{d['id']}] CREATE 已写入: {d['description']}  ({path.relative_to(ROOT)})")
            continue
    for pid, desc, path, anchor, patch in load(prefix):
        if not path.is_file():
            print(f"[{pid}] SKIP 文件不存在: {path}")
            failed += 1
            continue
        src = mod._read(path)
        if patch in src:
            print(f"[{pid}] OK   已应用过（幂等跳过）: {desc}")
            continue
        if anchor not in src:
            print(f"[{pid}] FAIL 锚点未命中: {path}")
            print(f"       期望锚点: {anchor.splitlines()[0][:100]}")
            failed += 1
            continue
        if dry:
            print(f"[{pid}] DRY  将替换 1 处: {desc}  ({path.relative_to(ROOT)})")
            continue
        bak = _qbak(path)
        if not bak.exists():
            shutil.copy2(path, bak)
        path.write_bytes(src.replace(anchor, patch, 1).encode("utf-8"))
        print(f"[{pid}] APPLY 已写入: {desc}  ({path.relative_to(ROOT)}，备份 {bak.name})")
    return 1 if failed else 0


def revert(prefix: str = "") -> int:
    n = 0
    seen: set[Path] = set()
    for pid, desc, path, _a, _p in load(prefix):
        bak = _qbak(path)
        if path in seen or not bak.exists():
            print(f"[{pid}] SKIP 无备份可还原: {desc}")
            continue
        shutil.copy2(bak, path)
        bak.unlink()
        seen.add(path)
        print(f"[{pid}] REVERT 已还原: {desc}")
        n += 1
    return 0 if n else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Q 轮补丁（预演/应用/回滚）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--prefix", default="", help="只处理该文件名前缀的补丁（按阶段分批验证）")
    ns = ap.parse_args(argv)
    if ns.list:
        for pid, desc, path, _a, _p in load(ns.prefix):
            print(f"  [{pid}] {desc}  ({path.relative_to(ROOT)})")
        return 0
    if ns.revert:
        return revert(ns.prefix)
    return apply(ns.dry_run, ns.prefix)


if __name__ == "__main__":
    sys.exit(main())
