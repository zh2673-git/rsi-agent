#!/usr/bin/env python
"""应用工具层补丁（核心区改动，需在宿主停止后由用户执行）。

为什么需要这个脚本：`runtime/` 整树在 `files.py::_CORE_BLOCKLIST` 里（第一项就是 "runtime"），
write_file / edit_file 触碰即 CORE_PROTECTED。这里把补丁做成**幂等、可预演、可回滚**的形式，
由用户显式执行——不是绕闸，是把「需要人决策的核心改动」交到人手里。

用法（宿主停止后，在仓库根）：
    python scripts/apply-tool-patches.py --dry-run     # 只打印将要改什么（推荐先跑）
    python scripts/apply-tool-patches.py               # 实际写入（自动生成 .patchbak）
    python scripts/apply-tool-patches.py --revert      # 从 .patchbak 还原
    python scripts/apply-tool-patches.py --list        # 列出内置 + 外挂补丁

外挂补丁（v8 数据驱动扩展）：`scripts/patches/*.json`，每文件一个补丁，字段
    {"id": "X-xx", "description": "...", "file": "runtime/...（仓库相对路径）",
     "anchor": "被替换的精确原文", "patch": "替换后的原文"}
agent 只写 JSON（scripts/ 在可写区），**执行仍由用户跑本脚本**——预演/回滚/
幂等语义与内置补丁完全一致。同文件多补丁时共享一份 .patchbak，--revert 会把
该文件还原到最初态（覆盖所有已应用补丁）。

补丁清单：
  P1  bash.py     多行命令 fail-loud（MULTILINE_UNSUPPORTED）
  P2  skills.rs   产物段补「中间物不是产物」反向约定
  P3  index.html  max_rounds 输入框 max=64 → max=10000
  P4  bash.py     工具描述（_description 两个分支）加「单行约束 + 专用工具优先」引导
  P5  files.py    核心写保护布尔闸升级为前缀闸（v7，四小项 a-d）：
                  env ALLOW_CORE_WRITE 从 "1"/"0" 升级为逗号分隔的路径前缀列表；
                  _core_write_allowed(real) 前缀匹配 + _CORE_NEVER_ALLOW 永不豁免项
                  （config.json、plugins/memory、.git 在命中授权前缀时仍拒绝）；
                  _guard_write() 报错文案给「按路径授权」指引；模块 docstring 同步 v7。
                  config.rs 的数组映射由 P6 落地；两者共用 env 键 ALLOW_CORE_WRITE，
                  passthrough 白名单无需新增条目。
  P6  config.rs   tools.allow_core_write：布尔（兼容旧配置，false→"0"）或字符串数组
                  （路径前缀列表 → 逗号序列化进同一 env 键）。
  D5  README.md   「快照仅做 4 处适配」→ 5 处：第 5 处 = 细粒度闸三文件改动，
                  数值（放行前缀数）按补丁内容现场统计。

v7 语义：允许列表为空 / 变量缺失 / 值为 "0" / 布尔遗留 "1" → 全部核心路径拒绝
（默认关，fail-closed）；命中列表项 → 放行，但永不豁免项除外。布尔全解禁窗口不复存在。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── P1：bash 多行 fail-loud ───────────────────────────────────────────────────
P1_FILE = ROOT / "runtime/plugins/tools/tools/bash.py"
P1_ANCHOR = '''def _run_bash(args: dict) -> dict:
    command = require(args, "command")
'''
P1_PATCH = '''def _run_bash(args: dict) -> dict:
    command = require(args, "command")
    # cmd.exe /c 只执行首行（换行即命令终止，且不尊重引号）：多行命令的其余行会被
    # **静默丢弃且 exit_code 仍为 0**。静默截断比报错危险得多——模型会基于虚假成功
    # 继续推理。故此处 fail-loud，把问题挡在入口。
    if "\\n" in command or "\\r" in command:
        raise ToolError(
            "bash command 含换行符：cmd.exe /c 只执行首行，其余行会被静默丢弃（exit_code 仍为 0）。"
            "请改用单行 + `&&` / `&` 串联，或拆成多次调用；python 多语句用 `;` 分隔。",
            code="MULTILINE_UNSUPPORTED",
            field="command",
        )
'''

# ── P2：skills.rs 产物段反向约定 ──────────────────────────────────────────────
P2_FILE = ROOT / "runtime/crates/agent-loop/src/skills.rs"
P2_ANCHOR = '''            cfg.output_dir
        ));
        lines.join("\\n")
'''
P2_PATCH = '''            cfg.output_dir
        ));
        // 反向约定（与上面那条成对出现才有约束力）：只讲「成品去哪」时，模型会把
        // 探针/一次性脚本也算作「产物」写进产物目录。实测成因：那类脚本占 file_change
        // 的 46%，且产物目录在 bash 快照排除区（写了连 undo 留痕都没有）。
        lines.push(format!(
            "- Intermediate files (probe / scratch / one-off analysis scripts) are NOT artifacts: do not write them into `{}`. Prefer reading files with the dedicated tools (grep / read_file / symbols_search); if a script is unavoidable, put it under `.scratch/` and delete it when done.",
            cfg.output_dir
        ));
        lines.join("\\n")
'''

# ── P3：index.html 上界 ──────────────────────────────────────────────────────
P3_FILE = ROOT / "runtime/crates/host/web-dist/index.html"
P3_ANCHOR = '''id="agent-max-rounds" type="number" min="1" max="64"'''
P3_PATCH = '''id="agent-max-rounds" type="number" min="1" max="10000"'''

# ── P4：bash 工具描述加「单行 + 专用工具优先」引导 ────────────────────────────
# 依据：opencode 把同样的硬约束写进 bash 工具描述文件（tool/shell/shell.txt），效果优于
# 只写在 system prompt——工具描述随 schema 注入，离调用点最近。沙箱/直跑两个分支都要改。
P4_FILE = ROOT / "runtime/plugins/tools/tools/bash.py"
P4_ANCHOR = '''        "Run a shell command in the workspace (cwd = WORKSPACE_ROOT) via a restricted-token sandbox helper "
        "(reduced privileges, admin groups deny-only; fail-closed). Large output keeps head 40KB + tail 20KB. "
        "Args: command (required), timeout_ms (default 30000, max 60000)."'''
P4_PATCH = '''        "Run a shell command in the workspace (cwd = WORKSPACE_ROOT) via a restricted-token sandbox helper "
        "(reduced privileges, admin groups deny-only; fail-closed). Large output keeps head 40KB + tail 20KB. "
        "Args: command (required), timeout_ms (default 30000, max 60000). "
        "IMPORTANT: command must be a SINGLE line - a newline makes cmd.exe /c run only the first line "
        "and silently drop the rest with exit_code=0; chain steps with && or & instead. "
        "This tool is for running/building/testing, git, process and port queries - do NOT use it for "
        "file operations (reading, writing, editing, searching, listing files); use the dedicated tools "
        "(read_file/write_file/edit_file/grep/list_dir/symbols_search) instead."'''

P4_ANCHOR2 = '''            "Run a shell command in the workspace (cwd = WORKSPACE_ROOT). "
            "Runs with full user permissions - NOT sandboxed (BASH_SANDBOX=off). "
            "Large output keeps head 40KB + tail 20KB. "
            "Args: command (required), timeout_ms (default 30000, max 60000)."'''
P4_PATCH2 = '''            "Run a shell command in the workspace (cwd = WORKSPACE_ROOT). "
            "Runs with full user permissions - NOT sandboxed (BASH_SANDBOX=off). "
            "Large output keeps head 40KB + tail 20KB. "
            "Args: command (required), timeout_ms (default 30000, max 60000). "
            "IMPORTANT: command must be a SINGLE line - a newline makes cmd.exe /c run only the first line "
            "and silently drop the rest with exit_code=0; chain steps with && or & instead. "
            "This tool is for running/building/testing, git, process and port queries - do NOT use it for "
            "file operations (reading, writing, editing, searching, listing files); use the dedicated tools "
            "(read_file/write_file/edit_file/grep/list_dir/symbols_search) instead."'''

# ── P5：files.py 布尔闸 → 前缀闸（v7，三文件同改之一：解释器） ────────────────
P5_FILE = ROOT / "runtime/plugins/tools/tools/files.py"
P5_ANCHOR = '''def _core_write_allowed() -> bool:
    return os.environ.get("ALLOW_CORE_WRITE", "").strip() == "1"
'''
P5_PATCH = '''# 永不豁免项（v7）：即使命中放行前缀也拒绝——密钥与运行配置、trace 记忆（随回滚撤销
# 的对偶面：撤销不该抹掉记忆）、版本库（防篡改历史/回退能力）。
_CORE_NEVER_ALLOW = (
    "config.json",
    "plugins/memory",
    ".git",
)


def _core_write_prefixes() -> tuple[str, ...]:
    """ALLOW_CORE_WRITE = 逗号分隔的工作区相对路径前缀列表；空/"0" → 空（默认关）。"""
    raw = os.environ.get("ALLOW_CORE_WRITE", "").strip()
    if not raw or raw in ("0", "1"):  # "1" 是 v6 布尔遗留，不再全解禁
        return ()
    return tuple(p.strip().replace("\\\\", "/").strip("/").lower() for p in raw.split(",") if p.strip())


def _is_never_allow(rel_low: str) -> bool:
    return any(rel_low == e or rel_low.startswith(e + "/") for e in _CORE_NEVER_ALLOW)


def _core_write_allowed(real: Path) -> bool:
    """v7 前缀闸：命中放行前缀且不在永不豁免项内才放行；空/未命中一律拒绝（fail-closed）。"""
    prefixes = _core_write_prefixes()
    if not prefixes:
        return False
    try:
        rel = real.relative_to(workspace_root())
    except ValueError:
        return False
    rel_low = os.path.normcase(str(rel)).replace("\\\\", "/")
    for p in prefixes:
        if rel_low == p or rel_low.startswith(p + "/"):
            return not _is_never_allow(rel_low)
    return False
'''
P5_ANCHOR2 = '''def _guard_write(real: Path, path_str: str) -> Path:
    """写入闸（write_file/edit_file 专用）：核心黑名单默认拒绝，ALLOW_CORE_WRITE=1 放行。"""
    if _core_write_allowed():
        return real
    if _is_core_path(real):
        raise ToolError(
            f"核心路径写入被拒绝: '{_display(real)}'——这是 agent 自身的运行体（宿主源码/内核"
            "插件/内置工具/配置），自扩展只能走固定途径（skills 目录写 SKILL.md、技能目录放 "
            "tools.json、plugins/tools/ 顶层放新工具 .py、config.json 声明 mcp_servers）。"
            "确需修改核心请直接向用户说明，由用户自行修改或显式开启 ALLOW_CORE_WRITE=1。",
            code="CORE_PROTECTED",
            field="path",
        )
    return real
'''
P5_PATCH2 = '''def _guard_write(real: Path, path_str: str) -> Path:
    """写入闸（write_file/edit_file 专用）：核心黑名单默认拒绝；env ALLOW_CORE_WRITE 为
    逗号分隔前缀列表时，命中前缀且不在永不豁免项内的路径放行（v7 细粒度授权）。"""
    if _is_core_path(real) and not _core_write_allowed(real):
        rel = _display(real).replace("\\\\", "/").lower()
        hit = next((p for p in _core_write_prefixes() if rel == p or rel.startswith(p + "/")), None)
        extra = f"；授权前缀 '{hit}' 命中，但该路径属于永不豁免项" if hit else ""
        raise ToolError(
            f"核心路径写入被拒绝{extra}: '{_display(real)}'——这是 agent 自身的运行体（宿主源码/内核"
            "插件/内置工具/配置），自扩展只能走固定途径（skills 目录写 SKILL.md、技能目录放 "
            "tools.json、config.json 声明 mcp_servers）。"
            "确需修改核心请直接向用户说明，由用户自行修改，或按路径授权：config.json "
            'tools.allow_core_write 填前缀列表（如 ["runtime/crates/agent-loop"]，'
            "config.json 与 plugins/memory 永不豁免），改后重启 host 生效。",
            code="CORE_PROTECTED",
            field="path",
        )
    return real
'''

# ── P5c：黑名单尾注补永不豁免声明（_CORE_BLOCKLIST 元组结尾） ─────────────────
P5_ANCHOR3 = '''# 说明：plugins/tools 顶层不在黑名单——L2 自扩展通道（放新 .py 工具模块），
# 仅内置模块名（files/bash/web/grep/symbols/mcp/__init__）在 _is_core_path 内单独保护。
'''
P5_PATCH3 = '''# 说明：plugins/tools 顶层不在黑名单——历史上是 L2 自扩展通道（放新 .py 工具模块），
# 但本仓库 plugins/ 在 runtime/ 整树禁写区内，该通道实际不可达（已收口，见 SYSTEM.md）；
# 仅内置模块名（files/bash/web/grep/symbols/mcp/todo/__init__）在 _is_core_path 内单独保护。
'''

# ── P5d：files.py 模块 docstring 的 v6 布尔逃生舱文案同步 v7 ─────────────────
P5_ANCHOR4 = '''v6 核心写保护（2026-09-08，自扩展安全边界）：write_file/edit_file 追加「核心路径黑名单」
——agent 自扩展只能走四条固定途径（SKILL.md / 技能 tools.json / plugins/tools/*.py 新
文件 / config.json 的 mcp_servers），对 agent 自身运行体（crates 源树、memory/llm_adapter
插件、内置工具实现、config.json、.git）的写入默认拒绝（fail-closed）。技能根目录（自扩展
主通道）显式豁免。逃生舱：env ALLOW_CORE_WRITE=1（config.json tools.allow_core_write 持久
通道映射，改后重启 host 生效）。诚实边界：bash 间接写不经此闸（靠 SYSTEM.md 纪律 + bash
沙箱兜底）。
'''
P5_PATCH4 = '''v6 核心写保护（2026-09-08，自扩展安全边界）：write_file/edit_file 追加「核心路径黑名单」
——agent 自扩展只能走三条固定途径（SKILL.md / 技能 tools.json / config.json 的 mcp_servers），
对 agent 自身运行体（crates 源树、memory/llm_adapter 插件、内置工具实现、config.json、.git）
的写入默认拒绝（fail-closed）。技能根目录（自扩展主通道）显式豁免。v7 升级为前缀闸：env
ALLOW_CORE_WRITE = 逗号分隔的路径前缀列表（config.json tools.allow_core_write 填数组，持久
通道映射，改后重启 host 生效），命中前缀且不在 _CORE_NEVER_ALLOW（config.json、
plugins/memory、.git 永不豁免）内才放行；空 / "0" / 布尔遗留 "1" 一律拒绝。诚实边界：
bash 间接写不经此闸（靠 SYSTEM.md 纪律 + bash 沙箱兜底）。
'''

# ── P6：config.rs 布尔 → 数组/布尔双形态（persistent 通道） ───────────────────
P6_FILE = ROOT / "runtime/crates/host/src/config.rs"
P6_ANCHOR = '''    if let Some(allow) = cfg.get("tools").and_then(|t| t.get("allow_core_write")).and_then(Value::as_bool) {
        set("ALLOW_CORE_WRITE", if allow { "1".to_string() } else { "0".to_string() });
    }
'''
P6_PATCH = '''    // tools.allow_core_write 双形态（v7 细粒度授权）：布尔 false → "0"；字符串数组 →
    // 逗号分隔的路径前缀列表（如 ["runtime/crates/agent-loop"]）。guests 经
    // passthrough_env 继承同一 ALLOW_CORE_WRITE 键，files.py 按前缀解释（见 P5）。
    if let Some(v) = cfg.get("tools").and_then(|t| t.get("allow_core_write")) {
        if let Some(paths) = v.as_array() {
            let items: Vec<String> = paths.iter().filter_map(Value::as_str).map(str::to_string).collect();
            if !items.is_empty() {
                set("ALLOW_CORE_WRITE", items.join(","));
            }
        } else if let Some(false) = v.as_bool() {
            set("ALLOW_CORE_WRITE", "0".to_string());
        }
    }
'''

# ── D5：README 适配表第 5 行（数值现场统计，防文档漂移） ──────────────────────
D5_FILE = ROOT / "README.md"
D5_ANCHOR = '''4. `runtime/plugins/tools/tools/bash.py` 新增 `_shell_cwd()`：子进程 cwd 剥掉 `\\\\?\\` 扩展长度前缀再校验可用性（不可用即 `BAD_WORKSPACE` fail-closed）。原因：宿主 `instances.rs` 用 `canonicalize()` 写 `WORKSPACE_ROOT` 会带该前缀，而 Windows `cmd.exe` 拒绝 UNC 形态并**静默改在 `C:\\Windows` 执行且 exit=0**（错目录 + 越界写 + 追溯失效三重危害）。

同步方式：从对应版本的 react-agent / agent-kernel 重新复制上述文件，再重放这 4 处适配。'''
D5_PREFIXES = "runtime/crates/agent-loop, runtime/crates/host, runtime/plugins/tools/tools, runtime/plugins/memory/guest_sdk.ts, runtime/plugins/assets"
D5_NEVER = "config.json / plugins/memory / .git"
D5_PATCH = f'''4. `runtime/plugins/tools/tools/bash.py` 新增 `_shell_cwd()`：子进程 cwd 剥掉 `\\\\?\\` 扩展长度前缀再校验可用性（不可用即 `BAD_WORKSPACE` fail-closed）。原因：宿主 `instances.rs` 用 `canonicalize()` 写 `WORKSPACE_ROOT` 会带该前缀，而 Windows `cmd.exe` 拒绝 UNC 形态并**静默改在 `C:\\Windows` 执行且 exit=0**（错目录 + 越界写 + 追溯失效三重危害）。
5. `runtime/plugins/tools/tools/files.py` + `runtime/crates/host/src/config.rs` 核心写保护升级为前缀闸：`tools.allow_core_write` 接受字符串数组（路径前缀列表，缺省仍全禁；config.json / plugins/memory / .git 永不豁免），`files.py::_CORE_NEVER_ALLOW`（{D5_NEVER}）与 `_core_write_allowed()`/`_guard_write()` 同改。放行前缀共 {len(D5_PREFIXES.split(", "))} 条：{D5_PREFIXES}。

同步方式：从对应版本的 react-agent / agent-kernel 重新复制上述文件，再重放这 5 处适配。'''

PATCHES = (
    ("P1", "bash.py 多行 fail-loud", P1_FILE, P1_ANCHOR, P1_PATCH),
    ("P2", "skills.rs 产物段反向约定", P2_FILE, P2_ANCHOR, P2_PATCH),
    ("P3", "index.html max_rounds 上界", P3_FILE, P3_ANCHOR, P3_PATCH),
    ("P4a", "bash.py 描述(沙箱分支) 加单行+替代引导", P4_FILE, P4_ANCHOR, P4_PATCH),
    ("P4b", "bash.py 描述(直跑分支) 加单行+替代引导", P4_FILE, P4_ANCHOR2, P4_PATCH2),
    ("P5a", "files.py 闸解释器 v7（_core_write_allowed + 前缀解析）", P5_FILE, P5_ANCHOR, P5_PATCH),
    # P5b 已退役（2026-11-03）：目标终态早已生效且锚点漂移，验证外迁至外挂 P5B-VERIFY。
    ("P5c", "files.py 黑名单尾注收口（L2 通道已移除）", P5_FILE, P5_ANCHOR3, P5_PATCH3),
    ("P5d", "files.py 模块 docstring 同步 v7（四途径→三途径 + 前缀闸）", P5_FILE, P5_ANCHOR4, P5_PATCH4),
    ("P6", "config.rs allow_core_write 数组/布尔双形态", P6_FILE, P6_ANCHOR, P6_PATCH),
    ("D5", "README.md 适配表第 5 行（细粒度闸）", D5_FILE, D5_ANCHOR, D5_PATCH),
)


def _load_external() -> list[tuple[str, str, Path, str, str]]:
    """v8：scripts/patches/*.json 外挂补丁（agent 只写 JSON，执行仍由用户跑本脚本）。

    单个外挂文件格式错误 → 打印 SKIP 并跳过，不影响内置补丁与其它外挂补丁。
    """
    out: list[tuple[str, str, Path, str, str]] = []
    pdir = ROOT / "scripts" / "patches"
    if not pdir.is_dir():
        return out
    for jf in sorted(pdir.glob("*.json")):
        try:
            d = json.loads(jf.read_text(encoding="utf-8"))
            out.append((
                str(d["id"]),
                str(d.get("description", jf.stem)),
                ROOT / str(d["file"]),
                str(d["anchor"]),
                str(d["patch"]),
            ))
        except Exception as e:  # 外挂文件损坏不能拖垮整个补丁流程
            print(f"[{jf.name}] SKIP 外挂补丁格式错误: {e}")
    return out


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _bak(p: Path) -> Path:
    return p.with_suffix(p.suffix + ".patchbak")


def apply(dry: bool) -> int:
    failed = 0
    for pid, desc, path, anchor, patch in tuple(PATCHES) + tuple(_load_external()):
        if not path.is_file():
            print(f"[{pid}] SKIP 文件不存在: {path}")
            failed += 1
            continue
        src = _read(path)
        if patch in src:
            print(f"[{pid}] OK   已应用过（幂等跳过）: {desc}")
            continue
        if anchor not in src:
            print(f"[{pid}] FAIL 锚点未命中（源码已漂移，需人工核对）: {path}")
            print(f"       期望锚点: {anchor.splitlines()[0][:80]}")
            failed += 1
            continue
        if dry:
            print(f"[{pid}] DRY  将替换 1 处: {desc}  ({path.relative_to(ROOT)}）")
            continue
        if not _bak(path).exists():
            shutil.copy2(path, _bak(path))
        path.write_text(src.replace(anchor, patch, 1), encoding="utf-8")
        print(f"[{pid}] APPLY 已写入: {desc}  ({path.relative_to(ROOT)}，备份 {_bak(path).name})")
    return 1 if failed else 0


def revert() -> int:
    n = 0
    for pid, desc, path, _a, _p in tuple(PATCHES) + tuple(_load_external()):
        bak = _bak(path)
        if not bak.exists():
            print(f"[{pid}] SKIP 无备份可还原: {desc}")
            continue
        shutil.copy2(bak, path)
        bak.unlink()
        print(f"[{pid}] REVERT 已还原: {desc}")
        n += 1
    return 0 if n else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="应用/预演/回滚工具层核心补丁")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写盘")
    ap.add_argument("--revert", action="store_true", help="从 .patchbak 还原")
    ap.add_argument("--list", action="store_true", help="列出内置与外挂补丁（不执行）")
    ns = ap.parse_args(argv)
    if ns.list:
        print("内置：")
        for pid, desc, path, _a, _p in PATCHES:
            print(f"  [{pid}] {desc}  ({path.relative_to(ROOT)})")
        ext = _load_external()
        print(f"外挂（scripts/patches/*.json）：{len(ext)} 个")
        for pid, desc, path, _a, _p in ext:
            print(f"  [{pid}] {desc}  ({path.relative_to(ROOT)})")
        return 0
    if ns.revert:
        return revert()
    rc = apply(ns.dry_run)
    if rc == 0 and not ns.dry_run:
        print("\n下一步：重启宿主（cargo build + 前端重打包），否则测的是旧二进制。")
    return rc


if __name__ == "__main__":
    sys.exit(main())
