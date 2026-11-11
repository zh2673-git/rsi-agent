# DeepTutor 逆向解析与集成评估

> 对象：<https://github.com/HKUDS/DeepTutor>（HKUDS，Apache-2.0，Python，v1.7.2 / 2026-11-06）
> 规模（GitHub tree 实测）：4530 文件 = `deeptutor/` 1396 py + `web/` 1686（Next.js）+ `tests/` 1006；
> 55 个 router 模块 / 721 条路由；28 个 module manifest；11 个 subagent 后端。
> 目的：判它是什么、哪些机制值得搬、集成进 rsi-agent 有哪几条路、每条要付什么代价。

---

## 0. 先分清：这是**两件不同的事**，不是一件事的两种说法

上一版把「三步路线」和「A/B/C/D 四条集成路」并排放在一张表里，容易读成同一件事的备选方案。
它们其实是**两个独立的目标**，可以只做一个、也可以都做，顺序自选：

| | 目标 | 结果长什么样 | 谁在用 | 需要 DeepTutor 在本机吗 |
|---|---|---|---|---|
| **目标甲：集成 DeepTutor** | 让 rsi-agent 能**用上** DeepTutor 的教学能力（深度研究、出题、可视化、知识库问答） | rsi-agent 多一个工具/技能，调用时把活外包给 DeepTutor，拿回结果 | 你，日常用 | **要**（`deeptutor` 必须装得上、跑得起来） |
| **目标乙：优化 rsi-agent 本身** | 把 DeepTutor 里被验证过的**机制**搬进你的运行时 | 你的 agent 变聪明/变稳，但**代码里没有一行 DeepTutor** | 所有后续任务，以及别人的 rsi-agent | **不要**（只读它源码当参考） |

一句话区分：

- **甲 = 装一个外部器官**（`deeptutor` 是依赖项，缺了功能就没了）。
- **乙 = 学一个手艺**（DeepTutor 是教材，学完教材可以扔，能力留在自己身上）。

所以第 8 节的 A / B / C 是**目标甲**的三种接法，D 是**目标乙**的做法；
第 9 节那三步（deferred 工具 / 记忆 L2 / 回合持久化）**全部属于目标乙**，
和「deeptutor 进不进本机」这个决定**完全无关**——就算你一辈子不装 DeepTutor，那三步照样值得做。

> 上一条回答里我把两件事混在一段里说，是我的表述问题，这里更正。

---

## 1. 一句话本质

**它是一个「以回合为持久对象」的教学领域应用**——不是 agent 框架。
框架层（ReAct 循环、工具协议、模型适配）它有，但那是自用的地基；它的产品价值在领域侧：
知识库/多引擎检索、三层记忆、测验与掌握度、书籍与视频课、可视化与数学动画。

这跟 rsi-agent 的关系是**错位的**：rsi-agent 是「技能生产线 + 账本 + 自进化」的**运行时发行形态**，
DeepTutor 是「教学」这个垂直领域的**成品应用**。二者都自带工具层/技能层/记忆层，
所以「整体集成」等于让两个运行时互相吞并——这是最该先排掉的选项。

---

## 2. 时空契约还原

| 契约 | DeepTutor 的答案 | 证据 |
|---|---|---|
| **空间归属** | 每人一个 `DEEPTUTOR_HOME` + `data/user/settings/*.json`；工作区（content workspace）为第二层归属，物理路径仅运行时可见，禁止进模型消息/持久元数据 | `core/context.py::WorkspaceRuntimeContext`（注释明写 "Physical paths are runtime-only"） |
| **时间形态** | **回合（Turn）是持久对象**，不是一次 HTTP 请求。turn 有 id/status/last_seq/owner_id，可订阅、可补播、可恢复、可接管 | `api/contracts/turn_protocol.py::TurnSummary` |
| **规则拦截** | 静态分层契约（import-linter）守包依赖方向；manifest 审批守插件；白名单守工具挂载 | `.importlinter`；`docs-for-dev/PLUGINS.md` |

`TurnApplicationService` 是这套契约的独占者：所有写操作都是它的 command，
订阅与在途查询**刻意只读**（"Subscriptions and active-turn checks are deliberately read-only,
including when the owner worker has disappeared and leader recovery is still pending"）。

---

## 3. 第 0 级映射（目录 → 职责）

```
core/            纯值对象 + 协议（12 文件）      ← forbidden 依赖 app/api/runtime/services
runtime/         编排（orchestrator / registry / stream_bus / bootstrap）
services/        空间落地（575 文件，最大的一块：llm/rag/memory/skill/mcp/subagent/workspace…）
capabilities/    领域流水线（111 文件：chat/deep_research/visualize/math_animator/mastery/…）
tools/           单步工具（100 文件）
agents/          循环与共享件（134 文件：loop / _shared / tool_composition）
api/             入口适配（65 文件，FastAPI + WS）
app/             应用门面（6 文件：facade / container / service / engine）
modules/         可选模块清单（28 个 json：依赖闭包 + 就绪状态）
```

`.importlinter` 三条契约值得直接抄：

1. `core` 只能放值与协议，禁止 import app / api / runtime / services；
2. runtime / services / knowledge / learning / capabilities / agents **禁止反向 import api**；
3. `app` 禁止 import api。

> 对照：rsi-agent 的 `runtime/crates/agent-loop` 与 `runtime/crates/host` 之间、
> 以及 Python guest 插件与 Rust 宿主之间，目前靠**人守**（文档写边界），没有机器可执行的分层门禁。
> 这是第一处「抄了立刻有收益」的地方。

---

## 4. 执行流：三条入口 → 一条回合主干

```
CLI(Typer)  ─┐
WS /ws      ─┼→ TurnApplicationService（持久化 / 协调 / 重放）
Python SDK  ─┘        ↓
                  TurnEngine → ChatOrchestrator → 选中的 Capability（默认 chat）
                        ↓                    ↓
                  ToolRegistry(L1)     CapabilityRegistry(L2)
```

要点：

- **每个回合一条 `StreamBus`**：capability 发事件 → turn runtime 落库（带 `seq`）→ 适配器按 seq 重放给消费者。
  所以「断线重连」= 带 `after_seq` 再订阅，不是重跑。
- **能力层拥有回合**：`TurnCapability.run(context, stream)`，用 `async with stream.stage("planning")` 划分阶段。
  同一份事件协议，多阶段流水线与单循环 chat 都是一等公民（`chat` capability 内部就是一个 agentic loop）。
- **中途可交互**：工具返回值里有 `pause_for_user` → 循环**暂停但不结束回合**，
  发 `wait_for_input`，等回复后**把回复替换进同一条 tool message** 继续同一轮迭代。
  另有 `user_input` 命令：回合运行中插话，循环在下一步读走，可 `withdraw` 撤回。
- **多进程协调**：`RuntimeStatus` 暴露 `coordination_mode: memory|redis`、leader 租约、恢复积压；
  落单 worker 的回合由 leader 接管（`recovering` 是客户端可见态）。

> 对照 rsi-agent：`POST /api/chat` 是**阻塞到收敛**的，事件经 `GET /api/events` 轮询 memory trace；
> 已有 `queue` + `steer`（插话）、`cancel`、`rollback`，但没有「回合对象 + seq 补播」，
> 也没有「暂停等用户回答后继续同一回合」。**断线重连只能靠 trace 重放推断，不是契约保证。**

---

## 5. 两个插件层（Level 1 / Level 2）

### Level 1 — Tools（模型按需选）

`BaseTool` 抽象两件事：`get_definition() -> ToolDefinition`、`async execute(**kwargs) -> ToolResult`。

协议里几个「被踩过坑才有的字段」值得注意：

| 字段 | 解决的真问题 |
|---|---|
| `ToolParameter.items` / `nullable` / `minimum..max_items` | 严格 provider（Gemini/Anthropic）对 array 缺 items、可选字段缺 null 直接 400；OpenAI 会静默容忍 → 只在 Gemini 炸 |
| `ToolParameter.sensitive` | 参数值不进 trace 事件（如即将提问的正确答案） |
| `ToolResult.pause_for_user` | 回合内暂停交互，而不是结束回合 |
| `ToolResult.model_message` | 只给模型看的追加多模态上下文，禁止进流事件/持久元数据 |
| `ToolResult.public_result` | 公开投影与私有内容分离——**省略即不继承**，不是覆盖 |
| `BaseTool.deferred` | 渐进披露：schema 不进初始工具列表，系统提示只放一行，模型用 `load_tools` 按需拉全 |

`deferred` 是真金：所有 MCP / CLI 工具都是 deferred。rsi-agent 目前 MCP 工具是
「装载 ≠ 启用，启用后**常驻全会话可见**」（`tools_plugin.py` 头注释），工具一多就是纯 token 税。

### Level 2 — Capabilities（多阶段流水线，拥有整个回合）

`CapabilityManifest`：`name / description / stages / tools_used / cli_aliases / request_schema / config_defaults`。
内置十条：`chat / ask_questions / deep_solve / deep_question / deep_research / visualize /
math_animator / mastery_path / immersive_reading / video_lesson`。
全部收敛到 `emit_capability_result()` 出同一个信封（response + `cost_summary`），**不许自造完成事件**。

> 对照 rsi-agent：**没有这一层**。rsi 的 "capability" 是内核语义（插件间 call），
> 回合永远是「一个 ReAct 循环」；多阶段任务靠**技能文档**（SKILL.md 写流程）让模型自己走。
> 差异的代价：技能路线灵活但不可观测（阶段不可枚举、失败不可分阶段归因、前端画不出进度条）；
> 能力层路线刚性但可观测。

---

## 6. 逐个机制拆解（可迁移性排序）

### ① 回合协议 v2（**高价值 / 中成本**）

客户端命令是判别联合，`protocol_version: "2.0"` 强校验，未知/缺版本直接 `protocol_error`：

```
start_turn | subscribe_turn | subscribe_session | resume_from | unsubscribe
cancel_turn | regenerate | submit_user_reply | user_input | check_active_turn | ping
```

服务端事件：`stage_start/stage_end/thinking/observation/content/tool_call/tool_result/
progress/sources/result/error/session/session_meta/wait_for_input/done`，
统一带 `seq`，`protocol_error` 带 `error_code`/`retryable`。

状态机：`queued → running → waiting_input → completed|failed|cancelled`，
查询态多一个 `recovering`（服务端恢复窗口，客户端据此显示而非判死）。

**抄什么**：把「回合」做成持久对象 + 事件带 seq + 补播契约。
**别抄**：Redis 协调与 leader 租约（rsi-agent 是单进程多实例形态，不需要）。

### ② 三层记忆（**高价值 / 中成本**）

```
trace/<surface>/<YYYY-MM-DD>.jsonl   L1 只追加，事件流
L2/<surface>.md                      L2 每面摘要（带脚注引用，可追溯到 L1）
L3/<recent|profile|scope|preferences>.md   L3 跨面结论
```
surface ∈ `chat / notebook / quiz / kb / book / partner / cowriter`。

三个设计细节值得抄：

- **脚注引用 + 条目锚**：`- 文本 [^1][^3] <!--m_xxx-->`，脚注 `[^1]: chat:def`。
  同源条目共享脚注号 → 渲染不重复；`<!--m_xxx-->` 是稳定 id，drip/dedup/DELETE 都靠它；
  `serialize(parse(x))` **幂等**，且有 legacy 格式兼容期。
- **`recall.py` 只读时间戳不读正文**：返回 `surface/label/ts/days_ago`，
  且 `days_ago` 在服务端算好（注释：模型对 ISO 时间做减法会错）。
  这让「最近在干什么」可以放进**交互路径**而不是只在离线 consolidate 时跑。
- **consolidator 有 modes**：`audit / dedup / merge / update`，各有 prompt（en/zh），有 chunker 与 guards。

> 对照 rsi-agent 的记忆是**四个分立事实源**：`memory` 插件（sessions/traces JSONL，L1 等价）+
> `.rsi/profile.json`（结论，L3 等价）+ `.rsi/board.json`（任务/灵感）+ `skills/`（能力）。
> 缺的是 **L2（按面摘要 + 可追溯引用）** 和 **离线 consolidate 工具链**。
> 后果正好对上老板抱怨过的「问简单问题它像忘了」：L1 有大量事件，但没有可召回的中层摘要，
> 每次都要么全读要么不读。

### ③ `deferred` 工具 + `load_tools`（**高价值 / 低成本**）

渐进披露从「技能」下沉到「工具」。rsi-agent 已有技能的渐进披露（提示词只放 name+description，
`load_skill` 拉全文），但**工具没有**。MCP 工具一启用就常驻，是当前最直接的 token 浪费点。

### ④ `ask_user` = 暂停而非结束（**高价值 / 中高成本**）

`ToolResult.pause_for_user` + `wait_for_input` 事件 + `submit_user_reply` 命令 + 运行时 reply 队列。
rsi-agent 没有这条。影响：需要人工裁决的任务（比如「这份 release notes 发不发」）
只能「结束本轮 → 用户下一条消息 → 新一轮」，上下文与工具状态全部重建。
它自己的 `turn_protocol` 注释写得很直白：`ask_user` 早先用 `terminate_turn`，
后来改成 `pause_for_user`，就是为了「keep the turn alive across the user's answer」。

### ⑤ MCP 完整度（**中价值 / 低成本**）

DeepTutor：`stdio`（仅管理员）+ `sse` + `streamableHttp`，带 OAuth、按用户配置、密钥引用而非明文、
per-tool 超时、进度上报、传输层瞬时错误**只重试一次**。
rsi-agent：只有 `stdio`（`tools/mcp.py`：JSON-RPC 换行分帧，5s 退避重启）。
补 `streamableHttp` 的现实收益：能接远程 MCP（官方 server 多是 HTTP），且不需要用户本机装 node/python。

### ⑥ subagent 注册表（**低价值 / 参考**）

11 个本地 CLI 后端 + remote + partner，`SubagentBackend` 统一 `detect()/consult(on_event)`，
注入 `answer_by = partner:x | subagent:y` → `HandoffCapability` 整回合移交。
rsi-agent 的 `task` 子代理是「新 session 复用同一循环、只回最终答案、禁止嵌套」，形态更简单也更省。
不必抄注册表；**可抄的是 `detect()` 探活思路**（能力可用性由探测得出，不由配置文件自述）。

### ⑦ modules / plugins（**中价值 / 参考**）

- modules：每个 `manifests/*.json` 自带依赖闭包 + 就绪状态（`installed/enabled/ready` + `issues`），
  `requirements/` 由 manifest 生成，安装粒度为 wheel。
- plugins：`deeptutor.plugin/v1` manifest + 审批绑定 + 版本私有 venv + worker 协议
  （legacy 单次 JSON 或 `ndjson-v1` 流式：`{"kind":"event"}` … `{"kind":"complete"}`）+
  静态页 CSP 沙箱（`connect-src 'none'`）。
- 明确写了「权限声明与审批不是 OS 沙箱」——不吹。

> rsi-agent 的等价物是「技能目录 + tools.json + exec.cmd」：更轻，但没有可选依赖闭包、
> 没有就绪状态、没有审批。技能工具缺依赖时只能靠 `ImportError` 静默降级（`symbols_search` 就是这样）。

---

## 7. 差异矩阵（决定集成方式的那张表）

| 维度 | DeepTutor | rsi-agent | 冲突程度 |
|---|---|---|---|
| 语言/运行时 | Python FastAPI + asyncio | Rust host/kernel + Python guest 插件 | **高**（进程模型天生不同） |
| 回合 | 持久对象，seq 可补播 | 阻塞调用，trace 事后回放 | 中 |
| 执行流 | 单循环 + 十条多阶段能力 | 只有单循环 | 中 |
| 技能 | SKILL.md + references，`name/description/tags/always/requires` | SKILL.md + tools.json，`name/description/origin` | **低（近同构，可互认）** |
| 记忆 | L1/L2/L3 + consolidator | L1 + profile + board | 中 |
| 账本/自进化 | 无 | 有（board / ledger / evals / 晋升） | **零（它没有）** |
| 领域能力 | 教学全家桶 | 无 | — |
| 交付形态 | 桌面 App（Electron）+ Docker + PyPI | cargo + run.cmd + web-dist | 高 |

结论：**技能格式几乎同构，运行时完全不同，领域能力是它独有的、账本是它缺的。**

---

## 8. 目标甲：集成 DeepTutor 的四条接法（按代价排序）

### A0. 先看「deeptutor 进本机」到底要装什么（这一步决定了 A 可行不可行）

CLI 的真实入口是 `deeptutor run <capability> "<消息>" --format json`（`deeptutor_cli/main.py:77`），
参数面比上一版写的大：`--session / --workspace / --tool / --kb / --notebook-ref /
--history-ref / --language / --config / --config-json / --format`。
`--format json` 是 **NDJSON 逐事件透传**（`stream_turn_as_json`，一行一个事件），不是单个 JSON 对象。

依赖分层（`requirements/` 由 module manifest 生成）：

| 层 | 装什么 | 体量判断 |
|---|---|---|
| `core.txt` | PyYAML / jinja2 / openai / tiktoken / aiohttp / httpx / ddgs / tenacity / pydantic / aiosqlite / typer / rich / mcp / loguru / python-docx / openpyxl | 中等，都是常见包，本机多半已有大半 |
| `modules/research` | `-r core.txt` + `arxiv` | 轻 |
| `modules/solve` | `-r core.txt` | 零额外 |
| `modules/visualize` | `-r core.txt` | 零额外 |
| `modules/knowledge` | `-r core.txt -r parsing.txt` + `pageindex / llama-index / bm25s / faiss-cpu / numpy` | **重**（FAISS + llama-index，向量检索全家桶） |
| `modules/parsing` | PyMuPDF / Pillow / python-pptx / pypdf / pdfplumber / reportlab / defusedxml / pywin32 | 中重 |
| `modules/renderer-manim` | `manim` | **重**（要 LaTeX + ffmpeg） |

**结论（这是决策的关键）**：

- 只装 core + research + solve + visualize → 能拿到**深度研究、解题、可视化**，依赖可控。
- 想拿**知识库问答** → 必须吃下 llama-index + FAISS 那一坨。
- 想拿**数学动画** → 必须装 manim + LaTeX + ffmpeg（Windows 上 LaTeX 是最麻烦的一环）。

**所以「教学能力」不是一档，是三档**：轻（研究/解题/可视化）、中（知识库）、重（数学动画/视频课）。
进本机要不要进、进哪一档，是你要定的，不是我能替你定的。

### A. 当「技能工具」用：CLI 子进程（最便宜）

```
deeptutor run <capability> "<输入>" --kb <kb> --config k=v --format json
```
包成一个技能：`skills/deeptutor/tools.json` 里 `exec.cmd = ["deeptutor","run", ...]`，
stdin 收 `{"args":{...}}`，stdout 回 `{"ok":true,"result":...}` —— 与 rsi-agent 技能工具的
Wire 契约（`tools_plugin.py` 头注释）**天然同构，零改造**。

- 改动量：一份 `SKILL.md` + 一份 `tools.json` + 一个薄封装脚本（解析 `--format json`）。
- 代价：宿主机要有 `deeptutor` 可执行 + 目标 capability 的依赖（knowledge/rag、manim、playwright 都是重依赖）。
- 边界：**单向**。rsi-agent 调它，它不知道 rsi-agent 存在。没有回合共享、没有工具互借。
- 适用：只要「深度研究 / 出题 / 可视化 / 知识库检索」这几个能力，不要它的壳。
- **一个坑要注意**：headless（`--format json`）下它的 `ask_user` 暂停会被自动填成 `"(empty reply)"`
  （`stream_turn_as_json` docstring 明写「headless runs cannot hang on a question no one will answer」）。
  即**用 A 接法拿不到它的人机交互能力**，模型会自己往下猜。要交互只能走 C。

### B. 反过来：把 rsi-agent 注册成 DeepTutor 的 subagent 后端

它的 `services/subagent/registry.py` 是一张**闭表**（11 个后端硬编码在 `_BACKENDS`）。
要让 DeepTutor 能「咨询 rsi-agent」，得改它的源码加一个 `RsiAgentBackend`（Shell 到
`react-agent-host <问题>` 读 stdout）。属于 **fork 别人的仓库**，且带来长期 rebase 成本。
- 改动量：一个 backend 文件 + 一行注册（在他们仓库里）。
- 收益：让教学应用能借你的 RSI 能力。**除非你打算长期维护这个 fork，不建议。**

### C. WS 桥接：rsi-agent 侧实现 DeepTutor 客户端

rsi-agent 的 tools guest 里 `websockets` / `httpx` 都已可用，技术上能做：
`start_turn` → `subscribe_turn` 收 `seq` 事件 → 拼成 tool result。
- 代价：要处理它的鉴权（`ws_require_auth`）、workspace 归属、`wait_for_input` 回头路、
  以及两边事件模型映射（它 15 种事件 → rsi 的 tool 结果字符串）。**这是最贵的路，收益等同 A 但多一层。**
- 结论：**否决**。A 已经覆盖 95% 需求，且进程隔离天然更稳。

### D. 不集成代码，只搬机制

见第 9 节（目标乙）。一句话：不装 deeptutor、不碰它的代码，只把 ①②③④⑤ 那几套机制
按自己的形态实装到 rsi-agent 里。**它和 A/B/C 不是并列选项——A/B/C 都是「装它」，D 是「不装它」。**

---

## 9. 目标乙：优化 rsi-agent 本身（三步，各自可独立验收）

> 这三步**与是否安装 deeptutor 无关**。DeepTutor 在这里的角色只是「这套做法在别处被验证过」的证据。

### Step 1（便宜、当天可验）：`deferred` 工具 + `load_tools`

- 补丁改 `agent-loop`：`ToolSpec` 加 `deferred: Option<bool>`；MCP / 技能工具默认 deferred；
  提示词只放一行摘要；新增保留工具 `load_tools` 拉取全 schema。
- 验收：MCP 工具数 ≥5 时，首轮工具 schema token 明显下降，且模型仍能调用成功（回归用例）。

### Step 2（中）：记忆 L2 层 + 只读时间戳召回

- 新增 `scripts/memory_consolidate.py`：读 `runtime/plugins/memory/data/{sessions,traces}`，
  产出 `L2/<面>.md`（带脚注引用到 session/round），`serialize(parse(x))` 幂等。
- 召回走「只读时间戳 + days_ago」，与 `.rsi/profile.json` 的结论层并列而不合并。
- 验收：给定「问一个上周做过的事」，能返回含 L2 摘要的召回，且不读正文（可用字节计数验证）。

### Step 3（贵）：回合持久化 + `wait_for_input`

- 最小形态即可：turn 对象存 `.rsi/turns/<turn_id>.json`，事件带 `seq`，
  `POST /api/chat` 增加 `turn_id` 返回、`GET /api/turns/{id}?after_seq=` 补播；
  新增 `POST /api/turns/{id}/reply` 承接暂停中的回答。
- 验收：断线重连不重跑、暂停回复后续跑同一轮的上下文不重建（可用工具调用次数对比证明）。

### 不做

| 项 | 理由 |
|---|---|
| 整体引入 DeepTutor 作运行时 | 与 rsi-agent 的账本/自进化/单循环全部冲突，等于重写两个产品 |
| Redis 协调 / leader 租约 / 多 worker | rsi-agent 是多实例单进程形态（`.instances/`），没有这个空间需求 |
| 它的 plugin 审批 + 版本私有 venv | rsi 的技能是「目录 + SKILL.md」的轻资产，加 venv 管理违背既有裁决（`docs/02 §2`） |
| 它的 15 种流事件全盘照搬 | rsi 的前端已经按自己的 trace 事件渲染，事件集要收敛不要膨胀 |
| 把 DeepTutor 的 `skill-creator` 技能搬进来 | rsi 已有 `creat-skill`，且有它没有的评测与晋升链 |

---

## 10. 两件事的组合，实际是四种局面

| 局面 | 目标甲（集成） | 目标乙（抄机制） | 结果 |
|---|---|---|---|
| **只做乙** | ✗ | ✓ | agent 变好，但没有教学能力。**成本最低、风险最小** |
| **只做甲** | ✓ | ✗ | 有教学能力，但 token 税/记忆断层/断线重跑照旧。**最快见效** |
| **先甲后乙** | ✓ | 之后 | 先拿到能用的教学能力，再回头补运行时 |
| **都做** | ✓ | ✓ | 最终形态，但要分两次动核心区 |

**没有「只做甲就顺手把乙做了」这种便宜**——甲是加一个技能目录（轻，随时可删），
乙是改内核（重，走补丁 + 回归）。两件事的改动位置、验收方式、回滚成本完全不同。

---

## 11. 待你拍板（现在只剩两个决定，第三个已拆分掉）

### 决定 1：要不要做目标乙（抄机制）

我的建议：**要**，且从 Step 1 开始。理由：`deferred` 工具是纯 token 收益、改动面最小、
不依赖任何外部项目；而记忆 L2 直接对应你抱怨过的「问简单问题它像忘了」。

### 决定 2：要不要做目标甲（集成），做哪一档

| 档 | 装什么 | 拿到什么 | 判断依据 |
|---|---|---|---|
| 轻 | core + research/solve/visualize | 深度研究、解题、可视化 | 想「偶尔让它替我查资料/画图」→ 选这个 |
| 中 | + knowledge + parsing | 再加知识库问答（丢 PDF 进去问） | 有大量本地文档要问 → 选这个 |
| 重 | + renderer-manim | 再加数学动画 | 要出教学视频 → 才选这个 |

**只要聊天（chat capability）= 零收益**：chat 就是它自己的 ReAct 循环，
你已经有一个更好的（带账本、带技能、带自进化）。装它只为用**它独有的领域能力**。

> 上一版列的第 3 件「Step 3 的优先级」不是独立决定，它属于决定 1 内部的排序，已并入。

---

## 附：可直接引用的关键文件（便于复核）

| 主题 | 路径 |
|---|---|
| 架构总述（作者自述） | `AGENTS.md`（"Agent-Native Architecture"） |
| 分层契约 | `.importlinter` |
| 工具协议 | `deeptutor/core/tool_protocol.py` |
| 能力协议 | `deeptutor/core/capability_protocol.py` |
| 回合上下文 | `deeptutor/core/context.py`（`UnifiedContext`） |
| 回合请求 | `deeptutor/core/turn_request.py`（`TurnRequest`，含 legacy config 平移） |
| 线协议 | `deeptutor/api/contracts/turn_protocol.py` |
| WS 适配 | `deeptutor/api/routers/unified_ws.py` |
| 编排器 | `deeptutor/runtime/orchestrator.py` |
| 应用门面 | `deeptutor/app/facade.py` |
| 记忆路径/文档/召回 | `deeptutor/services/memory/{paths,document,recall}.py` |
| MCP 管理器 | `deeptutor/services/mcp/manager.py`（三传输 + OAuth + 单次重试） |
| subagent 注册表 | `deeptutor/services/subagent/registry.py` |
| 技能规范 | `deeptutor/skills/builtin/skill-creator/SKILL.md` |
| 模块清单 | `deeptutor/modules/manifests/*.json` |
| 插件契约 | `docs-for-dev/PLUGINS.md` |
