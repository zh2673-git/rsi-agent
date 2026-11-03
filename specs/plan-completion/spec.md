# Spec：计划完成度校验（plan-completion）

状态：待批准
日期：2026-11-03
来源：`specs/call-efficiency/spec.md` §E6（原登记「只登记，不实施」）+ §E7 遗留观测缺口
排序依据：`project-development-prompt.md:346`「先规则层，再时间层」——本 spec 属正确性/可验证性，
应**先于** call-efficiency 的 Q 项复测（否则「做完了」这个判据本身就不可信）。

## 1. 背景

`chat.rs` 主循环有三个出口：模型不再发工具调用（`chat.rs:440`）、护栏（`chat.rs:426` /
`chat.rs:630`）、错误。**没有任何一个出口读 `tasks.md`**：模型说「答完了」即 `finish()`，
无论计划里还剩多少未勾选项。

实测例证（call-efficiency §E6）：一次会话在 **160 轮**处「证据链已闭合」自然收敛，当时
`specs/call-efficiency/tasks.md` 的 A1/B1/C1/D1 **全部未勾选**。用户看到的却是「已完成」。

## 2. 现状实测（P 证据，均为本次代码核查，非推断）

| 机制 | 位置 | 默认 | 检查对象 | 局限 |
|---|---|---|---|---|
| `has_acceptance_marker` | `lib.rs:104` | — | 答复文本里的关键词（`验收`/`acceptance`/`checklist`/`核对清单`） | **纯关键词扫描**，答复里出现「验收」二字即通过 |
| `contract_first` | `chat.rs:404` | **关** | 首个工具调用前的验收清单 | 只拦首轮、只看文本 |
| `verify_before_final` | `chat.rs:444` | **关** | 最终答复的验收痕迹 | 只提醒一次、**不查 `tasks.md` 实际勾选** |
| 主循环出口 | `chat.rs:440` / `426` / `611` / `630` | — | 无 | 均无计划校验 |

决定性证据：全仓 `findstr /S /C:"tasks.md" *.rs` **只命中 `lib.rs:538` 的一条测试字符串**
（`user_wants_skill_build("读 specs/call-efficiency/tasks.md 继续")`）。即：**代码里没有任何
一处真正读取计划文件**。计划目前只是给模型看的文本，对循环的停止判定零影响。

## 3. 审计结论

### E1（P1）完成度判据只有「模型自述」，没有「计划事实」

`finish()` 的唯一收敛依据是 `resp.tool_calls.is_empty()`。这等于把「任务是否完成」的判定
完全交给模型主观判断，而模型有系统性偏向：**上下文越长、越接近预算，越倾向宣布完成**
（call-efficiency §E6 的 160 轮收敛就是这种偏向的产物）。

RSI 的 I（不变量）在这里被违反：`tasks.md` 的勾选状态是**可机读的客观事实**，却在判定时被忽略。

### E2（P1）观测缺口：终止路径不写 `chat_summary`

`budget_stop`（`chat.rs:630`）只写一条 `error` 事件，**不写 `chat_summary`**。后果（call-efficiency
§E2 实证）：

- 中止型 chat 在 trace 里**完全没有效率画像**，无法事后判断「掐断时做到哪」；
- 复测时只能靠 `user` 事件分段 + 人工判读，这正是 call-efficiency Q 项无法判定的直接原因。

同一缺陷存在于空答案出口（`chat.rs:733` → K502）：只写 `error`，无 `chat_summary`。

### E3（P2）无计划场景无提示

工作区没有 `tasks.md`（或本 chat 从未读过它）时，模型可以随意收敛且无任何提示。
这是**可接受**的（不该硬造计划），但应记进观测：`plan_unchecked = null` ≠ `0`。

## 4. 目标与非目标

目标：
- 收敛前把**计划事实**引入判定：解析 `tasks.md` 未勾选项，模型要在有未勾选项时收敛 →
  **提醒一次**（附未勾选清单原文），让它自己决定补做还是明确交代。
- 补齐观测：**任何终止路径**（自然收敛 / 预算 / 错误）都写 `chat_summary`，含
  `stopped_by`、`plan_unchecked`、`plan_path`。

非目标（明确不做）：
- **不做闸门**：不阻断、不返回错误。「有未勾选项」不等于「不许停」——模型可能确实撞上了
  外部阻塞，硬拦会把「未完成」升级成「什么都交不出」（这正是 call-efficiency §E7 的错误）。
- **不自动勾选**：`tasks.md` 只能由模型自己改。循环越权写计划等于伪造进度。
- **不解析任意 markdown**：只认行首 `- [ ]` / `- [x]`，只取最近一个 `## ` 标题作段名。
- 不改前端渲染（`plan_unchecked` 纯观测，不渲染）。

## 5. 方案

### 阶段 A：解析器（纯函数，可测）

新增 `runtime/crates/agent-loop/src/plan_scan.rs`：

```rust
pub struct PlanItem { pub section: String, pub text: String, pub line: usize }
pub struct PlanScan { pub total: usize, pub done: usize, pub unchecked: Vec<PlanItem> }
pub fn scan_plan(text: &str) -> PlanScan
```

规则：
- 只认行首（可含前导空格）`- [ ]`（未完成）/ `- [x]`、`- [X]`（完成）；
- `section` = 该行之前最近的 `## ` 标题（去掉 `## `），无则空串；
- **跳过 ``` 围栏内**的行（避免把示例/模板里的 `- [ ]` 误判为真实待办）；
- 不计 `### ` 标题（只做一级分段，避免噪声）。

### 阶段 B：挂载（`chat.rs`）

计划路径解析优先级（fail-open，任一步失败即跳过，不报错）：
1. `cfg.plan_file`（新配置项 `agent.plan_file`，工作区相对路径，默认空）；
2. 本 chat 内**最后一次**工具调用参数里出现的 `specs/<name>/tasks.md`（从 `steps` 的
   `args` 反查——即「模型这次实际读过的那份计划」）；
3. 都没有 → 跳过（`plan_unchecked = null`）。

挂载点：`chat.rs:440` 的 `resp.tool_calls.is_empty()` 分支，**在 `verify_before_final` 之后**：

```
if plan_reminded == false && unchecked.len() > 0 && !answer_covers_plan(&answer_text, &unchecked) {
    plan_reminded = true;
    trace(policy, where="plan_completion", unchecked=N, plan=path);
    messages.push(PLAN_REMINDER /* 含前 10 条未勾选项原文 */);
    continue;   // 只提醒一次
}
```

- `answer_covers_plan`：答复里出现 `has_acceptance_marker` 的关键词 **且** 至少提到
  `min(3, unchecked.len())` 条未勾选项的关键词 → 视为已交代，放行。
- **二次收敛无条件放行**（`plan_reminded` 一次性），剩余数写进 `chat_summary`。
- 提醒文本附清单原文，避免模型「忘了还剩什么」再读一遍文件（省一轮调用）。

### 阶段 C：观测补齐

- `budget_stop` 与空答案出口**也写 `chat_summary`**：`{ok:false, stopped_by:"tokens"|"error",
  calls/rounds/steps 照实, plan_unchecked}`。
- `finish` 的 `chat_summary` 增 `plan_unchecked: Option<usize>`、`plan_path: Option<String>`。
- `tests/contract_conformance.rs` 的 `FROZEN_EVENT_TYPES` 不变（不新增事件类型，复用 `policy`
  与 `chat_summary`）——这是刻意选择：**新增字段而非新增事件**，前端无感。

### 阶段 D：配置

`agent.plan_file` → `PLAN_FILE` env → `AgentLoopConfig.plan_file: Option<String>`。
默认空（自动探测生效）；显式设置则**只**用该文件（消除「历史遗留未勾选项」的误报）。

## 6. 验收（P/Q/I）

**P（规则层，确定性）**
- `scan_plan` 单测 ≥5：空文本 → `0/0`；混合勾选计数正确；``` 围栏内 `- [ ]` 不计；
  无 `##` 时 `section == ""`；`- [X]` 大写计入完成。
- 事件断言：有未勾选项时**恰好 1 条** `policy/plan_completion`；第二次收敛**不再发**。

**Q（实测，可复现）**
- 构造 `tasks.md`（3 未完成 / 2 完成）→ mock chat 最终答复不提验收 →
  断言：`ok:true`、`answer` 保留、**恰好 1 次**提醒注入、`chat_summary.plan_unchecked == 3`。
- 无计划文件 → **不发** `policy` 事件、`plan_unchecked == null`（区分于 `0`）。
- 预算中止 → trace 里**存在** `chat_summary` 且 `stopped_by == "tokens"`。

**I（不变量）**
- 既有 **64 项测试全绿**（零回归）。
- 每次 chat 提醒 ≤1 次；因此新增 LLM 调用 ≤1 次。
- 解析器只读工作区内路径（沿用 `read_file` 的 `_guard`），越界即跳过。
- 不改变 `chat_summary` 既有字段语义（只增不改）。

## 7. 生效条件（是否需要重启）

| 改动 | 生效方式 |
|---|---|
| `plan_scan.rs` / `chat.rs` 挂载 | **需重启宿主**（Rust 重编译） |
| `agent.plan_file` | **需重启**（实例启动时读入 env） |

注意：call-efficiency §E2 的教训——**改完不重启就复测，等于测旧二进制**。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| **误报**：`tasks.md` 里历史遗留的未勾选项导致每次都提醒 | ① 默认只在「本 chat 读过该文件」时生效；② `agent.plan_file` 显式指定时以显式为准 |
| **死循环**：提醒后模型仍不勾选就收敛 | `plan_reminded` 一次性，二次无条件放行 |
| **解析误判**：把模板/示例里的 `- [ ]` 当真 | ``` 围栏跳过 + 只认行首 |
| **越权**：循环替模型改计划 | 明确不做（非目标） |
| **提醒噪声**：长清单一次贴 10 条太多 | 上限 10 条 + 段名分组，其余以「共 N 条」概括 |

## 9. 与既有计划的关系

- 前置：`specs/tool-call-integrity`（已批准，规则层已落地）
- 并列：`specs/call-efficiency`（本 spec 是其 §E6 的立项去向 + §E7 的观测遗留）
- **顺序**：本 spec 的 Q 项应先于 call-efficiency 的 Q 项复测完成，否则「复测通过」这个
  结论依赖的是模型的自我声明，而不是计划事实。
