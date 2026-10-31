"""rsi-agent 脚本共享基础设施（标准库 only）。

职责：定位目录、读取 config/rsi.toml、复用 assets 的 skillkit、提供 JSON 输出约定。
不封装业务规则——校验/评分/账本规则仍在各自脚本里，保持可读。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
RSI_ROOT = _SCRIPTS.parent
TOOL_ROOT = RSI_ROOT.parent
SKILLS_DIR = RSI_ROOT / "skills"
CONFIG_PATH = RSI_ROOT / "config" / "rsi.toml"

# skillkit 单一事实来源：assets guest 与本地脚本共用；仓库内 vendored 副本优先，
# 保证单独克隆 rsi-agent 后脚本可直接运行。
_VENDOR = _SCRIPTS / "vendor"
if (_VENDOR / "skillkit.py").is_file():
    sys.path.insert(0, str(_VENDOR))
else:
    sys.path.insert(0, str(TOOL_ROOT / "react-agent" / "plugins" / "assets"))

DEFAULT_CONFIG = {
    "lifecycle": {"min_cases": 3, "max_skill_lines": 120},
    "eval": {"pass_threshold": 0.80, "baseline_tolerance": 0.05, "trigger_threshold": 0.90},
    "recall": {"limit": 5},
    "promotion": {"external_signals": ["E1", "E2", "E3"], "require_human_for": ["tools", "core"]},
    "retire": {"min_uses": 5, "min_success_rate": 0.50, "idle_days": 30, "fail_streak": 2},
    "review": {"lookback_days": 30, "correction_days": 7, "interval_days": 30},
    "ab": {"tolerance": 0.05, "min_fixed": 1},
    "quota": {"max_active": 8, "max_total": 20},
    "budget": {"max_rounds": 20, "max_attempts": 3},
}


def load_config() -> dict:
    cfg = {k: dict(v) for k, v in DEFAULT_CONFIG.items()}
    if not CONFIG_PATH.is_file():
        return cfg
    try:
        import tomllib
    except ImportError:  # pragma: no cover - Python < 3.11
        return cfg
    try:
        with CONFIG_PATH.open("rb") as fh:
            data = tomllib.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[rsi] config/rsi.toml 读取失败，使用默认值: {exc}", file=sys.stderr)
        return cfg
    for section, values in data.items():
        if isinstance(values, dict):
            cfg.setdefault(section, {}).update(values)
    return cfg


def ledger_dir() -> Path:
    return Path(os.environ.get("RSI_LEDGER_DIR") or (RSI_ROOT / "ledger"))


def evidence_dir() -> Path:
    return ledger_dir() / "evidence"


def resolve_skill(name_or_path: str, root: Path | None = None) -> Path:
    """接受目录名（在 skills 根内解析）或绝对/相对路径。"""
    p = Path(name_or_path)
    if p.is_dir():
        return p.resolve()
    root = root or Path(os.environ.get("SKILLS_DIR") or SKILLS_DIR)
    return (root / name_or_path).resolve()


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def emit(obj) -> None:
    print(dumps(obj))


def fail(code: str, message: str, path: str = "") -> dict:
    return {"ok": False, "error": {"code": code, "path": path, "message": message}}
