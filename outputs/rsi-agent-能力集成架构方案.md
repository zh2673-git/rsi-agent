# 架构集成方案：RAG / 深度研究 / 教学 三类能力怎么接进 rsi-agent

> 依据：本仓库源码实测（非推断）。所有结论都标了文件与函数，便于复核。
> 结论先说：**三类能力没有一个需要新增内核插件。** 它们的差别不在「接哪个层」，
> 而在「缺的是检索、是账本、还是状态机」——而这三种缺口在本仓库已经有各自的先例。

---

## 0. 一张表看完结论

| 能力 | 落层 | 具体形态 | 为什么不是更低的层 | 为什么不是更高的层 |
|---|---|---|---|---|
| **RAG / 检索** | `scripts/` CLI + `bash` | `scripts/index.py`（SQLite FTS5）+ 召回入口 | — | 不需要新 capability：它不是协议，是领域逻辑 |
| **深度研究** | 技能（提示词纪律）+ `scripts/` 账本 | `deep-research` 技能 + `scripts/sources.py` 来源账本 | 光有提示词不够：来源必须落盘才能在预算掐断后恢复 | 不需要新插件：`task` 并行子代理 + `web_search/web_read` 已够 |
| **教学** | `scripts/` CLI + 技能 | `scripts/mastery.py` + `tutor` 技能 | 同上 | **看板已经证明这条路可行**（见 §5） |

三条都不是「往内核里塞东西」，而是「往已有的三条扩展通道里塞」。

---

## 1. 先盘点：本仓库实际有哪几条扩展通道

这决定了方案的上限。下面每一条都标了代码位置。

### 通道 A：内核 capability 插件（最重）

`HostSpec::from_env` 里硬编码四个插件【`runtime/crates/host/src/assemble.rs:78-145`】：

| 插件 | 运行时 | capability |
|---|---|---|
| memory | NodeTs | `memory.session`、`session.trace` |
| llm-adapter | Python | `llm.chat` |
| tools | Python | `tools.exec` |
| assets | Python | `assets.registry` |

跨插件调用按 capability 寻址【`agent-loop/src/lib.rs:79-86`】：
`CAP_MEMORY` / `CAP_LLM` / `CAP_TOOLS` / `CAP_ASSETS`。agent-loop 的 manifest 把前三个声明为
**硬依赖**（`hard: true`）【`lib.rs:251-253`】，assets 为软依赖。

**能做什么**：新增一个 `rag` 插件、或给 llm-adapter 加 `llm.embed` op。

**代价**：`assemble.rs` 在 `runtime/` 下，而 `_CORE_BLOCKLIST` 第一项就是 `"runtime"`
（整树禁写）【`runtime/plugins/tools/tools/files.py:45`】。要改只有两条路：
用户在 `config.json` 的 `tools.allow_core_write` 填前缀授权，或走 `scripts/patches/*.json` 外挂补丁。

**真正的反对理由不是「改不动」，是「不该」**：这一层是**传输/生命周期协议**层
（谁提供、谁依赖、deadline、panic 隔离、背压），不是领域逻辑层。把「怎么检索」放进去，
等于让组合根知道业务语义——这正是 `docs/02-架构设计.md:9` 那条边界
（内核「不理解技能/评测/经验；不承载业务语义」）在下一层要守的同一个原则。

### 通道 B：内置工具池（次重）

`tools_plugin.py::_reload_modules()` 扫描 `tools/` 包目录下所有 `*.py`，
要求模块暴露非空 `TOOLS: dict[name, spec]`，`spec` 必须含 `description`/`parameters`/`run`
【`tools_plugin.py:273-302`】。单模块失败 fail-closed 跳过，不影响其余。

**能做什么**：新增 `tools/retrieval.py`，暴露 `rag_search` 工具。

**代价**：`runtime/plugins/tools/tools/` 在禁写名单里【`files.py:50`】，同样要核心写授权。
且 `_BUILTIN_MODULES` 里的七个名字不可覆盖【`tools_plugin.py:141`】。

### 通道 C：技能配套工具 `tools.json`（可写，但有闸）

`skills/<name>/tools.json` 声明 `exec.cmd`，执行时：
子进程 `stdin = {"args":{...}}`、`stdout` 为 `{"ok":...}` 同形 JSON、cwd 缺省技能目录
（`exec.cwd` 不得越出技能目录）、超时杀进程、按 session 登记可 abort
【`tools_plugin.py:604-655`】。

**这是唯一一条我（agent）不需要任何授权就能用的「新工具」通道**——`skills/` 在工作区里、
不在 `runtime/` 下。

**但有一个必须知道的闸**：`_parse_enabled()` 的缺省白名单是**内置全集**，
注释原文「MCP/技能工具不自动启用（人工闸）」【`tools_plugin.py:149-161`】。
用户技能的工具调用时直接报 `TOOL_DISABLED`，错误文案写得很清楚：
「需在设置面板 → 技能 → {owner} 条目内勾选启用；**装载≠启用**」
【`tools_plugin.py:540-546`】。

出厂技能（`origin: preset`）装载即自动启用【`skills.rs:430-433` + `install_skill_tools`】，
但 preset 是 git 管理的出厂件、且 host 删除 API 拒删【`assets_plugin.py:71-73`】。

### 通道 D：`bash` + `scripts/` CLI（一直可用）

`bash` 是内置工具、默认启用【`config.example.json:8-21`】。`scripts/` 在工作区、可写。

**这条通道在本仓库已经是被验证过的主力**，而且有两处明确的先例：

- 任务看板：`scripts/board.py`，通道**写死 bash 调 CLI**。`skills.rs:162-164` 注释原文：
  > **通道写死 bash 调 CLI**：`python scripts/board.py`。不走技能 `tools.json`
  > （装载后默认未启用，闭环会断在用户点配置上）。

- 习惯画像：`scripts/profile.py`；记忆 L2/L3：`scripts/memory_consolidate.py`。

**这个先例是本次方案的关键依据**：当「闭环不能断在用户点一下配置」时，选 CLI 而不是 tools.json。

### 通道 E：MCP（需用户改 config.json）

`config.json mcp_servers` → `MCP_SERVERS` env → tools 插件 init 时逐台 stdio 连接、
枚举工具入池，全限定名 `mcp__<server>__<tool>`，**默认标 `deferred: true`**
（schema 不进下发清单，模型调 `load_tools` 报名后下一轮才下发）
【`config.rs:408-414`、`tools_plugin.py:207-260,336-349`、`tools_deferred`】。

`config.json` 对我是永不豁免的禁写项【`files.py:52`】，所以这条路**必须由用户配置**。

---

## 2. 一个决定性的硬约束：技能工具拿不到 LLM 密钥

这条直接决定了 RAG 能不能用「调 embedding API」的形态。

`HostSpec::from_env` 给各插件装配的 env 不同：

- llm-adapter 拿 `cfg.llm_env()`——含 `LLM_PROVIDER`/`LLM_MODEL`/`LLM_BASE_URL`，
  以及从父进程继承的 `OPENAI_API_KEY`【`config.rs:113-133`】。
- tools 与 assets 拿 `cfg.passthrough_env()`，白名单键里**没有** `OPENAI_API_KEY`
  【`config.rs:137-167`】。

而技能工具是 **tools 插件的子进程**（`_exec_command` 用 `subprocess.Popen` 继承 tools 的 env）。

**结论**：`skills/*/tools.json` 里的执行体**读不到用户的模型密钥**。
想让检索用 embedding，就得让用户**再配一份 embedding 密钥**（走 media 那样的持久 env 通道，
`config.rs:433-436` 是现成模板），或者干脆不用 embedding。

这个约束把方案推向**本地、零密钥**的检索——见 §3。

---

## 3. RAG：真正的落点不是「通用检索」，是 L2 召回升级

### 3.1 先看清现状：检索能力其实有三块，缺的是第三块

| 现有能力 | 实现 | 强在哪 | 弱在哪 |
|---|---|---|---|
| `grep` / `symbols_search` | 内置工具 | 精确、零成本、代码/英文强 | 中文语义不匹配就找不到 |
| `memory.recall` | 子串扫描**最近 2000 行**事件 sidecar，上限 **5 条**【`memory_plugin.ts:249-266`】 | 快 | 只看最近、只做字面包含、无排序 |
| `memory_consolidate.py` L2/L3 | 确定性按天摘要，`recall` 只读 `L3/index.json` | 能回答「哪天干了什么」 | **只能按时间窗取，不能按内容取** |

第三块缺的正是：**给定一个问题，按内容相关度在历史里取回片段**。

`docs/self-evolution/00-PLAN.md:22` 对 memory 的自评已经点明：「无索引/无向量/无相关性召回」。

### 3.2 语料规模实测（这决定了技术选型）

| 语料 | 规模 | 实测 |
|---|---|---|
| `docs/*.md` | 8 个文件 | — |
| `outputs/*.md` | 25 个文件 | — |
| `.rsi/memory/L2/*.md` | 10 个文件 | **56 KB 合计** |
| `runtime/plugins/memory/data/traces/*.jsonl` | 40 个文件 | **74.3 MB** |
| `runtime/plugins/memory/data/events/*.jsonl` | 20 个文件 | 7.2 MB |

**关键观察**：L2 全部只有 56 KB——**整个 L2 层能一次塞进上下文**（约 1.5 万 token）。
所以「检索 L2」在技术上不需要索引，需要的是**把 56KB 换成「相关的 5 条」的排序**。
而 74 MB 的 trace 原文是唯一真正需要索引的东西，但它是 append-only 原文，
L2/L3 本来就是它的派生视图（`memory_consolidate.py:21` 三层表），
**去索引原文等于绕过自己刚建好的中间层**。

### 3.3 为什么不是向量库

三条理由，按硬度排序：

1. **没有 embedding 提供方**。全仓 `embedding|vector|faiss|qdrant|lancedb|cosine` 零命中；
   `llm_adapter` 只有 `openai_compat`/`anthropic`/`ollama`/`mock` 四个 chat provider，
   没有 embed op；技能工具拿不到密钥（§2）。要上向量 = 先改 llm-adapter（核心写）+ 用户再配一份密钥。
2. **中文检索 FTS5 就够用**。本机 `sqlite3` 实测 **3.41.2，FTS5 可用**（`create virtual table ... using fts5` 通过）。
   FTS5 的 `bm25()` 给的是真正的相关性排序——这恰好是 `recall()` 现在缺的那一块。
   中文需要分词：FTS5 无 CJK tokenizer，用 **字符二元组（bigram）** 建索引即可，
   查询侧同样切 bigram，召回率与 FTS5 默认相当，代价是索引大一点（可接受）。
3. **语料量级不需要**。可检索单元（L2 56KB + outputs 25 篇 + docs 8 篇）总计数 MB，
   暴力 BM25 排名在毫秒级。向量库解决的是「千万级文档」，这里差三个数量级。

### 3.4 落点设计

```
scripts/index.py          # 建索引 + 检索（sqlite3 标准库，零新依赖）
  build  [--corpus l2|outputs|docs|skills|all]   # 增量：按 (path, mtime, size) 跳过未变
  search "<query>" [--k 5] [--corpus ...]        # bm25 排序，返回 path:line + 片段
  stat                                           # 索引体积/条目数/最后构建时间
索引落盘：.rsi/index/fts.db（派生视图，可随时删掉重建）
```

**入口形态：v1 走 `bash python scripts/index.py search "..."`，不做 `tools.json`。**
依据就是看板那条先例（`skills.rs:162-164`）：技能工具默认未启用，闭环会断在用户点配置上。
等它真的变成高频调用，再包一层 `tools.json` 也不迟——那时用户已经知道这个工具存在。

**接进提示词的位置**：不是新造一段，而是把 `memory_ctx::memory_ops_hint()`
（现在讲「L2 按天打开」那段）扩一句「按内容找用 `index.py search`」。
这是既有段落的一句话扩展，不是新通道。

### 3.5 但先做 P0：量一下到底值不值

**这是整个方案里最重要的一步，也是最容易被跳过的一步。**

做法：从真实会话里取 20 个「按内容找历史」的问题（形如「上周那个 X 我们怎么定的」
「之前评估 Y 的结论是什么」），对每个问题比较三个基线：

| 基线 | 命令 |
|---|---|
| B0 无检索（现状） | 模型只能自己 `grep` 或读 L2 |
| B1 grep | `grep "<关键词>" .rsi/memory/L2 outputs docs` |
| B2 FTS5 | `index.py search "<原问题>"` |

**判据：如果 B1 已经能命中 18/20，就不要建 B2。** 建了也是白建——
这正是 Bastani 那条教训的工程版本：先证明增量，再付出成本。
反过来，如果 B1 只命中 8/20 而 B2 到 16/20，那这个索引有明确价值，且**这个对比数字本身就是验收证据**。

---

## 4. 深度研究：缺的不是搜索，是账本和断点

### 4.1 现状：能力已经在了，缺的是「研究这件事的持久状态」

已有的件：

| 件 | 位置 | 提供什么 |
|---|---|---|
| `web_search` | `tools/web.py` | 6 引擎链（bing/sogou/baidu/ddg/bocha/tavily），`SEARCH_BACKEND` 可钉 |
| `web_read` | 同上 | Jina 代理 + 直读兜底 + 8MB 内存缓存（翻页不重复出网） |
| `task` 子代理 | `agent-loop/src/subagent.rs` | 新会话、depth≤1、预算随链衰减、事件镜像回父 trace |
| 并行波次 | `chat.rs:842` `join_all` | 同一轮多个工具调用并发执行 |
| `todo` | `tools/todo.py` | 轮内计划 |

也就是说：**「搜→读→综合」这个循环，模型现在就能跑**。跑出来的东西也不差
（本轮会话前面那 5 份调研文档就是证据）。

缺的是三件，而且都不是「再加一个搜索工具」能解决的：

### 4.2 缺口一：来源账本（citation ledger）

现状：来源只以 `sources` 观测胸牌的形式**流向前端溯源卡**
（`ToolObs.sources`：`result_list` / `single_url`，见 `contract.rs:61-65` + `tools_exec.rs::detect_sources`）。
它是**展示用的**，不是**可查询的账本**：跑完就散在 trace 里，下一轮无法据此核对「这条断言有没有出处」。

要做的是：`scripts/sources.py`，一个 append-only 的 JSONL 账本
`.rsi/research/<topic>/sources.jsonl`：

```
{"id":"S7","url":"...","title":"...","fetched_at":"...","quote":"<原文摘录>","used_by":["claim-3"]}
```

配套纪律（写进技能提示词）：**报告里每条事实性断言必须带 `[S7]` 标记**，
没标记的断言要么删掉、要么标成「推测」。

**验收是可机检的**：`sources.py check <report.md>` 扫出所有 `[S*]` 引用，
① 每个引用在账本里存在；② 每条账本条目至少被引用一次（找出「读了没用」的浪费）；
③ 报出没有引用标记的段落数。这比「让模型注意别瞎编」强一个数量级——
和 DeepTutor `quiz.py` 那条 `evidence_key(...) not in context_key → raise` 是同一个思想。

### 4.3 缺口二：预算边界断点

硬约束在这里：`CHAT_BUDGET_SECS` 缺省 **900s**（`lib.rs:149` 注释原文
「整轮预算 CHAT_BUDGET_SECS 缺省 900s 需 ≥ 单步闸」），`max_rounds` 缺省 2000
（`config.example.json:24`）。到边界时 `budget_stop` / `wrap_up_once` 会收尾
（`chat.rs:1048-1183`），**本轮就结束了**。

一个 60 个子问题的深度研究会撞上这个墙。撞上时如果中间产物只在上下文里，全部作废。

所以账本不只是为了引用，**它是崩溃恢复的唯一载体**。研究进度必须每完成一个子问题就落盘：

```
.rsi/research/<topic>/
  plan.json      # 子问题列表 + 每个的状态（pending/done）+ 已完成部分的结论摘要
  sources.jsonl  # 来源账本
  draft.md       # 增量成稿
```

这样下一轮只要读 `plan.json` 就知道从哪继续——**这就是「状态由证据算出，不是靠计数器」**
在看板上的同一条原则，只是换了对象。

### 4.4 缺口三：并行子问题的合并

`task` 子代理已经是并行执行（同一波次 `join_all`），每个子代理返回**只有最终答案**
（`subagent.rs:81-86`：`{"ok":true,"answer":...,"sub_session":...}`）。

问题：子代理**不写父的账本**。它自己搜到的东西如果没写进 `answer`，就丢了。
所以子代理的任务描述里必须**要求它先写账本再返回**
（`sources.py add` 是 bash 可达的，子代理有 bash）。

这一条不改代码，只改技能提示词——但它决定了并行研究是「真并行」还是「并行然后丢失细节」。

### 4.5 落点

```
scripts/sources.py                    # 账本 CLI（add/list/check/link）
skills/deep-research/SKILL.md         # 纪律：先建 plan、每个子问题落盘、断言带引用
```

**不做**：不新增 `deep_research` capability，不做多阶段流水线（DeepTutor 那条
`research → outline → write` 的三段式对我们是负收益：它的收益是「阶段间可人工介入」，
而我们的形态是单会话连续对话，介入靠 `ask_user` 暂停已经够了）。

---

## 5. 教学：它要的状态机，本仓库已经有了

### 5.1 先说一个容易搞错的前提

DeepTutor 的 `mastery_path` 之所以能做成状态机，是因为它走的是 `loops` 通道
（独立循环），其余九个能力走 `capabilities` 通道（chat loop + 提示词 + 工具）。

而 rsi-agent **没有「能力通道」这个概念**——`agent.chat` 是唯一的循环。
所以「照搬 mastery_path 做成一个能力」在本仓库没有对应位置。

但这不是坏消息。因为 mastery 真正需要的不是「独立循环」，是**跨会话的持久状态 + 由证据推进**。
而这个形态本仓库已经有一个成熟实例：**任务看板**。

| mastery_path 的件 | 看板里的对等件 | 证据 |
|---|---|---|
| `policy.py` 门（按知识类型分阈值） | `checks`（cmd/file/grep/manual） | `board.py:403-441` |
| `next_objective` 从掌握度算，不靠阶段计数器 | `eval` 拿 verdict，**失败把 done 降回 doing** | `board.py:705-755` |
| test-out（已证明掌握就跳过） | checks 全 pass 即 verdict pass | 同上 |
| `learner_mastery_overrides` 留痕区分来源 | `manual` check 恒 skip（人不自评） | `board.py:_run_check` |
| `mastery.json` 持久化 | `.rsi/board.json` | — |

**这张表是本节的核心论点**：教学需要的机制，我们已经有了一半，而且是从「验收」而不是
「教学」的角度建的——它更硬。

### 5.2 那么「教学」在这个工作区到底是什么

必须先分清两件事，它们的落点完全不同：

| | 形态 | 谁受益 | 本仓库适配度 |
|---|---|---|---|
| **甲：当导师** | 跨会话学习者模型、出题、判掌握、推下一步 | 人学东西 | **低**——这是老板用来看项目的 agent，不是他的补习老师 |
| **乙：产课件** | 把研究结论变成有结构、可验收的教学材料 | 老板的交付物 | **高**——前面那 5 份调研文档就是这个形态 |

**建议先做乙，不做甲。** 理由：乙的输入（`outputs/*.md`）和输出（讲义/题/图）都在
已有通道里；甲的投入（学习者模型 + 判分 + 防作弊）全部是新的，而受益者只有一个人，
且那个人（用户）本来就能直接读懂文档，不需要被教。

如果确实要做甲，落点是：

```
scripts/mastery.py            # .rsi/mastery/<topic>.json：objective + evidence[] + mastered
skills/tutor/SKILL.md         # 纪律：先出题、不给答案、按 evidence 判
```

关键设计（直接抄 `policy.py` 两条，这是它最值钱的部分）：
1. **门是分类型的**：记忆/程序类用可机检的正确率阈值；概念/设计类不能靠选择题，
   要让学生用自己的话讲（DeepTutor 用 Feynman 判定，我们至少可以用 `manual` check）。
2. **推进从 evidence 算，不靠 stage 计数器**：`mastered` 只由 `evidence[]` 推出，
   而且已掌握的 objective **直接跳过**（test-out）。

**不抄**：`compute_mastery` 的加权正确率（`learning/mastery.py` 40 行，
docstring 自标「replace `compute_mastery` alone」）——抄一个已知的简化没意义，
真要做直接上 pyBKT（292★，MIT）。

---

## 6. 被否决的方案（逐条带理由）

| 方案 | 结论 | 理由 |
|---|---|---|
| 新增 `rag` capability 插件 | **否决** | 领域逻辑进组合根，违反 `docs/02:9` 的内核边界；且要核心写授权 |
| 给 llm-adapter 加 `llm.embed` | **暂否决** | 要核心写 + 用户再配一份 embedding 密钥；而语料量级用 FTS5 就够（§3.3） |
| 上向量库（Qdrant/LanceDB/chroma） | **否决** | 三个数量级的过度工程；且无 embedding 提供方 |
| 索引 trace 原文（74MB） | **否决** | L2 是它的派生视图，索引原文等于绕过中间层 |
| 用 `tools.json` 做检索工具（v1） | **否决（v1）** | 技能工具默认未启用，闭环断在用户点配置——看板已经踩过这个坑并留了注释 |
| 照搬 DeepTutor 十能力并列结构 | **否决** | 那是它的产品形态；我们的能力单元是技能，不是 capability |
| 照搬 `deep_research` 三段流水线 | **否决** | 收益是阶段间人工介入，我们的 `ask_user` 暂停已覆盖 |
| 自建 MCP server 包检索 | **暂缓** | 可行，但需要用户改 `config.json`；CLI 已经够用，等多实例共享索引时再说 |
| 教学做成「独立模式/独立循环」 | **否决** | `agent.chat` 是唯一循环；状态机由持久 JSON + CLI 提供，不需要新循环 |

---

## 7. 分期与验收

顺序按「先证明、后投入」排，每一期都可独立验收、可独立放弃。

### P0（半天，零代码）：量一下检索值不值

- 产出：20 条真实问题 + B0/B1/B2 三基线命中率对比表。
- 验收：**给出「建」或「不建」的结论及数字依据**。如果 B1 已 ≥18/20，P1 直接取消。

### P1（1-2 天）：`scripts/index.py` + 提示词一句

- `build` 增量（按 path+mtime+size 跳过）、`search` 走 bm25、中文 bigram。
- 入口：`bash python scripts/index.py search "..."`（不做 tools.json）。
- 提示词：`memory_ctx::memory_ops_hint()` 加一句「按内容找用 index.py search」。
- 验收：① P0 问题集上 hit@5 优于 B1 基线；② `build` 二次运行 0 变更（增量正确）；
  ③ 索引可删可重建，重建后结果一致。

### P2（2-3 天）：`scripts/sources.py` + `deep-research` 技能

- 账本 JSONL + `check` 子命令（引用完整性三查：悬空引用 / 未用来源 / 无引用段落）。
- `plan.json` 断点续跑：读 plan 恢复 pending 子问题。
- 验收：① 一份真实研究报告，`sources.py check` 输出 0 悬空引用；
  ② 故意在报告里插一条 `[S99]`，`check` 必须报错（负向用例）；
  ③ 中途 kill 会话，下一轮能从 `plan.json` 继续。

### P3（可选，按需）：`mastery.py` + `tutor` 技能（形态乙优先）

- 先做「产课件」形态（输入 `outputs/*.md`，输出讲义+题+验收清单）。
- 若要做「当导师」形态，再加 `mastery.json` + 分类型门 + test-out。
- 验收：已掌握 objective 被跳过（test-out 生效），且 `mastered` 能从 `evidence[]` 重算一致。

---

## 8. 未验证 / 需要你拍板

**未验证（不要当结论讲）**：
- FTS5 的 CJK bigram 方案在**本仓库真实语料**上的召回率——没跑过，只有「FTS5 可用」这一条实测。
- `web_search` 六引擎链在长时间深度研究下的限流行为——`_throttle` 存在（`web.py:36`），但没压测。
- 技能工具的 `origin: preset` 是否能让**新装**技能的工具立即启用——代码路径看着成立
  （`install_skill_tools` 传 origin，tools 侧 preset 装载即启用），但我没有实装验证过。

**需要你拍板的三件事**：

1. **P0 要不要做？** 我建议做——它是唯一能避免「建了个没用的索引」的步骤，成本半天。
2. **教学是做甲（当导师）还是乙（产课件）？** 我建议乙。甲需要你真的是学习者，
   而你的实际用法是让我把项目搞清楚。
3. **如果将来要上 embedding，密钥走哪条通道？** 现在技能工具拿不到 LLM 密钥（§2），
   要么给用户再加一个配置项（像 `media` 那样），要么只走本地模型。这个决定可以拖到 P2 之后。
