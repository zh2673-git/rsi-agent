"""导入适配器（Phase 1）：把现有技能目录转成 rsi-agent 标准目录。

职责边界：
- 只做结构转换：复制目录 + 从 frontmatter 生成 `skill.json`；
- 不重写 SKILL.md 内容，不编造验收标准（acceptance 为空 = 不可自动晋升）；
- 无 evals/cases.jsonl → `verification=unverified` + `legacy=true`（可用、不可晋升）。

用法：
    python scripts/import_skill.py --source ../react-agent/plugins/assets/skills/tdd
    python scripts/import_skill.py --source <dir> --dest skills --force
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import date
from pathlib import Path

# 复用 assets guest 的 skillkit（单一事实来源；与 react-agent 是同级目录）
_TOOL_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_TOOL_ROOT / "react-agent" / "plugins" / "assets"))
from skillkit import parse_frontmatter  # noqa: E402


def _copy_ignore(_dir: str, names: list[str]) -> list[str]:
    return [n for n in names if n == "__pycache__" or n.endswith(".pyc")]


def import_skill(source: Path, dest_root: Path, force: bool = False) -> dict:
    if not (source / "SKILL.md").is_file():
        return {"ok": False, "error": {"code": "E_SKILL_MD_MISSING", "message": f"{source} 缺少 SKILL.md"}}
    meta = parse_frontmatter((source / "SKILL.md").read_text(encoding="utf-8"))
    if meta is None:
        return {"ok": False, "error": {"code": "E_FRONTMATTER", "message": "frontmatter 缺 name/description"}}
    name = meta["name"]
    target = dest_root / name
    if target.exists() and not force:
        return {"ok": False, "error": {"code": "E_DEST_EXISTS", "message": f"{target} 已存在（--force 覆盖）"}}
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=_copy_ignore)

    has_evals = (target / "evals" / "cases.jsonl").is_file()
    contract = {
        "name": name,
        "version": "0.1.0",
        "status": "draft",
        "description": meta["description"],
        "triggers": [],
        "inputs": [],
        "outputs": [],
        # 适配器不编造验收：空数组表示尚未建立可执行判据，candidate 前必须补齐
        "acceptance": [],
        "requires": [],
        "handoff": [],
        "verification": "unverified",
        "source_level": "unverified",
        "created_at": date.today().isoformat(),
        "parent": None,
        "legacy": True,
        "source": {"path": str(source), "imported_at": date.today().isoformat()},
    }
    (target / "skill.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "skill": name,
        "dest": str(target),
        "has_evals": has_evals,
        "verification": "unverified",
        "legacy": True,
        "note": "导入完成：可直接使用，但缺验收/案例前不可自动晋升",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="把现有技能导入 rsi-agent/skills（结构转换）")
    ap.add_argument("--source", required=True, help="现有技能目录（含 SKILL.md）")
    ap.add_argument("--dest", default=str(Path(__file__).resolve().parents[1] / "skills"), help="目标 skills 根目录")
    ap.add_argument("--force", action="store_true", help="目标已存在时覆盖")
    ap.add_argument("--json", action="store_true", default=True, help="JSON 输出（默认开启）")
    args = ap.parse_args()
    result = import_skill(Path(args.source), Path(args.dest), args.force)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
