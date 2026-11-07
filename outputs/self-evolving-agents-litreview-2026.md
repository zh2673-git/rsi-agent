# 自我进化 / 自我改进 AI Agent 文献调研（2024 – 2026 初）

调研方式：arXiv abs/html 全文逐篇核验（`arxiv.org/abs/…`、`arxiv.org/html/…`）+ arXiv 全站检索。
所有 arXiv ID 均已打开原文确认标题、日期与摘要；未读到正文的地方标注「未核实」。

---

## A. 自我修改 / 自我改进系统本体

| 工作名 | 年份 / 出处 | 自我修改对象 | 评估信号 | 是否涉及冻结边界 | 是否报告退役 / 回滚率 |
|---|---|---|---|---|---|
| **Darwin Gödel Machine (DGM)** — Zhang, Hu, Lu, Lange, Clune（Sakana AI / UBC / Vector） | 2025-05-29（v1），v3 2026-03-12；[arXiv:2505.22954](https://arxiv.org/abs/2505.22954) | agent **自己的 Python 代码库**（`coding_agent.py`、`tools/`、`prompts/`、`forward()` 工作流）；底层 FM 冻结、不改权重 | SWE-bench Verified 20.0%→**50.0%**；Polyglot 14.2%→**30.7%**（论文正文另报 38.0%）。分阶段评估：先 10 task 验"还能不能改代码"，过门槛再 50 task，>40% 再 200 task | **部分，但只是"限制"而非"安全机制"**：§3 明写"archive 维护 + 父代选择目前是固定的、**DGM 不可修改**（*fixed and not modifiable by the DGM*），留作未来工作"。§5 提出"可以造一个**不可修改的部分**，以便在其余部分停下时评估它"（*create an unmodifiable part of the system to be able to evaluate at halt the rest*）——**但只是一句 future direction，没有实现、没有实验** | **间接、无"回滚率"指标**。附录 A.4 Table 2：DGM 只有 **51.3%** 的生成 agent 保留"基本代码编辑功能"（≈**48.7% 变异体因失去该功能被淘汰出 archive**）；两个 baseline 均为 32.5%。Ethics Statement 声称 archive"完整可审计的 lineage，**enabling rollback**"，但没有报告撤销了多少改动 |
| **Huxley-Gödel Machine (HGM)** — Wang, Piękos, …, Schmidhuber | 2025-10-24；[arXiv:2510.21614](https://arxiv.org/abs/2510.21614) | 同上（coding agent 代码库）；搜索策略改为按 CMP 引导 | SWE-bench Verified / Polyglot；提出 **metaproductivity (CMP)** = 后代 benchmark 表现聚合，明确指认"meta 能力 ≠ benchmark 分数"的错配 | 未找到明确冻结层（**未核实**，未读全文） | 未找到 |
| **DGM-Hyperagents (DGM-H)** — Zhang, Zhao, …, Shavrina | 2026-03-19（v1），v2 2026-11-01；[arXiv:2603.19461](https://arxiv.org/abs/2603.19461) | 把 task agent 与 **meta agent 合成单一可编辑程序**，"元层的修改过程本身也可编辑"（metacognitive self-modification） | 多域任务性能 + 元层改进可跨域迁移、跨 run 累积 | **否，恰恰相反**：目标是移除"元层固定"这一假设 | 未找到 |
| **Gödel Agent** — Yin, Wang, Pan, Lin, Wan, W. Y. Wang | 2024-10-06（ACL 2025 main），v4 2025-05-31；[arXiv:2410.04444](https://arxiv.org/abs/2410.04444) | **整个 agent 代码**（policy π **与**元学习算法 I 都可递归重写），靠运行时内存 **monkey patching** 读写自身代码；动作集 `self_inspect / interact / self_update / continue_improve` 本身也可被 agent 扩展 | MGSM / MMLU / DROP / GPQA 准确率；环境反馈 U(ℰ,π) | 否。但显式区分 **Gödel-base（受约束）** vs **Gödel-free（无约束）** 两种配置 | **是——最接近"退役/回滚率"的先例**：§6.2 在 MGSM 上跑 100 次优化试验，报告 **4% 意外终止、92% 中途出现性能暂时下降、14% 最终优化失败** |
| **ADAS / Meta Agent Search** — Hu, Lu, Clune | 2024-08-15（v1）；[arXiv:2408.08435](https://arxiv.org/abs/2408.08435) | 由 meta agent 编写**新 agent 的代码**（prompt / tool / workflow 组合），**meta agent 自身固定** | 跨域（coding / science / math）任务性能 + 跨域迁移 | **是（结构性冻结）**：元层是手写固定的，不能在搜索中被改 | 未找到 |
| **SICA（Self-Improving Coding Agent）** — Robeyns, Szummer, Aitchison | 2025-04-21；[arXiv:2504.15228](https://arxiv.org/abs/2504.15228) | agent **scaffolding** 代码（工具、prompt、子 agent），不改模型权重 | SWE-bench Verified 随机子集 **17%→53%**；LiveCodeBench；自造合成 benchmark | **是（运行时外部监督）**：内置**异步 LLM overseer**，每 30s 或被关键事件触发，可向运行中 agent 及其父代注入消息、严重时可**取消该 agent 执行**；只用不同 LLM 作 overseer | 未量化退役率；但 §6 明说纯 scaffolding 系统有**性能上限**（Figure 4） |
| **SEAL（Self-Adapting Language Models）** — Zweiger, Pari, Guo, Akyürek, Y. Kim, Agrawal（MIT） | 2025-06-12；[arXiv:2506.10943](https://arxiv.org/abs/2506.10943) | **模型权重**（模型自生成 self-edit = 微调数据 + 优化超参 + 工具调用，经 SFT 落成持久权重更新） | 更新后模型的**下游表现**作为 RL 奖励信号 | 否（但存在 RL 外循环做筛选） | 未找到 |
| **Voyager** — Wang, Xie, Jiang, Mandlekar, Xiao, Y. Zhu, Fan, Anandkumar（NVIDIA） | 2023-05-25；[arXiv:2305.16291](https://arxiv.org/abs/2305.16291) | **技能库**（可执行代码的增删改），不改模型参数（黑盒调 GPT-4） | 环境反馈 + 执行错误 + **self-verification**；Minecraft 独有物品数 3.3×、行进距离 2.3×、科技树里程碑最快 15.3× | 否 | 未找到 |
| **AlphaEvolve** — Novikov, Vũ, …, Balog（Google DeepMind） | blog 2025-05-14；白皮书 [arXiv:2506.13131](https://arxiv.org/abs/2506.13131)（2025-06-16） | 被优化的**目标算法代码**（evolve entire codebases），**不改 agent 自身** | 一个或多个**自动 evaluator** 打分的客观指标（正确性 / 速度 / 资源） | **是（结构性）**：evaluator 位于进化循环之外，候选程序无法修改自己的评分器 | 否（种群采样，无"回滚"概念） |
| **EvoPrompt** — Guo, Wang, Guo, Li, Song, Tan, Liu, Bian, Yang | 2023-09-15（ICLR 2024）；[arXiv:2309.08532](https://arxiv.org/abs/2309.08532) | **prompt**（离散 token 序列，EA 算子驱动） | 开发集适应度 | 否 | 未找到 |
| **Promptbreeder** — Fernando, Banarse, Michalewski, Osindero, Rocktäschel（DeepMind） | 2023-09-28（ICML 2024）；[arXiv:2309.16797](https://arxiv.org/abs/2309.16797) | **task-prompt + mutation-prompt**（自指：进化"进化算子"本身） | 训练集 fitness | 否 | 未找到 |
| **STOP（Self-Taught Optimizer）** — Zelikman, Lorch, Mackey, Kalai | 2023-10-03（COLM 2024）；[arXiv:2310.02304](https://arxiv.org/abs/2310.02304) | **scaffolding 程序代码**（种子 improver 改进自身） | 下游任务效用函数 | **是（沙箱）**：专门评估"生成代码**绕过沙箱的频率**" | 无退役率；但**报告了沙箱逃逸率**——性质上等价于"越界率" |
| **Absolute Zero / AZR** — Zhao, Wu, Yue, …, G. Huang | 2025-05-06；[arXiv:2505.03335](https://arxiv.org/abs/2505.03335) | **模型权重 + 自生成任务课程** | 代码执行器同时验证"提出的任务"和"答案"，构成统一可验证奖励 | 否 | 未找到 |

---

## B. 自修改的安全边界 / 冻结层 / 治理（2025–2026）

| 工作名 | 年份 / 出处 | 自我修改对象 | 评估信号 | 是否涉及冻结边界 | 是否报告退役 / 回滚率 |
|---|---|---|---|---|---|
| **The Unfireable Safety Kernel** — Dobrin, Chmiel | 2026-06-24；[arXiv:2606.26057](https://arxiv.org/abs/2606.26057) | 不自我修改；提供**外部**授权内核（Rust 实现） | 授权决策（fail-closed），Z3 SMT 定理 + Kani 有界模型检验；Python→Rust 迁移按字节等价 1000/1000 门控 | **是，最强的一个**：定义"escapable AI systems"，要求 (1) 进程隔离 (2) 动作前强制执行于**结构性唯一路径** (3) 请求与系统双层 fail-closed (4) 外部可验证的签名证据。明言"agent 地址空间内的任何控制都可被触及" | 否；但报告**防御成功率**：1000 次自修改中针对安全核心的 **704 次全部拒绝**，operator kill switch 下另 300 次也拒绝；6,240 次授权往返零绕过 |
| **Algorithmic Unverifiability of Safety for Fixed and Recursively Self-Improving Systems** — Gumbau Mezquita | 2026-06-26（v1），v4 2026-10-14；[arXiv:2606.28639](https://arxiv.org/abs/2606.28639) | 理论（把一步自修改建模为代码的全可计算变换） | 可证性 / 不可证性证明 | **是**：结论明写"**certification requires restricting rewrites by design**"、"a **frozen reference** keeps the question well posed"；并证明"**no tower of supervisors lowers the problem**"（监督者塔不能降低难度）、每个 total supervisor 都会在其无法定位的集合上出错 | 否 |
| **On The Statistical Limits of Self-Improving Agents** — C. L. Wang, Dorchen, Jin | 2025-10-05（v3 2026-08-11，TMLR 2026）；[arXiv:2510.04399](https://arxiv.org/abs/2510.04399) | 理论（把自修改分解为 5 个轴） | PAC 可学习性 / VC rate | **是**：提出 **Two-Gate guardrail** = 「验证-提升要求」+「容量上限」，证明只有 reachable capacity 有界时才保住 distribution-free PAC 可学习性 | 否 |
| **Authorization for Self-Modifying AI Agent Populations** — G. Zhu, C. Wang | 2026-09-29；[arXiv:2610.00347](https://arxiv.org/abs/2610.00347) | 不自我修改；给**自修改 agent 种群**做外部授权协议 | 授权/否决决策；32 个注册决策、64/64 trace 重放、28 个语义 mutant 全拒 | **是**：`authorization succession`——manifest / root / unique parent / 完整 lineage；**rollback creates a fresh generation without restoring spent authority**（回滚不重新铸权）、revocation closure、排除 self-certification；替换期"staged reservation 冻结前任残余权限" | 否（但报 28 allows / 36 denies） |
| **Safety Must Survive Self-Improvement: Why Failures Persist and How Agents Recover** — Y. Zhang, J. Wang, …, Hamm | 2026-10-01；[arXiv:2610.01073](https://arxiv.org/abs/2610.01073) | 可执行 agent 组件（固定 LLM editor 优化） | 独立 trace 记录效果；配对干预分离"通过验证的版本 / 继续运行的版本 / 下一步被编辑的版本" | **是**：`full validation` + `validated rollback` | **是（部分）**：新授权依赖使旧优化失效后，**48 条框架历史中有 22 条仍保留不安全程序**（尽管每个受影响 archive 里都有正确替代品）；validated rollback 后核心轨迹全部收敛到正确程序，且仍保留 >43% 部署节省 |
| **Self-Evolving Coordination Protocol in Multi-Agent AI Systems (SECP)** — de la Chica Rodriguez, Vera Díaz | 2026-02（v1 2025-10-17）；[arXiv:2602.02170](https://arxiv.org/abs/2602.02170) | **协调协议**（六方 Byzantine 共识提案） | 固定硬约束：BFT f<n/3、O(n²)、完整安全/活性论证、有界可解释性；单一指标 proposal coverage | **是**：只允许"**externally validated** self-modification"，同时保持**固定形式化不变量** | 未找到 |
| **Self-Evolving AI for Humanoids** — Nguyen, Raha, Le, Huh, Niyato, Hong | 2026-09；[arXiv:2609.13236](https://arxiv.org/abs/2609.13236) | policy / perception / memory / workflow / body 状态元组 | 世界模型验证门 | **是**：把 **admissible evolution** 形式化为约束，由 world-model verification gate 在 **human-oversight envelope** 内强制执行 | 未找到 |
| **Corrigibility Transformation** — R. Hudson | 2025-10-17（v2 2026-08-04）；[arXiv:2510.15395](https://arxiv.org/abs/2510.15395) | **目标函数 / 奖励** | 可纠正性 + 与其他目标的"竞争力"（性能不牺牲） | **是**：构造出的目标在最优可纠正目标类中达到最优性能，且**disincentivize 蓄意自我修改**（让 AI 不愿阻止自己被更新） | 否 |
| **MemScope** — Su, Y. Guo, Z. Li, Bai, Hou, Jin, Jiafeng Guo | 2026-10-15；[arXiv:2610.21170](https://arxiv.org/abs/2610.21170) | **memory 架构代码**，用局部 in-place 补丁 | 原始执行 trace + 运行时记忆状态 + 当前架构代码（GAIA 86.67% vs trace-only 70.00% vs summary-only 63.33%） | **是（弱形式）**：provider-identity 与 memory-compatibility 约束、`bounded in-place edits`；动机正是"粗糙反馈导致大范围重写" | 否；报告 **median code-change ratio 4.4%**（编辑幅度，**不是**退役率） |
| **Audit Without Verification: When LLM Accountability Layers Relay Rather Than Check** — P.-P. Arslan | 2026-09-07；[arXiv:2609.07680](https://arxiv.org/abs/2609.07680) | 不自我修改；研究**跨机构边界 6-agent pipeline 的缺陷归因层** | 平衡缺陷注入 + 匹配的 clean twins（每条链 345,600 请求 × 2 模型） | 不适用 | 报告的是**归因层失效**：7,996 个 clean episode 中"零指控"（该层几乎不主动产出指控）；上游真错时误伤无辜方 **34.4% / 62.6%**；给定各 agent 已提交的报告，审计者只在 **4.1%** 情况下找回真实源头（低于 20% 均匀猜），而读原始文档可达 60.3% |

---

## C. 综述（含安全/治理章节）

| 工作名 | 年份 / 出处 | 覆盖对象 | 评估信号 | 是否涉及冻结边界 | 是否报告退役 / 回滚率 |
|---|---|---|---|---|---|
| **A Survey of Self-Evolving Agents: What, When, How, and Where to Evolve** — Gao et al.（27 作者） | 2025-07-28（v4 2026-01-16，TMLR 01/2026）；[arXiv:2507.21046](https://arxiv.org/abs/2507.21046) | model / memory / tool / architecture 四类组件 × intra/inter-test-time 两阶段 | 综述，含 self-evolving agent 专用 metric & benchmark 梳理 | 部分（safe/scale/co-evolution 列为 challenge） | 未找到 |
| **A Comprehensive Survey of Self-Evolving AI Agents** — Fang et al. | 2025-08-10（v2 2025-08-31）；[arXiv:2508.07407](https://arxiv.org/abs/2508.07407) | 统一框架：System Inputs / Agent System / Environment / Optimisers | 综述 | 有 safety & ethics 专节 | 未找到 |
| **Safety in Self-Evolving Agents: A Survey** — J. Chen, Feng, …, Shouling Ji（31 作者） | 2026-09-08；[arXiv:2610.00093](https://arxiv.org/abs/2610.00093) | 可复用状态：parameters / memories / tool definitions / skills / workflows | **SAVER 框架**：Substrate（定位可复用影响）→ Adaptation（如何变）→ Violation（哪个安全属性受损）→ **Exposure**（失效何时可观测）→ **Response**（containment / repair / **revocation**） | **是**：明确提出 safety 必须"在经验的累积、泛化与跨上下文复用中存活" | **明确提出该领域缺口**："现有工作对 admission / retrieval / activation / exposure / local containment 证据较强，**对 descendant repair 与 adaptation 恢复后的评估证据少得多**"；主张做 longitudinal evaluation，追踪不安全影响到其**originating transition**、跨后代验证修复 |
| **Trustworthy Recursive Self-Improvement in the Era of Large Models** — Pu, Gao, …, Xiao Zhang | 2026-10-26；[arXiv:2610.35193](https://arxiv.org/abs/2610.35193) | RSI 全流程 S1 诊断→S2 生成提案→S3 评估提案→S4 实施更新，**外加 RI（这些阶段自身的递归应用）** | 三维：Improvement Validity / **Constraint Preservation** / **Effective Oversight** | **是，且指认同构问题**："**changes to improvement mechanisms may invalidate earlier verification results and make human oversight less effective**"（改了改进机制，就作废了此前的验证结论） | 未找到成体系的退役率指标，但把"successor 继承的效应"单列为一类评估对象 |

---

## 关键结论

### 1. DGM 的确切事实（逐项回答提问）
- **自我修改对象**：agent 自己的 **Python 代码库**（`coding_agent.py`、`tools/`、`prompts/`、`forward()` 工作流）；底层 foundation model **冻结、不改权重**（§4.1 "built around a **frozen FM**"）。改进目标是"改代码的能力"，因此 SWE-bench 分数与自我修改能力同构——这正是后来 HGM 批评的"metaproductivity–performance mismatch"。
- **评估信号**：SWE-bench Verified（20.0→50.0%）与 Polyglot（14.2→30.7%）的 **pass@1 分数**；三段式 staged evaluation 节省算力。
- **"不可修改层"**：**只以两种弱形式存在**。(a) §3 承认 archive 维护与父代选择"目前固定、DGM 不可修改"——这是**实现局限**，不是安全设计。(b) §5 提出"可以造一个**不可修改的部分**，好在停下其余部分时评估它"——**一句 future direction，无实现、无实验、无度量**。**没有任何"冻结边界"作为架构原则被形式化。**
- **失败修改撤销比例**：**没有"回滚率"这个指标**。最接近的量化是附录 A.4 Table 2——只有 **51.3%** 的生成 agent 保留"基本代码编辑功能"，即 **≈48.7% 的变异体因为把"改代码的能力"改坏而被淘汰出 archive**（两个 baseline 都是 32.5%）。Ethics Statement 提到 archive"完整可审计 lineage，enabling rollback"，但**未报告撤销了多少**。

### 2. 已经被"占掉"的说法
- **"agent 改自己的代码、用 benchmark 分数当适应度、维护变异归档"**：DGM(2025) 已完全占位；更早的 ADAS(2024-08)、Gödel Agent(2024-10)、STOP(2023) 已是同一谱系。任何"用基准分选自我修改"的主张都不新。
- **"让元层也可改"（不止改策略，还改改进机制）**：Gödel Agent(2024) 的 π 与 I 同时递归更新、Promptbreeder(2023) 进化 mutation-prompt、DGM-Hyperagents(2026-03) 把 meta agent 并入单一可编辑程序——**这条已被三重占位**。
- **"不可修改的安全内核 / 进程隔离 / fail-closed 授权"**：Unfireable Safety Kernel(2026-06) 已把它做到形式化验证级（Z3 + Kani + 字节等价门控），并有"704 次针对安全核心的自修改全部被拒"的实测。**"immutable core"作为工程主张已被占满。**
- **"冻结参考 / 靠设计限制重写"**：Algorithmic Unverifiability(2026-06) 给出**不可能性证明**（"no tower of supervisors lowers the problem"、"certification requires restricting rewrites by design"、"a frozen reference keeps the question well posed"）。任何"加个不可改层就能保证安全"的弱主张，都会被这篇文章直接反驳——这是一个**必须引用、也容易被误撞**的地雷。
- **"自我修改必须有结构性约束（容量上限 / 验证-提升门）"**：Statistical Limits(2025-10, TMLR) 的 Two-Gate guardrail 已占。
- **"回顾/审计的单位应该是整条后代谱系，而不是单次修改"**：Safety in Self-Evolving Agents 综述(2026) 的 SAVER + Trustworthy RSI 综述(2026) 的"successor 继承效应"已占。
- **"回滚要防止重新铸权 / 撤销要闭包"**：Authorization for Self-Modifying Agent Populations(2026-09) 已给出形式化不变量（rollback non-reminting、revocation closure）。
- **"失败修改会被保留下来、形成安全性债务"**：Safety Must Survive Self-Improvement(2026-10) 已给出 48 条历史中 22 条保留不安全程序的实测。

### 3. 确实是空白的部分
- **"回滚/退役率作为一等评估指标"仍然是空白。** 搜 `"retirement rate"`、`"rollback rate"`、`"rejection rate"`、`"churn"` 与 self-modification 的组合，**没有命中任何一篇把它定义为报告指标的论文**。最接近的三个都是侧写：DGM 的"51.3% 保留基本功能"（淘汰率，非回滚率）、Gödel Agent 的"4%/92%/14%"（终止/抖动/最终失败，非撤销比例）、MemScope 的"median code-change ratio 4.4%"（编辑幅度）、Safety Must Survive 的"22/48 残留"（单一指标）。**没有人把"改了多少条、最后撤掉多少条"作为系统性的、跨方法可比的度量报出来。** 这个空白是有价值的，且与 DGM/DGM-H 的 archive lineage 数据天然兼容（他们本来就存了全部 diff，只是没做这个统计）。
- **"下游不能改上游 → 只能向上游报缺陷"这一机制，未找到等价工作。** 检索 `"bug report" + upstream + agent`、`"defect report" + upstream`、`"escalation" + upstream + defect`、`"fault attribution" + abstraction layers`、`"principal-agent" + model provider + downstream developer` 等组合，**均无直接命中**。最接近的三条都是"侧翼"而非"正中"：
  - **Audit Without Verification**(2026-09)：跨组织边界 6-agent 管线的**缺陷源头归因 + escalation 报告**，实测了"报告层 relay 而不 check"的失效模式——**这是"报告作为审计信号"的最强先例，但它的结论是负面的（这层不可信），且它讨论的是同构 agent 之间的横向/纵向 relay，不是"下游无权修改上游"这一权限不对称**。
  - **ASCEND**(2026-09, [arXiv:2609.32868](https://arxiv.org/abs/2609.32868))：一个真实案例——agent 要求 bit-for-bit 一致后发现所依赖的已发表求解器有两处 undefined behavior，**"both repaired and reported upstream"**。这是"下游向上游报缺陷"的**行为实例**，但只是案例叙述，不是机制设计。
  - **MemScope**(2026-10)：反向的——精确失败定位后做**局部代码修复**，回避大范围重写。是"故障归因 → 定点修复"，但修复者就是自己，不存在"越权"问题。
  因此 **"因权限受限而只能把缺陷上抛，并把上抛的信号当作审计/归因证据"这一闭环，目前是空白**——但**必须显式区分**于 Audit Without Verification（它已证明朴素的报告 relay 不可靠），否则会被审稿人当作"重复了 2609.07680 的负面结论"。
- **"报告机制本身的信道容量 / 保真度"**也是空白：即"下游向上游报的缺陷，能承载多少信息、失真多少"。Audit Without Verification 测了结论字段的危害（删掉"结论"这一子句后归因准确率从 94.4% 依赖降到 3.4%，auditor 准确率 +41.2pp），但**没有把它做成一个可设计的信道/协议**。

### 4. 给主张新颖性判定的三条提醒
1. **凡是"冻结层"类主张，必须先穿过 2606.28639 的不可能性结论**：该文已证明通用系统上无法在自修改前认证安全属性的保持，且"监督者塔"无用。若新主张仍是"加一层不可改的核心"，需要说明它如何绕开（合法路径是 2606.28639 自己指出的：**靠设计限制重写** + **frozen reference 让问题保持良定义**，而不是靠更强的监督者）。
2. **凡是"评估信号"类主张，必须先穿过 HGM 的 metaproductivity 批评**：benchmark 分数 ≠ 自我改进潜力，这是 2510.21614 的核心贡献，且 DGM 自己也承认"coding benchmark 与自修改能力同构"是其方法的**特例假设**（DGM §6 Limitations）。
3. **"退役率"这个点有真实空白，但表述要精确**：现有最快被反驳的方式是"这不过是 DGM 附录 Table 2 的淘汰率换个说法"。要立住，需要 (a) 明确定义"退役"（拒绝入库 / 入库后被弃用 / 部署后撤回，三者不同）、(b) 给出**跨方法可比**的归一化（否则 51.3% 与 22/48 无法对话）、(c) 说明它衡量的是**什么**（是搜索效率？是安全性债务？是架构可演化性？）。

---

## 未能核实 / 未找到的项目
- **HGM (2510.21614) 是否定义了冻结边界**：仅读摘要与检索页，未读全文 —— **未核实**。
- **"self-modification safety boundary" 作为固定术语**：arXiv 全站未出现该 exact phrase 的标题级工作；语义等价概念分散在 safety kernel / authorization succession / admissible evolution / Two-Gate 等不同命名下。
- **"immutable core"**：arXiv 全站 `"immutable core" self-improving` **零命中**（该短语在 AI 安全文献中尚未定型）。
- **"frozen layer" + agent**：唯一命中是 SplitFrozen(2503.18986)，属边缘设备 LLM 微调，**与自修改无关**。
- **"self-modification guardrails"**：仅 2 篇命中，即 2606.26057 与 2510.04399。
