"""技能源仓库 → 本仓 skills/ 部署副本的一致性检查与同步。

背景：部分技能有独立的源仓库（sibling，如 `skills/tool/deepseek-paper`），
本仓 `skills/<name>/` 是运行时实际加载的部署副本（SKILLS_DIR 指向本仓 skills/，
见 scripts/rsi_common.py:17）。此前没有任何机制保证两者不漂移——
2026-11 一次核对发现内容一致纯属巧合（差异只在 CRLF/LF），
下次源仓库有提交就会静默落后。

本脚本只做两件事：
  1. `--check`：逐文件比对（规范化行尾与 BOM 后按字节），报出漂移，退出码非 0；
  2. `--sync` ：把源仓库内容复制到部署副本（默认 dry-run，需 --write 才落盘）。

刻意不做的事：
  - 不生成/改写 skill.json（那是 skill_state/import_skill 的职责，二者语义不同）；
  - 不删除部署副本多出的文件，除非 --prune 显式要求（避免误删本地调试物）。

用法：
    python scripts/sync_skills.py --check
    python scripts/sync_skills.py --check --skill deepseek-paper
    python scripts/sync_skills.py --sync --skill deepseek-paper --write
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import SKILLS_DIR, TOOL_ROOT, emit  # noqa: E402

# 源仓库在兄弟目录；键=技能名，值=源仓库内的技能根（相对 TOOL_ROOT）
SOURCE_MAP = {
    "deepseek-paper": "deepseek-paper",
    "law-application": "law-application",
}

# 源仓库独有、不进部署副本的条目（相对源仓库根的路径前缀）。
# 判定依据：这些是"仓库自用资产"，运行时加载技能不需要它们；
# 部署进 skills/ 只会让运行时目录膨胀。
#   docs/     案例研究（case-selfhost 一个案例就 27 个文件 / 数百 KB）
#   LICENSE   仓库法务文件
#   README.md 仓库说明（技能对外说明是 SKILL.md）
#   .gitignore 源仓库的忽略规则
DEPLOY_EXCLUDE = {".gitignore", "LICENSE", "README.md", "docs"}

_SKIP_NAMES = {"__pycache__", ".git", ".DS_Store"}
_SKIP_SUFFIX = {".pyc", ".pyo"}


def _norm(path: Path) -> bytes:
    """读文件并规范化行尾与 BOM，用于跨 CRLF/LF 的等价比较。"""
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def _is_excluded(rel: str) -> bool:
    """部署排除：源仓库自用资产（docs/、LICENSE 等）不参与比对也不下发。"""
    top = rel.split("/", 1)[0]
    return top in DEPLOY_EXCLUDE


def _walk(root: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(part in _SKIP_NAMES for part in p.parts):
            continue
        if p.suffix in _SKIP_SUFFIX:
            continue
        rel = p.relative_to(root).as_posix()
        if _is_excluded(rel):
            continue
        out[rel] = p
    return out


def diff_skill(name: str, src_root: Path, dst_root: Path) -> dict:
    if not src_root.is_dir():
        return {"skill": name, "ok": False, "code": "E_SOURCE_MISSING",
                "source": str(src_root), "dest": str(dst_root)}
    if not dst_root.is_dir():
        return {"skill": name, "ok": False, "code": "E_DEST_MISSING",
                "source": str(src_root), "dest": str(dst_root)}

    src = _walk(src_root)
    dst = _walk(dst_root)

    only_src = sorted(set(src) - set(dst))
    only_dst = sorted(set(dst) - set(src))
    changed = sorted(r for r in set(src) & set(dst) if _norm(src[r]) != _norm(dst[r]))

    drifted = bool(only_src or only_dst or changed)
    return {
        "skill": name,
        "ok": not drifted,
        "code": "E_DRIFT" if drifted else "OK",
        "source": str(src_root),
        "dest": str(dst_root),
        "files_src": len(src),
        "files_dest": len(dst),
        # 源仓库有、部署副本缺（最危险：功能缺失）
        "only_in_source": only_src,
        # 部署副本有、源仓库无（本地调试残留，未必是错）
        "only_in_dest": only_dst,
        # 两边都有但内容不同（真漂移）
        "content_differs": changed,
    }


def apply_sync(name: str, src_root: Path, dst_root: Path, prune: bool) -> dict:
    src = _walk(src_root)
    written, pruned = [], []

    for rel, sp in src.items():
        dp = dst_root / rel
        if dp.is_file() and _norm(dp) == _norm(sp):
            continue
        dp.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sp, dp)
        written.append(rel)

    if prune:
        for rel, dp in _walk(dst_root).items():
            if rel not in src:
                dp.unlink()
                pruned.append(rel)

    return {"skill": name, "ok": True, "written": written, "pruned": pruned}


def main() -> int:
    ap = argparse.ArgumentParser(description="技能源仓库与部署副本一致性检查/同步")
    ap.add_argument("--check", action="store_true", help="只检查（默认）")
    ap.add_argument("--sync", action="store_true", help="复制源仓库到部署副本")
    ap.add_argument("--write", action="store_true", help="--sync 时真正落盘（否则 dry-run）")
    ap.add_argument("--prune", action="store_true", help="同步后删除部署副本多出的文件")
    ap.add_argument("--skill", default=None, help="只处理指定技能")
    args = ap.parse_args()

    names = [args.skill] if args.skill else list(SOURCE_MAP)
    unknown = [n for n in names if n not in SOURCE_MAP]
    if unknown:
        emit({"ok": False, "code": "E_UNKNOWN_SKILL", "skills": unknown,
              "known": list(SOURCE_MAP)})
        return 2

    results = []
    for name in names:
        src_root = (TOOL_ROOT / SOURCE_MAP[name]).resolve()
        dst_root = (SKILLS_DIR / name).resolve()
        r = diff_skill(name, src_root, dst_root)
        if args.sync:
            if not r.get("ok") and r.get("code") == "E_DRIFT":
                if args.write:
                    r["applied"] = apply_sync(name, src_root, dst_root, args.prune)
                else:
                    r["applied"] = {"dry_run": True,
                                    "would_write": r["only_in_source"] + r["content_differs"],
                                    "would_prune": r["only_in_dest"] if args.prune else []}
            elif r.get("ok"):
                r["applied"] = {"noop": True}
        results.append(r)

    all_ok = all(r.get("ok") for r in results)
    emit({"ok": all_ok, "skills_dir": str(SKILLS_DIR), "results": results})
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
