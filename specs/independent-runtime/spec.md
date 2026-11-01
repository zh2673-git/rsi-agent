# Spec：rsi-agent 独立运行（内嵌运行时快照）

状态：已批准并完成
日期：2026-11-01

## 1. 目标

让 `rsi-agent` 仓库**克隆即能启动 agent**：不依赖本地 `react-agent` 源码检出，也不依赖本地 `agent-kernel` 检出。

实现方式：把 react-agent 运行时（Rust 宿主 + agent-loop + Python/TS 插件 + Web 静态资源）与 agent-kernel 的 guest 运行时（Python/TS bindings + proto schema）作为**快照**内嵌到 `rsi-agent/runtime/`，并提供一键启动脚本。

非目标：
- 不 fork 新内核，不新增 Rust 第三方依赖。
- 不改变 RSI 语义（技能/评测/账本/晋升逻辑保持原样）。
- 不做自动化同步工具；快照同步方式写入 README。

## 2. 已确认事实（本次调研结论）

- react-agent workspace 版本 0.1.21，成员 `crates/agent-loop`、`crates/host`；内核以 git 依赖 `agent-kernel` tag `v0.1.7`。
- 宿主路径口径（`crates/host/src/config.rs`）：
  - workspace 根 = `CARGO_MANIFEST_DIR` 上溯 2 层 → 快照后为 `rsi-agent/runtime`。
  - `plugins_dir` 缺省 = workspace/plugins → `runtime/plugins`。
  - `kernel_repo` 缺省 = workspace 父目录/agent-kernel；**需用 `AGENT_KERNEL_REPO` 指向 `runtime/kernel`**。
  - `skills_dir` 缺省 = workspace/plugins/assets/skills；**需用 `SKILLS_DIR` 指向 `rsi-agent/skills`**。
  - `config.json` 缺省 = workspace/config.json；**用 `CONFIG_FILE` 指向 `rsi-agent/config.json`**。
  - `.stream` / `.instances` / `outputs` 均锚定编译期 workspace（`runtime/`）。
- Python guest 通过 `PYTHONPATH=<kernel_repo>/bindings/python` 启动；TS guest 通过 `guest_sdk.ts` 相对导入内核 TS SDK。
- 内核 TS SDK 的 proto 路径为 `bindings/typescript/src/../../../schema/kernel.proto` → 快照后必须存在 `runtime/kernel/schema/kernel.proto`。
- 工具写入闸 `plugins/tools/tools/files.py` 的 `_CORE_BLOCKLIST` 以 `WORKSPACE_ROOT` 相对路径判定；若 `WORKSPACE_ROOT=rsi-agent`，必须以 `runtime` 作为整体纳入黑名单，否则 agent 可自改运行体。
- 技能自扩展要求 `SKILLS_DIR` 必须位于 `WORKSPACE_ROOT` 内，否则 `write_file/edit_file` 会触发 `PATH_OUTSIDE_WORKSPACE`。因此 `WORKSPACE_ROOT` 必须是 `rsi-agent` 根目录（而非 `runtime/`）。
- 前端缺省是 REPL；`REACT_FRONTEND=web` 才启动 Web（127.0.0.1:8710）。
- react-agent 的 `config.json` 含真实密钥，**不得复制**。
- react-agent 的 `plugins/memory/data` 为运行期数据；`assets/skills/gongwen-format` 为用户技能；均不复制。

## 3. 目标目录结构（新增部分）

```text
rsi-agent/
├── run.cmd                       # 一键启动（默认 Web）
├── SYSTEM.md                     # 工作区系统提示词（WORKSPACE_ROOT/SYSTEM.md）
├── config.example.json           # 配置样例（无密钥）
├── runtime/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── crates/
│   │   ├── agent-loop/{Cargo.toml,src/,tests/}
│   │   └── host/{Cargo.toml,src/,tests/,web-dist/}
│   ├── plugins/
│   │   ├── assets/{assets_plugin.py,skillkit.py,prompts/,skills/(出厂 5 件)}
│   │   ├── llm_adapter/{llm_plugin.py,presets.py,providers/}
│   │   ├── tools/{tools_plugin.py,tools/}
│   │   └── memory/{memory_plugin.ts,guest_sdk.ts}
│   └── kernel/
│       ├── bindings/python/agent_kernel/{__init__.py,guest.py,_proto/}
│       ├── bindings/typescript/{src/index.ts,package.json,package-lock.json,tsconfig.json}
│       ├── schema/kernel.proto
│       └── LICENSE-MIT, LICENSE-APACHE
└── specs/independent-runtime/{spec.md,tasks.md}
```

## 4. 精确复制清单

### 4.1 从 `react-agent/`

复制：
- `Cargo.toml`、`Cargo.lock`
- `crates/agent-loop/`：`Cargo.toml`、`src/`、`tests/`（不含 PLAN.md、README.md）
- `crates/host/`：`Cargo.toml`、`src/`、`tests/`、`web-dist/`（不含 PLAN.md、README.md）
- `plugins/`：
  - `assets/assets_plugin.py`、`assets/skillkit.py`、`assets/prompts/`、`assets/skills/{project-dev,repo-explorer,tdd,web-research,media-gen}/`
  - `llm_adapter/llm_plugin.py`、`llm_adapter/presets.py`、`llm_adapter/providers/`
  - `tools/tools_plugin.py`、`tools/tools/`
  - `memory/memory_plugin.ts`、`memory/guest_sdk.ts`
- `SYSTEM.md` → 复制到 **`rsi-agent/SYSTEM.md`**（不是 runtime 下）

排除：
- `config.json`（含密钥）
- `target/`、`.instances/`、`.stream/`、`outputs/`、`*.log`
- `plugins/memory/data/`
- `plugins/assets/skills/gongwen-format/`
- 所有 `__pycache__/`、`*.pyc`、`node_modules/`
- 各目录 `PLAN.md`、`README.md`（运行时不需要）

### 4.2 从 `agent-kernel/`

复制到 `runtime/kernel/`：
- `bindings/python/agent_kernel/{__init__.py,guest.py,_proto/}`
- `bindings/typescript/{src/index.ts,package.json,package-lock.json,tsconfig.json}`
- `schema/kernel.proto`
- `LICENSE-MIT`、`LICENSE-APACHE`

排除：`bindings/typescript/examples/`、`node_modules/`、`__pycache__/`、其余内核源码。

## 5. 快照适配（仅 2 处代码改动）

1. `runtime/plugins/memory/guest_sdk.ts`
   - 将 `export ... from "../../../agent-kernel/bindings/typescript/src/index.ts"`
   - 改为 `export ... from "../../kernel/bindings/typescript/src/index.ts"`
   - 注释同步改为「runtime 布局：从 plugins/memory 上溯 2 级到 runtime，再进 kernel」。
2. `runtime/plugins/tools/tools/files.py`
   - `_CORE_BLOCKLIST` 增加 `"runtime"`（注释：RSI 发行形态的运行体快照，整体禁写）。
   - 其余逻辑零改动。

## 6. 新增根文件

### 6.1 `rsi-agent/SYSTEM.md`
从 react-agent 原样复制（保持提示词语义不变）。

### 6.2 `rsi-agent/config.example.json`
形状与宿主 `config.json` 一致，所有密钥留空：

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "base_url": "https://api.openai.com/v1",
    "api_key": ""
  },
  "tools": {
    "enabled": ["read_file","write_file","edit_file","list_dir","bash","web_search","web_read","grep","symbols_search","todo"]
  },
  "agent": {
    "max_rounds": 20,
    "system_prompt": null,
    "history_limit": 0,
    "compact_trigger": 40,
    "compact_keep": 10,
    "tool_result_limit": 4000,
    "budget_secs": 900,
    "token_budget": 0,
    "retry_attempts": 2,
    "retry_base_ms": 500
  }
}
```

### 6.3 `rsi-agent/run.cmd`
逻辑（Windows cmd）：
1. `cd /d <repo>`；计算 `REPO=%CD%`。
2. 设置：
   - `SKILLS_DIR=%REPO%\skills`
   - `WORKSPACE_ROOT=%REPO%`
   - `RSI_LEDGER_DIR=%REPO%\ledger`
   - `AGENT_KERNEL_REPO=%REPO%\runtime\kernel`
   - `PLUGINS_DIR=%REPO%\runtime\plugins`
   - `CONFIG_FILE=%REPO%\config.json`（无条件设置；缺失时宿主按空配置启动，Web 设置面板写入此文件）
   - 若未定义 `REACT_FRONTEND`，设为 `web`
3. 依赖自检：
   - Node：`node --version` 不可用 → 报错退出并提示需 Node >= 22.6。
   - `runtime\kernel\bindings\typescript\node_modules` 不存在 → 在该目录执行 `npm install`。
   - `python -c "import grpc, httpx"` 失败 → `python -m pip install grpcio httpx`。
4. 启动：
   `cargo run --manifest-path "%REPO%\runtime\Cargo.toml" -p react-agent-host %*`
5. 失败时暂停（仅双击场景），并透传 `%*`（透传单轮问题/参数）。

## 7. `.gitignore` 追加

```gitignore
# runtime 快照的构建与运行期产物
runtime/target/
runtime/.stream/
runtime/.instances/
runtime/outputs/
runtime/plugins/memory/data/
runtime/kernel/bindings/typescript/node_modules/
config.json
*.log
```

（`__pycache__/`、`*.pyc` 已有。）

## 8. README 更新

- 「快速开始」改为独立运行：
  - 先复制 `config.example.json` 为 `config.json` 并填模型/密钥（或直接 mock 启动）。
  - 双击/执行 `run.cmd`；Web 地址 `http://127.0.0.1:8710`，REPL 用 `set REACT_FRONTEND=repl`。
  - 首次运行需要网络：cargo 拉取 agent-kernel git 依赖 + npm install。
  - 依赖：Rust stable、Node >= 22.6、Python 3.10+（grpcio/httpx）、npm。
- 删除「接入真实 agent 仍需 react-agent」的表述。
- 目录树加入 `runtime/`、`SYSTEM.md`、`config.example.json`、`run.cmd`。
- 新增「运行时快照」小节：来源（react-agent v0.1.21 + agent-kernel v0.1.7 bindings/schema）、同步步骤（重新复制 + 重放 2 处适配）、禁止直接改 runtime（改了会在下次同步丢失）。

## 9. 验证步骤

1. 结构检查：`runtime/kernel/schema/kernel.proto`、`runtime/kernel/bindings/python/agent_kernel/guest.py`、`runtime/crates/host/web-dist/index.html` 均存在。
2. `runtime/plugins/memory/guest_sdk.ts` 导入路径为 `../../kernel/bindings/typescript/src/index.ts`。
3. 依赖安装：在 `runtime/kernel/bindings/typescript` 执行 `npm install`。
4. 构建：
   `cargo build --manifest-path runtime/Cargo.toml -p react-agent-host`
   （需要网络拉取 agent-kernel git 依赖；失败则记录实际错误，不放宽验收）
5. Mock 单轮冒烟（不依赖真实模型）：
   - 设置上述 env，`$env:LLM_PROVIDER="mock"`；
   - 执行 `cargo run --manifest-path runtime/Cargo.toml -p react-agent-host -- "请回复一句你好"`；
   - 断言进程退出码 0，且输出包含 assistant 回复（mock provider 的固定文案）。
6. Python 自测与技能校验（确认 RSI 层未受影响）：
   - `python -m unittest discover -s tests -v`（6 tests OK）
   - `python scripts/skill_validate.py --all --mode full`（6/6 ok）
7. 安全检查：
   - `git status` 中无 `config.json`、`runtime/target`、`runtime/plugins/memory/data`、`node_modules`。
   - `runtime/` 内无真实密钥（grep `api_key` 仅命中空串/字段名/代码）。
8. 提交并推送：`git add` 指定文件 → 新提交（不 amend）→ `git push`，确认 GitHub 页面出现 `runtime/` 与 `run.cmd`。

## 10. 验收标准

- [x] 在仅克隆 `rsi-agent` 的机器上（无本地 react-agent / agent-kernel 源码），按 README 执行 `run.cmd` 能启动 host。
- [x] `cargo build -p react-agent-host` 成功。
- [x] mock 单轮冒烟退出码 0。
- [x] Python 自测 6/6、技能校验 6/6。
- [x] 无密钥、运行期产物入库。
- [x] README 明确独立运行方式与快照同步规则。

## 11. 风险与处置

| 风险 | 处置 |
|---|---|
| 首次 cargo build 需网络拉取 agent-kernel git 依赖 | README 明确前置网络要求；不 vendored Rust 内核源码 |
| Node 版本过低（<22.6）导致 TS guest 无法启动 | run.cmd 启动前检查 `node --version` 并报错 |
| Python 缺 grpcio/httpx | run.cmd 自检并 pip install |
| 快照与上游漂移 | README 记录来源版本与「重复制 + 重放 2 处适配」流程 |
| runtime 被 agent 自改 | files.py 黑名单加入 `runtime`；SYSTEM.md 原有核心写保护纪律 |
| 大文件（Monaco ~12MB）入库 | 属 Web 编辑器必需静态资源，接受 |
