# Spec：工具调用效率（call efficiency）

日期：2026-11-02
状态：待执行（规则层 `tool-call-integrity` 已完成，本 spec 进入时间层）
基线来源：会话 `s-mvz75po6` 的 chat#3（一次完整 RSI 工具层审计任务）实测 trace

## 1. 背景

用户反馈：「这个 agent 调用工具时比其他 agent 感官上多很多」。本 spec 把该反馈转成
**可量化、可回归**的工程目标——不做主观优化，只做有基线与判据的收敛。

先明确一件事：**调用多不等于做错**。chat#3 是一次「审计 5 个缺陷 + 改 5 个文件 +
写 18 条用例 + 6 轮回归 + 双仓库同步 + git 提交 + 写账本」的完整工程，物理下限不低。
但实测显示，**其中约一半是可消除的放大器**，与任务难度无关。

上游 react-agent 的 `tools_exec.rs:110` 已把「多轮 offset 续读」记为**效率根因 #1**，
但该认知从未传导到 rsi-agent 的计划文档（`docs/06`、`docs/07` 均零条目）。本 spec 是补位。

## 2. 基线（实测，P 证据）

测量时点 2026-11-02 21:21，trace `memory/traces/s-mvz75po6.jsonl`（1.03 MB）。

### 2.1 全量

| 指标 | 实测 |
|---|---|
| 工具调用总数 | 297（3 段 chat 累计） |
| 工具失败率 | 8 / 296 = **2.7%** |
| 相邻完全重复调用 | **0** |
| 全量工具分布 | bash 195、write_file 38、read_file 24、edit_file 17、list_dir 16、grep 4、load_skill 3 |

### 2.2 chat#3（本次审计任务，唯一对照对象）

| 指标 | 实测 | 判读 |
|---|---|---|
| 工具调用 | **217** | 参考量级 10–30（普通单任务） |
| LLM 轮次 | **160** | 参考量级 10–20 |
| 每轮调用数 | 1 次:110 轮、2 次:46、3 次:2、4 次:1、5 次:1 | **69% 轮次只发 1 个调用**（并行未用） |
| bash 占比 | 140 / 217 = **65%** | 专用工具被绕过 |
| bash 以 `cd /d` 开头 | **134 / 140 = 96%** | D1 的强制外壳 |
| bash 外壳字符开销 | **5353 字符 = bash 总量 26%**，均摊 38 字符/条 | 纯环境税 |
| 探索 : 执行 | 33 : 184 | 不是「到处乱看」，是「大量动手」 |
| grep / symbols_search | 2 / 0 | 专用检索工具近乎弃用 |

### 2.3 运行配置快照（对照仓库默认）

| 参数 | 仓库默认 | 实例实测 | 判读 |
|---|---|---|---|
| `max_rounds` | 20 | **1000** | 50 倍，永不因轮数收敛 |
| `tool_result_limit` | 4000 | **0（禁用）** | 结果全量回喂 |
| `budget_secs` | 900 | **0（禁用）** | **墙钟无兜底**，只有轮数能停 |
| `compact_trigger` / `compact_keep` | 40 / 10 | 40 / **194** | 见 E4 |
| `system_prompt` | null（用内置） | `""`（同 null） | 走 `DEFAULT_SYSTEM_PROMPT` |

## 3. 审计结论

### E1（P0）五道刹车被配置拆除

`max_rounds=1000` + `tool_result_limit=0` + `budget_secs=0` 三项同时生效 = 循环
**没有任何上界**：不因轮数停、不因时长停、不因上下文胀停（结果不限长）。
本次 160 轮是「任务做完自然停」，不是被护栏停的——即**换一个更开放的任务，它可以跑更久**。

### E2（P1）系统提示词单向鼓励多调用

`agent-loop/src/lib.rs:134` `DEFAULT_SYSTEM_PROMPT` 原文：

> "When tools are provided and useful, **call them (one batch per round)**; after receiving
> tool results, **continue reasoning until you can produce the final answer**."

对模型是双重鼓励：①每轮都调工具；②收到结果继续而非收敛。**没有任何反向约束**
（「能一次调用解决就不要拆三次」「优先专用工具而非 bash」）。
另加 `skills_appendix` 每轮注入约 1.5 KB 工具使用说明（artifact 约定 + 技能自扩展 +
`tools.json` 打包教程），进一步抬高工具倾向。

### E3（P0，已修待量化）D1 逼出 96% 的 `cd /d` 外壳

因果链：会话开始时 `bash` cwd 不在工作区（D1：静默跑在 `C:\Windows`，exit=0）→
模型发现相对路径全错 → 无法信任 cwd（`echo %CD%` 返回 `C:\Windows`）→
**每条命令手动拼绝对路径重锚**。实测 96% 的 bash 带 `cd /d`，纯外壳占 bash 字符 26%。

`tool-call-integrity` T2 已修（`_shell_cwd()` 剥前缀 + fail-closed），但**收益未量化**——
本 spec 要求重启后复测确认外壳率下降。

### E4（P0）压缩配置异常，上下文被「假压缩」

实例 `compact_keep=194` 而 `compact_trigger=40`，历史 202 条 → 压缩时
`split = 202 - 194 = 8`，即**只摘要前 8 条、保留 194 条原文**。
后果：压缩几乎不生效，上下文长期维持 190+ 条，反复触发 `[Context compaction]`。
仓库默认 `keep=10`，194 是明显配置事故（疑为「想保留更多上下文」的手动调整）。

### E5（P1）并行利用率低 + 专用工具未被使用

- **并行**：`chat.rs:465` `wave = max_inflight.unwrap_or(4)`，`guest_manifest`
  给 `max_inflight: Some(8)` → 内核支持每轮最多 8 个并发调用。但实测 **69% 轮次只发
  1 个调用**，2 个的仅 46 轮。并行能力存在但未被使用（模型侧倾向串行）。
- **专用工具使用率**：`grep` 2 次、`symbols_search` 0 次，而 bash 140 次。

> **修正（2026-11-02 实测）**：原先把「专用工具用得少」归因为「工具坏了」，实测**不成立**。
> - `symbols_search` 工作正常且**已返回 `skipped` 统计**：`_repo/scripts` 查 `ledger` 命中
>   `rsi_common.py:61`；`agent-loop/src` 查 `chat_body` 命中 `chat.rs:218`。
> - `list_dir` 递归语义正确：夹具验证 `max_depth=1` 正常列出根层文件。
> - 当年那次「`list_dir` 返回空」的真实原因是 `_repo` 根层**本来就没有 `.py` 文件**，
>   返回空是正确答案，不是缺陷。
>
> 因此弃用属**习惯问题**，由 B1 提示词纠正，不改工具。详见 `tasks.md` C1/C2。

### E6（P1，新发现）停止条件由模型主观判断，计划完成度无校验

`chat.rs:338` 主循环只有三个出口（模型不再发工具调用 / 护栏 / 错误）。**循环不读
`tasks.md`**：模型说「答完了」即 `finish()`，无论计划里还剩多少未勾选项。

本次实测即有例证：一次会话在 160 轮处「证据链已闭合」收敛，但当时
`specs/call-efficiency/tasks.md` 的 A1/B1/C1/D1 **全部未做**。

现有可用挂载点是 `verify_before_final`（`chat.rs:405`），但它默认关闭、且只查
「答复里有无验收标记」，**不查 `tasks.md` 实际勾选**，且只提醒一次。

→ 该问题属「正确性/可验证性」而非「效率」，应**单独立项 `specs/plan-completion`**
（按 `project-development-prompt.md:346`「先规则层再时间层」，它应排在本 spec 之前）。
**已立项**（2026-11-03）：`specs/plan-completion/spec.md` + `tasks.md`。本 spec 只登记，不实施。

立项时补核了两条事实（比原描述更硬）：
1. 全仓 `findstr /S /C:"tasks.md" *.rs` **只命中 `lib.rs:538` 一条测试字符串** →
   **代码里没有任何一处真正读取计划文件**，计划目前纯属「给模型看的文本」。
2. `has_acceptance_marker`（`lib.rs:104`）是**纯关键词扫描**（`验收`/`acceptance`/
   `checklist`/`核对清单`），答复里出现这四个词之一即算「已核对」。

### E7（P0，2026-11-03 新增）终止即失忆：护栏被当成处罚

**用户原话**：`✗ [budget] chat 预算耗尽：时长超限。这个还是不合理的。就比如这次任务还没完成，
就提示这个。`

**根因**（`budget.rs:check_stop`）：墙钟与 token 都直接 `return K508`，**丢弃本轮全部
工具成果、思考与部分答案**。触发条件是阶段 A 把 `budget_secs` 从 0 改为 900——
护栏一装上，就把「未完成」升级成「什么都没留下」。

**语义缺陷**：预算耗尽有两种完全不同的含义，被同一个错误码糊住了：

| 类型 | 含义 | 正确处置 |
|---|---|---|
| token 超限 | **成本**上限，不能再花钱 | 硬停（K508），可接受 |
| 墙钟超时 | **时间**到了，但钱还能花 | 软收敛：剥工具 + 要一份进度报告 |

护栏的目的应是**帮任务安全落地**，不是**让已完成的工作凭空消失**。

**修复**（`budget.rs` + `chat.rs`）：
- `StopReason::{Tokens, Deadline}` + `is_hard()` + `tag()`；`check_stop` 拆为纯判定 `check_budget`
- 墙钟到点 → `wrap_up` 状态：**收敛轮剥掉 tools**（手里有工具模型必然继续探索，
  预算就形同虚设）、注入一次性 `WRAP_UP_DEADLINE` 指令、模型若仍想调工具则**就地**
  交 `wrap_up_report`（已完成 / 未完成 / 下一步），**绝不落回再调一次 LLM**（那是多花钱）
- 只有 token 超限才 `budget_stop` → K508

**回归**：`react_mocks` 新增 2 条 ——
`wall_clock_budget_soft_converges_instead_of_aborting`（断言 ok:true / 成果保留 /
仅一次收敛轮 / 收敛轮无 tools / 指令已注入）与
`wall_clock_budget_without_answer_still_reports_progress`（模型完全不配合时仍交进度报告）。
总测试 63 → **64 全绿**。

**仍未解决（转 `specs/plan-completion`）**：中止/收敛的 chat 必须写 `chat_summary`，
否则事后无法判断「掐断时做到哪」。见 tasks.md §E2「D1 观测缺口」。

## 4. 目标与非目标

目标：

- 把 chat#3 的调用量压到 **≤ 100 次 / ≤ 80 轮**（基线 217/160，目标降幅 ≥ 50%）。
- 恢复「有上界」：任一 chat 必被轮数/时长/上下文三者之一收敛。
- 让效率**可观测**：trace 里能直接读出每次 chat 的 `calls / rounds / tokens / 失败率`。
- 让专用工具重新可信（`list_dir`、`grep`、`symbols_search`）。

非目标：

- **不砍 `max_rounds`**。本次任务确实需要 160 轮，砍回 20 会硬切长任务（治症状不治病）。
  收敛应来自 `budget_secs` + 提示词约束 + 工具可信度，不是压低上限。
- 不改内核并发语义（`Semantics::Serial` 的插件级锁不动；那是 R1 停止失效修复的载体）。
- 不改 `contract_first` / `verify_before_final`（默认关闭，且属质量层非效率层）。
- 不引入新依赖、不改 LLM 供应商。

## 5. 方案

### 阶段 A：配置收敛（P0，零代码，热生效）

| 项 | 现值 | 目标值 | 依据 |
|---|---|---|---|
| `agent.tool_result_limit` | 0 | **4000** | 恢复仓库默认；`effective_result_limit` 的 4x/3x 放大才有基线可依 |
| `agent.compact_keep` | 194 | **10** | 恢复仓库默认；压缩真正生效 |
| `agent.budget_secs` | 0 | **900** | 恢复墙钟兜底 |
| `agent.max_rounds` | 1000 | **保留 1000** | 见非目标 |

生效：`config.json` 的 `agent.*` 经 env 注入 agent-loop 构造期——**需重启**（见 §7）。
注：`tools.enabled` 是热生效，但 `agent.*` 不是，两者不要混为一谈。

### 阶段 B：提示词加反向约束（P1，改 Rust，需重编译）

`DEFAULT_SYSTEM_PROMPT` 追加三条（保持简洁，勿堆砌）：

1. **批量优先**：独立无依赖的调用合并进同一轮（当前 69% 轮次只发 1 个调用）。
2. **专用工具优先**：查内容用 `grep`/`symbols_search`、读文件用 `read_file`、列目录用
   `list_dir`；`bash` 仅用于真正需要 shell 的场景（跑测试、git、构建）。
3. **收敛约束**：同一目标若两次尝试未获新信息，改变策略而非重复调用。

同时把 `skills_appendix` 的 `## Skill self-extension` 段（约 1.5 KB 的 `tools.json`
打包教程）改为**按需注入**：仅在用户明确提出「造技能/打包工具」时注入，其余轮次省略。

### 阶段 C：专用工具可信度（P1）

- 修 `list_dir` 递归 `max_depth=1` 跳过根层文件的缺陷（D2'）。
- 为 `symbols_search` 在无结果时返回**明确原因**（「该语言不支持」/「无匹配」），
  而非空列表——让模型能区分「没有」与「工具坏了」。
- 统一错误码：工具不可用/被脱敏/不存在三者必须可区分（关联 D6）。

### 阶段 D：效率可观测（P2）

- `chat.rs` 的 `finish` metrics 已在输出 `llm_calls / retries / tool_failures`
  （`chat.rs:643`）。**补 `tool_calls` 与 `rounds`**，并在 trace 写一条 `chat_summary`：
  `{calls, rounds, single_call_rounds, tokens, failures, wall_ms}`。
- `tool_failures` 目前**只进 metrics、不参与任何收敛判断**（`chat.rs` 全文无消费点）。
  阶段 D 评估：连续 N 次失败是否应提前收敛（谨慎，避免误杀）。

## 6. 验收（P/Q/I）

- **P（基线）**：chat#3 = 217 调用 / 160 轮 / bash 65% / `cd /d` 96% / 外壳 26% /
  失败率 2.7%。**已冻结于 §2，后续只与它比对**。
- **Q（达标）**：同类任务（一次工具层审计级工作量）复测 **≤ 100 调用 / ≤ 80 轮**，
  且 `cd /d` 外壳率 **≤ 10%**、`grep`+`symbols_search` 使用数 **≥ 5**。
- **I（不退化）**：
  - `python -m unittest discover -s tests` 仍 24/24 OK；
  - `skill_validate.py --all --mode full` 6/6 ok 无新增 warning；
  - `conformance_gate.py --skill skills/tdd --smoke` ok；
  - `ledger.py verify` violations = []；
  - **任务质量不降**：同一审计任务仍须产出全部 D1–D5 结论（效率优化不得以少做换少调）。

## 7. 生效条件（是否需要重启）

| 改动 | 生效方式 | 需重启？ |
|---|---|---|
| `config.json` 的 `agent.*`（阶段 A） | agent-loop 构造期经 env 注入 | **是** |
| `DEFAULT_SYSTEM_PROMPT` / `skills_appendix`（阶段 B） | Rust 重编译 | **是**（且需 `cargo build`） |
| `runtime/plugins/tools/tools/*.py`（阶段 C） | tools guest 常驻子进程 | **是** |
| `scripts/*.py`、`tests/*.py` | 独立进程 | 否 |
| `skills/<x>/tools.json` | 每次调用新起子进程 | 否 |

## 8. 风险

| 风险 | 处置 |
|---|---|
| 砍 `tool_result_limit` 到 4000 导致大结果被截断、反而多轮续读（效率根因 #1 重演） | `effective_result_limit` 对 read_file 4x / grep·symbols_search 3x 放大已存在；验收项 Q 要求总轮数下降，若反而上升则回退该项并单独评估 |
| 提示词加约束导致模型过度保守、少做验收 | I 项显式要求「任务质量不降」；同一任务须仍产出全部 D1–D5 |
| 阶段 C 修 `list_dir` 触及递归语义，影响其他调用方 | 用例先行（`tests/test_tool_contract.py` 追加递归用例），红→绿 |
| 阶段 B 需重编译，若中断会留下半成品 | 先做阶段 A（零代码、可回退），验证收益后再动 Rust |
| 基线数字随会话增长而漂移 | §2 已固定测量时点与 chat 段号；后续复测必须用**同等工作量**任务，不得用不同任务对比 |

## 9. 与既有计划的关系

- `docs/06-重构与技能优化清单.md`：**零**效率条目（本 spec 补位）。
- `docs/07-实施路线与验收.md`：Phase 0–4 全完成，风险清单只有「评测成本高」，
  无运行期调用成本。
- `runtime/crates/*/PLAN.md`：不存在。
- `project-development-prompt.md:346` 的硬顺序：「**先修规则层（正确性），再修时间层
  （效率/健壮性）**」——`tool-call-integrity`（规则层）已完成，本 spec 是其合法后继，
  不抢位。

> 阶段 A 是**唯一**与「规则层已完成」无关、可立即执行的部分（纯配置，不碰代码语义）。
