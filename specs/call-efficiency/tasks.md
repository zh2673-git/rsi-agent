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

- [ ] **`specs/plan-completion`（停前自检）**：`tasks.md` 有未勾选项时不禁止停，但要求
      `finish()` 写一条 `plan_mismatch` 并提醒一次。理由：本次实测证明「模型自认为做完」
      与「tasks.md 实际勾选」会不一致（见 spec §3 E6）。
- [ ] **重启验证 A1+B1+B2 的实际收益**：`agent.*` 与 Rust 改动都要重启才生效。
      重启后用同等工作量任务复测 `calls/rounds/cd /d 外壳率/grep 使用数`。
- [ ] **`compact_keep` 的量化复核**：改成 30 后应观察到压缩次数显著下降（基线 7 次）。

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

## 迭代记录

- 2026-11-02 21:21：spec 立项。基线 chat#3 = 217 调用 / 160 轮；69% 轮次只发 1 个调用；
  bash 占 65% 且 96% 带 `cd /d`；`grep` 2 次 / `symbols_search` 0 次；
  `compact_keep=194 > trigger=40` 致压缩 5 次仍每轮重复触发。
- 2026-11-02 22:5x（重启后）：D1 修复生效验证（`echo %CD%` 正确返回工作区）。
  A1 三项配置改完并读回校验。
- 2026-11-02 23:0x：C1/C2 实测**推翻**原假设，撤销；C3 定位到 `secrets.rs` 并修复。
- 2026-11-02 23:1x：B1/B2 完成；D1 完成并处理**冻结事件契约**冲突；D2 评估结论「不做」。
- 2026-11-02 23:2x：真实仓库同步 + 63 测试全绿 + 技能/gate/ledger 验收通过。

## 快照同步必重放项

> 本次改动位于 `runtime/crates/agent-loop/`，属「运行时快照适配」范畴。

1. **`secrets.rs`**：`scrub_str` / `looks_like_path` / `scrub_segment` + 2 用例（C3）
2. **`lib.rs:DEFAULT_SYSTEM_PROMPT`**：三条效率约束（B1）
3. **`skills.rs`**：`self_extension_section(root, full)` 双段 + `user_wants_skill_build`（B2）
4. **`chat.rs`**：`chat_summary` 事件（D1）+ `want_skill_build` 调用点
5. **`tests/contract_conformance.rs`**：`FROZEN_EVENT_TYPES` 增 `chat_summary`

> 这五处必须随每次 `runtime/` 同步重放，否则效率约束与可观测性会在下次快照更新后静默消失。
> 阶段 A 是纯配置（`config.json`），不在重放范围内。
