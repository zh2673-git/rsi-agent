# 教学型 AI Agent：可直接复用的开源构件与算法对照清单

> 核验方式：star / license / 语言 / 最近推送时间于 2026-11-11 取自 GitHub API；论文取自 arXiv API。**「未核实」= 我没查到可靠来源，别当结论用**。星数写量级以减少时效误差。URL 一律 `github.com/<全名>`，论文给 arXiv 号。

## 0. 先看结论

**可直接当底座（生产可用）**：gpt-researcher、LlamaIndex / Haystack、Qdrant / LanceDB / Milvus、fsrs-rs / py-fsrs、Math-Verify、manim、OATutor、docling / Marker / MinerU。
**只能抄架构，不能当依赖**：open_deep_research（已归档）、STORM（停更）、nickscamara / dzhng 的 deep-research（demo）、nano-graphrag、EduKTM。
**没有成熟件、必须自建**：自动出题、知识点图谱构建、苏格拉底式对话控制器。

---

## 一、深度研究 / 多步检索综述

| 项目 | star | 语言 | 许可 | 推送 | 成熟度 |
|---|---|---|---|---|---|
| assafelovic/gpt-researcher | 30k | Py | Apache-2.0 | 2026-11 | **生产可用** |
| stanford-oval/storm | 31k | Py | MIT | 2025-09 | 研究原型，维护放缓 |
| AkariAsai/OpenScholar | 1.7k | Py | Apache-2.0 | 2025-08 | 论文配套，**已停滞** |
| langchain-ai/open_deep_research | 12k | Py | MIT | 2026-08 | **已归档 ARCHIVED** |
| nickscamara/open-deep-research | 6.2k | TS | 仓库 NOASSERTION | 2025-05 | demo，停滞 |
| dzhng/deep-research | 19k | TS | MIT | 2026-04 | 极简参考实现 |
| Future-House/paper-qa | 9.5k | Py | Apache-2.0 | 2026-11 | **生产可用** |

- **gpt-researcher**：planner→并行检索→写报告，插拔 LLM / 检索器，支持本地文档。引用能追到 URL/页，但**没有「引用必须支撑该句」的硬校验**，防幻觉靠提示词——不要把它的引用当事实核验结果。成本按内部调用次数算，单份报告常在十几次到上百次调用（金额未核实）。
- **STORM**：Wikipedia 风格长文，perspective-guided 提问 + 模拟对话，引用质量是这批里最好的；但它是「写百科」不是「回答教学问题」，不做数值核算。
- **open_deep_research 已归档**：supervisor + researcher + compress 三段图是全行业最清晰的模板，**抄它的图，别 pin 它**。
- **paper-qa**：唯一把「每句必须带引用、检索不到就拒答」做成工程约束的；科学问答首选，通用网页研究不合适。
- **学术侧**：LitSearch（princeton-nlp，114★，MIT，EMNLP 2024，arXiv 2407.18940）是**检索评测集**不是系统，可当论文搜索的 eval；OpenScholar（arXiv 2411.14199）需自建 4500 万级论文索引（论文自述），工程代价高。
- 评估落点：引用可追溯 = paper-qa > STORM > gpt-researcher；防幻觉 = 只有 paper-qa 有硬约束；成本 = dzhng < gpt-researcher < deep 模式；离线 = gpt-researcher 可配本地检索，其余依赖在线搜索 API。

## 二、RAG 与知识库

**框架**（均活跃）：run-llama/llama_index 52k MIT｜langchain-ai/langchain 149k MIT｜deepset-ai/haystack 27k Apache-2.0。选型：文档处理平台用 LlamaIndex；可控 pipeline + 可评测用 Haystack；LangChain 抽象层最厚，教学系统里容易失控。

**图 RAG**：microsoft/graphrag 36k MIT（全局问答强，索引贵）；HKUDS/LightRAG 40k MIT（EMNLP 2025，**增量更新友好，当前图 RAG 首选**）；gusye1234/nano-graphrag 4k MIT（2026-01 后停更，代码可读，适合改）。

**向量库**：facebookresearch/faiss 41k MIT（是库不是服务，无元数据、无增量一致性，需自己包）；qdrant/qdrant 35k Apache-2.0（**推荐**：本地模式 + 过滤 + 增量都成熟）；milvus-io/milvus 46k Apache-2.0（重，集群才值得）；chroma-core/chroma 29k Apache-2.0（已换 Rust 内核，单机原型最快）；lancedb/lancedb 11k Apache-2.0（嵌入式，适合单机分发）。

**pageindex（VectifyAI/PageIndex，40k★，Py，MIT，活跃；pip `pageindex` 0.5.3）——真实可用但有边界**：树索引 + LLM 在树上推理检索，无向量无切块。官方 README 明确**本地开源版只处理文本型 PDF**，扫描件/图表/OCR 走 Cloud（需 API key）。建索引约 $0.001/页（官方自测），但**查询要多次 LLM 调用**——便宜的是索引不是问答。FinanceBench 98.7% 是自家 benchmark 自报，别当独立结论。适用：教材、年报这类长结构化文档，要「指到哪一节」的可解释引用；不适用：海量短文档、延迟敏感、扫描件。

**文档解析才是 kb 的真瓶颈**：opendatalab/MinerU 83k（公式/表格/版面最强，**license 字段 NOASSERTION，实际为强 copyleft，商业集成前必须自查条款**）；datalab-to/marker 40k Apache-2.0（快、质量好）；docling-project/docling 70k MIT（**许可最干净，PDF+Office 通吃，推荐默认**）；microsoft/markitdown 194k MIT（只转 MD，公式表格会丢）。

**评测**：explodinggradients/ragas 16k Apache-2.0（仓库已迁 vibrantlabsai/ragas）；truera/trulens 3.6k MIT；beir-cellar/beir 2.3k Apache-2.0（检索 benchmark，2025-10 后停更）。RAGAS 的 faithfulness / context-recall 用 LLM 当裁判，**是参考指标不是验收指标**，同模型自评偏乐观。

## 三、知识追踪 / 学生模型

| 项目 | star | 语言 | 许可 | 推送 | 判断 |
|---|---|---|---|---|---|
| CAHLR/pyBKT | 292 | C++/Py | MIT | 2026-11 | **生产可用，可解释** |
| pykt-team/pykt-toolkit | 460 | Py | MIT | 2026-10 | **公平比较首选** |
| bigdata-ustc/EduKTM | 267 | Py | Apache-2.0 | 2024-01 | 停滞，当 baseline |

- **pyBKT**：每知识点 4 参数（先验 / 学习率 / guess / slip），支持个体先验、题目难度（KT-IDEM）等变体。**可解释性是最大优势**——P(mastery) 是概率不是黑盒分。工程坑：Windows 上 pip 会退回纯 Python 实现，拟合慢 60–100 倍（README 实测表：5000 学生 fit 1.5s → 1h30m），要么用 Linux 预编译轮子，要么离线批量拟合。
- **冷启动**：BKT 结构上小样本也能 fit，但每知识点至少数十次作答 guess/slip 才稳定。实践做法是**先验参数（population prior）→ 随数据积累再个性化**，不要一上来 per-student 拟合。EduKTM / pykt 的深度模型需万级序列，冷启动更差且不可解释。
- **pykt vs EduKTM**：前者统一了数据划分与指标（AUC/ACC），能做公平比较且还活着；后者是模型动物园，跑 DKT/AKT/SAKT baseline 快但代码旧。**先用 pyBKT 上线可解释版本，pykt 只用来验证「深度模型是否真赢」——在多数教育数据集上赢不了多少（具体差距未核实）。**
- **知识点图谱构建：没有成熟通用开源件**。现实路线 = LLM 抽三元组 + 人工审核 + 与教材目录对齐，别指望现成库。

## 四、间隔重复 / 记忆调度

| 项目 | star | 语言 | 许可 | 推送 |
|---|---|---|---|---|
| open-spaced-repetition/fsrs-rs | 460 | Rust | BSD-3-Clause | 2026-11 |
| open-spaced-repetition/py-fsrs | 530 | Py | MIT | 2026-08 |
| open-spaced-repetition/free-spaced-repetition-scheduler | 735 | TS | MIT | 2026-04 |
| open-spaced-repetition/fsrs4anki | 4.1k | Notebook | MIT | 2026-08 |
| ankitects/anki | 32k | Rust | 仓库字段 NOASSERTION，按 **AGPL-3.0** 对待 | 2026-11 |

- **FSRS 是这块唯一正解**：DSR 三变量模型，FSRS-6 用 21 个参数；默认参数由约 1 万用户、数亿条复习记录拟合（awesome-fsrs wiki 自述）。官方称同保持率下比 SM-2 少 20–30% 复习量，且更擅长处理「断更后回归」（模拟结果）。
- **参数拟合需要多少记录**：官方手册只说「需要大量复习数据」「每隔几个月优化一次」，**没给硬阈值——具体门槛未核实**。工程建议：< 数百条用默认参数；数千条起才做 per-user 拟合，且必须用 hold-out 对数损失对照，拟合后 loss 没降就别用。
- **接入方式**：要 Anki 生态就导出 `.apkg`（新版 Anki 已内置 FSRS）；要自己控调度就直接用 fsrs-rs / py-fsrs 那张 review_log 表（rating + 间隔 + 耗时）。**别自己实现 SM-2**——它无保持率目标、对延迟复习处理是错的。
- 唯一的坑：FSRS 依赖诚实打分。教学系统里「做错」映射 Again、「做对但慢」映射 Hard，**必须强制区分「不会」和「会但慢」**，否则参数跑偏。

## 五、数学可视化与动画

| 方案 | star | 许可 | 判断 |
|---|---|---|---|
| 3b1b/manim | 96k | MIT | **生产可用**，离线渲染 |
| ManimCommunity/manim | 42k | MIT | **生产可用**，社区维护、文档更好，优先 |
| jsxgraph/jsxgraph | 1.5k | **LGPL-3.0** | 生产可用，交互几何 |
| unconed/mathbox | 1.5k | MIT | 2023-05 停更，**停滞** |
| geogebra/geogebra | 2.4k | **专有**：非商业免费，商用须签约（geogebra.org/license） | 谨慎 |
| Desmos API | 闭源商业 API（desmos.com/api） | 有公开 demo key，生产需自购 | 体验最好 |
| matplotlib/matplotlib｜plotly/plotly.py | 23k｜19k | PSF-style｜MIT | 生产可用 |

- **manim**：渲染依赖重（Python + LaTeX + ffmpeg + cairo/pango），单场景秒级、成片分钟级。**生成成功率没有权威公开数字（未核实）**；实践规律是「简单几何/函数变换 1–2 轮修好，复杂排版或 3D 基本修不动」——所以必须做成「渲染失败 → 带报错重试 N 次 → 降级为静态图」的流水线。**没有 LaTeX 就别做 manim 数学动画。**
- **浏览器侧是教学交互的正解**：JSXGraph（LGPL，前端链接义务要看清楚）、Desmos（体验最好但需商业授权）、GeoGebra（**非商业许可，商用必须签约——最容易踩的一条**）。mathbox 不要选，作者 fork 后无人维护。
- **图表**：matplotlib / plotly 由 LLM 生成 + 沙箱执行 + 看图自检，可执行即验证，成功率高；manim 是「不可靠的可视化」。**默认出静态图，只有明确要「动画讲解」才走 manim。**

## 六、题目生成与自动评分

- **自动出题：没有成熟开源项目**（GitHub 搜索无 >100★ 的通用教育出题库）。学术侧有 MathGen（back-translation 增强）、各类 distractor 生成研究，都只是论文代码。**唯一工程解 = LLM 生成 + 程序化校验器**：数值题用 SymPy 反算，选择题要求「每个干扰项对应一条真实错误路径」，证明题走 Lean。必须配人工抽检。
- **自动评分**：huggingface/Math-Verify 1.2k★ Apache-2.0（活跃至 2026-01）——**生产可用**。三步：答案抽取 → LaTeX 转 SymPy 统一表示 → 等价判定；支持集合/区间/矩阵/百分比/单位；README 自报在 MATH 上优于 lm-eval-harness 与 Qwen 评测器。sympy/sympy 15k★ BSD 是等价判定底座。**注意它判的是「最终答案等价」，判不了过程对错**；步骤级批改要另配（步骤级标签可参考已归档的 openai/prm800k 2.1k★ MIT）。
- **Lean4 / mathlib4**（leanprover/lean4 10k、leanprover-community/mathlib4 4.5k，均 Apache-2.0）：能做**绝对可靠判题**，但要求题目已形式化——把自然语言题翻成 Lean 的成本远高于人工批改。只适合少量高价值题（竞赛、证明）或做「答案可信度」最后一道闸，**不要当通用判题器**。
- **作文评分（ASAP）**：数据集需注册获取，开源实现零散无维护，**没有可直接用的生产库**（哪个实现最好未核实）。
- 落点：题目质量靠校验器 + 人工抽检，不靠模型自评；答案唯一性数值题可保证、开放题不能；判题准确率数值/符号题足够，过程与开放题不达标。

## 七、教学对话框架

| 项目 | star | 许可 | 判断 |
|---|---|---|---|
| CAHLR/OATutor | 279 | MIT（内容库 CC BY 4.0） | **生产可用，重点推荐** |
| CMUCTAT/CTAT | 125 | NOASSERTION（CMU 条款，需自查） | 作者工具，实验/重 |
| ASSISTments | 平台不开源 | 只有数据集 | 仅研究数据 |

- **OATutor**（CHI'23，DOI 10.1145/3544548.3581574）：开源自适应教材 + ITS。三件核心：**BKT 掌握度估计**（`BKT-brain.js`）、**脚手架/提示分级**（hint / scaffold 多级可展开）、**自适应选题**（默认启发式 = 选平均掌握度最低的题）。内容覆盖 OpenStax 初等代数→微积分 I + 统计，JSON 格式，带 hint/scaffold 作者标注；可纯静态部署（GitHub Pages），Firebase 可选日志，Section 508 合规。**这是「掌握学习 + 提示分级 + 选题」最省事的参考实现**：抄它的 JSON 内容模型和 BKT 更新函数，比读论文快十倍。局限：只有英文数学内容、无 LLM 接入、前端技术栈老。
- **CTAT**：CMU 的 Cognitive Tutor Authoring Tools，是**作者工具**不是运行时，Java 重、面向研究者，不建议接。
- **苏格拉底式对话：没有成熟开源框架**。有的只是数据与训练代码（eth-nlped/mathdial，100★）。控制器逻辑（何时提问而不给答案、何时给提示、何时放手）必须自己写——这也是差异化最大的地方。
- LLM 提示生成的唯一同行评议证据：OATutor 团队的 PLOS ONE 论文（DOI 10.1371/journal.pone.0304013）报告了 LLM 生成 hint 的学习增益与课堂部署结果，可作为「LLM 生成 + 人工审核」路线的设计依据。

## 八、评测基准

| 基准 | 用途 | 出处 |
|---|---|---|
| MathVista（368★，CC-BY-SA-4.0） | 视觉数学推理 | arXiv 2310.02255 / lupantech/MathVista |
| MathTutorBench | **开放式教学能力**评测 | arXiv 2502.18940（2025-02） |
| TutorBench | 辅导能力评测 | arXiv 2510.02663（2025-10） |
| MathDial | 教师-学生对话数据 | arXiv 2305.14536 / eth-nlped/mathdial，HF 可下 |
| Eedi | 误解诊断 / 干扰项 | Kaggle「Mining Misconceptions in Mathematics」(2024)；HF `Eedi/Question-Anchored-Tutoring-Dialogues-2k`、`Eedi-Misconceptions-Graph` |
| LitSearch | 论文检索评测 | arXiv 2407.18940 |

- **纠正一个常见误解**：MMLU **没有「教育子集」**，只有学科子集（elementary_mathematics、high_school_* 等）；拿它证明教学能力是错配。
- **教学对话质量目前没有公认 rubric**：MathTutorBench / TutorBench 是 2025 年才出现的两个尝试，覆盖「是否只给答案、是否贴合学生错误、脚手架是否递进」，但规模小且大量用 LLM 评分——**当内部回归测试用，不要当对外的能力证明**。
- **「Bridge 数据集」：未核实**（arXiv 与 HF 均未检索到对应教学对话数据集，注意重名歧义）。
- 实用组合：能力回归 MathTutorBench + TutorBench；RAG 用 LitSearch + 自建 100 题金标；误解诊断用 Eedi；判题正确率用 Math-Verify 在 MATH-500 上跑基线。

---

## 九、最小施工组合

1. **kb**：docling（许可干净）→ Qdrant 或 LanceDB → 长文档额外挂 PageIndex 做章节级可解释引用；公式表格多则换 MinerU，但先解决许可条款。
2. **deep_research**：抄 open_deep_research 的三段图，检索层接自己的 kb，生成层套 paper-qa 的「逐句引用 + 拒答」约束。别部署归档仓库。
3. **mastery_path**：pyBKT（population prior → 个性化）+ OATutor 的知识点/题目 JSON 结构 + 自适应选题启发式。
4. **记忆调度**：py-fsrs，只记 rating / 间隔 / 耗时三字段，不自研 SM-2。
5. **visualize**：matplotlib / plotly 出静态图（沙箱执行即验证），manim 只做精品动画（用 ManimCommunity）；浏览器交互用 JSXGraph，**避开 GeoGebra 商用许可**。
6. **deep_question / 判题**：LLM 生成 + SymPy / Math-Verify 校验 + 人工抽检；过程批改单独设计。
7. **教学对话**：自研控制器（提示分级 0–4 + 掌握阈值 + 退出条件），数据结构照 OATutor，策略参考 PLOS ONE 的 LLM-hint 结论。

**一句话**：RAG 基础设施、间隔重复、判题、渲染、知识追踪都有生产级开源件可直接用；**真正没有现成答案的是「题目生成」和「教学对话策略」——这两块恰是产品差异所在，必须自建且必须配人工审核。**
