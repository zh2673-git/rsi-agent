# Spec：工具调用完整性（tool-call integrity）

状态：已批准（待实施）
日期：2026-11-02
触发：用户要求「按 RSI 的要求审计工具调用并优化」

## 1. 背景

rsi-agent 要开启自迭代，第一层是**工具调用**：模型能做什么、做错时错在哪、改坏了有没有证据。
本规格只处理工具调用的**正确性缺陷**（执行层），不动启用/装载流程与技能认知层（单点改动纪律）。

## 2. 审计结论（均为实测，非推断）

### D1 致命：`bash` 在带 `\\?\` 前缀的工作区里静默跑在 `C:\Windows`

- 观测：当前会话 `WORKSPACE_ROOT=\\?\D:\ZH\vibe code\test\1102`（`echo` 确认）。
- 探针（`_probe/probe_cwd.py`）：
  - `subprocess.run(shell=True, cwd="\\\\?\\D:\\ZH\\...")` → stderr
    `CMD.EXE was started with the above path as the current directory. UNC paths are not supported.
     Defaulting to Windows directory.`，stdout `C:\Windows`，**exit=0**；
  - 同一命令换成无前缀 cwd → stdout 为真实工作区，stderr 空。
- 归因链：`runtime/crates/host/src/instances.rs:171` 用 `ws.canonicalize()` 写 `WORKSPACE_ROOT`
  （Windows 产出 `\\?\` 扩展长度前缀）→ `tools/bash.py:_run_direct/_run_sandboxed` 把该值原样
  当 `cwd` 传给 cmd.exe → cmd.exe 拒绝 UNC 形态、退回 `C:\Windows`。
- 危害叠加三重：
  1. **静默错目录执行**：`exit_code=0` 让模型以为成功，实际命令在系统目录跑（`cd`/相对路径全偏）；
  2. **越界写**：命令写到工作区之外（`_guard` 只拦 `write_file/edit_file`，bash 不受其保护）；
  3. **追溯失效**：`_scan_zone` 扫的是工作区，越界改动不进 `changes[]`，undo 快照拿不到。
- 违反 RSI 的 I（不变量）：工具声明的 `cwd = WORKSPACE_ROOT` 与实际行为不符。

### D2 致命：`run_tests` 无上界等待，且超时不回收子进程

- `skills/tdd/run_tests.py:90` `subprocess.run(cmd, cwd=ws, capture_output=True, ...)`
  **无 `timeout`** → 挂死的测试套件会一直占住插件线程。
- 插件侧 `tools.json` 声明 `timeout_secs: 900`，到点后 `tools_plugin._exec_command` 只
  `proc.kill()` 杀 **python 主进程**，pytest/cargo 孙进程可能残留 → 时空闭环（init/destroy 配对）被破坏。
- 这与 tdd 技能自己宣称的不变量（「新增循环/后台任务有退出路径吗」）直接冲突。

### D3 严重：`run_tests` 跑的不是项目约定的测试命令

- `_detect` 只要看到 `tests/` 目录就选 `python -m pytest`；rsi-agent 的约定命令是
  `python -m unittest discover -s tests`（README / spec / tasks 全一致）。
- 实测：在工作区跑 `run_tests` → `profile=pytest` → pytest 把 `_repo/.../repo-rsi/tests/test_phase34.py`
  等嵌套同名文件一起收集 → `2 errors`、`passed=false`。而 `python -m unittest discover -s tests`
  是 `6 tests OK`。
- 结论：**验证工具（Q 执行器）报的结论与项目真实状态相反** —— 基线假红会让整个 P/Q/I 环失效。

### D4 中等：工具名口径三方漂移

| 位置 | 正则 |
|---|---|
| `scripts/conformance_gate.py:26` | `^[a-z][a-z0-9_]*$`（snake_case） |
| `runtime/plugins/tools/tools_plugin.py:146` | `[A-Za-z][A-Za-z0-9_-]{0,63}` |
| `scripts/vendor/skillkit.py:20`（技能名） | `^[a-z0-9]+(-[a-z0-9]+)*$`（kebab） |

同一份 `tools.json` 可能「过准入闸但被插件拒」，或反之。准入闸的权威性因此不成立。

### D5 观测：工具层没有可回归的验收案例

`policies/skill-contract.schema.json` 的 `acceptance.check` 有 `assert/test/...`，但内置 9 件工具
不属于任何 skill → **工具层零用例**。RSI 自迭代要改工具，却没有任何 E2 证据来源。

## 3. 目标与非目标

目标：
- 修 D1/D2/D3/D4，使工具声明与行为一致、验证工具报真话、工具名口径统一。
- 补 D5：为工具层建可回归的确定性用例（RSI 的 Validate/Evaluate 证据来源）。

非目标（明确不做）：
- 不改 `tools.enabled` / `load_skill` 装载与启用流程（流程层，另轮）。
- 不改 SKILL.md 的规则表述（认知层，另轮）。
- 不改 Rust 宿主（重编译代价高；D1 在 guest 侧归一即可，见 §4）。
- 不引入新依赖。

## 4. 方案

### 4.1 快照适配第 3 处（唯一 runtime 改动）：`bash.py` cwd 归一

`runtime/plugins/tools/tools/bash.py`：
- 新增 `_shell_cwd()`：取 `workspace_root()`，剥 `\\?\`（含 `\\?\UNC\` → `\\`）前缀、`/`→`\`
  归一，再校验 `os.path.isdir`；**不可用即 `ToolError`（fail-closed）**，绝不回落系统目录。
- `_run_direct` / `_run_sandboxed` 的 `cwd=` 改用 `_shell_cwd()`。
- `_SANDBOX_HELPER` 由 import 期常量改为 `_sandbox_helper()` 惰性读取（可测试注入；
  spawn 期 env 已固定，行为不变）；`_SANDBOXED` 仅保留给描述文本。

> 为何在 guest 侧修而不修 host：host 的 `canonicalize()` 是通用行为（子实例/Web 切工作区都依赖），
> 改它影响面大且需重编译；`cmd.exe` 不认 `\\?\` 是**执行体特有**约束，拦截点应落在执行点。

### 4.2 `skills/tdd/run_tests.py`

- 抽出 `run(args)`（纯函数，返回契约 dict），`main()` 只做 stdin/stdout —— 可测试。
- 新增 `timeout_secs` 参数（默认 900、上限 900，与 `tools.json` 对齐）；超时
  **杀进程树**（Windows `taskkill /T /F`，其余 `kill` 进程组）并返回
  `{ok:true, result:{passed:false, timeout:true, ...}}`。
- 探测口径修正（修 D3）：`pytest` 仅在其清单存在时命中；`tests/` 目录含 `test_*.py`
  时改用 `unittest discover -s tests`（与 rsi-agent 约定一致）；`profile` 枚举加 `unittest`。
- 结果增 `profile_reason`，说明为什么选这个 profile（可审计）。

### 4.3 `scripts/conformance_gate.py`

`NAME_RE` 与插件闸统一为 `[A-Za-z][A-Za-z0-9_-]{0,63}`；snake_case 降级为 warning
（模型友好命名建议），不再作为硬错误。

### 4.4 新增 `tests/test_tool_contract.py`（D5 证据）

确定性用例（E2）：
- `_shell_cwd()`：剥前缀、目录可用、不可用即 fail-closed；
- `run_tests`：超时必返回且 `timeout:true`、`NO_PROFILE`/`BAD_EXTRA` 契约不变、
  rsi-agent 形态工作区探测为 `unittest`；
- 口径一致性：`conformance_gate.NAME_RE` 与 `tools_plugin` 源码里的字符类一致；
- 防漂移：`skills/tdd/tools.json` 的 `timeout_secs` == `run_tests.py` 的 `MAX_TIMEOUT`。

## 5. 验收（P/Q/I）

- **P**：基线 `python -m unittest discover -s tests` = 6 OK（已测，绿）；
  `python -m pytest` 在工作区因嵌套同名 `test_phase34.py` 报 2 collection errors —— **既有失败，非本次引入**。
- **Q**：新增用例全绿；`_shell_cwd()` 在 `\\?\` 下返回 cmd 可用路径（探针复验）；
  `run_tests` 超时用例 <2s 返回且 `timeout:true`。
- **I**：`python -m unittest discover -s tests` 仍全绿（6+新用例）；`skill_validate.py --all` 不退化；
  `tools.json` 契约不变（仅新增可选 `timeout_secs` 参数语义，向后兼容）。

## 6. 生效条件（是否需要重启）

| 改动对象 | 生效方式 | 需重启？ |
|---|---|---|
| `runtime/plugins/tools/tools/*.py`（内置工具实现） | tools guest 是**子进程**，import 期装载；`reload` op 跳过 `_BUILTIN_MODULES` | **是**（重启 host 或该 guest） |
| `skills/<x>/tools.json` 执行体（如 `run_tests.py`） | 每次调用新起子进程，读盘即最新 | **否** |
| `skills/<x>/SKILL.md` | `skills.list` 每轮重扫 | **否**（下一轮对话） |
| `config.json tools.enabled` | `configure` op 热替换白名单 | **否** |
| `config.json` 的 `mcp_servers` / `media` / `allow_core_write` | 持久通道 → env，guest spawn 期固化 | **是** |
| `scripts/*.py`、`tests/*.py` | 独立进程，无缓存 | **否** |
| `runtime/crates/**`（Rust） | 需重编译 | **是**（且需 `cargo build`） |

## 7. 风险

| 风险 | 处置 |
|---|---|
| 第 3 处快照适配在下次同步 `runtime/` 时丢失 | spec/tasks 登记为**必重放项**；`tests/test_tool_contract.py` 会在丢失时变红 |
| `unittest` 探测对非 rsi 仓库误判 | 仅在无 pytest 清单且 `tests/` 下有 `test_*.py` 时启用；结果带 `profile_reason` 可审计；可显式 `profile=pytest` 覆盖 |
| `taskkill /T` 在非 Windows 不可用 | 按 `os.name` 分支，其余平台用 `killpg` |
