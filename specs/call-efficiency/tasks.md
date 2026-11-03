# Tasks：工具调用效率

> 上游 spec：`specs/call-efficiency/spec.md`
> 前置：`specs/tool-call-integrity`（规则层）已完成并回归通过
> 基线冻结：chat#3 = 217 调用 / 160 轮（2026-11-02 21:21 实测）

## 重启后从这里开始

若你（新的会话）读到这份文件而不知道上下文：

1. **恢复入口**：本会话 ID = `s-mvz75po6`。Web UI 侧栏点它即可续聊；若 localStorage 丢失，
   点「新会话」手动输入该 ID（`app-core.js` 支持自定义 ID）。
2. **记忆位置**：`runtime/.instances/1102/memory/{sessions,trace}/s-mvz75po6.*`
   （绑**工作区** `D:\ZH\vibe code\test\1102`，不绑端口；端口变了记忆仍在，只是侧栏不自动列出）。
3. **本文件进度**：见下方勾选框。**已完成项不要重做**，尤其 A1（配置已改）与 C3/B1/B2/D1（已改代码）。
4. **未完成项**：见「剩余待办」。
5. **必读教训**：C1/C2 的前提经实测**不成立**（详见下方「审计结论被推翻」）。不要照着旧结论改代码。

## 进度

- [x] A1 配置收敛（`tool_result_limit=4000`、`budget_secs=900`、`compact_keep=30`）
- [x] C1 `list_dir` 递归 —— **实测无此 bug，已撤销**
- [x] C2 `symbols_search` 空结果 —— **实测正常，已撤销**
- [x] C3 脱敏保留路径结构（D6）—— 已改 `secrets.rs` + 2 用例
- [x] B1 `DEFAULT_SYSTEM_PROMPT` 三条反向约束 —— 已改 + 用例
- [x] B2 技能附录按需注入 —— 已改 + 2 用例
- [x] D1 `chat_summary` 效率指标入 trace —— 已实现 + 冻结事件类型
- [x] D2 `tool_failures` 参与收敛 —— **评估结论：不做**（见下）
- [x] E1 终验 —— 真实仓 63 测试全绿 / 6/6 技能 / gate ok / ledger 无违规

## 剩余待办（本 spec 未覆盖，需单独立项）

- [x] **`specs/plan-completion`（停前自检）** —— **已立项**（2026-11-03）：
      `specs/plan-completion/spec.md` + `tasks.md`（阶段 A 解析器 / B 挂载 / C 观测 / D 配置）。
      设计定调：**不做闸门**——有未勾选项不等于不许停，硬拦会把「未完成」升级成
      「什么都交不出」，正是 §E7 的错误重演。只**提醒一次** + 把 `plan_unchecked`
      记进 `chat_summary`。顺带承接 §E7 的观测遗留（§E2）：任何终止路径都必须写 `chat_summary`。
- [x] **重启验证 A1+B1+B2 的实际收益** —— **结论：配置已生效，Rust 未生效，Q 项未达标**（§E2）。
      `agent.*` **已生效**（`compaction.kept` 194→30 实证，见 §E3）；
      但 **Rust 改动未生效**（`chat_summary` 事件 0 条 —— 宿主进程 23:06 启动，早于 23:1x 的改动）。
      复测数据又被「预算硬中止」事故污染，**不能作为 Q 项判据**。
- [x] **`compact_keep` 的量化复核** —— **结论：已生效，但「压缩次数下降」的预期被证伪**（§E3）。
      真压缩从 `keep=194 > trigger=40`（split=8，几乎不生效）变为 `keep=30 < trigger=40`
      （split≈history-30）；首次真压缩一次摘掉 **603 条**。
      但压缩**次数**仍为每 chat 1 次、未下降——触发源是「单 chat 内历史 >40」而非跨 chat 累积。

---

## 阶段 A：配置收敛（已完成）

### A1 配置收敛 ✅

改 `runtime/.instances/1102/config.json` 的 `agent` 段：

| 项 | 原值 | 新值 | 依据 |
|---|---|---|---|
| `tool_result_limit` | 0（禁用） | **4000** | 恢复基线；`read_file` ×4 / `grep`·`symbols_search` ×3 自动放大 |
| `budget_secs` | 0（禁用） | **900** | 恢复墙钟兜底（唯一能**中途**打断的护栏） |
| `compact_keep` | 194 | **30** | 必须满足 `keep+1 < compact_trigger(40)`，否则每轮重复压缩 |
| `max_rounds` | 1000 | **不动** | 见 spec 非目标（砍回 20 会硬切长任务） |

- 备份：`config.json.bak`（原值 0 / 0 / 194）
- 生效：`agent.*` 走 env 注入 agent-loop **构造期** → **需重启**
- 校验：`python -c` 读回三项均一致；`keep+1=31 < 40` ✅

## 阶段 C：专用工具可信度

### C1 `list_dir` 递归 —— 撤销 ❌（前提不成立）

**实测结论**：递归语义**正确**。夹具验证：

```
max_depth=1 -> root_a.txt, root_b.txt        （根层文件在）
max_depth=2 -> sub1/mid.txt + 根层            （第 2 层在）
max_depth=3 -> sub1/sub2/deep.txt + 全部      （第 3 层在）
```

**误判来源**：`round=68` 的 `list_dir(_repo, recursive, max_depth=1, glob=*.py)` 返回空，
被记成「跳过根层文件」。但实测 `_repo` 根层**本来就没有 `.py` 文件**（0 个），
返回空是**正确答案**。

**教训**：把「结果为空」当成「工具坏了」，是审计中典型的因果倒置。证据必须包含
「期望值应当是什么」的独立验证，而不只是「返回了什么」。

### C2 `symbols_search` 空结果 —— 撤销 ❌（前提不成立）

**实测结论**：工作正常，且**已返回 `skipped` 统计**（`oversize` / `unsupported_ext`）：

```
_repo/scripts          query=ledger      -> function ledger_dir rsi_common.py:61
_repo/.../agent-loop   query=chat_body   -> method chat_body chat.rs:218
```

模型弃用它（实测 0 次）不是工具缺陷，而是**习惯问题**——已由 B1 提示词
「PREFER dedicated tools over shell」纠正，不需要改工具。

### C3 脱敏保留路径结构 ✅（D6 根因）

**根因**：`secrets.rs:scrub_with` 把密钥替换进**所有字符串**。密钥值最短 6 字符
（`collect()` 的阈值），一旦某个 6 字符密钥恰好是路径片段（实测 `magpie`），
`_repo\magpie` 会被抹成 `_repo\«KEY_MASKED»` → `list_dir` 报 `NOT_FOUND` →
**模型无法区分「被脱敏」与「真不存在」**。

**修复**（`secrets.rs`）：
- 新增 `scrub_str`：路径串按 `/` `\` 切分，**逐分量**替换后原样拼回（分隔符保留）
- 新增 `looks_like_path`：含 `://` 的 URL **不走**路径逻辑（否则 `https://x?key=SECRET`
  会被拆坏）；含空白的不走（多是句子/日志）
- 新增 `scrub_segment`：命中分量整体抹掉（不留残片）
- **脱敏强度不降**：密钥字符一个不漏，非路径串仍整体替换

**用例**（`secrets.rs` tests，2 新）：
- `scrub_path_keeps_structure_and_masks_only_hit_segment`：断言 `_repo` / `sub` / 分隔符保留
- `scrub_non_path_string_still_replaces_inline`：断言命令输出里的密钥仍被抹

**回归**：`secrets` 7/7 通过（含原有 5 个）。

## 阶段 B：提示词反向约束 ✅

### B1 `DEFAULT_SYSTEM_PROMPT` 追加三条 ✅

`lib.rs:134` 在原纪律后追加（保留原有 `read before writing files` 等）：

```
Efficiency discipline (these bound the tool budget, not the task):
(a) BATCH independent calls into one round
(b) PREFER dedicated tools over shell (grep/symbols_search/read_file/list_dir; bash only for real shell)
(c) CONVERGE, do not thrash — two attempts with no new information → change strategy
```

**关键设计**：`not the task` 明示「不缩减任务范围」，防模型以少做换少调。

**用例**：`default_prompt_has_efficiency_discipline` 断言三条俱在 + 原纪律未丢 + `not the task` 存在。

### B2 技能附录按需注入 ✅

`skills.rs:self_extension_section(root, full)` 拆成两段：
- **常驻 brief**：只讲授权与最小落点（约 600 字符）
- **按需 full**：完整打包/安装协议（`### Skill packaging with companion tools`，约 1.2 KB）

触发判定 `user_wants_skill_build(user_text)`：`技能|skill` **且** 命中
`造/做/建/打包/新建/写一个/生成/创建/封装/沉淀/整理成/create/build/make/package/author/write a/new`。

**用例**（2 新）：
- `self_extension_section_gated_by_workspace_reachability`：断言 brief 不含长教程、full 含且更长
- `want_skill_build_detection`：4 个正例 + 3 个反例

**注意**：测试首跑暴露词表缺口——「沉淀成技能」未命中，已补 `沉淀`/`整理成`。

## 阶段 D：效率可观测

### D1 `chat_summary` ✅

`chat.rs:finish` 在 `assistant` 事件后追加：

```json
{"type":"chat_summary","calls":N,"rounds":N,"steps":N,"llm_calls":N,
 "retries":N,"failures":N,"failure_rate":F,"tokens":{...},"llm_ms":N,
 "budget_secs":N,"max_rounds":N}
```

**关键约束**：事件类型是**冻结契约**。首跑 `contract_conformance` 立即失败：
`事件类型越界：chat_summary（新增类型必须先冻结进 FROZEN_EVENT_TYPES + 前端 render）`。
已同步把 `chat_summary` 加入 `FROZEN_EVENT_TYPES`（并注明前端不渲染、纯观测）。

**e2e 实证**（`e2e_full_react_mock` 输出中可见）：
`{"type":"chat_summary","calls":1,"rounds":2,"steps":1,"llm_calls":2,"failures":0,
"failure_rate":0,"budget_secs":0,"max_rounds":1000}`

### D2 `tool_failures` 参与收敛 —— 结论：不做 ✅

**证据**（510 条 `tool_result`）：
- 失败率 **1.8%**（9/510）
- **最长连续失败串 = 1**（从未连续两次失败）
- 每种失败过的工具最终都成功：`read_file` 5 败/60 次、`edit_file` 3 败/31 次、`list_dir` 1 败/16 次

**结论**：不存在「连续失败应当提前收敛」的场景。加收敛闸只会**误杀**「试错后成功」的
正常探索（如 `EDIT_NO_MATCH` 后修正重试、`NOT_FOUND` 后改正路径）。
保持现状：只观测（D1 已把它写进 `chat_summary`），不参与循环控制。

## 阶段 E：终验 ✅

### E1 验收结果

| 项 | 结果 |
|---|---|
| `cargo test -p react-agent-agent-loop`（**真实仓库**） | **63 passed / 0 failed**（23 lib + 1 + 2 + 37 react_mocks + 0） |
| `cargo test --workspace`（镜像 `_repo`） | 除 2 个**宿主 env 污染**项外全绿，清 env 后 100% 绿 |
| `skill_validate.py --all --mode full` | **6/6 `ok:true`**，warnings 均为既有（`W_NO_EVALS`/`W_UNVERIFIED`/`W_DESCRIPTION_LONG`），无新增 |
| `conformance_gate.py --skill skills/tdd --smoke` | `ok: true`，`smoke.ok: true` |
| `ledger.py verify` | `ok: true`，`checked: 4`，**`violations: []`** |
| 任务质量不降 | C3/B1/B2/D1 全部为**增强**，未删任何既有能力；C1/C2 撤销是因为前提不成立 |

### ⚠️ 测试环境陷阱（必须记住）

`cargo test --workspace` 在**本会话 shell** 下曾大面积失败，根因不是代码而是
**宿主进程 env 泄漏**：

| 泄漏变量 | 污染哪个测试 | 机理 |
|---|---|---|
| `TOOL_RESULT_LIMIT=0` | `oversized_tool_result_is_truncated_in_context` | `AgentLoopConfig::from_env` 读进程 env，覆盖默认 8000 |
| `CONFIG_FILE` | `web_config_center_and_skills_crud` | `/api/config` 经 `apply_config_file_to_env` 读**实例**配置，provider 变 `openai` 而非 mock |
| `WORKSPACE_ROOT` | `full_react_loop_with_mock_llm_and_real_guests` | `fresh_artifact` 用**进程** env 解析相对路径，找不到临时工作区里的 `data.xlsx` |

**正确跑法**：跑测试前清空这些 env（见 `_p/final_tests.bat` 模板）。
这不是代码缺陷，但**会让「测试全红」误判成回归**——本次差点误判。

## 阶段 E2：重启后收益复测（2026-11-03）

### 测量方法

trace `memory/traces/s-mvz75po6.jsonl`（2.03 MB / 2042 事件）。**按 `user` 事件分段**
（每段 = 一次 chat），比按 `assistant` 分段更准（中止的 chat 不写 assistant 事件）。

### 分阶段对比

| 阶段 | 段数 | tool_call | bash 占比 | `cd /d` 率 | grep | symbols_search |
|---|---|---|---|---|---|---|
| `keep=194`（旧，段 1–8） | 8 | 397 | 259 / 397 = 65% | **253 / 259 = 97.7%** | 4 | **0** |
| `keep=30`（新，段 9–12） | 4 | 479 | 286 / 479 = 60% | **285 / 286 = 99.7%** | 11 | **0** |

### 三条硬结论（必须诚实记录）

1. **`agent.*` 配置确实生效**。`compaction` 事件的 `kept` 字段：前 8 次恒为 `194`，
   23:08 之后 3 次恒为 `30`。这是配置生效的**直接物证**，不依赖任何推断。

2. **Rust 改动（B1 提示词 / C3 脱敏 / D1 观测）在此 trace 内未生效**。
   **且比「启动早于改动」更严重：二进制本身就是旧的**。实测（2026-11-03 07:0x）：
   `target/debug/react-agent-host.exe` 的 **mtime = 2026-11-02 23:06:26**，与两个在跑进程
   （PID 34032 @ 23:06:26、PID 37204 @ 23:06:45）的启动时间**完全吻合**——即该二进制自
   23:06:26 之后**从未重新编译过**。更直接的证据：`cargo test` 报
   `failed to remove file ...react-agent-host.exe` / `sandbox-run.exe`（os error 5 拒绝访问），
   说明 cargo 想 relink 但被进程的文件锁挡住。
   → **「重启」不是充分条件**。正确顺序是：**停进程 → `cargo build` → 启动**。
   只重启不重编译，跑的还是 23:06:26 那个旧二进制。
   决定性证据：`chat_summary` 事件 **0 条**。宿主 `react-agent-host.exe` 启动时间
   **23:06:26**，而上述 Rust 改动完成于 **23:1x 之后**——进程跑的是改动前的二进制。
   `grep` 工具越界（报 `PATH_OUTSIDE_WORKSPACE`）、`cd /d` 率仍 99.7%，与此一致
   （B1 的「PREFER dedicated tools」和 D1 的 cwd 修复都还没加载）。

3. **Q 项（≤100 调用 / ≤80 轮）本次不可判定，且数据被污染**。
   - 段 10（115 调用）与段 11（67 调用）期间发生了 `budget_secs=900` **墙钟硬中止**，
     任务被中途掐断 → 调用数**偏低**，不代表效率改善。
   - 段 12（69 调用）是**当前会话本身**（含本次复测、改测试、跑回归）→ 调用数**偏高**。
   - 段 9（228 调用）是「完成所有待办」的大任务，工作量大，不宜直接对比基线 217。

### 复测暴露的 D1 观测缺口（新发现）

`budget_stop`（中止路径）**只写一条 `error` 事件，不写 `chat_summary`**。后果：

- 中止型 chat 在 trace 里**完全没有效率指标**，无法事后判断「掐断时已完成多少」；
- 本次复测正是因为这一点，才不得不靠 `user` 分段 + 人工判读。

→ 已并入 `specs/plan-completion` 的观测要求：**任何终止路径（正常 / 预算 / 取消 /
轮次耗尽）都必须写 `chat_summary`**。

## 阶段 E3：`compact_keep` 量化复核

`compaction` 事件共 11 条，字段为 `{type, ts, kept, summarized, summary}`：

| 序号 | 时间 | kept | summarized | 判读 |
|---|---|---|---|---|
| 1 | 21:01:55 | 194 | 186 | keep>trigger 的「假压缩」：历史 380 → split=186 |
| 2 | 21:20:51 | 194 | 131 | 同上 |
| 3 | 21:47:55 | 194 | 25 | 历史仅 219，split=25 |
| 4–8 | 21:59 – 22:23 | 194 | 81/16/43/22/12 | 每 chat 各触发 1 次 |
| 9 | **23:08:30** | **30** | **603** | **新配置首次真压缩**：一次摘掉 603 条 |
| 10 | 23:24:44 | 30 | 199 | 生效 |
| 11 | 06:25:43 | 30 | 120 | 生效 |

**结论修正**：原预期「压缩次数显著下降」**不成立**。次数仍是每 chat 约 1 次。
真实改善在**压缩质量**而非次数：

- 旧：`keep=194 > trigger=40` → `split = 历史 - 194`，摘要只覆盖极少数尾部；
  历史长期维持 190+ 条，**同一份上下文被反复摘要、且摘要几乎不减少体积**。
- 新：`keep=30 < trigger=40` → `split = 历史 - 30`，**首次即摘掉 603 条**，上下文真正瘦身。

触发源是「单个 chat 内历史条数 > trigger(40)」，不是「跨 chat 累积」——所以次数不会因
`keep` 改变而下降。这是对 spec §3 E4 的**修正**：E4 的问题描述（「假压缩」）正确，
但「压到 10 会减少压缩次数」的隐含预期错误。

---

## 迭代记录

- 2026-11-02 21:21：spec 立项。基线 chat#3 = 217 调用 / 160 轮；69% 轮次只发 1 个调用；
  bash 占 65% 且 96% 带 `cd /d`；`grep` 2 次 / `symbols_search` 0 次；
  `compact_keep=194 > trigger=40` 致压缩 5 次仍每轮重复触发。
- 2026-11-02 22:5x（重启后）：D1 修复生效验证（`echo %CD%` 正确返回工作区）。
  A1 三项配置改完并读回校验。
- 2026-11-02 23:0x：C1/C2 实测**推翻**原假设，撤销；C3 定位到 `secrets.rs` 并修复。
- 2026-11-02 23:1x：B1/B2 完成；D1 完成并处理**冻结事件契约**冲突；D2 评估结论「不做」。
- 2026-11-02 23:2x：真实仓库同步 + 63 测试全绿 + 技能/gate/ledger 验收通过。
- 2026-11-03 06:2x：**修正 `budget.rs` 语义缺陷**（用户核心不满的直接根因）——
  墙钟到点不再 `return K508` 丢弃全部成果，改为「软收敛轮」：剥工具 + 注入 wrap-up
  指令 + 没答案时自述进度报告。`StopReason::{Tokens(硬停), Deadline(软收敛)}` 分离。
  测试 63 → **64 全绿**（新增 2 条预算语义用例，改写 1 条）。
- 2026-11-03 06:5x：**修掉一条环境依赖型假红**（`secrets.rs:275`）。
  `config_mtime_is_zero_for_missing_file` 断言裸 `config_mtime() == 0`，但宿主任一实例在跑
  都会把 `CONFIG_FILE` 指向真实 config.json（实测 env 值 = `runtime/.instances/1102/config.json`，
  mtime=1793632057932）→ 该测试「宿主在跑就红、不在跑就绿」。改为显式把 `CONFIG_FILE`
  指向一个不存在的临时路径再断言 0。**这条不是本轮 Rust 改动引入的，属既有缺陷**，
  但它会让 Q/I 验收恒假红，故一并修。**全量 64 项复归全绿**（23+1+2+38）。
- 2026-11-03 06:3x：**重启后收益复测**（§E2）。结论：配置生效、Rust 未生效、Q 项未达标；
  发现 D1 观测缺口：`budget_stop` 中止路径**不写 `chat_summary`**，故中止型 chat 不可观测。

## 快照同步必重放项

> 本次改动位于 `runtime/crates/agent-loop/`，属「运行时快照适配」范畴。

1. **`secrets.rs`**：`scrub_str` / `looks_like_path` / `scrub_segment` + 2 用例（C3）
2. **`lib.rs:DEFAULT_SYSTEM_PROMPT`**：三条效率约束（B1）
3. **`skills.rs`**：`self_extension_section(root, full)` 双段 + `user_wants_skill_build`（B2）
4. **`chat.rs`**：`chat_summary` 事件（D1）+ `want_skill_build` 调用点
5. **`tests/contract_conformance.rs`**：`FROZEN_EVENT_TYPES` 增 `chat_summary`
6. **`budget.rs`**：`StopReason`（`Tokens` 硬停 / `Deadline` 软收敛）+ `is_hard()` /
   `tag()` + `WRAP_UP_DEADLINE`；`check_stop` → 纯判定 `check_budget`（不含取消逻辑）
7. **`chat.rs`**：`wrap_up` 软收敛状态 + 收敛轮**剥工具** + `budget_stop`（仅 token 返 K508）+
   `wrap_up_once`（一次性注入）+ `wrap_up_report`（按 `steps` 生成进度报告）

> 这五处必须随每次 `runtime/` 同步重放，否则效率约束与可观测性会在下次快照更新后静默消失。
> 阶段 A 是纯配置（`config.json`），不在重放范围内。
