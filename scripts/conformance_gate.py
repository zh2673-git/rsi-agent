"""生成代码工具的准入闸：tools.json 契约校验 + 可选协议冒烟 + 可选内核套件。

- 静态：字段齐全、名称 kebab/唯一、parameters 为 object、exec 可定位、timeout 合理；
- 冒烟（--smoke）：以 `{"args":{}}` 启动执行体，要求 stdout 是含 `ok` 的 JSON；
- 内核套件（--kernel-suite）：调用 agent-kernel 既有 conformance 测试，不改内核代码。

用法：
    python scripts/conformance_gate.py --skill skills/tdd
    python scripts/conformance_gate.py --skill skills/tdd --smoke --kernel-suite
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import TOOL_ROOT, emit, resolve_skill  # noqa: E402
from skillkit import _tools_errors, parse_frontmatter  # noqa: E402

# 工具名口径（与运行时插件闸单一事实来源，防三方漂移）：
#   runtime/plugins/tools/tools_plugin.py::_SKILL_TOOL_NAME_RE
#     = [A-Za-z][A-Za-z0-9_-]{0,63}
# 准入闸必须与插件**同口径**，否则会出现「过闸但插件拒」或反之——闸的权威性即失效。
# snake_case 是面向模型的可读性建议，降级为 warning（不再作为硬错误）。
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
SNAKE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
MAX_TOOL_NAME = 64
# 内置工具名（模型已熟悉，技能工具不得占用）——与 tools_plugin 的 ALL_TOOLS 同名清单。
RESERVED_NAMES = frozenset({
    "read_file", "write_file", "edit_file", "list_dir", "bash", "web_search", "web_read",
    "grep", "symbols_search", "todo", "load_skill", "skill_install", "task",
})


def _static_checks(skill_dir: Path) -> tuple[list, list, int, str]:
    meta = parse_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8")) or {}
    decl = (meta.get("tools") or "").strip()
    path = skill_dir / (decl if decl else "tools.json")
    if not path.is_file():
        return [], [], 0, ""
    errors = list(_tools_errors(skill_dir, meta))
    warnings = []
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return errors, warnings, 0, decl
    if not isinstance(items, list):
        return errors, warnings, 0, decl
    seen = set()
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        where = f"{path}#item{idx}"
        name = item.get("name")
        if isinstance(name, str):
            if not NAME_RE.match(name):
                errors.append({"code": "E_TOOL_NAME", "path": where,
                               "message": f"工具名非法（须 [A-Za-z][A-Za-z0-9_-]{{0,63}}，与运行时插件闸同口径）: {name}"})
            elif len(name) > MAX_TOOL_NAME:
                errors.append({"code": "E_TOOL_NAME", "path": where, "message": f"工具名超过 {MAX_TOOL_NAME} 字符: {name}"})
            if name in RESERVED_NAMES:
                errors.append({"code": "E_TOOL_NAME_RESERVED", "path": where, "message": f"工具名与内置/保留名冲突（不可覆盖）: {name}"})
            if NAME_RE.match(name) and not SNAKE_RE.match(name):
                warnings.append({"code": "W_TOOL_NAME_STYLE", "path": where,
                                 "message": f"建议用 snake_case（模型更熟悉）: {name}"})
            if name in seen:
                errors.append({"code": "E_TOOL_DUPLICATE", "path": where, "message": f"工具名重复: {name}"})
            seen.add(name)
        params = item.get("parameters")
        if not isinstance(params, dict) or params.get("type") != "object":
            errors.append({"code": "E_TOOL_PARAMS", "path": where, "message": "parameters 必须是 type=object 的 JSON Schema"})
        if len(str(item.get("description", ""))) < 20:
            warnings.append({"code": "W_TOOL_DESC", "path": where, "message": "description 过短，模型难以正确选择"})
        exec_spec = item.get("exec") if isinstance(item.get("exec"), dict) else {}
        timeout = exec_spec.get("timeout_secs")
        if timeout is not None and (not isinstance(timeout, int) or not 1 <= timeout <= 900):
            errors.append({"code": "E_TOOL_TIMEOUT", "path": where, "message": "timeout_secs 必须在 1..900"})
        cwd = exec_spec.get("cwd")
        if cwd:
            target = Path(cwd) if Path(str(cwd)).is_absolute() else skill_dir / str(cwd)
            try:
                target.resolve().relative_to(skill_dir.resolve())
            except ValueError:
                errors.append({"code": "E_TOOL_CWD", "path": where, "message": "cwd 不能越出技能目录"})
    return errors, warnings, len(items), decl


def _smoke(skill_dir: Path) -> tuple[list, list]:
    decl = (parse_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8")) or {}).get("tools")
    path = skill_dir / (decl or "tools.json")
    if not path.is_file():
        return [], []
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return [], []
    errors, warnings = [], []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        cmd = (item.get("exec") or {}).get("cmd")
        if not isinstance(cmd, list) or not cmd:
            continue
        where = f"{path}#item{idx}"
        try:
            proc = subprocess.run(
                cmd, input=json.dumps({"args": {}}), capture_output=True, text=True,
                timeout=min(int((item.get("exec") or {}).get("timeout_secs") or 10), 15),
                cwd=str(skill_dir), encoding="utf-8",
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            errors.append({"code": "E_TOOL_SMOKE_EXEC", "path": where, "message": f"冒烟启动失败: {exc}"})
            continue
        try:
            resp = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {}
        except ValueError:
            warnings.append({"code": "W_TOOL_SMOKE_JSON", "path": where, "message": "stdout 不是单行 JSON（协议可能不符）"})
            continue
        if not isinstance(resp, dict) or "ok" not in resp:
            warnings.append({"code": "W_TOOL_SMOKE_SHAPE", "path": where, "message": "stdout JSON 缺 ok 字段"})
        elif resp.get("ok") is False:
            warnings.append({"code": "W_TOOL_SMOKE_ARGS", "path": where,
                             "message": f"空参数下 ok=false（可接受）: {resp.get('error')}"})
    return errors, warnings


def _kernel_suite(timeout: int = 600) -> dict:
    kernel = TOOL_ROOT / "agent-kernel"
    if not (kernel / "Cargo.toml").is_file():
        return {"ok": False, "error": {"code": "E_KERNEL_ROOT", "message": f"找不到 {kernel}"}}
    try:
        proc = subprocess.run(
            ["cargo", "test", "-p", "agent-kernel-conformance", "--quiet"],
            cwd=str(kernel), capture_output=True, text=True, timeout=timeout, encoding="utf-8",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": {"code": "E_KERNEL_SUITE", "message": str(exc)}}
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-20:]
    return {"ok": proc.returncode == 0, "returncode": proc.returncode, "tail": tail}


def main() -> int:
    ap = argparse.ArgumentParser(description="生成代码工具准入闸")
    ap.add_argument("--skill", required=True)
    ap.add_argument("--smoke", action="store_true", help="以空参数启动执行体，检查协议形状")
    ap.add_argument("--kernel-suite", action="store_true", help="调用 agent-kernel conformance 套件")
    args = ap.parse_args()

    skill_dir = resolve_skill(args.skill)
    if not skill_dir.is_dir():
        emit({"ok": False, "error": {"code": "E_SKILL_DIR", "message": f"目录不存在: {skill_dir}"}})
        return 2
    errors, warnings, count, decl = _static_checks(skill_dir)
    smoke = {"requested": args.smoke}
    if args.smoke:
        smoke_errors, smoke_warnings = _smoke(skill_dir)
        errors.extend(smoke_errors)
        warnings.extend(smoke_warnings)
        smoke["ok"] = not smoke_errors
    kernel = {"requested": args.kernel_suite}
    if args.kernel_suite:
        kernel.update(_kernel_suite())
        if not kernel.get("ok"):
            errors.append({"code": "E_KERNEL_CONFORMANCE", "path": "agent-kernel",
                           "message": "内核 conformance 套件未通过"})
    result = {
        "ok": not errors,
        "skill": skill_dir.name,
        "tools_declared": count,
        "tools_file": decl or ("tools.json" if (skill_dir / "tools.json").is_file() else None),
        "errors": errors,
        "warnings": warnings,
        "smoke": smoke,
        "kernel_suite": kernel,
    }
    emit(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
