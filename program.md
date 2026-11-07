生产
# rsi-agent 项目开发 program.md（已确认）

> 本文件按 `project-dev` 正向模式「生产」运行：先契约、后设计、再实施。
> 首行 `生产` 表示产出完整文档树，而非探索版精简方案。
> **当前状态：关键决策已确认（第 10 节），Phase 1–4 已实施并通过验收。**

## 0. 一句话

rsi-agent 不是第三个内核，而是 **基于 react-agent 的 RSI 发行形态**：
以预置技能为起点，把「需求 → 技能生产 → 客观评测 → 任务执行 → 经验沉淀 → 晋升/回退」做成可复现的闭环。

## 1. 项目目标

1. 让 agent 在真实任务中**先判断要不要造技能**，再按 creat-skill 生产技能，而不是逢事就写。
2. 让每个技能都带**可执行验收**：契约、案例、评分、验证状态，而不是一段自说自话的说明。
3. 让「改进」可积累：基线 → 单点改动 → 回归 → 晋升/回退 → 经验写回。
4. 让工作留下三类记忆：会话记忆、情景账本、程序技能，互不污染。
5. 在 **不改 agent-kernel 语义**、**不破坏 react-agent 通用性** 的前提下落地。

## 2. 非目标

- 不做独立于 react-agent 的第二个 ReAct 引擎。
- 不做技能包管理器（版本解析、依赖求解、远端仓库）。
- 不做内核级技能感知、事件总线持久化、多 provider 负载均衡。
- 不让 agent 自主修改 `agent-kernel` / `react-agent` 的核心代码（`CORE_PROTECTED`）。
- 不让评估器/裁判自改；裁判只读、无生产上下文，不能调用写入工具。
- 账本只追加、不改写；修正以新记录追加，保留审计轨迹。
- 不追求「无人监督的全自动进化」；没有外部信号只能停在「未验证」。

## 3. 三者关系（推荐决策）

| 角色 | 定位 | 对 RSI 的职责 | 是否改造 |
|---|---|---|---|
| agent-kernel | 运行时内核：空间/时间/规则管家 | 插件隔离、调度、契约、conformance | 仅把 conformance 作为「生成代码工具」准入门 |
| react-agent | 通用 agent 执行体 | ReAct 循环、工具、资产、记忆、Web、trace | 只在三个接缝处做轻量扩展 |
| rsi-agent | 基于 react-agent 的发行形态 | 预置技能、生产线、评测、证据、晋升策略 | 新增资产层与薄工具，不新建运行时 |

**结论：不要在 agent-kernel 上直接创建 rsi-agent。** 内核没有 LLM、循环、工具、技能语义；直接做等于重写 react-agent。
rsi-agent 采用「发行版 / 产品层」关系：复用 react-agent 的宿主与插件，把 RSI 语义放在技能、策略与薄工具中。

### 3.1 哪些项目需要改

| 项目 | 是否改 | 说明 |
|---|---|---|
| `rsi-agent/` | 新建 | 独立目录、独立技能、独立账本、独立策略 |
| `react-agent` | 只改三个接缝 | host 装配 spec、assets 校验/状态、agent-loop 验收钩子；默认行为不变 |
| `agent-kernel` | 零代码改动 | 仅调用现有 conformance 作为生成代码工具准入门 |
| `creat-skill` / `project-dev` | 原目录不改 | 复制到 `rsi-agent/skills/` 的 vendored 副本上优化 |

### 3.2 现有技能如何接入

接入标准是「目录 + SKILL.md + skill.json（或无则自动生成）+ 可选 evals/state」：

1. **导入**：复制或挂载到 `rsi-agent/skills/{name}/`；适配器从 frontmatter 生成 `skill.json`，缺案例标 `verification: unverified`。
2. **校验**：过 `skill_validate`；结构不合法则保持 `draft`，不可晋升。
3. **建基线**：有 evals 的技能跑一次 `run_evals` 建立基线；无 evals 的标 `legacy`，可直接用但不能自动晋升。
4. **进化**：补案例 → candidate → 外部信号 → active；每次晋升写账本。

因此**现成技能可以接入**，但接入不等于自动合格：没有案例与验收的技能，只能作为「可用但未验证」的 legacy 资产。

## 4. 技术栈与运行方式

| 阶段 | 语言/形态 | 说明 |
|---|---|---|
| Phase 1 | **Rust 接缝优先** + Python 薄工具 | 先做 host 装配 spec、assets 校验/状态钩子、agent-loop 验收钩子；脚本工具并行补齐，不作为主线 |
| Phase 2 | 生产线闭环 | 预置技能 + validate/eval/ledger + 真实任务 |
| Phase 3 | 对比与退役 | A/B、使用率、看板 |
| Phase 4 | 例行化 RSI | 外部信号触发的复盘与提案 |

运行入口（Phase 2 起；Phase 1 先完成接缝与自测）：

```powershell
$env:SKILLS_DIR   = "<repo>\rsi-agent\skills"
$env:WORKSPACE_ROOT = "<repo>\rsi-agent"
react-agent-host
```

## 5. 时空契约（已确认）

- **空间归属**
  - `skills/`：由 assets capability **单写**；rsi-agent 只通过 `skill_install` / 文件工具写入。
  - `ledger/`：由 rsi 工具单写；不进入会话上下文，按需检索。
  - 会话 trace：仍归 `memory` 插件所有，rsi-agent 只读不写。
  - `workspace/`：归 `tools` 插件的 `WORKSPACE_ROOT` 管辖。
- **时间流形态**
  - 外层：**状态机**（Intake → Recall → Decide → Author → Validate → Evaluate → Execute → Verify → Retro → Promote）。
  - 内层：agent-loop 的 **ReAct 循环**，受最大轮次与预算约束。
  - 晋升：离散状态迁移，不允许跳步。
- **规则拦截**
  - 写技能时：`skill_validate` 静态拦截（结构/引用/预算/验收段）。
  - 进候选时：`run_evals` 评分 + 基线对比。
  - 晋升时：外部信号（E1/E2/E3）成立即自动晋升；无外部信号保持 `candidate`；改工具/核心的高风险变更仍保留人工确认。
  - 评估时：裁判必须是新上下文、只读、看不到生产者理由；晋升由规则引擎执行，不再找一个 agent 裁决。
  - 运行期：工具走现有沙箱与超时；核心文件只读。

## 6. P / Q / I（具体值）

### P（前置）

- [ ] `react-agent-host` 可启动，node ≥ 22.6、python 有 grpcio。
- [ ] `SKILLS_DIR` 指向 `rsi-agent/skills` 且可写。
- [ ] 至少一个 LLM provider 可用；`config.json` 已配置。
- [ ] 基线快照存在：`ledger/baseline.json` 记录当前 active 技能及分数。
- [ ] 评测工具依赖可用（Python 标准库即可，不引入新框架）。

### Q（后置）

- [ ] 故意写坏的技能（缺验收段/引用断链）被 `skill_validate` 拦截，且错误信息定位到字段。
- [ ] 候选技能低于基线分 → 不晋升；不低于基线且外部信号成立 → 可晋升。
- [ ] 一次真实任务能产出工作账本记录；失败/返工能生成 failure-fix 并写回对应技能 `registry/`。
- [ ] 下一次同类任务能检索到该经验，且不把整本账本塞进上下文。

### I（不变量）

- [ ] react-agent 既有测试全绿；`cargo test` 无回归。
- [ ] agent-kernel 代码零改动（Phase 1/2）。
- [ ] 技能仍是「目录 + SKILL.md + 附属文件」轻资产，不引入包管理。
- [ ] 账本不含密钥、令牌、个人隐私；写入前做字段白名单。
- [ ] 状态机无死循环：每次任务有最大尝试次数与预算上限。
- [ ] 有兄弟源仓库的技能，部署副本与源仓库无漂移（`python scripts/sync_skills.py --check` 退出码 0）。

## 7. 范围

### 包含

- `rsi-agent/` 目录：`program.md`、`docs/`、`skills/`、`policies/`、`config/`、`ledger/`（运行时生成）。
- 预置技能：`rsi-steward`、`skill-eval`；随附改造后的 `creat-skill`、`project-dev`。
- 薄工具：`skill_validate`、`run_evals`、`ledger_append/query`。
- 策略与 schema：技能契约、案例格式、状态机、晋升规则。

### 不包含

- 新 ReAct 引擎、新插件调度器、新数据库。
- 面向公众的技能市场。
- 自动修改核心代码的「自我改写」。

## 8. 约束

1. 先契约后代码：每个模块先写四层设计，再实现。
2. 单次改动 ≤50 行直接测；>50 行先出《大范围改动合理性说明》。
3. 不引入未列出的依赖；Phase 1 的 Rust 接缝不新增第三方 crate，Python 工具只用标准库。
4. 所有新增能力以 **capability** 暴露，不以插件名硬编码。
5. 文档与代码同目录演进；不新增 `docs/` 编号之外的流水账。

## 9. 研究方向（优先级）

1. **技能可评测化**：案例、rubric、判分器、基线对比。
2. **外部信号采集**：用户修正、测试/eval 结果、返工次数。
3. **经验检索**：按任务/技能召回账本，控制上下文预算。
4. **技能编排**：依赖声明 + 组合技能，不做图引擎。
5. **生成代码工具的准入**：conformance 门。

## 10. 决策记录（2026-10-31 已确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 三者关系 | **rsi-agent = react-agent 发行形态**；不直接建在 agent-kernel 上 |
| 2 | Phase 1 方式 | **先做 Rust 接缝**（host 装配 spec、assets 校验/状态、agent-loop 验收钩子） |
| 3 | 预置技能 | **vendored 副本**，在 rsi-agent 内独立演进，`skills.lock.json` 记录来源 |
| 4 | 晋升闸门 | **外部信号自动**：E1/E2/E3 任一成立即晋升；无外部信号最多 candidate；改工具/核心仍人工确认 |
| 5 | 账本落点 | **默认 `rsi-agent/ledger/`**；`RSI_LEDGER_DIR` 覆盖（可指向 `<workspace>/.rsi/`）；账本默认不进 git |

---

进入 `docs/01-项目方案.md` 的方案冻结，并按 Phase 1 的 Rust 接缝顺序实施。
