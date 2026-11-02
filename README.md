# rsi-agent

基于 [react-agent](https://github.com/zh2673-git/react-agent) 的 RSI 发行形态：预置技能 + 技能生产线 + 评测/证据 + 晋升策略。
**不是第三个内核**，也不直接建在 [agent-kernel](https://github.com/zh2673-git/agent-kernel) 上。

## 三者关系

| 层 | 项目 | 职责 | RSI 中的位置 |
|---|---|---|---|
| 运行时 | agent-kernel | 插件隔离、调度、契约、conformance | 只提供「生成代码工具」的准入证 |
| 执行体 | react-agent | ReAct 循环、工具、资产、记忆、Web | 提供执行与观测能力 |
| 发行形态 | **rsi-agent** | 预置技能、生产线、评测、账本、晋升 | RSI 语义都在这一层 |

```text
用户 / Web
   ↓
react-agent host（ReAct + tools + assets + memory）
   ↓ 插件
agent-kernel（空间 / 时间 / 规则）
   ↑
rsi-agent：skills/ + policies/ + ledger/ + config/
```

**改造边界**：react-agent 只改 host 装配、assets 校验/状态、agent-loop 验收三个接缝；agent-kernel 零代码改动；creat-skill / project-dev 原目录不改，使用 vendored 副本。

## 文档

| 文档 | 内容 |
|---|---|
| [program.md](program.md) | 开发契约（生产模式），决策记录 |
| [docs/00-项目简介与架构图.md](docs/00-项目简介与架构图.md) | 理念、三层关系、RSI 闭环、评估三角色、分层矩阵 |
| [docs/01-项目方案.md](docs/01-项目方案.md) | 本质定义、时空契约、第0级映射、愿景 |
| [docs/02-架构设计.md](docs/02-架构设计.md) | 三层关系、被否决方案、目录与技术选型 |
| [docs/03-模块设计.md](docs/03-模块设计.md) | 生产线、校验、评测、账本、晋升、预置技能包 |
| [docs/04-技能生产线四层设计.md](docs/04-技能生产线四层设计.md) | 契约/案例/状态机/晋升的详细设计 |
| [docs/05-评测与记忆四层设计.md](docs/05-评测与记忆四层设计.md) | run_evals、判分、账本、复盘、记忆边界 |
| [docs/06-重构与技能优化清单.md](docs/06-重构与技能优化清单.md) | agent-kernel / react-agent / 两个 skill 的改法 |
| [docs/07-实施路线与验收.md](docs/07-实施路线与验收.md) | Phase 0-4、交付物、P/Q/I、风险 |

## 目录规划

```text
rsi-agent/
├── program.md
├── README.md
├── run.cmd                # 一键启动（默认 Web）
├── SYSTEM.md              # 工作区系统提示词（WORKSPACE_ROOT/SYSTEM.md）
├── config.example.json    # 配置样例（无密钥）
├── config.magpie.json     # 可选：magpie 免费模型上游档（retry_attempts=1）
├── docs/
├── specs/                 # 规格与任务记录
├── policies/              # skill-contract / eval-case / ledger schema + lifecycle + promotion
├── config/                # rsi.toml、skills.lock.json
├── skills/                # 预置与自产技能（SKILLS_DIR）
│   ├── rsi-steward/       # 十阶段生产线编排
│   ├── skill-eval/        # 案例 / rubric / 基线
│   ├── creat-skill/       # vendored：技能编译器
│   ├── project-dev/       # vendored：项目方法论编排
│   ├── repo-explorer/     # project-dev 依赖
│   └── tdd/               # project-dev 依赖（含 run_tests 工具）
├── ledger/                # 工作账本（运行时生成，不进 git；evidence/proposals/reports/review 同）
├── scripts/               # skill_validate / run_evals / ledger / skill_state / conformance_gate /
│                          # import_skill / skill_ab / usage_report / dashboard / rsi_routine / health_report
└── runtime/               # react-agent 运行时快照（内嵌，勿直接改）
    ├── crates/            # host + agent-loop（Rust）
    ├── plugins/           # memory / llm-adapter / tools / assets
    ├── kernel/            # agent-kernel guest bindings（Python/TS）+ schema/kernel.proto
    ├── Cargo.toml
    └── Cargo.lock
```

## 快速开始（独立运行）

本仓库已内嵌运行时快照（`runtime/`），单独克隆即可启动 agent，无需本地 react-agent / agent-kernel 检出。

前置依赖：Rust stable、Node.js 22.6+、Python 3.10+、npm。
首次构建需要联网：cargo 拉取 agent-kernel 的 git 依赖，`run.cmd` 自动在 `runtime/kernel/bindings/typescript` 执行 `npm install`，并自动安装 Python 依赖 `grpcio httpx`。

```powershell
# 1) 配置（可选；不配置时默认 mock provider）
Copy-Item config.example.json config.json
# 编辑 config.json 填 provider / model / base_url / api_key

# 2) 一键启动 Web 端（双击 run.cmd 亦可；4 秒后自动打开浏览器）
.\run.cmd
# → http://127.0.0.1:8710（端口可用 WEB_ADDR 覆盖）

# 若 config.json 的 base_url 指向本机 magpie（127.0.0.1:3425）：
# run.cmd 检测到网关未运行会自动拉起 magpie serve（最小化窗口），无需手动执行。

# REPL
set REACT_FRONTEND=repl; .\run.cmd

# 单轮
.\run.cmd "你好"
```

启动后在网页里完成全部配置（无需改文件）：

1. 右上角 **⚙ 设置 → LLM**：`provider` 选 `openai 兼容`，「站点」选 **magpie 本地网关（免费额度）** → base_url / 令牌自动预填 → 点 **保存**（热生效，零重启）。
2. 若网关未运行，LLM 卡片里会出现 **一键启动**（等同 `magpie serve`），点一下即可。
3. 点 **拉取模型** 列表里选模型（如 `workbuddy/glm-5.3-flash`），再 **保存**。
4. 积分：LLM 卡片下方按账户显示 WorkBuddy / Trae CN 各窗口剩余额度与重置日期。
5. 同一页可切换「工具 / 技能 / Agent」标签配置白名单、技能与运行参数，保存即热生效。

`run.cmd` 会设置 `SKILLS_DIR` / `WORKSPACE_ROOT` / `RSI_LEDGER_DIR` / `AGENT_KERNEL_REPO` / `PLUGINS_DIR` / `CONFIG_FILE`，并把 `WORKSPACE_ROOT` 锚定到本仓库根目录（技能目录因此可被 agent 自扩展写入）。

**也可以不用脚本，直接像 react-agent 那样裸跑**（host 启动时检测到内嵌布局会自动补齐上面 6 个锚点，显式 env 仍最优先）：

```powershell
cd runtime
$env:REACT_FRONTEND="web"; cargo run -p react-agent-host   # → http://127.0.0.1:8710
```

裸跑与 `run.cmd` 的差别只在便利性：`run.cmd` 额外做依赖检查、自动拉起 magpie 网关、自动开浏览器。

脚本工具（校验 / 评测 / 账本）不依赖 host，可直接运行：

```powershell
python scripts/skill_validate.py --all --mode full
python scripts/run_evals.py --skill rsi-steward --set-baseline
python scripts/skill_ab.py --skill rsi-steward --a 0.1.0 --b 0.2.0
python scripts/ledger.py query --skill rsi-steward --keyword 周报
python scripts/skill_state.py show --name rsi-steward
python scripts/usage_report.py                     # 使用率 + 退役候选（--apply --yes 执行）
python scripts/rsi_routine.py scan --auto-propose  # 外部信号 → 复盘提案
python scripts/rsi_routine.py queue
python scripts/health_report.py                    # 月度健康报告
python scripts/dashboard.py                        # dashboard/index.html
```

自测：

```powershell
python -m unittest discover -s tests -v
```

## 运行时快照

`runtime/` 是以下版本的运行时代码快照，**请勿直接修改**（升级时按下面的同步流程重放）：

- [react-agent](https://github.com/zh2673-git/react-agent) v0.1.21：`crates/agent-loop`、`crates/host`（含 web-dist）、`plugins`（memory / llm-adapter / tools / assets）。
- [agent-kernel](https://github.com/zh2673-git/agent-kernel) v0.1.7：`bindings/python`、`bindings/typescript`、`schema/kernel.proto`。

快照仅做 3 处适配：

1. `runtime/plugins/memory/guest_sdk.ts` 的导入路径改为 `../../kernel/bindings/typescript/src/index.ts`；
2. `runtime/plugins/tools/tools/files.py` 的 `_CORE_BLOCKLIST` 增加 `runtime`（禁止 agent 自改运行体）。
3. `runtime/crates/host/src/config.rs` 新增 `apply_rsi_layout_defaults()`（`main.rs` 启动时调用）：检测到内嵌布局（`runtime/kernel/bindings/python` + 上级 `skills/`、`config.json`）时自动补齐 `AGENT_KERNEL_REPO` / `PLUGINS_DIR` / `SKILLS_DIR` / `WORKSPACE_ROOT` / `CONFIG_FILE` / `RSI_LEDGER_DIR`——否则裸 `cargo run` 会因 kernel 与运行时不同级而找不到 `agent_kernel` 模块（K700）。非内嵌布局（独立的 react-agent 快照）不触发，行为不变。

同步方式：从对应版本的 react-agent / agent-kernel 重新复制上述文件，再重放这 3 处适配。

## 可选：magpie 免费模型上游

> [magpie](https://github.com/yetone/magpie) 是"路由层"，**不是免费模型来源**；免费额度来自 magpie 里配置的 provider（API key 型）。接入后获得多源故障转移，长评测不再被单供应商 429 打断。
>
> 这是**可选增强**：不进 `runtime/` 依赖链，不内嵌二进制，默认 mock/直连仍可独立运行。

账户边界（R6 硬门）：

```text
账户 A（magpie-run，标准用户，计划任务常驻）
  magpie serve                                 # 只有网关，不暴露 /api；默认就在 127.0.0.1:3425
  %USERPROFILE%\.config\magpie\providers.json  # 免费额度 key

账户 B（日常账户，rsi-agent）
  run.cmd → LLM_BASE_URL=http://127.0.0.1:3425/v1
  读不到 A 的 profile，只能经回环 HTTP 消费
```

接入三步：

```powershell
# 1) 账户 A：创建本地用户、安装 magpie、配置免费额度 provider，然后常驻 serve
schtasks /create /tn "magpie-gateway" /tr "<magpie>\magpie.exe serve" /ru magpie-run /sc onstart /rl limited

# 2) 账户 B：确认 Phase 0 硬门（端点 / 只回环 / 管理面不可达 / 密钥隔离）
python scripts/magpie_check.py --magpie-user magpie-run --skip-smoke

# 3) 账户 B：复制 magpie 档，把模型 id 换成 /v1/models 里的真实 id，再启动
Copy-Item config.magpie.json config.json
.\run.cmd "你好"
```

全量冒烟（chat / stream / tool_calls / usage / abort），网关不可达时返回 blocked（退出码 2）：

```powershell
python scripts/magpie_check.py
```

必须遵守：

- 只用 `magpie serve`，**不要用 `magpie web`**——`web` 会把管理面 `/api/*` 暴露给本机任何进程，agent 有 bash 时可反写 magpie 配置。
- 不要启用 LAN / `0.0.0.0`；回环即边界（回环下 token 任意值都收，`api_key` 只是占位）。
- 不要接"内置订阅"——magpie 已把订阅类内置退役（触供应商条款），这类只能走社区插件。
- `retry_attempts` 用 1：故障转移交给 magpie，避免重试叠加造成重复计费。

### 额度来源：CodeBuddy / Trae / opencode

三个来源在 magpie 里的形态不同，provider id 与模型 id（`provider/model`）在 `magpie models` 里查实：

| 来源 | provider id | 谁提供 | 说明 |
| --- | --- | --- | --- |
| opencode Zen | `opencode-zen` | magpie 内置 relay（`NoKey`） | 免费模型（`-free`、`big-pickle`）免密钥；也可用社区插件 `opencode-zen-free` |
| Trae CN | `trae-cn` | 社区插件 `@magpie-community/opencode-trae-auth`（无内置、无 mover） | 每日签到 100 credits；9074/9095 当日即终局，不重试 |
| CodeBuddy 套餐 | `workbuddy` / `workbuddy-ai` | 社区插件 `@magpie-community/opencode-workbuddy-auth` | 国内 codebuddy.cn（WorkBuddy 国内版 = CodeBuddy 套餐）、国际 codebuddy.ai |

账户 A（`magpie-run`）里安装与登录：

```powershell
magpie provider add opencode-zen                              # 免密钥，无需登录
magpie plugin add workbuddy                                   # 或全名 @magpie-community/opencode-workbuddy-auth
magpie plugin login workbuddy                                 # 浏览器登 codebuddy.cn / workbuddy.cn
magpie plugin add @magpie-community/opencode-trae-auth         # Trae 不在 market 清单里，必须给全名
magpie plugin login trae-cn                                   # 用本机 Trae CN 客户端的 device id 签到
magpie plugin list
magpie models
```

坑：WorkBuddy/CodeBuddy 本机登录态在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，若 `accessToken` 是 `$wbEncrypted` 对象（凭据保护开启），magpie 读不了（`wbString` 只认纯字符串），必须用 `magpie plugin login` 自己登一次。

本机实测（2026-11-02）：三条免费链路全部跑通，登录态就绪：

- **Trae CN**：装插件后 `magpie plugin login trae-cn` 走本机客户端本地授权，自动完成（账户 行知日记，每日签到 100 积分，`magpie quota` 可查）。模型 `trae-cn/glm-5.3-flash` 等 90 个，`tool_calls` 正常。
- **WorkBuddy（CodeBuddy 套餐）**：桌面凭据 5.6+ 加密读不了，必须浏览器登录。CLI 交互式选项需保持 stdin 打开（管道 `echo 1 |` 会 EOF 退出）。登录后 `workbuddy/glm-5.3-flash` 等 16 个模型可用（账户 zh2673，免费档 500 订阅积分 + 5000 附加积分，11-30 重置）。
- **插件宿主 Bun**：插件运行依赖 Bun 1.4.2，GitHub 直连失败时 magpie 不会自动走镜像——预下载 `registry.npmmirror.com/-/binary/bun/bun-v1.4.2/bun-windows-x64-baseline.zip`（sha256 校验清单见 magpie 源码 `internal/plugin/bun.go`），解压出 `bun.exe` 放到 `~\.cache\magpie\bun\1.4.2\magpie-bun.exe` 即可（名字必须带 `magpie-` 前缀）。
- 未登录可选：`workbuddy-ai`（国际版）、`trae-global`

### Web 界面里的 magpie（自带前端集成，无需独立控制台）

rsi-agent 自带 web 前端（`REACT_FRONTEND=web`，默认 `http://127.0.0.1:8710`）已直接集成 magpie：

- **站点预设**：⚙ 设置 → LLM → 「站点」下拉选 **magpie 本地网关（免费额度）**，base_url / api_key（任意令牌）自动预填，保存即热生效；「拉取模型」列出全部 84 个模型，model 下拉直接切换。
- **本地网关卡片**：base_url 为本机回环时出现——状态灯（`运行中 · N 个模型` / `未运行`）+ **一键启动**（幂等 spawn `magpie serve`，日志落 config 同目录 `.magpie-serve.log`，找不到 magpie.exe 时提示设 `MAGPIE_EXE` 或装到 `%USERPROFILE%\.local\bin`）。
- **积分行**：按账户显示各窗口剩余百分比 + display 额度 + 重置日（WorkBuddy zh2673 / Trae CN 行知日记）。积分按账户计不按模型计——同账户所有模型共享积分池。

实现：站点清单在 [presets.py](runtime/plugins/llm_adapter/presets.py)；网关端点 `GET /api/upstream/status`（探活 + `/v1/magpie/quotas`、`/v1/magpie/usage?period=30d`）与 `POST /api/upstream/start`（幂等）由 llm-adapter `upstream.status` op + host 转发提供，仅放行回环 base_url。

安全边界：前端只读网关三个端点（`/v1/models`、`/v1/magpie/quotas`、`/v1/magpie/usage`），不碰 magpie 管理面 `/api/*`；启动端点只对 127.0.0.1/localhost 的 base_url 生效。WorkBuddy「Extra credits」窗口的 `remaining` 是 magpie 按插件上报的 amount/limit 折算的（读数 0），以窗口里的 display 文本和账户后台为准。

评测溯源（R1）：`scripts/run_evals.py` 从产物每行的 `llm.model` 收集回答模型；同一轮出现多个模型即判定漂移，`ok=false` 且 `--set-baseline` 拒绝写基线（`E_LLM_DRIFT`）。建议以 `assert`/`test` 断言类案例为主裁判，LLM judge 只做主观补充并固定单一模型。

策略钩子默认关闭；需要时显式开启：

```powershell
$env:RSI_CONTRACT_FIRST = "1"        # 首个工具调用前先写验收清单
$env:RSI_VERIFY_BEFORE_FINAL = "1"   # 最终答复前逐条核对
```

## 当前状态

- [x] 生产模式契约（关键决策已确认）
- [x] 架构与模块方案
- [x] Phase 1：react-agent 三个 Rust 接缝（HostSpec / skills.validate+state / LoopPolicy）
- [x] Phase 2：预置技能 + 校验/评测/账本/状态机 + schema/阈值闭环
- [x] Phase 3：A/B 对比、使用率/退役、静态看板（`dashboard/index.html`）
- [x] Phase 4：外部信号驱动的例行复盘、提案审批队列、月度健康报告、技能库配额告警（只告警不自动删）
- [x] 独立运行：内嵌 `runtime/` 快照（react-agent v0.1.21 + agent-kernel v0.1.7 bindings/schema）+ `run.cmd`
- [x] magpie 可选上游：Phase 0 门脚本（端点/回环/管理面/隔离）、评测溯源（`llm` 段 + 漂移拒基线）、`retry_attempts=1` 档（本机已用 Kilo 免密钥免费模型跑通端到端；独立账户隔离待人工）

生成的看板是 [dashboard/index.html](dashboard/index.html)，每次运行 `python scripts/dashboard.py` 覆盖更新。

