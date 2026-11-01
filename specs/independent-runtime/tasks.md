# Tasks：rsi-agent 独立运行

依赖：已批准的 [spec.md](spec.md)

## 进度

- [x] T1 复制 Rust 运行时
- [x] T2 复制 guest 插件
- [x] T3 复制内核 guest 运行时
- [x] T4 应用快照适配
- [x] T5 根文件与启动脚本
- [x] T6 .gitignore
- [x] T7 README
- [x] T8 验证
- [x] T9 提交与推送

## T1 复制 Rust 运行时

- 新建 `runtime/`，复制 react-agent 的 `Cargo.toml`、`Cargo.lock`。
- 复制 `crates/agent-loop/{Cargo.toml,src,tests}` 与 `crates/host/{Cargo.toml,src,tests,web-dist}`。
- 排除 `target`、PLAN.md、README.md。
- 验收：`runtime/crates/host/web-dist/index.html` 存在；`runtime/Cargo.toml` 成员为两个 crate。

## T2 复制 guest 插件

- 复制 `plugins/assets`（`assets_plugin.py`、`skillkit.py`、`prompts/`、出厂 5 技能）、`plugins/llm_adapter`（代码 + providers）、`plugins/tools`（`tools_plugin.py` + `tools/`）、`plugins/memory`（`memory_plugin.ts`、`guest_sdk.ts`）。
- 排除 `memory/data`、`assets/skills/gongwen-format`、`__pycache__`、`*.pyc`。
- 验收：`runtime/plugins/assets/assets_plugin.py`、`runtime/plugins/tools/tools/files.py`、`runtime/plugins/memory/memory_plugin.ts` 存在。

## T3 复制内核 guest 运行时

- 新建 `runtime/kernel/`，复制 agent-kernel 的 `bindings/python/agent_kernel/`（含 `_proto/`）、`bindings/typescript/{src/index.ts,package.json,package-lock.json,tsconfig.json}`、`schema/kernel.proto`、两份 LICENSE。
- 排除 `node_modules`、`__pycache__`、examples、内核 Rust 源码。
- 验收：`runtime/kernel/bindings/python/agent_kernel/guest.py` 与 `runtime/kernel/schema/kernel.proto` 存在。

## T4 应用快照适配

- 修改 `runtime/plugins/memory/guest_sdk.ts` 导入路径为 `../../kernel/bindings/typescript/src/index.ts`（含注释）。
- 修改 `runtime/plugins/tools/tools/files.py` 的 `_CORE_BLOCKLIST`，加入 `"runtime"`。
- 验收：grep 确认无 `../../../agent-kernel` 残留；黑名单含 `runtime`。

## T5 根文件与启动脚本

- 复制 `SYSTEM.md` 到 `rsi-agent/SYSTEM.md`。
- 新建 `config.example.json`（空 key，全工具启用，agent 段与 spec 一致）。
- 新建 `run.cmd`：设置 6 个 env（SKILLS_DIR/WORKSPACE_ROOT/RSI_LEDGER_DIR/AGENT_KERNEL_REPO/PLUGINS_DIR/CONFIG_FILE），默认 `REACT_FRONTEND=web`，检查 Node、按需 npm install、按需 pip install，最后 `cargo run`。
- 验收：`run.cmd` 无硬编码绝对路径；`%~dp0` 或 `%CD%` 相对仓库根。

## T6 .gitignore

- 追加 runtime 构建产物、运行期目录、node_modules、config.json、*.log。
- 验收：`git status --porcelain` 不出现 `runtime/target`、`runtime/plugins/memory/data`、`runtime/kernel/bindings/typescript/node_modules`、`config.json`。

## T7 README

- 快速开始改为独立运行（run.cmd / Web / REPL / 依赖 / 首次联网）。
- 目录树加入 runtime 与根文件。
- 新增「运行时快照」小节（来源版本、同步步骤、2 处适配、禁止直接改 runtime）。
- 删除「仍需 react-agent」表述。
- 验收：README 不再说接入真实 agent 需要本地 react-agent。

## T8 验证

- `npm install`（在 `runtime/kernel/bindings/typescript`）。
- `cargo build --manifest-path runtime/Cargo.toml -p react-agent-host`。
- mock 单轮：设置 env + `LLM_PROVIDER=mock`，`cargo run ... -- "你好"`，退出码 0 且有回复。
- `python -m unittest discover -s tests -v` → 6 OK。
- `python scripts/skill_validate.py --all --mode full` → 6/6 ok。
- 验收：以上全部通过；构建失败则修复后重验，不跳过。

## T9 提交与推送

- 清理 `__pycache__`。
- `git add` 指定新增/修改文件，创建新提交（不 amend），`git push`。
- 验收：`git status` 干净；GitHub 仓库可见 `runtime/`、`run.cmd`、`SYSTEM.md`、`config.example.json`。
