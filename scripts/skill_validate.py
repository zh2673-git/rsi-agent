"""静态校验 CLI：复用 assets 的 skillkit，输出可定位的 JSON 错误。

用法：
    python scripts/skill_validate.py --skill skills/rsi-steward --mode full
    python scripts/skill_validate.py --all --mode full
    python scripts/skill_validate.py --root skills --name rsi-steward --mode install
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import SKILLS_DIR, emit, resolve_skill  # noqa: E402
from skillkit import validate_skill  # noqa: E402


def _validate(target: Path, mode: str) -> dict:
    result = validate_skill(target, mode)
    result["path"] = str(target)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="技能目录静态校验（install/full 两档）")
    ap.add_argument("--skill", help="技能目录或名称")
    ap.add_argument("--root", default=None, help="skills 根目录（默认 rsi-agent/skills）")
    ap.add_argument("--name", help="技能名（配合 --root）")
    ap.add_argument("--all", action="store_true", help="校验 root 下全部技能")
    ap.add_argument("--mode", default="full", choices=["full", "install"])
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else SKILLS_DIR
    if args.all:
        targets = sorted(p for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())
        results = [_validate(t, args.mode) for t in targets]
        ok = all(r.get("ok") for r in results)
        emit({"ok": ok, "mode": args.mode, "root": str(root), "results": results})
        return 0 if ok else 1

    raw = args.name or args.skill
    if not raw:
        ap.error("需要 --skill / --all / --name")
    target = resolve_skill(raw, root)
    if not target.is_dir():
        emit({"ok": False, "error": {"code": "E_SKILL_DIR", "path": str(target), "message": "技能目录不存在"}})
        return 2
    result = _validate(target, args.mode)
    emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
