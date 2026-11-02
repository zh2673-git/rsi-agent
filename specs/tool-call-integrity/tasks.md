# Tasks：工具调用完整性

依赖：[spec.md](spec.md)（已批准）

## 进度

- [x] T1 基线取证（P）
- [x] T2 bash cwd 归一（D1）
- [x] T3 run_tests 超时 + 探测口径（D2/D3）
- [x] T4 工具名口径统一（D4）
- [x] T5 工具层确定性用例（D5）
- [x] T6 回归验证（Q/I）

## T1 基线取证（P）

- `python -m unittest discover -s tests` → 6 OK（绿）。
- `python -m pytest` → 2 collection errors（嵌套同名 `test_phase34.py`）——记录为既有失败。
- `python scripts/skill_validate.py --all --mode full` → 6/6 ok（仅 warning）。
- 探针 `_probe/probe_cwd.py` 复现 `\\?\` → `C:\Windows` 且 exit=0。
- 验收：基线状态写进 spec §5，后续只与它比对。✅

## T2 bash cwd 归一（D1）

- `runtime/plugins/tools/tools/bash.py` 新增 `_shell_cwd()`：剥 `\\?\`（含 `\\?\UNC\`）、
  归一分隔符、`isdir` 校验、失败 `ToolError`（fail-closed）。
- `_run_direct` / `_run_sandboxed` 改用 `_shell_cwd()`。
- `_SANDBOX_HELPER` / `_SANDBOXED` → `_sandbox_helper()` / `_sandboxed()` 惰性读取。
- 验收：实测 `echo %CD%` 在 `\\?\` 工作区下输出真实工作区；目录不存在抛 `BAD_WORKSPACE`。✅

## T3 run_tests 超时 + 探测口径（D2/D3）

- 抽 `run(args) -> dict` 纯函数；`main()` 只做协议收发。
- 增 `timeout_secs`（默认/上限 900），超时杀**进程树**（`taskkill /T /F` / `killpg`）并返回
  `timeout:true, passed:false`。
- `_detect` 修正：`pytest` 需清单文件；`tests/` 含 `test_*.py` 时用
  `unittest discover -s tests`；`profile` 枚举加 `unittest`；返回 `profile_reason`。
- 验收：rsi-agent 形态工作区探测为 `unittest` 且 `passed=true`；挂死套件 2.5s 返回、无孤儿进程。✅

## T4 工具名口径统一（D4）

- `scripts/conformance_gate.py` `NAME_RE` 改为 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`（与插件闸同口径）。
- snake_case 违规降级为 `W_TOOL_NAME_STYLE` warning；新增 `E_TOOL_NAME_RESERVED`（内置/保留名冲突）。
- 验收：`conformance_gate.py --skill skills/tdd --smoke` ok；口径一致性由用例守护。✅

## T5 工具层确定性用例（D5）

- 新增 `tests/test_tool_contract.py`（24 例中的 18 例）：`_shell_cwd` 四例、`run_tests` 契约六例、
  口径一致性四例、声明防漂移三例、端到端协议一例。
- 验收：`python -m unittest discover -s tests` 24/24 OK。✅

## T6 回归验证（Q/I）

- `python -m unittest discover -s tests` → 24 tests OK（基线 6 + 新增 18）。
- `python scripts/skill_validate.py --all --mode full` → 6/6 ok，无新增 warning。
- `python scripts/conformance_gate.py --skill skills/tdd --smoke` → ok，0 error。
- 验收：三项全过。✅

## 迭代记录

- 2026-11-02：D1–D5 修复完成并回归通过。发现并修复一个自查缺陷：`_SANDBOXED` 原先在 import 期
  固化，`importlib.reload` 后不会跟随 env 变化（宿主装配与运行期不一致时描述/分支会失真）→
  改为 `_sandboxed()` 惰性求值。

## 快照同步必重放项（新增登记）

下次从 react-agent 重新复制 `runtime/` 时，除既有 3 处（`guest_sdk.ts` 导入路径、
`files.py` 的 `_CORE_BLOCKLIST` 加 `runtime`、`config.rs` 的 `apply_rsi_layout_defaults`），
**必须重放第 4 处**：`tools/bash.py` 的 `_shell_cwd()`（剥 `\\?\` 前缀 + fail-closed 校验）。
丢失时 `tests/test_tool_contract.py::ShellCwdTest` 会变红。README「运行时快照」已同步为 4 处。
