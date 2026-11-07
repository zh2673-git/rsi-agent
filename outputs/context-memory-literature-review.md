# LLM Agent 上下文管理 / 记忆压缩 / 会话持久化与可审计性 —— 文献调研（判新颖性用）

检索窗口：2024 – 2026 初（并补入 2026 年中被检索到的、对新颖性判断具决定性影响的条目，已单独标注）。
检索方式：arXiv abs/HTML 页、ICLR/ICML/NeurIPS 会议页、官方文档（pi.dev、letta、getzep）、DuckDuckGo HTML 端点。**未能访问**：Semantic Scholar API（429）、arXiv 站内搜索（403 限流）、OpenReview（CAPTCHA）；因此"未找到"一律按"本次检索未命中"理解，不等于绝对不存在。

## 一、对照表

| 工作名 | 年份/出处 | 压缩是否有损 | 是否保留原文 | 是否可重放/审计 | 关键机制一句话 |
|---|---|---|---|---|---|
| **ACE: Agentic Context Engineering** | 2025-10 首版 / ICLR 2026（v3 2026-03）；Stanford + SambaNova；[arXiv:2510.04618](https://arxiv.org/abs/2510.04618) | **有损**（lessons 被 curate 成 compact delta bullets；embedding 去重剪冗余） | **否**（playbook 只存提炼后的条目，原始 trajectory 不入 playbook） | 否（无 session log、无 replay、无审计） | context 当"进化中的 playbook"：Generator→Reflector→Curator，Curator 用**确定性非 LLM 逻辑**把 delta 增量合并进 playbook，避免整篇重写 |
| **pi**（earendil-works/pi，前 pi-labs） | 无正式论文/技术报告，**仅官方文档 + 开源代码**：[how-pi-works](https://pi.dev/docs/latest/how-pi-works)、[session-format](https://pi.dev/docs/latest/session-format)、[compaction](https://pi.dev/docs/latest/compaction)；[GitHub](https://github.com/earendil-works/pi) | **模型可见上下文有损**（summary 替换旧消息）；**存储层无损** | **是**——"Compaction…does not delete the original session entries"；原文 entry 永留 session 树 | **是**——JSONL 树（`id`/`parentId`，v2 起）；typed entries（`message`/`model_change`/`thinking_level_change`/`usage`/`compaction`/`branch_summary`）；`/tree` `/fork` `/clone`；context 每次从 active branch **重建** | compaction entry = `summary` + `firstKeptEntryId` + `tokensBefore` + `systemMessage` checkpoint；active branch 决定模型可见历史，其余分支留在同一文件 |
| MemGPT / Letta | 2023-10 / v2 2024-02；[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)；[Letta memory 文档](https://www.letta.com/blog/agent-memory/) | 工作上下文**有损**（eviction + summarization） | **部分**：recall memory 落盘保存**完整**对话历史（"saves raw conversation history"） | 否（无 typed event log、无 replay/fork；持久化 = message 表 + 可编辑 memory blocks） | OS 式分层：core（in-context、可自编辑）/ recall（全量历史可检索）/ archival（外部知识），靠 interrupt 在层间搬数据 |
| **Mem0** | 2025-04；[arXiv:2504.19413](https://arxiv.org/abs/2504.19413) | **有损**（LLM 抽取/整合成事实+实体，图变体 Mem0^g） | 未核实（论文层面 retrieval substrate 是抽取结果，非原始对话） | 否 | 抽取-整合-检索三件套，追求 token/延迟省（p95 −91%、token −90%），用压缩换成本 |
| **A-MEM** | 2025-02 / NeurIPS 2025；[arXiv:2502.12110](https://arxiv.org/abs/2502.12110) | **有损，且会就地改写既有记忆** | 否（Zettelkasten 笔记 + 属性/关键词/标签） | 否 | 新记忆入网时触发 **memory evolution**：更新已有笔记的上下文表征 —— 历史被原地变更而非追加 |
| **Zep / Graphiti** | 2025-01；[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)；[Zep: How graph creation works](https://help.getzep.com/how-graph-creation-works) | 图侧**有损**（实体/关系抽取 + 摘要） | **是**：写入即存为 episode，"raw source material remains searchable and retrievable" | **部分**：temporal invalidation（边失效而非删除）、双时间轴，可追溯"何时认为什么为真"；**无** context replay | 双时态知识图谱：episode（原文）+ 抽取图 + 时间失效标记，非破坏性更新 |
| **MemoryOS** | 2025-05；[arXiv:2506.06326](https://arxiv.org/abs/2506.06326) | **有损**（FIFO + 分段页组织） | 否（短/中/长三层，跨层更新即压缩） | 否 | 照搬 OS 内存管理：short→mid 用对话链 FIFO，mid→long 用 segmented page |
| **HippoRAG** | 2024-05 / NeurIPS 2024；[arXiv:2405.14831](https://arxiv.org/abs/2405.14831) | **有损**（KG 抽取 + Personalized PageRank 检索） | 否 | 否 | 海马索引理论：LLM + KG + PPR 做单步多跳检索 |
| **E-mem** | 2026-01 / **ICML 2026**；[arXiv:2601.21714](https://arxiv.org/abs/2601.21714)；[ICML poster](https://icml.cc/virtual/2026/poster/65274) | **明确反有损压缩**（"without relying on lossy compression"） | **是**——assistant agents 各自持有 **uncompressed memory contexts** | 否（无 event log；"reconstruction" 是语义级重取，非日志级重建） | 把 Memory Preprocessing 换成 **Episodic Context Reconstruction**：需要时在被激活的片段里就地推理再汇总 |
| **Hindsight** | 2025-12；[arXiv:2512.12818](https://arxiv.org/abs/2512.12818) | 有损（抽取成四类网络，但保留 observation/inference 区分） | 部分（world facts 与 agent experiences 分离存放） | **部分**：retain/recall/reflect 三操作 + "update information in a **traceable** way"，支持 agent 解释推理 | 记忆当 first-class substrate：世界事实/经验/实体摘要/信念四网分离，避免 evidence 与 inference 混淆 |
| **ACON** | 2025-10 / ICML 2026；[arXiv:2510.00615](https://arxiv.org/abs/2510.00615) | **有损**（压 observations + history） | 否 | 否 | 用 agent 失败分析迭代精炼"压缩 guidelines"（自然语言空间优化），再蒸馏成小压缩器 |
| **Parallel Context Compaction** | 2026-05；[arXiv:2605.23296](https://arxiv.org/abs/2605.23296) | **有损**（明说 "summarization is inherently lossy"） | 未涉及 | 否 | 并行分块压缩以消除阻塞、给运营者对摘要体量的细粒度控制；顺带指出**保留内容 run-to-run 波动大、不可预测** |
| **The Log is the Agent (ActiveGraph)** ⚠️2026-05 | 2026-05；[arXiv:2605.21997](https://arxiv.org/abs/2605.21997)；[代码 Apache-2.0](https://github.com/yoheinakajima/activegraph) | 压缩层**未提供**（作者自述无 compaction/checkpointing） | **是**（append-only event log 为唯一真相源） | **是**——确定性 replay（content-addressed 模型/工具响应缓存，replay 零新调用）、任意事件处 cheap fork、structural diff、端到端 lineage | **把 agent 反过来建在日志上**：working graph 是 log 的确定性投影，memory 是派生视图（"provenance is total and replay is exact"） |
| **Replay Is a Family of Assertions** ⚠️2026-08 | 2026-08；[arXiv:2611.06924](https://arxiv.org/abs/2611.06924) | — | — | **是（验收层面）**：把 replay/fork 拆成 property-indexed 断言族，5,540 条公开 runtime log、317,296 个 projection cut 上实测 | 指出"确定性 replay / 廉价 fork / lineage"是**一族可分别证伪的断言**，需逐条给证据与环境前提；报告 36,251 个 cut 切断模型请求而不许可续跑 |
| **Context Compression for LLM Agents（综述）** ⚠️2026-05 | 2026-05 preprint；[preprints.org](https://www.preprints.org/manuscript/202605.2065) | 综述立场：压缩=**充分状态近似**，必有损 | 提出 S/C/M/R 四段流水线（含 **Recover**） | 提出失败分类 **F1 压缩前决策错 / F2 压缩中信息丢失 / F3 压缩后访问失败** | 把 agentic 压缩单列：异构组成、多步依赖、误差沿轨迹不可逆传播 |
| **A Survey of Context Engineering** | 2025-07；[arXiv:2507.13334](https://arxiv.org/abs/2507.13334) | — | — | — | 1,400+ 篇的统一分类（retrieval/generation、processing/management，再组合成 RAG/记忆/多 agent）；是当前引用基准，但**未把"可审计/可重放"作为独立维度** |
| LangGraph checkpointer（工业对照） | 文档；[Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) | — | 是（每 super-step 存全量 state 快照） | **是**——thread_id + checkpoint_id、time travel、replay、branch | 快照式（state snapshot）而非 typed event log；与"日志 fold"哲学不同 |

⚠️ = 超出用户指定窗口（2026 年中/下半年），但因直接命中第 4/5/6 项主张的新颖性，必须计入。

## 二、逐项查证结论

1. **ACE 的 context collapse / brevity bias**（原文措辞，已核）
 - `brevity bias`："drops domain insights for concise summaries"——迭代改写时偏好简短，把领域洞见当冗余丢掉。
 - `context collapse`："iterative **rewriting** erodes details over time"——每轮整篇重写导致细节逐轮流失。
 - 它给的示例性证据（Dynamic Cheatsheet 在 AppWorld）：第 60 步 18,282 tokens → 第 61 步 **122 tokens**，准确率 66.7 → 57.1（低于无上下文的 63.7）。
 - 更新方式：**是**增量 delta + playbook。三个角色 Generator / Reflector / Curator；Curator 产出 **compact delta entries**，用**轻量确定性、非 LLM 逻辑**合并进 playbook；每个 bullet 带 id、helpful/harmful 计数；新 bullet 追加，相关旧 bullet 可更新；**embedding 语义去重**用于主动剪枝或超窗时剪枝。
 - **是否仍有损：是。** 它避免的是"整篇重写式坍塌"，不是"信息无损"：lessons 本身是提炼物，去重会删冗余条目，且 playbook 里根本没有原始 trajectory。它没有 event log、没有原文保留、没有 replay/审计。→ 用 ACE 框住你的主张时，**"ACE 仍是不可重放的提炼层"是安全的说法**；但"增量更新/防坍塌"这个点已被它占满。

2. **pi 是否有正式论文/技术报告：未找到。** 只有 pi.dev 官方文档 + Apache 仓库源码（session-manager.ts / compaction.ts）。但其设计细节**逐项与你的描述吻合**（均出自文档原文）：
 - 持久化 = JSONL，每行一个带 `type` 的对象；entry 通过 `id`/`parentId` 构成**树**（v2 起；v1 线性已自动迁移；v3 把 `hookMessage` 改名 `custom`）。
 - **模型可见上下文 = active branch**（"The model receives the active branch, not every branch"）；"Model context is **reconstructed** from the active branch"。
 - compaction 只**插入**一条 entry：`{"type":"compaction", summary, firstKeptEntryId, tokensBefore, systemMessage}`；"Compaction adds a summary and keeps recent messages. **It does not delete the original session entries.**"
 - 分支：`/tree`（同文件内移动）、`/fork`（从早前 user message 起新 session 文件）、`/clone`（复制 active branch）；离开分支时可把该分支**摘要**挂到进入的分支（branch_summary entry）。
 - 触发：`contextTokens > contextWindow − reserveTokens`（默认 reserve 16384）；保留 `keepRecentTokens`（默认 20k）；另有 provider overflow 时的 compact-and-retry 兜底。
 → **结论：pi 事实上实现了"日志无损 + 视图有损 + 可重建 + 可分支"的整套工程形态，但没有任何学术写作、也没有任何量化验收。** 这既是你的最大风险（工程上不新），也是你的最大空间（学术上无人占位、无人评测）。

3. **记忆系统的压缩行为与"原文永不删除 + append-only 事件日志"**
 - 有损 vs 保留原文：Mem0 / A-MEM / MemoryOS / HippoRAG = 有损且不把原文当 substrate；A-MEM 更进一步**原地改写**历史记忆（memory evolution），是"日志"的反面。
 - 接近"保留原文"的只有三家：**Letta recall memory**（完整对话历史落盘）、**Zep/Graphiti episode**（原文可检索 + 时间失效而非删除）、**E-mem**（uncompressed contexts）。
 - **但没有任何一家做"append-only 的 typed 事件日志"。** 它们都是"记录 + 派生存储"，不是"日志即真相源、状态为日志的 fold"。真正的 append-only event log + 投影，只在 ActiveGraph（第 4 项）和 pi 的工程实现里出现。

4. **"模型可见上下文与系统真相源解耦"这一原则：学术上没有以此命名的原则，但相邻主张已被占。**
 - 最接近 = **ActiveGraph**：`append-only event log = source of truth`，`working graph = deterministic projection`，memory view 是派生状态，"provenance is total and replay is exact"。
 - 次近 = **MemGPT 的 virtual context management**（"提供大内存的**外观**"——这是"视图≠真相"的原始表述，但没做审计/重放）、**Zep**（raw episode vs 抽取图）、**Hindsight**（evidence vs inference 分离）。
 - 关键词 `model-visible means logged` / `view vs log separation` / `context virtualization`（作为"解耦原则"义）：**本次检索未命中**任何论文使用这一提法。`context virtualization` 的既有用法是 MemGPT 式"虚拟出更大上下文"，以及若干博客/OS 类比文（[onemancrew](https://www.onemancrew.dev/blog/virtual-memory-for-llms-paging-swapping-context-management)），**与你说的"视图与日志分离"不是同一概念**。
 → 术语层面仍是空白；**但概念层面 ActiveGraph 已经把最核心那句说出来了**，把它当"全新原则"提会很危险，应改为"未命名的原则 + 未做的验收"。

5. **"从事件日志无损重建压缩前上下文"的验收/评测：未找到。这是最干净的一个空白。**
 - E-mem 有 "reconstruction"，但是**语义级**（把片段重新喂给 assistant agent 就地推理再汇总），不是从日志无损重建 **pre-compaction 的模型可见字节**。
 - ActiveGraph 有确定性 strict replay（逐事件比对、分歧即报错），但那是**整条 run 的重放**，不是"压缩前上下文的重建保真度"；且作者明说**没有 compaction/checkpointing**，"a million-event run is replayed in full today"。
 - Parallel compaction 只量化了摘要**有损 + run-to-run 不可预测**，没有做重建验收。
 - 压缩综述提了 **F2 压缩中信息丢失 / F3 压缩后访问失败** 与流水线里的 **Recover** 算子，但**没有给出"从日志重建原始上下文的验收协议或指标**。
 - `lossless compaction` / `context reconstruction`（+compaction）/ `conversation replay fidelity` 作为**指标名**：检索未命中。
 → 若要立新颖性，**"把 reconstruct-from-log 做成可执行的验收/评测（含指标与失败判据）"是目前最稳的占位**。

6. **typed event log 用于 agent 会话审计与分支/时间旅行：概念已被做过多次，但学术化程度低。**
 - ActiveGraph：log 即 agent、fork 到任意事件、structural diff、frame（run 内轻量分支）、lineage 到单次模型调用；作者把"为什么这个事实在工作集里"直接列为对日志的一次查询——**与你的主张第 4、6 项几乎逐字对应**。
 - Replay Is a Family of Assertions：把这类保证做成**可证伪的断言族 + 大规模实测**（5,540 logs），是"审计可验证性"方向上目前最硬的一篇。
 - pi：typed entries（含 compaction / branch_summary / model_change / usage）+ 树 + fork/clone，工程完备但无学术写作。
 - LangGraph：checkpointer 的 time travel / branch 是工业标准做法，但是**state 快照**而非 typed event log。
 - 传统 event sourcing / CQRS 本来就是这套方法论——ActiveGraph 也自认"贡献不在这些机制，而在把机制用于含非确定性模型调用的 agent"。

## 三、哪些已被占 / 哪些仍是空白

1. **已被占（正面撞车，别当新贡献）**：见下节"二"对应的具体机制。
 - "增量 delta 更新优于整篇重写、可防 context collapse"→ ACE 已占（ICLR 2026）。
 - "session 存成 append-only 树、compaction 只插摘要 entry、原文永不删、模型只见 active branch"→ pi 已实现（工程），ActiveGraph 已理论化（2026-05）。
 - "日志为真相源 / 状态为日志的确定性投影 / memory 是派生视图"→ ActiveGraph 已明确主张。
 - "typed event log 支持 fork / time-travel / lineage"→ ActiveGraph + pi + LangGraph 已覆盖。
 - "别压缩、保留原始上下文、需要时重建"→ E-mem（ICML 2026）已占。
 - "保留原文 episode + 非破坏性时间失效"→ Zep/Graphiti 已占。
 "replay / fork 是断言族而非单一保证"→ 2611.06924 已占，且带大规模实测。

2. **仍是空白（可立）**：把"无损可重建"从**架构声明**推到**可执行验收**这件事，目前无人做。
 - **没有任何工作给出"从事件日志重建 compaction 之前模型可见上下文"的验收协议、指标或失败判据。** 这是六项里唯一干净的空白，且恰好是"可审计性"最有说服力的落点。
 - **"model-visible means logged" 作为一个被命名的系统不变式（invariant）+ 可机检**：无人命名、无人机检。ActiveGraph 说了"provenance is total"，但没把它写成可被 runtime 强制/断言检查的不变式。
 - **跨长生命周期的 log vs compaction 共存**：ActiveGraph 自认**没有** compaction/checkpointing（百万事件全量重放），pi 有 compaction 但没有 replay 保证与评测——**"压缩后仍可严格重放"这个交叉点空着**。
 - **typed event log 的学术化**：现有实证只在 arXiv 单作者系统论文/工业文档层面，**缺同侪评审与公开 benchmark**；把"typed compaction/rollback 事件"放进受控评测的会话审计数据集，也是空白。
 - **"重放不等于重建"这层区分无人展开**：2611.06924 指出 cut 会切断模型请求、36,251/317,296 个 cut 不许可续跑——这恰恰说明"能重放"≠"能重建出当时模型可见的上下文"，但没人把它做成 compaction 的验收维度。

## 四、给主张表述的三条修正建议

1. 不要主张 **"日志与视图解耦"是新的**——ActiveGraph（2026-05）已明确、pi 已工程化、MemGPT 的 virtual context 已有雏形。改为：**"该原则在现有系统中未被命名为可机检的 runtime 不变式"**。
2. 不要主张 **"append-only 树 + 摘要 entry + 原文保留"是新的**——pi 逐字实现了（仅缺论文）。改为：**"该形态被工程实践先占，但从未被形式化、也从未被验收"**。
3. 把新颖性押在**验收层**：`reconstruct(compaction 前模型可见上下文) from event log` 的**协议 + 指标 + 失败判据 + 公开 benchmark**，并明确与 ActiveGraph（无 compaction）、E-mem（语义级重构建）、Parallel compaction（只证有损）三者的边界。这一条同时吃下第 5 项空白与第 6 项的"压缩×重放"交叉点。

## 五、未能核实 / 需人工复核

- **Mem0 是否保留原始 message**：论文正文以抽取结果作为检索 substrate，但产品侧是否有独立 message store 未核实——表格标注"未核实"。用前请查 Mem0 文档或源码。
- **Letta recall memory 的"完整"程度**：来自 Letta 官方博客措辞（"preserves the complete history…saves raw conversation history"），未逐行核对数据库 schema。
- **pi 是否有官方/社区技术报告或 design doc（非 docs/）**：本次检索未找到；GitHub 上的 ADR/design 文档未逐目录核查。
- **`model-visible means logged` 等提法是否存在于非 arXiv 的工程博客/规范**（如模型厂商的 agent runtime 规范）：本次仅覆盖 arXiv/OpenReview/会议页/主流文档/DuckDuckGo，未系统覆盖各厂工程博客。
- **OpenReview 上的 ICLR 2026 / ICML 2026 全部投稿**未能检索（CAPTCHA + 限流），因此"未被占"的判断仅基于可达来源。
