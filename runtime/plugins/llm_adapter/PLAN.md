# llm-adapter 优化方案（模块级 PLAN）

> 定位：本文件是该模块的**演进轨迹**，每轮重构更新「迭代记录」。
> 方法论：`project-development-prompt.md`「优化模式」§3.4；格式对齐 `crates/agent-loop/PLAN.md`。
> 创建：2026-09-05 | 依据：运行时观测（ollama 上下文超限事故，R8 对位）

## 一、审计结论（2026-09-05）

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| L1 | **错误未归一化**：HTTP ≥ 400 时 `err("... HTTP {code}: {resp.text[:500]}")` 原文透传（ollama /v1 错误 message 内还嵌套一层 JSON），消费方只能字符串匹配 provider 文案；上下文超限 / 限流 / 鉴权失败无法按 code 分类决策 | `providers/openai_compat.py` `_chat_once` / `_stream_once`；`anthropic.py` 同型 | 中 |
| L2 | **前缀截断连锁错误无法分类**（2026-09-06 运行时观测）：ollama 默认窗口小（新版缺省 4096、旧版 2048），输入超窗口时**从前往后截断**——system/user 先被丢弃，服务端找不到 user query → `HTTP 500 "no user query found in messages"`。报错指向「缺 user 消息」，真实原因是窗口装不下；且形态为 500 而非 400，L1 状态码闸（400/413）与 agent-loop P8 特判都接不住 → 直接杀死整轮 | `providers/ollama.py`（传输层选型）+ `base.py`（归一化条件） | 高 |
| L3 | **num_ctx 无法 per-request 下发**：P7 的 `LLM_CONTEXT_TOKENS` 只做本地估算闸，未透传给 provider——本地认为没事，服务端窗口（缺省 4096）小得多，两侧对「窗口」的认知脱节 | `providers/ollama.py` / 线契约 | 高 |

## 二、路线

| 项 | 对应审计项 | 分类 | 状态 |
|----|-----------|------|------|
| L1 错误归一化：识别上下文超限类 400 → 统一 `code=CONTEXT_OVERFLOW`（+ 元数据） | agent-loop R8 | 规则 | ✅ 完成 |
| L2+L3 ollama 原生 `/api/chat` 传输（NDJSON 流式 + 错误/工具调用映射）+ 统一 `num_ctx` 窗口透传 | L2 L3 | 空间/规则 | ✅ 完成 |
| L4 models.list 追加 `models_meta`（ollama 逐模型原生窗口探测）| L3 延伸（窗口真值展示）| 规则 | ✅ 完成 |

### 方案（L1）✅ 已实施（见迭代记录）

- `base.py` 增 `err_from_resp(provider, status, resp_text) -> dict`：解析 400 体重「上下文超限」特征——
  ollama `exceed_context_size_error` / OpenAI `context_length_exceeded` / Anthropic `prompt is too long` 等；
  命中 → `{"ok":false,"error":{"code":"CONTEXT_OVERFLOW","message":...,"ctx":{"limit":?,"required":?}}}`
  （`limit`/`required` 仅 provider 给了才带）；未命中维持现状原文透传。
- 归一化职责归属 adapter：形状归一化本就是 adapter 既有职责（tool_calls / usage 已归一），错误侧对齐。
- 其余错误分类（限流/鉴权）不在本轮：agent-loop 瞬态判定已按文案工作，避免过度工程。

### 方案（L2+L3）：ollama 原生传输 + 统一 `num_ctx` 窗口映射 ✅ 已实施（见迭代记录）

调研依据（2026-09-06）：ollama 官方 `docs/api.md`——`POST /api/chat` 支持 `options`（Modelfile 参数，
含 **`num_ctx`** 上下文 token 数）、`tools`（模型支持时下发）、NDJSON 流式（每行一 JSON 对象，
末行 `done:true` 附 `prompt_eval_count` / `eval_count` 统计）、错误统一 `{"error": "..."}` 形态。

- **传输切换**（`providers/ollama.py`）：`POST {OLLAMA_HOST}/api/chat`；env `OLLAMA_ENDPOINT=native|v1`
  （缺省 `native`，`v1` 保留为回退通道，不搞一刀切）。当初「双协议路径 + 流式双实现」的拒绝理由成立但成本收敛：
  仅 ollama.py 单文件内实现，NDJSON（逐行 `json.loads`）比 SSE 更简单，openai_compat 共享实现不动。
- **请求映射**（归一化形状 → native）：
  - `messages`：role/content 原样；assistant `tool_calls` → `{"function": {"name", "arguments"}}`
    （arguments 归一化侧已是 object，直接放）；tool 消息 → `{"role": "tool", "content", "tool_name"}`——
    native 无 `tool_call_id`，按 `tool_name` 对位（同名多调用对位精度下降，记为已知限制）。
  - **`num_ctx`**：请求体 `options.num_ctx` ← payload 新可选字段 `num_ctx`（int）。
- **响应映射**（native → 归一化形状）：`message.content` / `message.tool_calls` → 既有契约；
  `done_reason` → `finish_reason`；`prompt_eval_count` / `eval_count` → `usage.input` / `output`；
  推理模型的 `message.thinking` 暂不入契约（与 /v1 行为对齐）。
- **流式**：NDJSON 行流 → 既有 `StreamSink`（增量行 `message.content` 片段，末行聚合统计）。
- **统一接口映射**（线契约，薄层不破）：chat 请求追加**单个强类型可选字段** `num_ctx`——
  ollama native → `options.num_ctx`；openai_compat / anthropic → 忽略（窗口由服务端模型决定）。
  不做任意 `options` 透传（维持 adapter 归一化薄层定位）。
- **agent-loop 下发通道**：`LLM_CONTEXT_TOKENS`（config `agent.llm_context_tokens`，web 已有）
  语义升级为「上下文窗口」——既作本地预算基准（×0.7，P7 既有），又随 `llm.chat` payload 下发
  `num_ctx`（0/缺省不下发，向后兼容）。**一处配置两侧生效**：本地估算闸与真实服务端窗口对齐，
  不新增 env，配置/前端零改动。
- **错误归一化扩展**（`base.py`）：ollama 分支新增 500 + 精确文案
  `no user query found in messages`（调研确证 = 前缀截断连锁，user 消息被服务端丢弃）→
  归一 `CONTEXT_OVERFLOW`（ctx.limit 尽力）→ 复活 agent-loop P8 降级重试（减半后请求变小通常可过）。
  L1 的「500 不归一」状态码闸保留——仅 ollama 该精确文案例外，避免 OpenAI 500 误判泛滥。
- **三层防护闭环**：`num_ctx` 透传（治本，窗口对齐）→ P7 发送前收紧（预防）→ P8 降级重试（兜底）。
- **验证**（实际执行口径）：Python 行为断言 35 项（请求映射 / 响应映射 / NDJSON 流式聚合（假 httpx 注入）/
  错误三形态：exceed_context_size_error 400、no user query 500、普通 500 / 分派 native|v1|流式）；Rust 回归
  `num_ctx_passthrough_follows_context_window`（缺省不下发 / 4096 透传 / 0 禁用）；全仓 `cargo test --workspace`；
  README 同步（线契约 `num_ctx` + `OLLAMA_ENDPOINT` + ollama 传输说明）。
- **已知限制**：tool 消息按 `tool_name` 对位；`thinking` 不入契约；v1 回退通道仅保兼容不加功能。

## 已评估不做

| 方案 | 理由 |
|------|------|
| ~~ollama 原生 `/api/chat` 传输（可传 `options.num_ctx`）~~ **已反转（2026-09-06）→ 升级为 L2+L3 方案** | 原理由（双协议路径 + 流式双实现；服务端 `OLLAMA_CONTEXT_LENGTH` 达同一效果）：前半被运行时观测推翻——`/v1` 下前缀截断连锁错误（`500 no user query found`）无法分类、num_ctx 无法 per-request 控制，服务端 env 只能全局兜底不能对齐两侧认知；后半成本收敛在单文件内可接受 |
| chat 请求透传任意 `options` 字段 | 破坏「adapter 只做归一化」的薄层定位；L2+L3 方案改为**单个强类型字段 `num_ctx`** 的统一映射，不开放任意透传，本条维持 |
| ~~models.list 附带 ctx_limit 元数据~~ **已反转（2026-09-06）→ 实施（见迭代记录 L4）** | 原理由（ollama `/v1` 拿不到窗口 + `LLM_CONTEXT_TOKENS` env 已覆盖需求）已过时：L2+L3 落地后 `llm_context_tokens` 需用户按模型原生窗口自行设定，硬编码数值被否决——窗口真值应从模型能力动态获取（native `/api/show` 的 `<family>.context_length`），前端展示与「填入原生值」形成闭环 |

## 三、迭代记录

### L1：错误归一化 err_from_resp ✅

- **目标**：HTTP ≥ 400 不再原文透传——上下文超限类失败统一为 `code=CONTEXT_OVERFLOW`，
  agent-loop（P8）据 code 特判降级重试，不再字符串匹配 provider 文案。
- **方案**：
  - `base.py` 新增 `err_from_resp(provider, status, resp_text)`：`status ∈ (400, 413)` 且响应体命中
    「上下文超限」特征（`_OVERFLOW_MARKERS`：ollama `exceed_context_size_error` /
    OpenAI `context_length_exceeded` / `maximum context length` / Anthropic `prompt is too long`）→
    `{"ok":false,"error":{"code":"CONTEXT_OVERFLOW","message":...,"ctx":{"limit":?,"required":?}}}`；
    未命中维持既有形状（`code=LLM_ERROR` 原文透传），消费方行为不变。
  - `_extract_ctx`：尽力提取窗口元数据（provider 给了才带，不做猜测）。兼容 ollama /v1 错误 message
    内嵌套 JSON 的转义形态（`\"n_ctx\":4096`）；`limit` ← `n_ctx` / `maximum context length is N`，
    `required` ← `n_prompt_tokens` / `you requested N tokens` / `too long: N tokens`。
  - `openai_compat.py` / `anthropic.py` 的 `_chat_once` / `_stream_once` 错误分支统一改走
    `err_from_resp`（流式与非流式同判）。
- **验证**：
  - 行为断言（临时脚本，5 组）：ollama 嵌套 JSON 形态 → CONTEXT_OVERFLOW + ctx{limit:4096, required:5000}；
    OpenAI 文案形态 → ctx{limit:8192, required:9000}；Anthropic 形态 → CONTEXT_OVERFLOW；
    非超限 400 → LLM_ERROR；超限文案但 status=500 → LLM_ERROR（状态码闸生效）。
  - 端到端：agent-loop P8 回归用例（`provider_overflow_*`）以归一化形状为输入全绿。
- **结果**：通过。错误契约追加可选 `error.ctx` 对象（`CONTEXT_OVERFLOW` 专属，缺省不出现）——
  既有消费者无感知；已同步本模块 README 错误段。

### L2+L3：ollama 原生 `/api/chat` 传输 + 统一 `num_ctx` 窗口透传 ✅（2026-09-06）

- **目标**：治本 L2（前缀截断连锁 500 无法分类）+ L3（num_ctx 无法 per-request 下发），
  与 agent-loop P7/P8 组成三层防护闭环。
- **改动**：
  - `providers/ollama.py` 重写为原生传输：`to_native_messages`（tool 消息按 `tool_name` 对位，
    从配对 assistant 反查 id→name）/ `_build_body`（tools 映射 + `options.num_ctx` ← payload.`num_ctx`，
    仅正 int 接受）/ `_native_once`（一次性）/ `_native_stream`（NDJSON 行流 → 既有 `StreamSink`，
    200 流内 `{"error":...}` 行也接住）；`prompt_eval_count` / `eval_count` → `map_native_usage`。
    分派 `chat()`：`OLLAMA_ENDPOINT=v1` 回退 `openai_compat._chat_with`（旧行为原样保留）。
  - `base.py`：`err_from_resp` 追加 ollama 500 + `_OLLAMA_TRUNCATION_MARKER`（`no user query found in messages`）
    → `CONTEXT_OVERFLOW`（精确文案 + provider 限定，避免 OpenAI 500 误判泛滥）。
  - **agent-loop 配合**（`lib.rs::plan`）：`LLM_CONTEXT_TOKENS` > 0 时随 payload 透传 `num_ctx`
    （0/缺省不下发，向后兼容）——Rust 侧回归用例见 `react_mocks.rs`。
  - **host 配合**（`config.rs`）：`HostConfig` 增 `ollama_endpoint`，`llm_env()` 下发
    `OLLAMA_ENDPOINT`（缺省 `native`）——否则子进程收不到该 env，开关形同虚设（文档同步排查发现）。
- **验证**：Python 行为断言 35 项全绿（映射/usage/错误三态/分派/NDJSON 流式端到端含 sink 事件与
  错误归一）；`cargo test --workspace` 全绿（agent-loop 31 项含新增 `num_ctx_passthrough_follows_context_window`，
  总 55 项）。
- **结果**：通过。线契约 chat 请求追加单个强类型可选字段 `num_ctx`（既有消费者无感知）；
  README 已同步（线契约段 / 文件结构表 / env 路由 / 已知坑 5）。

### L4：models.list 追加 `models_meta` 原生窗口元数据 ✅（2026-09-06）

- **目标**：模型原生窗口「动态获取、零硬编码」——用户在 web 设置 `llm_context_tokens` 时能直接
  看到当前模型的原生窗口并一键填入（配合 L2+L3 的 num_ctx 透传链路）。
- **改动**（仅 `providers/ollama.py`，纯增量不破坏契约）：
  - `_native_ctx_limit(host, name)`：POST `/api/show {"model": name}` → `model_info` 内
    `<family>.context_length`（如 `qwen35.context_length=262144`）；取不到（字段缺失/单模型失败/
    非法值）返回 None，探测不致命。
  - `models()`：`/api/tags` 列出后逐模型探测，返回追加**可选字段**
    `models_meta: [{"name", "ctx_limit"?}]`——`ctx_limit` 取不到省略键；其他 provider 不带该字段。
  - host `frontend.rs::get_models`：`models_meta` 存在才透传到 `GET /api/models` 响应。
  - web 前端：LLM 页 model 下拉展示原生窗口缩写（`qwen3.8:27b · 256k`）；Agent 页
    `llm_context_tokens` 旁显示当前模型原生窗口提示 + 「填入原生值」按钮；打开设置时对 ollama
    静默拉取一次，开箱可用。
- **验证**：Python 行为断言（假 httpx 注入：context_length 提取 / 缺失省略键 / 探测失败跳过 /
  非 int 不接受）+ 端到端 `GET /api/models` 实测；`cargo test --workspace` 全绿。
- **结果**：通过。`models.list` 主契约形状不变（`models` 数组照旧），仅追加可选 `models_meta`；
  README 已同步线契约段。

### L5：native 思考链接入契约（message.thinking 透传）✅（2026-09-06）

- **背景**：L2+L3 切 native 传输时 `message.thinking` 未透传（当时注释「暂不入契约」），
  推理模型（qwen3.8 等）在 web 前端「思考过程」块消失（用户反馈）。中间链路本就通用：
  sink `kind:"reasoning"` → 旁路文件 → host tail → SSE → 前端渲染均已存在（DeepSeek 在用），
  缺的只有 provider 层两处映射。
- **改动**（仅 `providers/ollama.py`）：
  - 非流式 `_native_once`：`message.thinking` → `norm(reasoning=...)`；
  - 流式 `_native_stream_once`：thinking 帧 → `sink.delta("reasoning", piece)` +
    聚合 `reasoning_parts` → `norm(reasoning=...)`；无 thinking 帧不写 delta（同 DeepSeek
    「空值不开块」纪律）。
- **验证**：Python 行为断言 10/10（假 httpx 注入：非流式映射 / 无 thinking 无键 /
  流式 delta 序列与聚合 / text 通道不受影响）。
- **结果**：通过。文件头「已知限制」同步改写；README SSE 解析规则补 ollama 思考字段。

### L6：站点预设一键切换（OpenAI 兼容多站聚合）✅（2026-09-06）

- **背景**：用户需求——ModelScope / 硅基流动 / OpenRouter 等均为 OpenAI 兼容站，希望聚合
  一键切换。评估三案：每站点 provider pack（全是样板，否决）；聚合路由（多 key/故障转移，
  远超需求，否决）；**站点预设清单**（站点=数据非代码，采纳）。
- **关键认知**：热切换通道 Phase 4-1 已存在——`PUT /api/config` → llm-adapter `configure`
  op 更新进程 env（pack 均请求时读 env）；provider/model/base_url/api_key 保存即热生效，
  零重启。切换站点 = `configure{base_url, api_key, model}` 一次调用，纯复用。
- **改动**：
  - 新增 `presets.py`（插件根，非 providers/——无 PROVIDER 导出，registry 自动跳过）：
    8 站点纯数据（modelscope/siliconflow/openrouter/deepseek/moonshot/dashscope/zhipu/custom），
    `list_presets(payload)` 返回清单；增改站点 = 改数据文件；
  - `llm_plugin.py`：新增 `presets.list` op 分派；
  - host `frontend.rs`：`GET /api/presets` 透传（照 get_models 模式）；
  - 前端：LLM 标签页「站点」下拉（仅 openai 显示）——选站自动填 base_url +
    localStorage 记忆 key 自动带出（`react-agent:llmkey:{id}`，custom 不记）+ 申请 key
    链接；保存后既有逻辑自动刷新模型列表；loadConfig 按 base_url 反查回显站点。
- **per-site key 取舍**：localStorage 记忆各站点 key（换浏览器需重填，可接受），
  config.json 只落当前生效站的 key（重启还原）——host 零改动，key 明文不新增落盘面。
- **验证**：Python 断言 9/9（清单形状/registry 无污染/op 分派/未知 op K400）；
  `cargo test --workspace` 55 项全绿；浏览器模拟联动 8 项全过（填充/显隐/填 base_url/
  key 链接/记忆回填/尾号提示/base_url 反查）。

### 修复：openai_compat 200 异常态防护 ✅（2026-09-06）

- **现象**：host 启动探测 llm-adapter（provider=openai，ModelScope）报
  `TypeError: 'NoneType' object is not subscriptable`。同 env 手动复现探测正常（pong，
  key 有效）→ 判定为 ModelScope 瞬时返回 200 + 异常 body（缺 choices）。
- **根因**：`_chat_once` 对 200 响应硬下标 `data["choices"]`——body 为 null / `{"error":...}`
  / 空 choices 时崩成 TypeError（200 异常态无防护；400+ 有 err_from_resp 闸）。
- **修复**：200 响应非 dict / 缺 choices → 统一收敛为业务错误（带响应原文前 300 字）；
  `message` / `choices[0]` 补 .get 链。行为断言 5/5（null / error 形态 / 空 choices /
  正常路径不受影响 / 错误码非 TypeError）。

### L5：K502 雪崩修复（provider 总时限 + guest 扩池）✅（2026-09-08）

- **现象（用户实测，现象 B 确认）**：ModelScope 偶发 `K502 llm-adapter deadline exceeded`
  （内核 LLM_DEADLINE=120s 抢先 abort）；之后同会话再发消息**卡住/连环 K502**，重启 host 才恢复。
- **机制链（对码核实）**：① 内核与 provider 同闸 120s，内核从 dispatch 起算必抢先；② gRPC 取消
  不中断 guest handler 线程，泄漏线程占坑（`agent_kernel.guest.serve` 缺省 max_workers=4）；
  ③ httpx timeout=120 是 per-read **不是 total**——流式涓流（限速/慢 token）可无限续命，泄漏
  线程钉死在还开着的流上 → 4 线程耗尽 → 全会话请求排队 → 连环 K502。内核 Process 域锁 bug
  （MutexGuard 跨 await，两个 checkout 均存在）进一步使 Concurrent 语义与 in-stream abort 失效
  （边界取消不受影响）——属内核层，本轮不动，待上游/patch 决策。
- **修复（本仓库内，纵深两层）**：
  1. `base.py` 增 `PROVIDER_DEADLINE = 110.0`（唯一真源，注释说明与内核闸的关系）；
     `_chat_once` / `_stream_once`（openai_compat）、`_native_once` / `_native_stream_once`
     （ollama）、anthropic 非流式：timeout 改 `httpx.Timeout(PROVIDER_DEADLINE, connect=10.0)`；
     两个流式循环增**总时限守卫**（monotonic 每帧检查），超时收敛为业务错误
     （message 含 "timeout" → agent-loop T3 `is_transient_llm_error` 正常重试，零泄漏）。
  2. `llm_plugin.py` / `tools_plugin.py`：`serve(..., max_workers=16)`（缺省 4 → 16，
     泄漏占坑的雪崩窗口加宽；tools 的 bash/web 长调用同动力学）。
- **验证**：py_compile 全过；重启 host 后真实 ModelScope 流式对话正常（守卫不误伤常规流）。
  挂死场景收口路径：provider 110s 干净业务错误 → T3 重试，内核 120s K502 不再触发。
- **已评估不做**：非流式用 blocking post 无法做墙钟总闸（connect+read 理论最坏 ~120s 边缘，
  实际 connect <1s 可忽略）；LLM_DEADLINE 上调（会放大重试最坏时长）；内核锁修复（跨仓库，
  待 [patch] vs 上游 issue 决策）。budget_secs 维持 0 由用户自决。
