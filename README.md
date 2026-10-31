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
├── docs/
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
└── scripts/               # skill_validate / run_evals / ledger / skill_state / conformance_gate /
                           # import_skill / skill_ab / usage_report / dashboard / rsi_routine / health_report
```

## 快速开始

脚本自带 `scripts/vendor/skillkit.py`，单独克隆本仓库即可运行校验/评测/账本等工具；
接入真实 agent 仍需 [react-agent](https://github.com/zh2673-git/react-agent)（含三处接缝改动）与 agent-kernel。

```powershell
$env:SKILLS_DIR      = "<repo>\rsi-agent\skills"
$env:WORKSPACE_ROOT  = "<repo>\rsi-agent"
$env:RSI_LEDGER_DIR  = "<repo>\rsi-agent\ledger"
react-agent-host

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

生成的看板是 [dashboard/index.html](dashboard/index.html)，每次运行 `python scripts/dashboard.py` 覆盖更新。

