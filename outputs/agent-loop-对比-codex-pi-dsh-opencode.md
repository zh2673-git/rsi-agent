# 4 个开源 AI Coding Agent 的「工具调用/主循环」机制对比

> 调研时间 2026-11-16。数据来源：GitHub 源码直读（raw.githubusercontent.com + api.github.com）、官方文档（learn.chatgpt.com / pi.dev / api-docs.deepseek.com / opencode.ai）、仓库 docs/*.md。
> pi 仓库已从 badlogic/pi-mono 重定向到 **earendil-works/pi**；opencode 仓库从 sst/opencode 重定向到 **anomalyco/opencode**（下文按 v1.19.5 取证）。
> 找不到的一律标「未查到」，未推测。

## 对比总表

| 维度 | OpenAI Codex CLI (codex-rs, Rust) | pi (earendil-works/pi, TS) | DeepSeek Harness (deepseek-ai/deepseek-harness, dsh) | opencode (anomalyco/opencode, TS) |
|---|---|---|---|---|
| **主循环驱动方式** | turn/step 模型：一次模型请求+其工具调用 = step；工具结果作为 `function_call_output` 回给 Responses API 触发下一步；每轮经 SQ/EQ 队列（用户输入、审批答复、settings、compact 全走同一 Submission Queue 保序）。出处：codex-rs/core/src/agent/*、codex-rs/protocol/src/protocol.rs | agent-loop 显式循环（`packages/ai/src/agent/agent-loop.ts`）：处理用户消息→执行工具→结果回喂→循环到模型不再调工具；**无 max steps 旋钮**（作者明说「没找到用途，所以不加」）。出处：badlogic/pi-mono 博客 + 源码路径 | turn/step 两级：turn = 零或多个 step，step = 一次模型请求+其工具调用；**agent loop 本身就是插件**（core/agent-loop 只是默认 driver，可整体替换）；turn 关闭条件 =「没有欠着的输入」（显式输入认领）。出处：docs/architecture.md、docs/agent-lifecycle.md | session 内 step 循环；session/processor 驱动，一 session 多消息；**loop 本身在 packages/core/src/session/compaction.ts 的 Service 层组装**（Effect 框架）。出处：packages/opencode/src/session/*（v1.19.5） |
| **一轮多工具并行** | 支持：MCP server 有 `supports_parallel_tool_calls` 开关（默认 false，需显式声明可并行）；模型侧并行执行的工具调用由 harness 按序喂回。出处：config-reference `mcp_servers.<id>.supports_parallel_tool_calls` | **并行执行、按源顺序持久化**（pi-agent-core README 明文：工具并行跑，结果按调用顺序落盘）。出处：packages/agent/README.md | 工具是插件包（dsh-tool-bash/fs/…）经 guarded 执行管线跑；并行度未见显式文档配置（**未查到**每轮并行工具数的上限设定）。出处：docs/tool-catalog.md | 有并发读取示例（提示词示例「uses concurrent read file tool use blocks in one tool call」鼓励并行搜索+并行读）；运行时并行度参数**未查到**独立旋钮。出处：packages/opencode/src/session/prompt/default.txt、docs/tools/ |
| **上下文压缩：触发与策略** | 三层：① `model_auto_compact_token_limit`（token 阈值触发 auto compact，scope 可选 total / body_after_prefix）；② `model_post_turn_compact_threshold_percent`（0–100，turn 结束时上下文占比达阈值就压缩，0=关）；③ rollout_budget（实验性，`limit_tokens` + `reminder_at_remaining_tokens` 多级提醒）。压缩走 PreCompact/PostCompact hooks + 本地摘要或服务端 remote v2 compaction；token-budget 型 compaction「跳过摘要、直接装新上下文窗口」。出处：config-reference（上述三个 key）、codex-rs/core/src/compact_token_budget.rs、state/auto_compact_window.rs | compaction = **追加一条 CompactionEntry**（summary / firstKeptEntryId / tokensBefore / systemMessage），原文条目不删，后续请求从「摘要+保留的近期消息」重建；接近上限自动触发，`/compact` 可手动并附「保留某主题」指令；**compaction 本身可由扩展自定义**（`pi.on` 拦截）。出处：pi.dev/docs/latest/sessions、packages/coding-agent/docs/session-format.md | compaction **不是 loop 骨架，是 capability seam**（`dsh-compaction` 服务 + `dsh-compaction-basic` provider + `/compact` consumer）；摘要 = 一条带 `surfaceOp:{op:'replace',startSeq,endSeq}` 的 user/message 落 model-visible surface；**日志锁括住全流程**（start→摘要→summary→replace→end），崩溃留「孤儿锁」（有 start 无 end）可检测。出处：docs/subsystems/compaction.md | 两条独立机制（v1.19.5 源码常量）：① **prune**：保留最近 40k token（`PRUNE_PROTECT=40_000`）的工具输出，把更老的工具输出清空（`TOOL_OUTPUT_MAX_CHARS=2_000` 截断后清），至少要能省 20k（`PRUNE_MINIMUM=20_000`）才动手，skill 工具受保护；② **summarize/compact**：把 head 段序列化成 `[User]:…/[Assistant]:…/[Tool result]:…` 文本交 compaction agent 生成摘要，**tail 保留预算 = min(15_000, max(2_000, usable×0.25))**（可配 `compaction.preserve_recent_tokens` / `tail_turns`）；溢出（isOverflow：tokens ≥ usable，usable = 输入上限 − 20k buffer）自动触发并重放 overflow 前的用户消息。出处：packages/opencode/src/session/compaction.ts、overflow.ts |
| **前缀稳定性（prompt cache）** | 前缀意识内建：`model_auto_compact_token_limit_scope = body_after_prefix` 把「压缩窗口携带的前缀」从阈值里剔除——承认前缀是稳定可复用部分；`base_instructions` 记录在 SessionMeta 首行（rollout），整个会话内 instructions 不变；**未查到**显式 cache_control 注入。出处：config-reference、codex-rs/rollout/src/recorder.rs（SessionMeta） | 三件套：① skill 只把 name+description+path 进 prompt（全文按需读取）→ 前缀小且稳；② **cacheWarming: off\|streaming\|idle（默认 streaming）**——仅当模型声明 cache 寿命且预计可省 ≥$0.05 时才做预热，预热用量计统计但不进模型上下文；③ tool 定义随请求携带（自然进前缀缓存）。出处：packages/coding-agent/docs/settings.md、session-format.md | **工具目录跨模式不变**（plan 模式原文："The tool catalog stays the same across modes for request-cache stability"——变更工具宁愿靠模式规则禁用，也不把工具从目录里摘掉，保住请求形状）；「model-visible means logged」保证请求可完整重建。出处：packages/bundle/base/cordis.patch.yml（plan-mode 段）、docs/architecture.md | **最重 cache 的一家**：① 给所有支持 provider 显式挂 cache 断点（anthropic/openrouter/bedrock/openaiCompatible/copilot/alibaba 的 cacheControl: ephemeral，挂 system 前 2 条 + 最后 2 条消息 `applyCaching`，transform.ts:358-406）；② 会话 ID 作 promptCacheKey（openai/azure/xai/mistral/deepinfra/cerebras 等，`result["promptCacheKey"] = input.sessionID`，transform.ts:1323-1384）；③ 未签名 reasoning 在分派 cache 点前先过滤（防「cache-point-only message」破坏前缀重放）。出处：packages/opencode/src/provider/transform.ts |
| **每轮注入的静态内容处理** | 极简工具面 = 每轮静态开销小：核心只有 exec_command（统一 shell）+ apply_patch，读文件/搜索全靠 shell 里的 rg（提示词："prefer using `rg`… because `rg` is much faster"）；MCP 工具 schema 超 5000 字节自动压缩（`tool_input_schema_max_bytes`）；AGENTS.md 分层按需。出处：gpt_5_codex_prompt.md、config-reference | 全部静态内容 <1000 token（system prompt + 4 个工具定义，作者博客实测数字）；AGENTS.md 是唯一追加注入；skill 全文不进 prompt。出处：mariozechner.at/posts/2025-11-30-pi-coding-agent | prompt 分节组装（core/system-prompt 包）；工具 schema 按注册表装配；dsh-base 含 persona（默认空串）+ AGENTS.md 等分节；**未查到**每轮注入体积硬上限。出处：docs/tool-catalog.md、packages/core/system-prompt/README.md | 按模型家族分文件的系统提示词（default/anthropic/gpt/gemini/kimi/meta/trinity…，anthropic.txt 是 Claude Code 提示词的裁剪版）；plan 模式切换用小片段注入（plan.txt/build-switch.txt）。出处：packages/opencode/src/session/prompt/ |
| **token 预算控制** | ① `model_context_window` 显式声明窗口；② `model_auto_compact_token_limit` 即上下文阈值；③ `features.rollout_budget`（实验）：整会话 token 硬上限 + 剩余预算多级提醒（reminder_at_remaining_tokens），prefill/sampling token 各有权重系数；④ `goals.max_goal_token_budget`；⑤ MCP 工具输出 `output_token_limit` + 「标准 20% 序列化余量」。出处：config-reference 各 key | 模型注册表带 contextWindow/maxTokens 字段（models.generated.ts，从 models.dev/OpenRouter 同步）；agent loop 无步数上限（有意设计）；**未查到**独立「每轮 token 预算」旋钮。出处：packages/ai/src/models.generated.ts、博客 | 工具输出超长存 **spill file**（不进上下文）；前台命令超时自动转后台 job（promoteOnTimeout）+ `job_output` 轮询——把「大输出」从上下文转移到文件；**每轮 token 数值预算**未查到。出处：docs/tool-catalog.md | compaction 预算体系见上行（usable = 输入上限 − reserved 20k；tail 保留按 usable×0.25）；每消息 token 估算用 `Token.estimate`；**每轮硬上限**未见（溢出走 compact 自动重试）。出处：session/overflow.ts、compaction.ts |

## 关键差异一句话

- **Codex**：预算法内建到配置面（auto_compact 阈值 + post_turn 百分比 + rollout_budget 三档），cache 靠「前缀剥离计阈值」的思路，不玩显式 cache_control。
- **pi**：最激进——把静态内容压到 <1000 token，让前缀天然稳定；compaction 是「追加不删」的事件；cache 是可选预热服务（cacheWarming）。
- **dsh**：唯一把「工具目录跨模式不变」写成 cache 策略的（request-cache stability），且 compaction 带崩溃可检测的日志锁——工程化最重。
- **opencode**：cache 做得最细（per-provider cacheControl 断点 + promptCacheKey=sessionID + 未签名 reasoning 过滤），压缩是 prune（清旧工具输出）+ summarize（tail 预算保留）双机制。

## 对比 rsi-agent 的三个最相关基线数字

| 指标 | rsi-agent（chat#3 实测，specs/call-efficiency §2.2） | 参照 |
|---|---|---|
| 每轮平均工具调用数 | **1.36**（217 calls / 160 rounds），69% 轮次只发 1 个调用 | 本轮外部调研工作流实测 54 chats 均值 1.3、max 2.94——说明并行利用率低是习惯/提示词问题，不是内核能力问题（内核 max_inflight 默认 8） |
| 工具结果回喂 | tool_result_limit 默认 8000 字符（按工具 ×4/×3 放大） | dsh 用 spill file（完全出上下文）、opencode 用 2000 字符截断 + prune——两家都把「大输出留文件」当默认 |
| 压缩 | 双闸（条数>40 或 token 超 ctx_budget×0.7）→ 摘要+保留最近 10 条 | opencode 的 tail 预算是 usable×0.25（比例自适应）而非固定条数；pi/dsh 是「追加不删原文」 |

## 主要出处清单

**Codex**：
- config-reference: https://developers.openai.com/codex/config-reference （model_auto_compact_token_limit / _scope / model_post_turn_compact_threshold_percent / features.rollout_budget.* / supports_parallel_tool_calls / tool_input_schema_max_bytes / output_token_limit / model_context_window）
- 源码： https://github.com/openai/codex/tree/main/codex-rs/core/src （compact*.rs、state/auto_compact_window.rs、context/token_budget_context.rs）
- 协议 SQ/EQ: https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs
- 提示词： https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/gpt_5_codex_prompt.md

**pi**：
- 设计博客（作者本人）： https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- agent loop 源码： https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/agent/agent-loop.ts
- sessions/compaction: https://pi.dev/docs/latest/sessions 、 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- cacheWarming: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/settings.md

**DeepSeek Harness**：
- 仓库： https://github.com/deepseek-ai/deepseek-harness
- architecture: https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md
- compaction: https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/compaction.md
- tool-catalog: https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/tool-catalog.md
- request-cache stability 原文： packages/bundle/base/cordis.patch.yml（plan-mode 段）

**opencode**：
- compaction 源码（常量即证据）： https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/compaction.ts
- overflow 触发： https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/overflow.ts
- cache 断点与 promptCacheKey： https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/provider/transform.ts
- 提示词目录： https://github.com/anomalyco/opencode/tree/v1.19.5/packages/opencode/src/session/prompt

**未查到（如实标注）**：
- Codex：TUI 内「回车即 steer」的键位级源码证据；本地 compaction 摘要的具体百分比默认值（文档只给「model defaults」）。
- pi：每轮 token 硬上限旋钮。
- dsh：每轮并行工具数上限、每轮 token 数值预算。
- opencode：运行时并行工具数的独立配置项（提示词鼓励并行，但未见 max_inflight 类旋钮）。
