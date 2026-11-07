# rsi-agent 前端交互 / 会话并发 / 记忆模块 逆向诊断与优化方案

> 产出方式：`project-dev` 技能判定为 **优化模式（逆向延续）**；按 `repo-explorer` 六步深读取证、按 `tdd` 纪律核对基线。
> 本文为**调研 + 详细方案**，本轮**未改动任何运行体代码**（原因见 §7 写保护边界）。
> 所有结论都给出 `文件:行号`；外部设计给出来源 URL。证据基线：rsi-agent 仓库内嵌 react-agent v0.1.22 / agent-kernel v0.1.8 快照（2026-11-06 工作区状态）。

---

## 0. 结论速览（先回答四个问题）

| # | 用户问题 | 结论 | 可行性 |
|---|---|---|---|
| 1 | 运行中能否追加指令（排队）/插队 | **能做，且底座已有 80% 零件**：取消链路（cancel + abort + K499）、同会话互斥闸、SSE 事件流都已具备；缺的是「显式队列 + 队首调度 + UI 状态按会话拆分」。**推荐两层实现**：A 层前端队列（零核心改动、可先落地）；B 层服务端持久队列（跨标签页/多窗口一致）。 | ✅ 可行 |
| 2 | 切换对话瞬间显示历史 | **当前是「每次切换都清 DOM + SSE 从 `after=0` 全量重放」**，没有任何前端历史缓存；慢点定位到 `switchSession()`、`connect(0)`、`trace.read` 分页 800 条/1MB 与逐事件 DOM 重建三处。**可行**：加「按会话 DOM 快照 + 游标缓存」即可做到切换瞬时显示，再用增量 SSE 补齐。 | ✅ 可行 |
| 3 | 同端口新对话被老任务挡住 / 新窗口呢 | **代码层面同端口不同 session 的 chat 是并发的**（HTTP 每连接 `tokio::spawn`、agent-loop `Concurrent` + `max_inflight=8`、会话锁是 per-session）。用户看到的阻塞主要来自**前端全局单例状态**：`sendBtn.disabled`、`chatAbort`、`es` 都是页面级变量，切换会话后仍禁用发送、且 SSE 被切走；此外 memory 插件 `concurrent:false`（串行）与内核全局 `max_total_inflight=32` 是共享上限。**真正的「新窗口」= 独立 host 进程 + 独立端口 + 独立数据目录，完全不受影响**；单纯 `window.open(同一个 8710 URL)` 只是新标签页，共享同一 host，但各自有独立 JS 全局状态。 | 部分误判 + 局部缺陷 |
| 4 | 记忆等模块借鉴先进项目优化 | 记忆模块已完成 P4（trace 行偏移索引、原子写、损坏告警），但**模型上下文仍是「每轮全量 get + 破坏性 summarize」**，缺分层记忆、append-only 事件源、索引/快照、TTL/淘汰、异步摘要、显式 steer 注入。pi / deepseek-harness / codex / Claude Code 的机制可**不脱离底座**地分三批落地（详见 §6）。 | ✅ 可行 |

---

## 1. 系统本质与时空契约还原（repo-explorer 第 1-3 步）

**本质**：一个「事件溯源 + 插件化 ReAct」运行时。host 是组合根（HTTP/SSE 入口 + kernel 装配），agent-loop 是状态机编排器，memory 插件同时持有「给模型看的上下文」与「给 UI 看的事件日志」两类数据。

- **空间归属**：
  - 会话上下文 `Map<sessionId, Msg[]>`  + `data/sessions/<id>.json`（每会话一文件，写时全量 rewrite）——`runtime/plugins/memory/memory_plugin.ts:72,100-115`；
  - UI 事件日志 `data/traces/<id>.jsonl`（只追加）——`memory_plugin.ts:63-70,304-308`；
  - 取消标志 / 会话闸 / 流式 sid 在 agent-loop 进程内 `Mutex<HashMap<session,…>>`——`runtime/crates/agent-loop/src/lib.rs:178-204`；
  - 前端 `session`、`es`、`chatAbort`、`sendBtn.disabled` 是**每个标签页一份的全局单例**——`runtime/crates/host/web-dist/vendor/app-core.js:11`、`app-events.js:163,268`。
- **时间流形态**：HTTP 每连接一个 `tokio::spawn`（`runtime/crates/host/src/web/mod.rs:97-105`）→ `/api/chat` 同步 `await kernel.dispatch` 直到收敛（`web/mod.rs:483-493`）→ agent-loop ReAct 循环（`chat.rs:266-…`）→ 过程事件经 `trace.append` 落盘 → SSE 连接独立轮询 `trace.read` 推给前端（`web/gateway.rs:41-215`）。**主循环是阻塞式单回合 + 旁路事件流**，不是消息泵/队列。
- **规则拦截**：per-session `tokio::Mutex` 的 `try_lock()` 拒绝同会话并发 chat，返回业务 `K409`（`chat.rs:235-247`）；`cancel` 走 `Concurrent` 语义 + 轮次边界 `take` 检查收敛为 `K499`（`lib.rs:226-231,329-360`、`budget.rs:127-134`）；插件并发语义由 manifest 声明（`assemble.rs:83,100,117,133`）。

**第0级分层审计**：`runtime/crates/host`（interfaces + 组合根）、`runtime/crates/agent-loop`（application/编排）、`runtime/plugins/*`（infrastructure 落地）、`runtime/kernel`（core 契约）基本对齐；**缺失的是「调度层」**——没有 per-session 任务队列、没有运行状态机（idle/running/cancelling/queued），运行态散落在前端 DOM 属性与 agent-loop 的几个 HashMap 里。这正是问题 1/3 的共同根因。

---

## 2. 问题 1：运行中不能追加指令 —— 根因与「排队 / 插队」方案

### 2.1 根因（代码证据）

1. **前端把「忙」表达成一次 fetch 的局部状态**：
   - `send()` 里 `sendBtn.disabled = true; ... finally { sendBtn.disabled = false; }`——`app-events.js:269-291`；
   - 输入框**没有禁用**、`send()` 开头只判 `if (!text) return;`，Enter 也直接调用 `send()`（`app-events.js:270-271,330-332`）——所以严格说运行中按 Enter 仍会发第二个 `/api/chat`，只是按钮被禁用、用户直觉上「发不出去」；
   - `chatAbort` 是单变量（`app-events.js:268,279,290`），并发两条请求会互相覆盖、`finally` 互相提前解锁；
   - 停止按钮复用这个单变量：`POST /api/chat/cancel?session=` + `chatAbort?.abort()`（`app-events.js:318-329`）。
2. **服务端没有「排队」概念，只有「拒绝」**：
   - 路由表只有 `/api/chat`、`/api/chat/cancel`、`/api/chat/rollback`、`/api/events`（`web/mod.rs:305-505`），无 queue/enqueue/status/running 端点；
   - `/api/chat` 直接 `kernel.dispatch({"op":"chat"})` 并阻塞等待（`web/mod.rs:473-493`）；
   - 同会话第二次 chat 被 `try_lock()` 挡回 `K409`「该会话已有进行中的对话……请等待完成或先停止当前回合」（`chat.rs:235-247`）——**这是 2026-11-04 P2/A1 的明确设计决策：「不排队不阻塞」**（`docs/self-evolution/00-PLAN.md:18,42`；`lib.rs:198-201`）。
3. **取消链路其实已经完整**（插队的现成零件）：
   - 前端 `POST /api/chat/cancel?session=`（`app-events.js:321`）；
   - host 并行 dispatch `agent-loop.cancel` + `llm-adapter.abort`（`web/mod.rs:359-383`）；
   - agent-loop 置位 `cancels`，并联动 `tools.abort` 用 System 优先级泳道（`lib.rs:329-359`）；
   - 轮次开头 / 工具波次之间 `check_cancel()` 收敛为 `K499`（`chat.rs:388,579`；`budget.rs:127-134`）；
   - llm-adapter 流式逐帧检查 abort 关流（`runtime/plugins/llm_adapter/llm_plugin.py:47-56`；`assemble.rs:99-100`）。

> 结论：**「插队 = 立即停止当前任务再执行新指令」= 已有 cancel 链路 + 一次新的 `/api/chat`**，只差「编排 + 状态保证」；**「排队」= 把被 K409 拒绝的指令先存起来、等当前回合结束后自动按序发出**，前端或服务端都可做。

### 2.2 语义定义（先定契约，再写代码）

| 用户输入 | 语义 | 触发时机 | 已有零件 |
|---|---|---|---|
| `Enter` / 发送（默认） | **排队（follow-up）**：任务完成后自动执行下一条 | 当前 chat 的 fetch `finally` 之后 | 无（需新增） |
| `Alt+Enter` / 「插队」按钮 | **steering（软插队）**：不杀当前任务，把消息注入**下一个轮次边界**，让模型在工具波次之间看到 | agent-loop 轮次边界 | 无（需 loop 配合，或 B 层用「取消+重启」近似） |
| `Esc` / 「停止并执行」 | **interrupt（硬插队）**：立即 cancel+abort，收敛为 K499 后立刻执行新指令 | 点击瞬间 | ✅ cancel/abort/K499 全套 |
| 队列抽屉 | 查看/编辑/删除/上移待发指令 | 任意时刻 | 无 |

借鉴来源：
- pi 明确区分 `Enter`=steering（当前 assistant turn 及工具调用结束后引导下一次）、`Alt+Enter`=follow-up（整任务完成后）、`Esc`=abort 并把排队消息退回编辑器、`steeringMode/followUpMode=all|one-at-a-time`——https://pi.dev/docs/latest/how-pi-works ，https://pi.dev/docs/latest/sessions ；
- deepseek-harness 单 inbox 三路由 `send(message,target,wakeup)`：followup 独占自己的 turn、steer 在最近 step 边界消费、inject 只补下一 pre-step 上下文；`cancel(cause,{keepInbox?})` + AbortSignal + `whenIdle()`——https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.md ；
- Claude Code：官方交互模式文档列出 Esc 中断、Up 取回历史/队首消息等快捷键与排队行为；「Esc 保留已完成工作并立即发送排队消息」的完整语义本次页面片段未能逐字复核，落地时以官方页为准——https://code.claude.com/docs/en/interactive-mode ；
- codex：SQ/EQ 单队列保序，`Op::Interrupt` 只 abort 当前任务、`InterruptIfNoPendingInput` 仅无排队输入时中断——https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs 。

### 2.3 方案 A（推荐先做：**前端队列，零核心改动**）

改动文件：`runtime/crates/host/web-dist/vendor/app-events.js`、`app-core.js`、`index.html`、`style.css`。

1. 把「忙」从 DOM 属性提升为 **per-session 状态表**：
   ```js
   // 新增（app-events.js 顶部）
   const runState = new Map();   // session -> {running:boolean, abort:AbortController|null, queue:[]}
   const st = (sid) => runState.get(sid) || {running:false, abort:null, queue:[]};
   ```
   `sendBtn.disabled` 只作为**当前会话**的视觉投影：`switchSession()` 时按 `st(id).running` 重算，而不是沿用旧会话的 `false/true`（`app-core.js:86-91`）。
2. `send(text)` 改写为「入队 + 单消费者」：
   - 若 `st(cur).running` → `queue.push({text,atts})`，立刻清空输入框、渲染「待发 N 条」抽屉，**不发 fetch**；
   - 否则启动 `drain(sid)`：`while(queue.length)` 顺序 `await postChat()`，每条 `finally` 里才取下一条；**绝不再用单变量 `chatAbort`**，改为 `st(sid).abort`。
3. 插队按钮 `interruptAndSend()`：
   ```
   await POST /api/chat/cancel?session=<sid>;  st(sid).abort?.abort();
   // 不直接发！等本轮 fetch 的 finally（服务端 K499 收敛）后再把新指令 unshift 到队首
   ```
   关键点：现有 `chatAbort.abort()` 只是**客户端**断开 fetch，服务端 agent-loop 仍在跑（`web/mod.rs:483` 的 dispatch 不随连接断开取消）；必须等 `cancel` 生效 + 轮次边界收敛，否则新 chat 会撞上 `K409` 同会话闸。**验收用例**必须覆盖这个竞态。
4. `stopBtn` 语义保持「停止并丢弃队列」（pi 的 abort 把排队消息退回编辑器，可做成「退回输入框」）；`rollbackTo` 的 `sendBtn.disabled` 拦截（`app-events.js:298`）改为查 `st(sid).running`。
5. UI：`index.html` composer 增加「⏭ 插队」按钮与待发队列抽屉（默认隐藏），样式复用 `.btn.ghost`。

**为什么 A 层不脱离底座**：完全复用既有 `/api/chat` + `/api/chat/cancel` + trace/SSE；不动 kernel、不动 agent-loop、不动插件 manifest。局限：队列只活在当前标签页内存，刷新/多标签页不共享（这正是 B 层要补的）。

### 2.4 方案 B（进阶：**服务端持久队列**，跨标签页一致）

改动文件：`runtime/crates/agent-loop/src/lib.rs`（加 `queues: Mutex<HashMap<String, VecDeque<ChatReq>>>` 与新 op）、`chat.rs`（chat 出口自动 drain 队首）、`host/src/web/mod.rs`（新增路由）、前端改为 POST 队列端点。

- 新 op 面（保持现有 op 兼容，纯追加）：
  - `{"op":"enqueue","session_id","user_text","attachments"?}` → 入队，返回 `{queued:true, position:n}`；当前空闲则**立即启动**（内部复用 `chat_body`）；
  - `{"op":"interrupt","session_id","user_text"}` → `cancel` 置位 + `llm-adapter.abort`（复用 `web/mod.rs:359-383` 的逻辑）+ 清空/保留队列策略 + 把新指令置队首；
  - `{"op":"queue/status","session_id"}` → `{running, pending:[…], mode}`；
  - `{"op":"queue/remove","session_id","id"}` → 删除待发项。
- 调度点：`chat_body` 的 `out` 返回前（`chat.rs:249-263`，`session_chats` 闸释放之后）检查队列，非空则 `tokio::spawn` 下一条 chat——**必须复用同一 per-session 闸**，绝不并发两条。
- 空间卫生：队列随 chat 结束逐出；`destroy()` 清空；队列上限（如 20 条）与总字节上限，防无界增长（tdd 不变量）。
- 持久性：队列项在入队时即写 `trace.append` 一条 `queued_user` 事件（前端可渲染「待发」气泡），这样刷新后队列仍在、UI 可重放；执行时再写正式 `user` 事件。这符合「Model-visible means logged」（`runtime/plugins/memory/README.md:8`）。
- **steering（软插队）**：如需轮次边界注入，在 `chat.rs:388` 的 `check_cancel` 之前加 `check_steer()`：读取队列里 `target=steer` 的项，把文本作为一条 `user` 消息 `messages.push` 后继续本轮（不新开 chat）。**这一步才真正动 loop**，属于可选 Phase 3；A/B 层的「插队」用「停止+重启」近似即可满足用户描述。
- 与既有裁决的关系：`00-PLAN.md:18,42` 否决的是「**隐式**把两次并发 chat 串成顺序」，不是「显式队列」。方案 B 是显式、可观测、可取消的队列，且保留 `K409` 对未走队列的并发裸请求的拒绝——**不推翻旧决策，只补一层入口**。应在 `docs/self-evolution/00-PLAN.md` 追加一条「已评估：显式队列 vs 隐式排队」的迭代记录。

### 2.5 验收（Q / I）

- Q1 运行中连发 3 条 → 三条依次执行，trace 出现 3 个 `user` 事件且顺序一致，无 `K409`；
- Q2 点「插队」→ 当前回合收敛 `K499`/被取消，新指令**紧接着**执行，不出现 `K409` 竞态；
- Q3 停止后队列项退回输入框（或按配置丢弃）；切换会话再切回，队列与按钮状态一致；
- I：旧行为不回归——直接并发 POST 同 session 仍返回 `K409`；`cancel` 仍能在长流式生成中即时生效；`rollback` 的 `user` 计数口径不被 `queued_user` 事件污染（该事件 `type` 不能是 `user`，见 `memory_plugin.ts:249-263` 的回滚计数逻辑）。

---

## 3. 问题 2：切换会话历史加载慢 —— 根因与「瞬时显示」方案

### 3.1 根因（代码证据，逐层）

1. **会话列表只存元数据**：`localStorage` 只有 `{id,title}`（`app-core.js:5-25`），**没有任何消息/DOM 缓存**。
2. **每次切换都全量重放**：`switchSession(id)` → `connect()` → `connect(0)` → `es.close()` + `resetSessionFeed()`（`feed.innerHTML=""` + 清 20+ 状态）→ 新建 `EventSource(...&after=0)`——`app-core.js:86-91`、`app-events.js:168-191`。回滚、删除会话同样 `connect(0)`（`app-core.js:84`、`app-events.js:310`）。
3. **服务端重放是分批的**：SSE 从 `after=0` 起，每轮 `trace.read` 最多 800 条 / 1MB（`memory_plugin.ts:328-345`），`has_new` 时立即再拉（`gateway.rs:191-195`）；大会话要跨多批才能 catch up，期间 `replaying=true` 不推流式旁路（`gateway.rs:23-25,60-64`）。
4. **每条事件都做 DOM 构建 + 强制滚动**：`render()` 逐事件 `el(html)`/`appendChild` + `scrollFeed()`（`app-events.js:14-157,157`），其中 `tool_call` 卡片、`renderAssistant` 的 markdown（`app-core.js:132-181`）、附件 base64 缩略图都较重；`resetSessionFeed()` 还调用各模块的 reset（`app-events.js:168-182`）。
5. **trace 索引已有但只优化「读文件」**：P4 的行偏移索引让稳态 `trace.read` 是 O(页)（`memory_plugin.ts:117-161,310-345`），但**没解决「前端每次都要重新接收并重新渲染全部事件」**。
6. 附带：`SSE` 是每标签页一条、按当前 session 建连（`app-events.js:187-191`），切换即关闭重建；服务端 `gateway.rs` 每连接独立 300ms 轮询，多标签页开同一 host 会放大 memory 轮询——`memory` 是 `concurrent:false`（`assemble.rs:83`），串行处理。

> 所以「慢」= 网络重传全量事件 + 逐事件 DOM 重建 + 分批 catch-up 三者叠加，与「磁盘读」关系已经不大。

### 3.2 方案：**会话视图缓存 + 增量追赶**（前端为主，零核心改动）

1. **DOM 快照缓存**：`Map<sessionId, {html:string, cursor:number, scrollTop:number, uiState}>`。离开会话时把 `feed.innerHTML`、`lastAfter`、`scrollTop`、以及 `resetSessionFeed()` 里那些状态（`userTurns`、`pending`、`doneSids`、stream/文件卡引用）序列化进缓存；切回来时 `feed.innerHTML = cached.html` **同步瞬时显示**，再用 `EventSource(...&after=cached.cursor)` 只补增量。
   - 关键约束：现有渲染器把状态放在模块级 `let`（`app-stream.js:5-7,38-40`、`app-events.js:3-13`），必须在 `resetSessionFeed()` 的对称位置加 `snapshotSessionFeed()`/`restoreSessionFeed()`，沿用 P7「集中重置入口」纪律（`docs/self-evolution/00-PLAN.md:47` 只落地了 reset 半边）。
   - `lastAfter` 目前是「收到的持久事件数 ≈ trace 游标」的近似（`app-events.js:212`），要用服务端 `trace.read` 的 `next` 精确值：建议 SSE 帧带 `cursor` 字段（前端优先用之，缺省退回自增），否则跨批/跳帧时游标会漂。
2. **保留每条 SSE 连接（可选增强）**：不 `es.close()`，改为按 session 建多条 `EventSource`，切会话只切换显示哪份 DOM；后台连接用 `after=cursor` 持续追。代价是每会话一条连接与 300ms 轮询，需设上限（如最近 5 个会话）与 `visibilitychange` 暂停。若不做，至少把重连从 `after=0` 改成 `after=cached.cursor`。
3. **服务端快照端点（可选，跨设备瞬时）**：`GET /api/session/snapshot?session=` 返回「最近 N 条事件的**预渲染友好**摘要 + 精确 cursor」，或让 `trace.read` 支持 `before/limit` 倒序分页；codex 的 `session_index` + filesystem-first 扫描、pi 的「首屏只重建活动分支」都是这个思路（§6 A）。**注意**：本项目 UI 真相源是 trace（`memory_plugin.ts:50-58`），快照必须是 trace 的派生，不能另立事实源。
4. **渲染层优化（长会话兜底）**：`DocumentFragment` 批量 append 替代逐条 `appendChild`；重放阶段抑制 `scrollFeed()`（只在 catch-up 后恢复用户原滚动位置）；`tool_call` 卡片默认 `open` 改为重放时折叠；超过阈值（如 2000 事件）走「只渲染最近 K 条 + 顶部『加载更早』按钮」（前端虚拟列表/窗口化），避免首屏 O(N) DOM。

### 3.3 借鉴与验收

- codex：`pending_items` 攒内存 + 单后台 writer + `flush()` ack、resume 以 append 打开——https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs ；`session_index` / `state_db` 让列表页不解析全量 JSONL——https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/lib.rs ；
- deepseek-harness：append-only typed `SessionEvent` 是唯一事实源，LLM 历史为派生视图，首屏 = replay 派生——https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.md ；
- pi：会话是 JSONL **树**，首屏只重建活动分支，compaction 原文不删——https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md 。

验收（Q/I）：切换前后 DOM 节点数/文本一致；切换耗时从「秒级重放」降到一次同步 `innerHTML` 赋值（可用 `performance.now()` 埋点）；切回后新增消息只追加一次、不重复气泡（`doneSids` 恢复正确）；回滚/删除会话走 `connect(0)` 时**必须清掉该会话缓存**（`app-events.js:310`、`app-core.js:84`），否则出现「已删除内容复活」——这是最容易被忽略的不变量。

---

## 4. 问题 3：同端口新对话是否被老任务挡住 / 新窗口如何

### 4.1 服务端：不同 session **不互斥**

| 层 | 证据 | 结论 |
|---|---|---|
| HTTP | `web/mod.rs:97-105` 每 `accept` 一个 `tokio::spawn` | 连接级并发 |
| agent-loop manifest | `lib.rs:226-231` `Semantics::Concurrent`、`max_inflight=Some(8)` | 最多 8 条 chat 并发（含 cancel 余量） |
| 会话闸 | `chat.rs:237-247` 按 `session_id` 取 per-session `tokio::Mutex`，`try_lock` 失败才 `K409` | **只锁同一 session** |
| kernel 全局 | `assemble.rs:76` `max_total_inflight=32` | 全局槽位（8 个不同会话 + 各插件调用基本够用；极端满载才排队） |
| memory | `assemble.rs:83` `concurrent:false` | 所有会话的 memory op **串行**执行（每轮 `get` 全量 + 多次 `append` + SSE 轮询），是共享瓶颈，但不会「拒绝」新会话 |
| llm / tools | `assemble.rs:100,117` `concurrent:true` | 并发 |

所以**「老对话有任务 → 新对话无法开展」不是服务端会话锁造成的**。可能的真实成因（按概率）：
1. **前端全局单例状态串台**：`sendBtn.disabled` 是页面级 DOM 属性，A 会话运行中切到 B，`disabled` 仍是 `true`（`app-events.js:275,290`；`switchSession` 未重算——`app-core.js:86-91`），用户点「发送」无反应 → 观感就是「新对话开不了任务」。同理 `chatAbort`/`stopBtn.hidden` 也串台。
2. **SSE 被切走**：切换会话 `es.close()` 后只连 B（`app-events.js:187-191`），A 的运行过程不再可见；A 的 `/api/chat` fetch 仍在后台 `await`，其 `finally` 会**把 B 的按钮解锁/或反过来提前解锁**，状态更乱。
3. **memory 串行 + 全量 get**：`chat.rs:82-90` 每轮 `perceive` 拉全量历史（无 limit），大会话下 A 的 `get`/SSE 轮询占住 memory 串行队列，B 的 `append`/`trace.read` 排队变慢（延迟而非拒绝）。
4. **同 session 误判**：若用户「新建对话」时复用了同一 `session` id（`app-core.js:94-98` 自动生成 `s-<timestamp>`，正常不会），或 A、B 两个标签页打开同一 session，则会命中 `K409`。

### 4.2 「新窗口」到底指什么（必须区分三种）

| 形态 | 代码路径 | 是否独立 host/数据 | 是否受老任务影响 |
|---|---|---|---|
| **同窗口新建对话** | `#newchat` → `prompt` → `switchSession(newId)` → `connect()`（`app-core.js:94-98,86-91`） | 同一 host 进程、同一端口、同一 `MEMORY_DATA_DIR`，只是 `session` 变量变了 | 服务端不锁；但**前端状态串台**（见上） |
| **浏览器新标签页打开同一个 URL**（手动 `window.open('http://127.0.0.1:8710')`） | 新 JS 全局（独立 `session`/`es`/`chatAbort`），但仍打到 8710 的同一 host | 共享 host 进程、共享 memory 串行插件、共享 8 个 chat 槽位 | 前端状态独立了；仍共享服务端瓶颈与同 session `K409` |
| **界面「▣ 新窗口」** | `index.html:13,156-166` → `app-settings.js:165-175` `POST /api/instances` → `instances.rs:166-179` `spawn_self` 覆盖 7 个 env（`WEB_ADDR` 8711 起、`MEMORY_DATA_DIR`、`AGENT_STREAM_DIR`、`CONFIG_FILE`、`REACT_INSTANCE_NAME`）→ `window.open(v.url)`（`app-settings.js:131,139,169-175`） | **完全独立 host 进程 + 独立端口 + 独立会话数据/配置 + 绑定工作区**（`instances.rs:1-5,193-195,242-253`；`index.html:166` 的说明） | **完全不受影响**（唯一共享的是磁盘上的代码/技能文件） |

> 直接回答：**同端口新建对话理论上能并发，实际被前端全局状态与 memory 串行拖累；界面里的「新窗口」是独立进程，不受影响；单纯新标签页只是前端状态独立，服务端仍共享。**

### 4.3 修复清单（按优先级）

1. **P0（前端，必须）**：`runState` 按会话拆分（§2.3 第 1 条），`switchSession()` 里按目标会话重算 `sendBtn.disabled / stopBtn.hidden / status`；`connect()` 用目标 session 的游标；`chatAbort` 不再全局单变量。这一条同时解决问题 1 与问题 3 的主体。
2. **P1（服务端，可选）**：
   - 给 `GET /api/chat/status?session=` 或 `queue/status` 提供真实运行态（现在前端只能靠「自己那次 fetch 没结束」猜），让多标签页能显示「A 正在运行」；
   - 把 `/api/chat` 从「阻塞等收敛」改成「立即返回 `accepted` + SSE 驱动 UI」（**较大改动**，需保留兼容：老前端仍走阻塞；新前端按 `run_id` 订阅）。这一步能彻底消除「fetch 长连接 + 客户端 abort 与服务端状态脱节」（`web/mod.rs:483-493`）。
   - memory `concurrent:false` 是数据安全前提（同步 fs 读写、无锁，`memory_plugin.ts:26,45-46`），**不建议直接改 true**；要提并发应先给插件内加 per-session 锁或换 append-only + 单 writer（§6 D），而不是翻 manifest 开关。
3. **P2**：把 `max_inflight=8` / `max_total_inflight=32` 做成 config.json 可调（`config.rs:263-277` 的 `AGENT_ENV_MAP` 已有先例），并在满载时返回明确 `K429/K503` 而不是静默排队。
4. **已评估不做的边界**（写进 PLAN，防重复尝试）：`00-PLAN.md:18,42` 明确「同 session 并发不排队、直接 K409」；`chat.rs:235-236` 注释「排队会把两次对话串成隐式顺序」。本方案不推翻它——**队列是显式入口**，裸并发仍拒绝。

---

## 5. 问题 4（上）：记忆等模块现状与缺陷清单

### 5.1 四层拆解（repo-explorer 第 4 步）

| 层 | 现状 | 证据 |
|---|---|---|
| 数据规范 | `Msg={role,content?,tool_calls?,tool_call_id?,attachments?}`；`Event` 任意 JSON；压缩标记是 **role=user 的合成消息**，靠 `[Context compaction]` 前缀识别 | `memory_plugin.ts:32-42,209-217,230-233`；`agent-loop/src/contract.rs:69-93` |
| 数据存储 | 内存 `Map` + `data/sessions/<safe>.json`（**整文件 rewrite**）；`data/traces/<safe>.jsonl`（append-only）；P4 已有 tmp+rename 原子写、损坏响亮告警、trace 行偏移索引 + 800 条/1MB 分页 | `memory_plugin.ts:72,100-115,117-161,304-345` |
| 数据流转 | 每轮 chat：先 `append` 用户消息（失败 K503 熔断）→ `trace.append` → **全量 `get`** → `maybe_compact` 双闸（40 条 or token 预算）→ `apply_history_limit` → 每工具波次 `append` → 最终答案 + 事件 | `chat.rs:274-315,628-635,893-904`；`compaction.rs:29-125` |
| 数据接口 | capability `memory.session` / `session.trace`；7 个 op：`append/get/clear/summarize/trace.append/trace.read/rollback`；`MEM_DEADLINE=5s` | `assemble.rs:78-93`；`memory_plugin.ts:3-12,179-347`；`lib.rs:57-61,121` |

生命周期钩子：`init` 建目录（`memory_plugin.ts:171-173`）、`destroy` 空实现且注释「每次写已即时落盘」（`:351-353`）——**init/destroy 成对但无连接/句柄可清，符合当前设计**；新增后台 writer/缓存时必须补 destroy 的 flush/close（tdd 时空闭环三问）。

### 5.2 缺陷清单（逐项判定，有证据才列）

| # | 缺陷 | 证据 | 严重度 |
|---|---|---|---|
| M1 | **模型上下文是「破坏性覆写」**：`summarize` 直接把 `msgs` 替换成 `[标记]+最近K`，原始消息永久丢失；回滚到摘要区只能整体清空，`/tree` `/fork` 分支能力无从实现 | `memory_plugin.ts:197-220,273-290`；`compaction.rs:99-115` | 高 |
| M2 | **每轮全量 `get` + 整文件 rewrite**：`perceive` 无 limit（`chat.rs:84-90`），`append` 每次 `JSON.stringify(msgs)` 全量写盘（`memory_plugin.ts:100-115,180-185`）；长会话 O(N) I/O 且跨插件 5s deadline 有风险 | 同上 | 高 |
| M3 | **无分层/长期记忆**：`docs/05-评测与记忆四层设计.md:72,76-90,115-134` 设计的「工作/情景/程序/语义」四层、字段白名单、召回 ≤5 条、不返回全文，均**未在本插件实现**；只有 per-session 的消息数组 | 文档 vs 代码对比 | 中 |
| M4 | **trace 与 model context 双写但非单一事实源**：两者各自写盘、靠 `rollback` 的「尾部对齐」手工保持一致（`memory_plugin.ts:222-300`）；任何新事件类型都要两侧同改 | `memory_plugin.ts:21-22,304-308`；`chat.rs:282-287` | 中 |
| M5 | **无索引/快照/会话元数据**：会话列表只在浏览器 localStorage（`app-core.js:5-25`），服务端没有 session index；`GET /api/session-exists` 只能判存在（`web/mod.rs:355`），列表/标题/最后活动时间全靠前端 | 同上 | 中 |
| M6 | **无 TTL / 淘汰 / 归档**：`sessions` Map 永不逐出（`memory_plugin.ts:72`），长驻进程无界增长；对比 agent-loop 已做的 `turn_starts/sid_seq` 逐出卫生（`chat.rs:251-262`） | 对比 | 中 |
| M7 | **压缩只在回合开局同步执行**：`maybe_compact` 在 `chat_run` 里 `await` 一次 LLM 摘要（最长 600s 单步 deadline），失败只是 warn 降级「保持全量历史」（`compaction.rs:80-93,116-124`）；无后台/异步摘要、无 `firstKeptEntryId`/token 前后计量 | 同上 | 中 |
| M8 | **无显式 steer/inbox**：模型上下文里没有「用户在工具执行期间追加的消息」这一概念，队列/注入只能靠外部编排（§2） | `lib.rs:326-363` op 面只有 chat/cancel | 中 |
| M9 | **取消与排队状态是瞬态**：`cancels`/`session_chats` 都是进程内 HashMap，host 重启即丢；无 durable pending input | `lib.rs:178-204` | 低（B 层补） |
| M10 | **回滚与压缩的耦合脆弱**：压缩标记是 `role=user` 合成消息，靠字符串前缀识别；`rollback` 要特判「落在摘要区」（`memory_plugin.ts:230-233,273-290`），任何格式变动易破 | 同上 | 低 |
| M11 | **SSE 轮询放大**：每标签页一条连接、300ms 一次 `trace.read`，`memory` 串行；多会话/多标签页线性放大 | `gateway.rs:203-204`；`assemble.rs:83` | 低 |

### 5.3 已有 RSI 成果（不要重复造轮子）

- 三轮迭代 P1-P8 / N1-N4 / O1-O4 的 P/Q/I 轨迹在 `docs/self-evolution/00-PLAN.md:34-50,91-164`；验收矩阵 `:125-126,150-152,184-186`。
- 与本文直接相关的成果：**P2/A1 同会话并发闸 + K409**（`00-PLAN.md:18,42`）、**P2/T1 取消 + llm-adapter abort**（`runtime/plugins/llm_adapter/README.md:18-64,98-137`）、**P4 memory trace 索引/原子写**（`00-PLAN.md:44`）、**P7 前端集中重置入口**（`00-PLAN.md:47`，只落地了 reset 半边）、**W17 多窗口多实例**（`instances.rs:1-16`）。
- LLM 模块有独立 `runtime/plugins/llm_adapter/PLAN.md`（L1-L6 + K502 雪崩修复），agent-loop/tool/kernel 的接缝与「已评估不做」清单见 `README.md:35-40`、`program.md:47,66,158`。
- 演化纪律：上游正式版优先（react-agent v0.1.22 / agent-kernel v0.1.8 已吸收五轮改进，`README.md:37-40`）；本仓补丁层从 73 收敛到 13，`scripts/patches/retired/` 保留 60 份退役补丁；`runtime/` 是快照「请勿直接修改」，升级时重放 5 处适配（`README.md:154-169`）。

### 5.4 现有测试基线（tdd P 前置，实测）

- 命令 `python -m unittest discover -s tests -v`（`README.md:148-152`）在本机环境**基线红**：`Ran 22 tests, FAILED (errors=15)`，失败全部来自 `D:\anaconda3\Lib\site-packages\tests\...`（conda 的 `binstar_client`/`pkg_resources`、`ultralytics.YOLO`、`Firecrawl.scrape_url` 等**第三方包自带测试被 discover 误收**），与本仓四个测试文件无关；本仓 `tests/test_bash_decode.py`、`test_o_selfheal.py`、`test_phase34.py`、`test_tool_contract.py` 在该 discover 下未被收集（环境把 `tests` 包解析到 site-packages）。
- 结论：**P 前置当前不满足（环境噪声）**，且本轮无代码改动，故不做 Q/I 判定。任何后续实现必须先修基线：在仓库根加 `tests/__init__.py` 并用 `python -m unittest discover -s tests -t .` 的隔离方式，或直接 `python -m pytest tests/ -q` + `conftest.py` 限制 `testpaths`，再跑 `cd runtime && cargo test`（`runtime/crates/agent-loop/tests/`、`host/tests/` 有契约与 e2e 测试）。README 第 170 行也提示：漏重放 bash 适配时 `tests/test_tool_contract.py::ShellCwdTest` 会变红。
- 本轮未运行 `cargo test`（只读调研，避免长时间构建）；实现阶段按 tdd 每完成一个逻辑改动跑一次。

---

## 6. 问题 4（下）：先进项目调研 → 不脱离底座的优化方案

### 6.1 项目身份确认

| 用户称呼 | 实际项目 | 来源 |
|---|---|---|
| pi / pi-mono / pi.dev | `earendil-works/pi`（原 `badlogic/pi-mono` 重定向），Pi Coding Agent，`@earendil-works/pi-coding-agent` | https://github.com/earendil-works/pi ，https://pi.dev/docs/latest |
| deepseekharness | `deepseek-ai/deepseek-harness`（dsh，Cordis 插件框架，developer preview，默认分支 `master`） | https://github.com/deepseek-ai/deepseek-harness |
| codex | `openai/codex`（Rust，`codex-rs/` 多 crate，rollout 独立成 crate） | https://github.com/openai/codex |
| claude-code | 官方文档已迁 `code.claude.com/docs` | https://code.claude.com/docs/en/memory |

### 6.2 可借鉴机制（★ = 不动内核底座即可落地）

**A 会话持久化 / 瞬时首屏**
1. ★【pi】会话 = 追加式 JSONL **树**（`id`/`parentId`/current entry，首行 SessionHeader），`/tree` `/fork` `/clone` 只换活动分支不删历史，首屏只重建活动分支——https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md ，https://pi.dev/docs/latest/how-pi-works
2. ★【codex】前台缓存 + 单后台 writer：`pending_items` 攒内存、有界 mpsc(256)、`flush()` 等 ack、失败留 pending 重试、resume 以 append 打开——https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs
3. ★【codex】`session_index` + `state_db`（SQLite 线程表，filesystem-first 修 stale 行，DB 挂了回退），列表页不解析全量 JSONL——https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/lib.rs
4. ★【dsh】append-only typed `SessionEvent` 是唯一事实源，LLM 消息历史是派生视图——https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.md

**B 上下文 / 记忆**
1. ★【pi】compaction **只追加一条** `CompactionEntry`（summary / firstKeptEntryId / tokensBefore / systemMessage），原文不删，后续从摘要 + 近期消息重建——https://pi.dev/docs/latest/sessions
2. ★【Claude Code】分层记忆 managed → user → project → local，父目录→cwd 拼接，子目录 `CLAUDE.md` / `.claude/rules` 的 `paths:` 按需加载，兼容 `AGENTS.md`——https://code.claude.com/docs/en/memory
3. ★【Claude Code】auto memory = `MEMORY.md` 索引 + topic 文件，**硬预算**只载前 200 行 / 25KB，超限报错令其精简；`/compact` 后从磁盘重注入——https://code.claude.com/docs/en/context-window
4. ★【pi】`cacheWarming: off|streaming|idle`，仅预计省钱才预热，预热用量计统计但不进模型上下文——https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/settings.md
5. ★【dsh】`SessionHandle` 每会话单写者，第二个 `open(id,'write')` 抛 `SessionAlreadyOwnedError`，跨进程写租约——https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/persistence.md

**C 指令排队 / steering / interrupt**
1. ★【pi】`Enter`=steering、`Alt+Enter`=follow-up、`Esc`=abort 且排队消息退回编辑器、`steeringMode`/`followUpMode`——https://pi.dev/docs/latest/how-pi-works
2. ★【dsh】单 inbox 三路由 `send(message,target,wakeup)` + `cancel(cause,{keepInbox?})` + AbortSignal + `whenIdle()`；inbox 是 durable projection，无 live agent 也能看到 pending——https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/core.md
3. ★【Claude Code】工具执行中排队的消息在工具调用结束后送达，Esc 中断当前运行、Up 可取回排队输入——https://code.claude.com/docs/en/interactive-mode
4. 【codex】SQ/EQ 单队列保序、`Op::Interrupt` 只 abort 当前任务——https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs

**D 会话并发 / 隔离**
1. ★【dsh】每会话单写者 + 写租约（同上 persistence.md）
2. ★【codex】`WriterLockGuard` 由后台 writer 持有到队列写完；rollout 独立 crate，换后端不动 loop——https://raw.githubusercontent.com/openai/codex/main/codex-rs/rollout/src/recorder.rs
3. ★【Claude Code】`claude agents` 一屏多后台会话 + worktrees 给每 session 独立 checkout；恢复运行中会话直接 attach 投递下一 turn 而非重载 transcript——https://code.claude.com/docs/en/agent-view
4. ★【本项目已有】W17 新窗口 = 独立 host 进程 + 端口 + 数据目录（`instances.rs:1-5,166-179`），等价于最彻底的隔离，无需借鉴。

> 说明：pi / codex / Claude Code 的「并行 subagent、后台 Bash task、worktree」属于**执行层隔离**，本项目已有 `task` 子代理（`lib.rs:69-70`、`subagent.rs`）与 W17 多实例；不建议为追新而改执行模型。

### 6.3 分阶段方案（严格贴合本项目底座）

**Phase 1（纯配置 / 前端 / 技能层，零核心改动）— 建议先做**
- 问题 1 A 层队列、问题 2 DOM 快照缓存、问题 3 P0 按会话状态拆分：全部落在 `web-dist/vendor/*.js` + `index.html`（这几处虽在 `runtime/` 快照内，但属于**写保护的前缀放行范围**，见 §7）。
- **分层记忆的「项目层」用现有机制落地**：`SKILLS_DIR` + `SYSTEM.md` + `config.json agent.system_prompt` 已是本仓的分层提示词入口（`config.rs:189,263-267`；`README.md:122`）。新增 `skills/<name>/references/` 语义记忆与 `ledger/` 情景记忆的**召回技能**（一个 `SKILL.md` 描述「何时读、读几条、不返回全文、不写密钥」），完全走合法自扩展通道，对应 `docs/05-评测与记忆四层设计.md:76-90,115-134` 的未实现部分。
- 硬预算：给上述技能加「召回 ≤5 条 / ≤25KB / 超限时报错令其精简」的 rubric（借鉴 Claude Code auto memory，且 `docs/05` 本就写了 ≤5 条）。

**Phase 2（插件层，memory 插件内部改造，不动 agent-loop / kernel）**
- `summarize` 改为**追加一条 typed 事件**（`type:"compaction", first_kept, tokens_before, summary`）到 trace/新 JSONL，`get` 按事件重建工作集；保留旧 `summarize` op 作为兼容别名（一个版本内），`rollback` 改为「按事件游标截断 + 重放」而非「按 user 计数尾部对齐」——这同时解决 M1/M4/M10。
- `append` 改 append-only 行写（每会话 `events.jsonl`），`get` 用 **per-session 偏移索引 + 有界工作集**（复用 P4 已验证的 `traceOffsets` 写法，`memory_plugin.ts:117-161`）；单后台 writer / 每会话锁保持 `concurrent:false` 不变（借鉴 dsh §6.2 D1、codex recorder）。解决 M2/M6。
- 新增 `session.index` 轻量元数据（id / title / updated_at / event_count / last_cursor），供 `GET /api/sessions` 列表与前端预取；filesystem-first 扫描修 stale（借鉴 codex）。解决 M5。
- 新增 `memory.recall` 能力：`{query, limit, project|session scope}` 返回**摘要级**条目（不返回全文、白名单字段），供技能层调用。解决 M3。
- 异步压缩：`compaction` 触发时把「生成摘要」放到后台（复用现有 `plan_with_retry` 但脱离用户可见回合），完成后只追加 compaction 事件；同步路径保留为 fallback（失败仍不阻断主链，`compaction.rs:86-93,116-124` 的降级语义不变）。解决 M7。

**Phase 3（编排层，需要动 agent-loop / host，最小切面）**
- B 层持久队列 + `queue/status` + `check_steer()` 轮次边界注入（§2.4），把排队消息作为 `user` 消息注入当前 `messages`（`chat.rs:388` 之前），实现真正的 steering。
- `/api/chat` 可选 `mode:"async"`：立即返回 `run_id`，UI 由 SSE 驱动；老前端仍走阻塞（接口兼容，I 不变量）。
- `GET /api/chat/status?session=` 由 agent-loop 的 `session_chats` + `cancels` 派生真实运行态，替代前端猜测。
- 把 `max_inflight` / `max_total_inflight` 纳入 `AGENT_ENV_MAP`（`config.rs:263-277`）做成可配置，并在满载时给明确错误码。

**Phase 4（评估后再定，写进 PLAN「已评估不做」）**
- 会话树 / fork / clone（pi）：会改变 `rollback` 的「第 N 条 user 消息」语义与前端 `userTurns` 索引（`app-events.js:5-6,36-46`），**收益与本仓「物理截断回滚 + 文件撤销」（`web/mod.rs:408-429`）冲突，暂不做**；
- SQLite / state_db（codex）：引入新依赖，与「无 DB、fail-closed 简单底座」（`memory_plugin.ts:25-26`）冲突，暂用 JSON 索引；
- 换掉 `memory` 的 `concurrent:false`：**否决**——同步 fs 无锁，翻开关就是数据竞争；要并发先做 per-session 锁/单 writer；
- 把 trace 与 model context 合并为单一事件源：方向正确但需同时改 `rollback`/`skills.rs:165` 的 trace 重放/`render()`，列为 Phase 2 完成后的独立迭代，不与队列混做。

### 6.4 PLAN.md 轨迹写法（沿用现有结构）

按 `project-dev` 优化模式，方案应落在**模块目录内**的 `PLAN.md`（`runtime/plugins/llm_adapter/PLAN.md` 是范本；`runtime/crates/agent-loop/PLAN.md`、`runtime/plugins/memory/PLAN.md` 目前不存在，可新建——但注意 `runtime/` 禁写，见 §7），或统一沉淀到 `docs/self-evolution/00-PLAN.md` 追加一轮「Q 轮」。章节沿用：`目标 / P·Q·I 验收表 / 方案与接缝 / 迭代记录 / 已评估不做`。每轮记录三件事：**改了哪些文件、跑了什么命令、保留还是回退**。本方案的「已评估不做」清单即 §6.4 末四条 + §4.3 第 4 条。

---

## 7. 落地路径与写保护边界（务必先读）

### 7.1 硬边界

`runtime/` 整树在 `files.py::_CORE_BLOCKLIST` 内（`README.md:164`；`scripts/apply-tool-patches.py:4-6`），agent 的 `write_file/edit_file` 触碰即 `CORE_PROTECTED`。**config.json / plugins/memory / .git 永不豁免**（`apply-tool-patches.py:129-135`；`README.md:167`）——注意：`plugins/memory` 指 `runtime/plugins/memory` 前缀，`guest_sdk.ts` 是历史列出的唯一例外前缀。

### 7.2 三条合法途径（按本项目 SYSTEM.md 纪律）

| 途径 | 适用 | 本方案对应 |
|---|---|---|
| ① 技能目录写 `SKILL.md` / 技能 `tools.json` | 知识/流程类能力 | Phase 1 的「记忆召回技能」、rubric、评测案例 |
| ② `config.json` 的 `mcp_servers` / 设置面板 | 外部服务工具 | 无（本方案不接外部服务） |
| ③ 用户自行修改核心 / 按路径授权 `tools.allow_core_write` | 必须改 `runtime/` 源码 | Phase 2/3 的 `web-dist/*.js`、`agent-loop/src/*.rs`、`host/src/web/*.rs`、`memory_plugin.ts` |
| ③' **外挂补丁**（推荐给核心改动） | 把改动写成 `scripts/patches/*.json`（`scripts/` 在可写区），然后由 **agent 自行执行** `python scripts/apply-tool-patches.py --dry-run` → 锚点全中再正式应用 → 向用户汇报；幂等、自动 `.patchbak`、可 `--revert` 回滚 | Phase 1/2/3 的核心文件改动都可以切成「anchor → patch」小补丁，逐个预演 |

补丁格式（`scripts/patches/x1-gate-hint.json` 是现成范例）：
```json
{"id":"Q1","description":"…","file":"runtime/...","anchor":"被替换的精确原文","patch":"替换后的原文"}
```
执行器语义见 `scripts/apply-tool-patches.py:310-333,336-350`（幂等跳过 / 锚点未命中 FAIL / 备份 / `--revert`）。**重启时机由用户掌握**：应用后需 `cargo build` + 前端刷新（前端是运行时 serve、`no-store`，`web/mod.rs:219-231`，刷新即生效；Rust/插件改动需重启 host）。

### 7.3 建议实施顺序与验证

1. 先修测试基线（§5.4），记录 P ✅；
2. Phase 1 三个前端改动（问题 1 A / 2 / 3 P0），每个逻辑改动跑一次测试 + 手工冒烟（Q/I）；
3. 用 `--dry-run` 预演所有 `scripts/patches/*.json`，锚点全中再应用，逐项汇报；
4. Phase 2 memory 插件改造（**注意 `plugins/memory` 永不豁免**：这一块必须用户自行修改或显式按路径决策，不能直接走 `allow_core_write` 前缀授权——见 `apply-tool-patches.py:129-135` 的 `_CORE_NEVER_ALLOW`）；
5. Phase 3 编排层（需用户授权 `runtime/crates/agent-loop` + `runtime/crates/host` 两个前缀，或用户自行改）；
6. 每轮把结论追加进 `docs/self-evolution/00-PLAN.md`（可写区），README 仅在对外契约真变更时同步最终形态。

**验证命令清单**：
- `python -m unittest discover -s tests -v`（先修基线）/ `python -m pytest tests/ -q`；
- `cd runtime && cargo test`（契约测试 `agent-loop/tests/contract_conformance.rs`、`host/tests/e2e_web_gateway.rs` 与 `e2e_ts_memory.rs` 是本次改动的重点回归面）；
- `node --check runtime/plugins/memory/memory_plugin.ts`（P4 轮已用过此校验）；
- `python scripts/apply-tool-patches.py --dry-run` / `--list` / `--revert`；
- 手工冒烟：同一 8710 开两个会话并发跑任务；运行中连发 3 条；点插队；切换会话来回看首屏耗时与消息数；「▣ 新窗口」另起端口验证隔离。

---

## 8. 本轮验证状态（tdd 汇报）

- **P 前置**：❌（环境噪声）——`python -m unittest discover -s tests -v` 实测 `Ran 22 tests, FAILED (errors=15)`，15 个 error 全部来自 `D:\anaconda3\Lib\site-packages\tests\...` 第三方包被 discover 误收（`pkg_resources` / `ultralytics.YOLO` / `Firecrawl.scrape_url` 等），与本仓代码无关；本仓 4 个测试文件在该环境下未被收集。已在 §5.4 给出修复方式。
- **Q 后置 / I 不变量**：本轮**只读调研、未做任何代码改动**，不适用；不宣称「完成实现」。
- 交付物为诊断与方案文档，事实核对方式：所有内部结论均回读 `文件:行号`，外部结论均回读官方文档/仓库页 URL；三个子任务报告与本人复核结论一致（关键分歧点「问题 3 是否服务端阻塞」已用 `web/mod.rs:97-105`、`lib.rs:226-231`、`chat.rs:237-247`、`assemble.rs:76,83` 亲自确认为「前端状态串台 + 共享瓶颈」，而非会话锁）。

---

## 附：关键文件索引

| 主题 | 文件 |
|---|---|
| 前端发送/停止/队列 | `runtime/crates/host/web-dist/vendor/app-events.js:265-332` |
| 前端会话切换/列表 | `runtime/crates/host/web-dist/vendor/app-core.js:5-98` |
| SSE 连接与重放 | `runtime/crates/host/web-dist/vendor/app-events.js:160-215`；`runtime/crates/host/src/web/gateway.rs:12-215` |
| HTTP 路由与 chat 阻塞 | `runtime/crates/host/src/web/mod.rs:94-105,305-505` |
| 会话并发闸 / 取消 | `runtime/crates/agent-loop/src/chat.rs:231-263,385-390,576-581`；`lib.rs:178-204,226-231,325-363`；`budget.rs:124-134` |
| 插件并发语义 | `runtime/crates/host/src/assemble.rs:74-140` |
| 多窗口实例 | `runtime/crates/host/src/instances.rs:1-21,113-179,196-273`；`web-dist/vendor/app-settings.js:83-175`；`web-dist/index.html:13,156-166` |
| memory 插件 | `runtime/plugins/memory/memory_plugin.ts:1-356`；`README.md:1-72` |
| 压缩/上下文窗口 | `runtime/crates/agent-loop/src/compaction.rs:1-126`；`chat.rs:71-90,266-315` |
| 演化轨迹/纪律 | `docs/self-evolution/00-PLAN.md`；`runtime/plugins/llm_adapter/PLAN.md`；`README.md:35-40,154-169`；`docs/05-评测与记忆四层设计.md` |
| 补丁机制 | `scripts/apply-tool-patches.py:1-40,261-377`；`scripts/patches/x1-gate-hint.json` |
