# DeepSeek 官方论文文体规范（调研稿）

> 用途：为「论文写作技能」提供可模仿的 DeepSeek 技术报告文体基线。
> 证据规则：所有英文引文均逐字摘自 arXiv abs/html 页或官方 GitHub README；查不到的写「未核实」。
> 引文截断用 `…`；每块末尾给 URL。凡我未做全文逐词穷举的结论，标「弱证据」。

---

## 1. 论文清单（DeepSeek-AI 官方技术报告）

arXiv 作者检索页（`au:"DeepSeek-AI"`）在 cs 归档下仅返回 8 条（集体署名条目），其余论文以个人署名发布，因此下表由「集体署名条目 + 官方 GitHub/个人署名条目」合并而成，编号均经 abs 页核对。

| # | 论文名（arXiv 标题原文） | arXiv | 时间 | 一句话主题 |
|---|---|---|---|---|
| 1 | DeepSeek LLM: Scaling Open-Source Language Models with Longtermism | 2401.02954 | 2024-01 | 自建 scaling law（7B/67B）指导预训练，2T token 语料，SFT+DPO |
| 2 | DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models | 2401.06066 | 2024-01 | 细粒度专家切分 + 共享专家隔离，追求「专家专门化」 |
| 3 | DeepSeek-Coder: When the Large Language Model Meets Programming -- The Rise of Code Intelligence | 2401.14196 | 2024-01 | 代码模型，仓库级/项目级语料 |
| 4 | DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models | 2402.03300 | 2024-02 | 120B 数学 token + 提出 GRPO |
| 5 | DeepSeek-VL: Towards Real-World Vision-Language Understanding | 2403.05525 | 2024-03 | 真实场景 VL（截图/PDF/OCR/图表）+ 混合视觉编码器 |
| 6 | DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model | 2405.04434 | 2024-05 | 提出 MLA + DeepSeekMoE，236B/21B，128K 上下文 |
| 7 | DeepSeek-Prover: Advancing Theorem Proving in LLMs through Large-Scale Synthetic Data | 2405.14333 | 2024-05 | Lean 4 大规模合成证明数据（8M 命题） |
| 8 | DeepSeek-Coder-V2: Breaking the Barrier of Closed-Source Models in Code Intelligence | 2406.11931 | 2024-06 | 从 V2 中间 checkpoint 续训 6T token，语言 86→338，16K→128K |
| 9 | DeepSeek-Prover-V1.5: Harnessing Proof Assistant Feedback for RL and Monte-Carlo Tree Search | 2408.08152 | 2024-08 | 证明助手反馈作 RL 奖励 + MCTS |
| 10 | Fire-Flyer AI-HPC: A Cost-Effective Software-Hardware Co-Design for Deep Learning | 2408.14158 | 2024-08 | 万卡 PCIe A100 集群软硬协同（HFReduce / 算存一体网络） |
| 11 | DeepSeek-VL2: Mixture-of-Experts Vision-Language Models for Advanced Multimodal Understanding | 2412.10302 | 2024-12 | 动态切图 + MoE(MLA) 语言塔 |
| 12 | DeepSeek-V3 Technical Report | 2412.19437 | 2024-12 | 671B/37B，无辅助损失负载均衡 + MTP + FP8，2.788M H800 GPU hours |
| 13 | DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning | 2501.12948 | 2025-01 | 纯 RL 激发的 R1-Zero + 冷启动 R1；Nature 645:633–638 (2025) |
| 14 | Native Sparse Attention: Hardware-Aligned and Natively Trainable Sparse Attention | 2502.11089 | 2025-02 | NSA：可端到端训练的稀疏注意力 |
| 15 | DeepSeek-Prover-V2: Advancing Formal Mathematical Reasoning via RL for Subgoal Decomposition | 2504.21801 | 2025-04 | V3 驱动的递归子目标分解 + RL |
| 16 | DeepSeek-OCR: Contexts Optical Compression | 2510.18234 | 2025-10 | 用光学 2D 映射压缩长上下文（DeepEncoder + 3B MoE 解码器） |
| 17 | DeepSeek-V3.2: Pushing the Frontier of Open Large Language Models | 2512.02556 | 2025-12 | DSA 稀疏注意力 + 可扩展 RL + 大规模 Agentic 任务合成 |
| 18 | Conditional Memory via Scalable Lookup: A New Axis of Sparsity for Large Language Models（Engram） | 2601.07372 | 2026-01 | 条件记忆作为与 MoE 正交的第二稀疏轴，U 形 sparsity allocation 律 |
| 19 | DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence | 2606.19348 | 2026-06 | V4-Pro 1.6T/49B、V4-Flash 284B/13B，百万上下文 |
| 20 | DeepSeek-V4.1-Flash: Pushing the Limits of KV Cache Compression | 2609.19969 | 2026-09 | CED 架构 + FP4 KV，KV 至 890 bytes/token |

两点需注意：
- **署名形态两种并存**：V3/R1/V3.2/V4 系列用「DeepSeek-AI 集体 + 长字母序作者表」；MoE/Math/VL/Coder/Prover 用「个人作者 + 单位（DeepSeek-AI, Tsinghua, Peking Univ）+ 通讯邮箱」。
- DeepSeek-V4 的 arXiv 页面时间字段显示 `Submitted 26 April, 2026; originally announced June 2026`（「先提交后公告」字段异常，按公告月记为 2026-06）。

来源：`https://arxiv.org/abs/2412.19437`、`https://arxiv.org/abs/2501.12948`、`https://arxiv.org/abs/2405.04434`、`https://arxiv.org/abs/2402.03300`、`https://arxiv.org/abs/2401.06066`、`https://arxiv.org/search/cs?searchtype=author&query=DeepSeek-AI`、`https://github.com/deepseek-ai/Engram`

---

## 2. 章节骨架

### 2.1 DeepSeek-V3（2412.19437）

1 Introduction｜2 Architecture（2.1 Basic Architecture：2.1.1 Multi-Head Latent Attention、2.1.2 DeepSeekMoE with Auxiliary-Loss-Free Load Balancing；2.2 Multi-Token Prediction）｜3 Infrastructures（3.1 Compute Clusters；3.2 Training Framework：3.2.1 DualPipe and Computation-Communication Overlap、3.2.2 Efficient Implementation of Cross-Node All-to-All Communication、3.2.3 Extremely Memory Saving with Minimal Overhead；3.3 FP8 Training：3.3.1 Mixed Precision Framework、3.3.2 Improved Precision from Quantization and Multiplication、3.3.3 Low-Precision Storage and Communication；3.4 Inference and Deployment：3.4.1 Prefilling、3.4.2 Decoding；3.5 Suggestions on Hardware Design：3.5.1 Communication Hardware、3.5.2 Compute Hardware）｜4 Pre-Training（4.1 Data Construction、4.2 Hyper-Parameters、4.3 Long Context Extension、4.4 Evaluations：4.4.1 Evaluation Benchmarks / 4.4.2 Evaluation Results、4.5 Discussion：4.5.1 Ablation Studies for Multi-Token Prediction、4.5.2 Ablation Studies for the Auxiliary-Loss-Free Balancing Strategy、4.5.3 Batch-Wise Load Balance VS. Sequence-Wise Load Balance）｜5 Post-Training（5.1 Supervised Fine-Tuning、5.2 Reinforcement Learning：5.2.1 Reward Model / 5.2.2 Group Relative Policy Optimization、5.3 Evaluations：5.3.1 Evaluation Settings / 5.3.2 Standard Evaluation / 5.3.3 Open-Ended Evaluation / 5.3.4 DeepSeek-V3 as a Generative Reward Model、5.4 Discussion：5.4.1 Distillation from DeepSeek-R1 / 5.4.2 Self-Rewarding / 5.4.3 Multi-Token Prediction Evaluation）｜6 Conclusion, Limitations, and Future Directions｜References｜A Contributions and Acknowledgments｜B Ablation Studies for Low-Precision Training（B.1 FP8 v.s. BF16 Training、B.2 Discussion About Block-Wise Quantization）｜C Expert Specialization Patterns of the 16B Aux-Loss-Based and Aux-Loss-Free Models

**骨架特征**：没有独立 Related Work；Discussion 不设独立章，而是下沉为「每一大章末的 Discussion 小节」；Infrastructures 前置到 Pre-Training 之前，且包含「对硬件厂商的建议」这种罕见章节。

### 2.2 DeepSeek-R1（2501.12948）

1 Introduction（1.1 Contributions、1.2 Summary of Evaluation Results）｜2 Approach（2.1 Overview；2.2 DeepSeek-R1-Zero: Reinforcement Learning on the Base Model：2.2.1 Reinforcement Learning Algorithm、2.2.2 Reward Modeling、2.2.3 Training Template、2.2.4 Performance, Self-evolution Process and Aha Moment of DeepSeek-R1-Zero；2.3 DeepSeek-R1: Reinforcement Learning with Cold Start：2.3.1 Cold Start、2.3.2 Reasoning-oriented Reinforcement Learning、2.3.3 Rejection Sampling and Supervised Fine-Tuning、2.3.4 Reinforcement Learning for all Scenarios；2.4 Distillation: Empower Small Models with Reasoning Capability）｜3 Experiment（3.1 DeepSeek-R1 Evaluation、3.2 Distilled Model Evaluation）｜4 Discussion（4.1 Distillation v.s. Reinforcement Learning、4.2 Unsuccessful Attempts）｜5 Conclusion, Limitations, and Future Work｜References｜A Contributions and Acknowledgments

**骨架特征**：章节标题允许带修辞（"…and Aha Moment of…"）、允许 `v.s.` 做小节标题、设 **Unsuccessful Attempts** 专节申报失败。

### 2.3 DeepSeek-V2（2405.04434）

1 Introduction｜2 Architecture（2.1 Multi-Head Latent Attention: Boosting Inference Efficiency、2.2 DeepSeekMoE: Training Strong Models at Economical Cost：2.2.1 Fine-Grained Expert Segmentation、2.2.2 Device-Limited Routing、2.2.3 Auxiliary Loss for Load Balance、2.2.4 Token-Dropping Strategy）｜3 Pre-Training（3.1 Experimental Setups：3.1.1 Data Construction / 3.1.2 Hyper-Parameters / 3.1.3 Infrastructures / 3.1.4 Long Context Extension；3.2 Evaluations：3.2.1 Evaluation Benchmarks / 3.2.2 Evaluation Results / 3.2.3 Training and Inference Efficiency）｜4 Alignment（4.1 Supervised Fine-Tuning、4.2 Reinforcement Learning、4.3 Evaluations、4.4 Discussion）｜5 Conclusion, Limitation, and Future Work｜References｜A Contributions and Acknowledgments｜B DeepSeek-V2-Lite: A 16B Model Equipped with MLA and DeepSeekMoE｜C Full Formulas of MLA｜D Ablation of Attention Mechanisms｜E Discussion About Pre-Training Data Debiasing｜F Additional Evaluations on Math and Code｜G Evaluation Formats

**骨架特征**：小节标题常写成「方法名: 收益」双段式（`Multi-Head Latent Attention: Boosting Inference Efficiency`）；附录从 B 到 G 共 6 个，覆盖小模型、全公式、消融、去偏讨论、补测、评测格式。

### 2.4 DeepSeekMath（2402.03300）

1 Introduction（1.1 Contributions、1.2 Summary of Evaluations and Metrics）｜2 Math Pre-Training（2.1 Data Collection and Decontamination、2.2 Validating the Quality of the DeepSeekMath Corpus：2.2.1 Training Setting / 2.2.2 Evaluation Results、2.3 Training and Evaluating DeepSeekMath-Base 7B）｜3 Instruction Tuning（3.1 Instruction Tuning Data、3.2 Training and Evaluating DeepSeekMath-Instruct 7B）｜4 Reinforcement Learning（4.1 Group Relative Policy Optimization：4.1.1 From PPO to GRPO、4.1.2 Outcome Supervision RL with GRPO、4.1.3 Process Supervision RL with GRPO、4.1.4 Iterative RL；4.2 Unified Paradigm）｜5 Discussion（5.1 Lessons Learnt in Pre-Training、5.2 Insights of Reinforcement Learning）｜6 Conclusion, Limitation, and Future Work｜References｜A Appendix（A.1 Analysis of Reinforcement Learning 等）

**骨架特征**：小论文也用 `1.1 Contributions` + `1.2 Summary of ...` 双首页；Discussion 独立成章且拆成「预训练教训 / RL 洞见」两半，专门报告**负面结果**（arXiv 语料无效）。

### 2.5 DeepSeekMoE（2401.06066）

1 Introduction｜2 Preliminaries: Mixture-of-Experts for Transformers｜3 DeepSeekMoE Architecture（3.1 Fine-Grained Expert Segmentation、3.2 Shared Expert Isolation、3.3 Load Balance Consideration）｜4 Validation Experiments（4.1 Experimental Setup：4.1.1 Training Data / 4.1.2 Infrastructures / 4.1.3 Hyper-Parameters、4.2 Main Results、4.3 Ablation Studies、4.4 Discussion）｜…

**骨架特征**：设 `Preliminaries` 章先铺通用公式（承接式推导第 1–5 式），再在本章公式沿用编号；`Validation Experiments` 直接以「验证」为章名。

### 2.6 补充两篇骨架（LLM / OCR，用于对照不同体裁）

**DeepSeek LLM（2401.02954）**：1 Introduction｜2 Pre-Training（2.1 Data、2.2 Architecture、2.3 Hyperparameters、2.4 Infrastructures）｜3 Scaling Laws（3.1 Scaling Laws for Hyperparameters、3.2 Estimating Optimal Model and Data Scaling、3.3 Scaling Laws with Different Data）｜4 Alignment｜5 Evaluation（5.1 Public Benchmark Evaluation：5.1.1 Base Model / 5.1.2 Chat Model；5.2 Open-Ended Evaluation：5.2.1 Chinese Open-Ended Evaluation …）。
→ 特征：**把 Scaling Laws 提为与 Pre-Training 并列的一级章**，且「数据→架构→超参→基础设施」四小节固定顺序（这套顺序后来成为 V2 的 3.1.1–3.1.4 母版）。

**DeepSeek-OCR（2510.18234）**：1 Introduction｜2 Related Works（2.1 Typical Vision Encoders in VLMs、2.2 End-to-end OCR Models）｜3 Methodology（3.1 Architecture、3.2 DeepEncoder：3.2.1 Architecture of DeepEncoder / 3.2.2 Multiple resolution support、3.3 The MoE Decoder、3.4 Data Engine：3.4.1 OCR 1.0 data / 3.4.2 OCR 2.0 data …）。
→ 特征：**只有偏应用/新任务的论文才设 Related Works**；方法章名从 `Architecture` 变为 `Methodology`；`Data Engine` 单独成节——说明「数据生产管线」已被 DeepSeek 视为与架构同级的一等公民。

### 2.7 共性骨架模板（可直接套用）

```
Abstract (150–180 词，无 "In this paper, we propose" 之外的铺垫语)
Figure 1 = 主 benchmark 对比图 + 一句话 caption
1 Introduction
   [段1] 领域趋势 + 前人/开源阵营状态（带 3–6 个引文簇）
   [段2] "To further push the boundaries of …, we … introduce <Model>, a …, with N total parameters, of which M are activated for each token."
   [段3..k] 逐条技术要点（Firstly/Secondly/Furthermore/In addition/Lastly）
   [段 k+1] "Our main contribution includes:" / "Our contributions are summarized as follows:" + 分组 bullet
   [段 k+2] "Summary of Core Evaluation Results" + 分组 bullet（每条带具体数字）
   [段 k+3] "In the remainder of this paper, we first … Subsequently, … Next, … Thereafter, … Lastly, …"（章节导览 + Section 交叉引用）
2 Architecture / Approach（2.1 主结构，2.2 附加机制；小节名可用「名: 收益」）
3 Infrastructures（算力集群 → 训练框架/并行 → 低精度训练 → 推理部署 → 对硬件的建议）
4 Pre-Training（数据 → 超参 → 长上下文 → 评测：Benchmarks/Results → Discussion+消融）
5 Post-Training / Alignment（SFT → RL(奖励模型/算法) → 评测 → Discussion）
6 Conclusion, Limitations, and Future Directions（固定三段 + 未来方向 bullet）
References
A Contributions and Acknowledgments（按功能分组的长名单）
B..G 消融附录 / 全公式附录 / 讨论附录 / 补测附录 / 评测格式附录
```

来源同 2.1–2.5 各 abs/html 页。

---

## 3. 措辞惯例（可直接模仿）

### 3.1 Abstract：开篇句式与数字给法

五种开篇范式，按「模型旗舰 / 架构创新 / 领域攻坚 / 系统 / 假设驱动」分工：

- **旗舰报告（present 型，最常用）**：`We present DeepSeek-V3, a strong Mixture-of-Experts (MoE) language model with 671B total parameters with 37B activated for each token.`（V3）
  变体：`We present DeepSeek-V2, a strong Mixture-of-Experts (MoE) language model characterized by economical training and efficient inference. It comprises 236B total parameters, of which 21B are activated for each token, and supports a context length of 128K tokens.`（V2）
- **系列/迭代（introduce 型）**：`We introduce our first-generation reasoning models, DeepSeek-R1-Zero and DeepSeek-R1.`（R1 v1）
- **架构创新（问题先行）**：`In the era of large language models, Mixture-of-Experts (MoE) is a promising architecture for managing computational costs when scaling up model parameters. However, conventional MoE architectures like GShard, which activate the top-K out of N experts, face challenges in ensuring expert specialization, i.e. each expert acquires non-overlapping and focused knowledge. In response, we propose the DeepSeekMoE architecture towards ultimate expert specialization.`（MoE）——`In the era of …, X is … However, … In response, we propose …` 是可复用的三段式。
- **领域攻坚（challenge 先行）**：`Mathematical reasoning poses a significant challenge for language models due to its complex and structured nature. In this paper, we introduce DeepSeekMath 7B, which continues pre-training DeepSeek-Coder-Base-v1.5 7B with 120B math-related tokens sourced from Common Crawl, together with natural language and code data.`（Math）
- **行业现状（finding 先行）**：`The rapid development of open-source large language models (LLMs) has been truly remarkable. However, the scaling laws described in previous literature presents varying conclusions, which casts a dark cloud over scaling LLMs.`（LLM）

**数字给法**（四条硬规则）：
1. 参数量必须写成 `N total parameters, of which M are activated for each token`（不写「激活参数 M」单说）。
2. 相对提升写「动作 + 三个具体百分比」：`Compared with DeepSeek 67B, DeepSeek-V2 achieves significantly stronger performance, and meanwhile saves 42.5% of training costs, reduces the KV cache by 93.3%, and boosts the maximum generation throughput to 5.76 times.`（V2）
3. 成本写绝对量 + 硬件单位：`Despite its excellent performance, DeepSeek-V3 requires only 2.788M H800 GPU hours for its full training.`（V3）
4. benchmark 分数直接内嵌：「achieving 88.5 on MMLU, 75.9 on MMLU-Pro, and 59.1 on GPQA」（V3 贡献 bullet）；`DeepSeekMath 7B has achieved an impressive score of 51.7% on the competition-level MATH benchmark without relying on external toolkits and voting techniques, approaching the performance level of Gemini-Ultra and GPT-4.`（Math）

**摘要收尾三类**：
- 稳定性叙述（V3 独有）：`In addition, its training process is remarkably stable. Throughout the entire training process, we did not experience any irrecoverable loss spikes or perform any rollbacks.`
- 开源承诺 + 链接：`To support the research community, we open-source DeepSeek-R1-Zero, DeepSeek-R1, and six dense models (1.5B, 7B, 8B, 14B, 32B, 70B) distilled from DeepSeek-R1 based on Qwen and Llama.`（R1）／`The model checkpoints are available at https://github.com/deepseek-ai/DeepSeek-V3.`
- 归因式两因素：`The mathematical reasoning capability of DeepSeekMath is attributed to two key factors: First, … Second, …`（Math）

### 3.2 Introduction：铺垫与贡献列表

铺垫段固定套路：`领域趋势（带引文簇）→ 开源阵营状态 → 成本/效率痛点 → To further push the boundaries of …, we … introduce …`。原文：

> `To further push the boundaries of open-source model capabilities, we scale up our models and introduce DeepSeek-V3, a large Mixture-of-Experts (MoE) model with 671B parameters, of which 37B are activated for each token.`（V3）

贡献列表有 **两种排版**，均可模仿：

**(a) 「论断式引导句 + 分组小标题 + bullet」**（V3）：

> `Our main contribution includes:`
> `Architecture: Innovative Load Balancing Strategy and Training Objective`
> `• On top of the efficient architecture of DeepSeek-V2, we pioneer an auxiliary-loss-free strategy for load balancing, which minimizes the performance degradation that arises from encouraging load balancing.`
> `• We investigate a Multi-Token Prediction (MTP) objective and prove it beneficial to model performance. It can also be used for speculative decoding for inference acceleration.`
> `Pre-Training: Towards Ultimate Training Efficiency`
> `• We design an FP8 mixed precision training framework and, for the first time, validate the feasibility and effectiveness of FP8 training on an extremely large-scale model.`

分组小标题形如 `阶段: 目标口号`（`Pre-Training: Towards Ultimate Training Efficiency`、`Post-Training: Knowledge Distillation from DeepSeek-R1`）。注意 `Our main contribution includes:` 用单数 contribution——这是 DeepSeek 的固定（略不合语法的）用法，模仿时保留。

**(b) 「一句话总纲 + 分组小标题 + bullet」**（MoE / Math / R1）：

> `Our contribution includes scalable math pre-training, along with the exploration and analysis of reinforcement learning.`（Math）
> `Our contributions are summarized as follows:`（MoE，bullets 以 **加粗短语开头**：`Architectural Innovation.` `Empirical Validation.` `Scalability.` `Alignment for MoE.` `Public Release.`）
> R1 的小标题是 `Post-Training: Large-Scale Reinforcement Learning on the Base Model` 与 `Distillation: Smaller Models Can Be Powerful Too`（后者带修辞）。

**第三条必写段：章节导览**（V3 原文，模板化程度极高）：

> `In the remainder of this paper, we first present a detailed exposition of our DeepSeek-V3 model architecture (Section 2). Subsequently, we introduce our infrastructures, … Next, we describe our pre-training process, … Thereafter, we discuss our efforts on post-training, … Lastly, we conclude this work, discuss existing limitations of DeepSeek-V3, and propose potential directions for future research (Section 6).`

### 3.3 技术表述动词分布

按「创新归属」选词，这是 DeepSeek 最稳定的用词纪律（括号内为原文实例）：

| 动词 | 使用场合 | 原文 |
|---|---|---|
| **pioneer** | 自称首创、且是本文最卖点的机制 | `DeepSeek-V3 pioneers an auxiliary-loss-free strategy for load balancing`／`we pioneer an auxiliary-loss-free strategy` |
| **propose** | 提出新架构/新算法（学术贡献） | `we propose the DeepSeekMoE architecture towards ultimate expert specialization`（MoE） |
| **introduce** | 首次引入某技术到本体系，或首次做某事 | `we introduce an FP8 mixed precision training framework and, for the first time, validate its effectiveness`／`we introduce MLA, an attention mechanism equipped with low-rank key-value joint compression`（V2） |
| **design** | 自研工程件/调度/流程 | `we design the DualPipe algorithm for efficient pipeline parallelism`／`we design the DeepSeekMath Corpus` 的 `meticulously engineered data selection pipeline` |
| **adopt** | 沿用他人/自家上一代已验证件 | `DeepSeek-V3 adopts Multi-head Latent Attention (MLA) and DeepSeekMoE architectures, which were thoroughly validated in DeepSeek-V2`／`we adopt Group Relative Policy Optimization (GRPO)` |
| **present** | 摘要/章首的「本文呈现」与图表引用（`is presented in Figure 2`） | `We present DeepSeek-V3, …` |
| **investigate / explore** | 探索性、结论未定 | `we investigate a Multi-Token Prediction (MTP) objective and prove it beneficial`／`we explore a unified paradigm` |
| **employ / use** | 纯配置陈述 | `we employ the AdamW optimizer`／`we employ a 16-way zero-pipeline parallelism` |
| **observe / find** | 实验发现（避免断言因果） | `which we have observed to enhance the overall performance`／`we find that the Online RFT significantly outperforms RFT` |
| **validate / demonstrate** | 结论强度分级 | `consistently validate its substantial advantages`（MoE）／`Experimental results validate the high level of expert specialization` |
| **recommend** | 给外部（尤其硬件厂商）提建议 | `we recommend that future chip designs increase accumulation precision in Tensor Cores` |

形容词纪律：**remarkably / notably / consistently / significantly / substantial / impressive / meticulous(ly) / elegant** 高频；`top-tier performance among open-source models` 是 DeepSeek 对「非第一」结果的标准说法（V2 摘要、V2 结论、V3 摘要均用）。禁用未限定的 `state-of-the-art`——V3 用它是带范围的：`DeepSeek-V3 achieves state-of-the-art performance on math-related benchmarks among all non-long-CoT open-source and closed-source models`。

### 3.4 实验句式

引用图表（`As shown in / As depicted in / As illustrated in / As presented in` 四选一，不重复用同一个）：

> `Figure 2 depicts the performance trajectory of DeepSeek-R1-Zero on the AIME 2024 benchmark throughout the RL training process. As illustrated, DeepSeek-R1-Zero demonstrates a steady and consistent enhancement in performance as the RL training advances.`（R1）

> `Table 2 provides a comparative analysis between DeepSeek-R1-Zero and OpenAI's o1-0912 models across a variety of reasoning-related benchmarks. The findings reveal that …`（R1）

> `In Table 3, we compare the base model of DeepSeek-V3 with the state-of-the-art open-source base models, including DeepSeek-V2-Base (our previous release), Qwen2.5 72B Base, and LLaMA-3.1 405B Base.`（V3）

对手逐个点评用编号 `(1)…(2)…(3)…` + `Compared with X, …`，且**主动承认劣势**：

> `(3) Compared with LLaMA-3.1 405B Base, the largest open-source model with 11 times the activated parameters, DeepSeek-V3-Base also exhibits much better performance on multilingual, code, and math benchmarks. As for English and Chinese language benchmarks, DeepSeek-V3-Base shows competitive or better performance`（V3）

> `While it trails behind GPT-4o and Claude-Sonnet-3.5 in English factual knowledge (SimpleQA), it surpasses these models in Chinese factual knowledge (Chinese SimpleQA)`（V3 贡献段）

「同规模比较」是必需限定语：`with only half of the activated parameters`／`with only about 40% of computations`／`even with only 21B activated parameters`。

领先幅度写法：`surpasses existing open-source base models by over 10% absolute`（Math）／`outperforming 96.3% human participants`（R1 Codeforces）／`jumping from an initial 15.6% to an impressive 71.0%`（R1）。

口径澄清句（DeepSeek 特色）：`Note that the aforementioned costs include only the official training of DeepSeek-V3, excluding the costs associated with prior research and ablation experiments on architectures, algorithms, or data.`

### 3.5 结论与 Limitations

V3 §6 三段结构（成果复述 → 承认局限 → 未来方向）原文：

> `In this paper, we introduce DeepSeek-V3, a large MoE language model with 671B total parameters and 37B activated parameters, trained on 14.8T tokens. …`（首段把摘要数字再给一遍）
> `While acknowledging its strong performance and cost-effectiveness, we also recognize that DeepSeek-V3 has some limitations, especially on the deployment. Firstly, to ensure efficient inference, the recommended deployment unit for DeepSeek-V3 is relatively large, which might pose a burden for small-sized teams. Secondly, although our deployment strategy … there still remains potential for further enhancement. Fortunately, these limitations are expected to be naturally addressed with the development of more advanced hardware.`
> `DeepSeek consistently adheres to the route of open-source models with longtermism, aiming to steadily approach the ultimate goal of AGI (Artificial General Intelligence). In the future, we plan to strategically invest in research across the following directions.`（后接 4 条 bullet，每条以 `We will` 开头）

注意 Limitations 的三个固定手法：①「承认 + 只说与该论文定位相关的 2 条」；②每条均自带「原因」；③末尾用 `Fortunately, these limitations are expected to be naturally addressed with …` 把责任外推给硬件/生态，不承诺具体修复时间。

- V2 用「通用局限」写法：`DeepSeek-V2 and its chat versions share the acknowledged limitations commonly found in other LLMs, including the lack of ongoing knowledge updates after pre-training, the possibility of generating non-factual information such as unverified advice, and a chance to produce hallucinations.`
- Math 用「能力缺口」写法：`Although DeepSeekMath achieves impressive scores on quantitative reasoning benchmarks, its capability on geometry and theorem-proof are relatively weaker than closed models. For instance, in our dry run, the model cannot handle problems related to triangles and ellipses, which may indicate data selection bias in pre-training and fine-tuning.`
- R1 的 Limitations 藏在 §5 的**未来方向 bullet** 里，每条 `领域名:` 开头并写明差距来源：`General Capability: Currently, the capabilities of DeepSeek-R1 fall short of DeepSeek-V3 in tasks such as function calling, multi-turn, complex role-playing, and JSON output.`／`Prompting Engineering: When evaluating DeepSeek-R1, we observe that it is sensitive to prompts. Few-shot prompting consistently degrades its performance. Therefore, we recommend users directly describe the problem and specify the output format using a zero-shot setting for optimal results.`

### 3.6 附录惯例

- **A 恒为 `Contributions and Acknowledgments`**（V2、V3、R1 一致）。
- **消融附录**：V3 `B Ablation Studies for Low-Precision Training`（B.1 FP8 v.s. BF16 Training、B.2 Discussion About Block-Wise Quantization）；V2 `D Ablation of Attention Mechanisms`。
- **公式附录**：V2 `C Full Formulas of MLA`——「把正文里为可读性拆散的式子补全」是固定动作。
- **讨论附录**：V2 `E Discussion About Pre-Training Data Debiasing`（含人工标注一致性表 Table 10）。
- **补测附录**：V2 `F Additional Evaluations on Math and Code`、`G Evaluation Formats`（把 prompt/评测格式全文贴出）。
- **case study 用表而非图**：R1 把 aha moment 的模型输出做成 `Table 3: An interesting "aha moment"…`；V3 `Appendix C Expert Specialization Patterns…` 用图展示专家-领域热图。

### 3.7 段落级连接词与句式指纹

DeepSeek 正文的连接词使用高度程式化，几乎可以按位置预测：

- **列举机制**：`Firstly, … Secondly, …`（枚举 2–3 项机制时必用，V3 引言第 3、4 段即如此）；`First, … Second, … Third, …`（用在段内归因，Math 摘要两因素、R1 §4.2 对 PRM 的三条限制均如此）；超过 3 项改用 bullet，不再堆序数词。
- **递进**：`Furthermore, …` / `In addition, …` / `Moreover, …` / `Additionally, …` 四选一轮换，同一节内不连用同一个两次（V3 §2.1、V2 §3.1 可验证）。
- **转折承认**：`However, …` 起句 + 后用 `we also acknowledge that` / `it is worth noting that` 缓冲。原文：`However, DeepSeek-R1-Zero encounters challenges such as poor readability, and language mixing.`（R1）／`it is worth noting that AGIEval includes both English and Chinese subsets`（V2）。
- **目的从句开场**（最标志性的句法）：`In order to …` / `To …` 开头 + `we + 动词`。原文：`In order to achieve the best of both worlds, we introduce MLA, an attention mechanism equipped with low-rank key-value joint compression.`（V2）／`To further push the boundaries of open-source model capabilities, we scale up our models and introduce DeepSeek-V3`（V3）／`To achieve efficient inference and cost-effective training, DeepSeek-V3 adopts …`（V3 摘要）。
- **同位语解释链**（定义术语的固定手法）：`X, a/an <类别> that/which <作用>`，例：`GRPO, an efficient and effective reinforcement learning algorithm`（Math）／`DeepSeek Sparse Attention (DSA), an efficient attention mechanism that substantially reduces computational complexity`（V3.2）。缩写首次出现一律 `全称 (缩写)`，此后只用缩写。
- **弱化断言**：`we observe that` / `we find that` / `as expected`。原文：`which we have observed to enhance the overall performance on evaluation benchmarks`（V3）／`we observe that the auxiliary-loss-free model demonstrates greater expert specialization patterns as expected`（V3）。
- **免责与边界句**：`Note that …` 单句成段或置于段首。原文：`Note that the bias term is only used for routing.`／`Note that during inference, we directly discard the MTP module, so the inference costs of the compared models are exactly the same.`／`Note that the aforementioned costs include only the official training …`（均 V3）。
- **禁用清单（弱证据）**：在 V3/R1/V2/Math/MoE 的 arXiv HTML 正文中我**未见到** `to the best of our knowledge`、`it is well known that`、`we argue that`、`we claim`、`novel`（作自夸形容词）；人称只用 `we`/`our`，无 `the author(s)`。因未做全库逐词检索，记为弱证据。

### 3.8 摘要一句话可复用模板

> `We present <Model>, a <架构类型> language model with <N> total parameters, of which <M> are activated for each token. To achieve <目标A> and <目标B>, <Model> adopts <已验证技术> and pioneers <新机制>. Compared with <基线>, it achieves significantly stronger performance, and meanwhile saves <pct1>% of training costs, reduces the KV cache by <pct2>%, and boosts the maximum generation throughput to <k> times. Comprehensive evaluations reveal that <Model> outperforms other open-source models and achieves performance comparable to leading closed-source models, achieving <s1> on <B1> and <s2> on <B2>. Despite its excellent performance, <Model> requires only <X>M H800 GPU hours for its full training. The model checkpoints are available at <URL>.`

（各槽位取值规则：`<已验证技术>` 只能是上一代已发表的东西，如 MLA/DeepSeekMoE；`<新机制>` 必须能用动词 `pioneer` 或 `first, validate` 表述；`<k> times` 保留两位小数。）

---

## 4. 贡献/作者惯例

**署名两式**：
1. **集体作者**：arXiv 作者表第一项即 `DeepSeek-AI`，其后为字母序长名单（V3 约 200 人，R1 约 190 人，V3.2 约 280 人）。DeepSeek LLM 的脚注给出排序规则原文：`Corresponding author: Authors are ordered alphabetically by the last name. Affiliation: DeepSeek-AI`。
2. **个人作者**：MoE/Math/VL/Coder/Prover 用 `Name^{1,2*†}` 上标 + 单位 + 通讯邮箱（`{zhihongshao,wangpeiyi,zhuqh,guoday}@deepseek.com`）+ GitHub 链接。

**Contributions 附录的分组**（按功能而非按贡献大小）：

- V3 分三组：`Research & Engineering`、`Data Annotation`、`Business & Compliance`；末尾脚注原文：`Within each role, authors are listed alphabetically by the first name. Names marked with * denote individuals who have departed from our team.`
- R1 分两组：`Core Contributors` / `Contributors`（Core 里把一作候选放前面，不再字母序）。
- 注意：**不写「XX 负责 XX 模块」式的细粒度职责**，只做分组 + 排序声明 + 离职标记。这一点与 NeurIPS 式 credit statement 明显不同。

来源：`https://arxiv.org/html/2412.19437v1`（Appendix A 全文）、`https://arxiv.org/html/2501.12948v1/`、`https://arxiv.org/html/2402.03300v3/`（首屏署名块）、`https://arxiv.org/html/2401.02954v1`

---

## 5. 图表惯例

### 5.1 图（caption 在图下方，句式 = 名词短语 + 一句解释 + 一句结论）

- **主 benchmark 对比图（Figure 1 恒定）**：极简 caption。`Figure 1: Benchmark performance of DeepSeek-V3 and its counterparts.`（V3）／`Figure 1: Benchmark performance of DeepSeek-R1.`（R1）。图本身是横向多 benchmark 的分组柱状/雷达式对比，DeepSeek 用统一色系突出自己。
- **架构图**：`Figure 2: Illustration of the basic architecture of DeepSeek-V3. Following DeepSeek-V2, we adopt MLA and DeepSeekMoE for efficient inference and economical training.`（V3）
- **多子图架构演进图**：`Figure 2: Illustration of DeepSeekMoE. Subfigure (a) showcases an MoE layer with the conventional top-2 routing strategy. Subfigure (b) illustrates the fine-grained expert segmentation strategy. Subsequently, subfigure (c) demonstrates the integration of the shared expert isolation strategy, constituting the complete DeepSeekMoE architecture. It is noteworthy that across these three architectures, the number of expert parameters and computational costs remain constant.`（MoE）——用 `Subfigure (a) showcases / (b) illustrates / (c) demonstrates` 三个不同动词避免重复。
- **pipeline 图**：`Figure 2: An iterative pipeline that collects mathematical web pages from Common Crawl.`（Math，一句话到底）
- **训练曲线**：`Figure 2: AIME accuracy of DeepSeek-R1-Zero during training. For each question, we sample 16 responses and calculate the overall average accuracy to ensure a stable evaluation.`（R1，第二句交代统计口径）／`Figure 10: Loss curves comparison between BF16 and FP8 training. Results are smoothed by Exponential Moving Average (EMA) with a coefficient of 0.9.`（V3，第二句交代平滑系数）——**曲线图 caption 必带「如何得到这条曲线」的方法句**，这是 DeepSeek 的硬规矩。
- **趋势解释型**：`Figure 3: The average response length of DeepSeek-R1-Zero on the training set during the RL process. DeepSeek-R1-Zero naturally learns to solve reasoning tasks with more thinking time.`（R1，第二句给作者解读）
- **scaling 图**：`Figure 1: Comparison between DeepSeekMoE 16B and open source models on the Open LLM Leaderboard. The red dashed line is linearly fitted from data points of all models except DeepSeekMoE 16B.`（MoE，交代拟合口径与为何排除自己）
- **子图标注**：图内用 `(a)/(b)`，caption 开头可写 `Figure (a) shows the compression ratio …; Figure (b) shows performance comparisons on OmniDocBench …`（OCR）；多子图信息量大时用 `Figure 7: (a) We propose a fine-grained quantization method …; (b) In conjunction with our quantization strategy, we improve the FP8 GEMM precision …`（V3）。

### 5.2 表（caption 在表上方，booktabs 风格：无竖线、三线、分组行前置）

列头组织方式（三种范式）：
1. **类别列前置**：`Knowledge / Code / Math / Chinese` 行分组（V2 Table 2、V3 Table 3），组名占一列，同组内 benchmark 名 + 指标 + shot 数。
2. **指标括号内联**：`HumanEval (Pass@1)`、`GSM8K (EM)`、`MMLU (Acc.)`、`TriviaQA (EM)`——即 `Benchmark (Metric)` 成为列头字符串。
3. **元信息成行**：`# Total Params`、`# Activated Params`、`FLOPs per 2K Tokens`、`# Training Tokens` 作表头左侧的行（MoE Table 1、V2 Table 7）。

caption 三件套 = **是什么 + 怎么测 + 结论一句**：

> `Table 1: Training costs of DeepSeek-V3, assuming the rental price of H800 is $2 per GPU hour.`（V3；成本表必给单价的假设）
> `Table 2: Comparison among DeepSeek-V2 and other representative open-source models. All models are evaluated in our internal framework and share the same evaluation setting. Bold denotes the best and underline denotes the second-best. Scores with a gap smaller than 0.3 are regarded as at the same level. With only 21B activated parameters, DeepSeek-V2 achieves top-tier performance among open-source models.`（V2）
> `Table 3: Comparison among DeepSeek-V3-Base and other representative open-source base models. All models are evaluated in our internal framework and share the same evaluation setting. Scores with a gap not exceeding 0.3 are considered to be at the same level. DeepSeek-V3-Base achieves the best performance on most benchmarks, especially on math and code tasks.`（V3）
> `Table 1: Evaluation results for validation experiments. Bold font indicates the best. Compared with other MoE architectures, DeepSeekMoE exhibits a substantial performance advantage.`（MoE）
> `Table 2: Comparison of pipeline bubbles and memory usage across different pipeline parallel methods. F denotes the execution time of a forward chunk, B denotes the execution time of a full backward chunk, …`（V3；符号表说明塞进 caption）
> `Table 3: AlignBench leaderboard rated by GPT-4-0613. Models are ranked in descending order based on the overall score. Models marked with * represent that we evaluate them through their API service or open-weighted model, instead of referring to the results reported in their original papers. Suffixes of Erniebot-4.0 and Moonshot denote the timestamps when we called their API.`（V2；星号与后缀含义必须在 caption 里定义）

格式纪律：
- 格式纪律：`Benchmark (Metric)` 与 `# Shots` 是官方列头写法（V2 Table 2 实测列头为 `Benchmark (Metric)` / `# Shots` / `DeepSeek 67B` / `Qwen1.5 72B` / `Mixtral 8x22B` / `LLaMA 3 70B` / `DeepSeek-V2`）。
- **best 加粗**，V2 主结果表还用**下划线标 second-best**：`Bold denotes the best and underline denotes the second-best.`（V2 Table 2 caption 原文）。V3 同类表的 caption 未声明下划线规则（是否仍有下划线为弱证据，仅凭 HTML 文本无法判定字形）。
- **0.3 分以内算同档** 的容差声明是 DeepSeek 主结果表的固定项（V2/V3 均有）。
- 消融表 caption 必须写出**结论方向**：`Table 4: Ablation results for the MTP strategy. The MTP strategy consistently enhances the model performance on most of the evaluation benchmarks.`（V3）／`Table 5: … Compared with the purely auxiliary-loss-based method, the auxiliary-loss-free strategy consistently achieves better model performance …`（V3）
- 成本单位：`$ per GPU hour` 显式假设 + `K/M` 缩写（`2664K GPU hours`、`2.788M H800 GPU hours`、`$5.576M`）。
- 缺失值写 `-`（V2 Table 2 中 Qwen1.5 72B 的 CHID 留空并在正文解释原因）。

来源：`https://arxiv.org/html/2412.19437v1`、`https://arxiv.org/html/2501.12948v1/`、`https://arxiv.org/html/2405.04434v5/`、`https://arxiv.org/html/2401.06066v1`、`https://arxiv.org/html/2402.03300v3/`、`https://arxiv.org/html/2510.18234v1/`

---

## 6. 判别特征：10 条质检 rubric

| # | 像 DeepSeek 的特征 | 可检查的判断方法 |
|---|---|---|
| 1 | 摘要里必须出现**具体 benchmark 数字**，而不只是定性描述 | 正则扫摘要，要求至少 2 处 `\d+(\.\d+)?%?` 且紧跟 benchmark 名（`on MMLU`/`on MATH`/`on AIME`）。反例：只说 "achieves superior performance"。 |
| 2 | 摘要必须给**总参数 + 每 token 激活参数**成对出现，且用 `of which … activated for each token` | 检索 `total parameters` 与 `activated`；缺任一即不合格。 |
| 3 | 摘要/引言必给**训练成本**（GPU hours 或 $）与 token 量 | 检索 `GPU hours`、`\d+(\.\d+)?[TBM] tokens`。V3/R1/V2/Math/MoE 均命中。 |
| 4 | 摘要末句是 **checkpoint/HF 链接**或**开源清单** | 摘要最后 1–2 句含 `github.com/deepseek-ai`/`huggingface.co/deepseek-ai`/`open-source`。 |
| 5 | 有 `Our main contribution includes:` / `Our contributions are summarized as follows:` + **分组小标题** + bullet | 检索这两个字符串之一（注意单复数变体）；贡献 bullet 必须按 `阶段: 口号` 分组，不能是一条长流水账。 |
| 6 | 引言末尾必有**章节导览段**，以 `In the remainder of this paper, we first …` 开头并带 `(Section N)` 交叉引用 | 检索 `In the remainder of this paper`；数 `(Section \d)` 出现次数应 ≥ 3 且与实章数一致。 |
| 7 | **没有独立 Related Work 章**；讨论下沉为各章末 `Discussion` 小节；未来工作/局限合并进 `Conclusion, Limitations, and Future Directions` | 目录里若出现 `Related Work` 独占一级标题 → 不像；若 `Conclusion` 后无 `Limitations` 字样 → 不像。 |
| 8 | 图表 caption 是**「是什么 + 怎么测 + 结论」三件套**，曲线图必带平滑/采样口径，表必带 0.3 容差或加粗规则 | 检查每个 figure caption 是否 ≥ 2 句；每个主结果表 caption 是否含 `Bold`/`same level`/`evaluated in our internal framework` 类声明。 |
| 9 | **主动申报失败与负面结果**（`Unsuccessful Attempts`、`arXiv papers are ineffective`），并给成本口径澄清 | 检索 `Unsuccessful`、`failure`、`does not`、`Note that the aforementioned costs include only`；一个都没有 → 不像 DeepSeek。 |
| 10 | 形容词/连接词指纹：`remarkably`、`notably`、`consistently`、`meticulously`、`top-tier performance among open-source models`、`with only X% of computations`；且 `state-of-the-art` **必须带范围限定** | 统计上述词频（≥5 次/篇为像）；若出现裸 `state-of-the-art`（后面无 among/in/on 限定）→ 扣分。 |

**弱证据补充（需全文检索确认后再入 rubric）**：
- 在我通读的 V3/R1/V2/Math/MoE 正文（arXiv HTML 全篇）中**未见到** `to the best of our knowledge`、`novel`（作形容词自夸）、`we argue that` 这类套话——但因未做整库逐词检索，暂记为弱证据。
- 我未核实：各篇 PDF 排版是否严格用 booktabs 三线表（HTML 版只可见单元格结构，无边框信息）；各篇总页数/图数分布。

**使用方式建议**：rubric 应分两档——第 1–6 条做**硬门禁**（缺一项即判定「不像」，因为它们是 DeepSeek 的强制格式件）；第 7–10 条做**评分项**（每项 0/1/2 分，7 分以上视为文体合格）。第 9、10 条最难被其他实验室模仿，是区分度最高的两条。

---

## 7. 调研边界与未核实项

- 上表 20 篇中，我**逐章读取过 arXiv HTML 全文或大半**的是 V3、R1、V2、DeepSeekMath、DeepSeekMoE、DeepSeek LLM；其余（VL/VL2/Coder/Coder-V2/Prover 系列/Fire-Flyer/OCR/V3.2/Engram/V4/V4.1-Flash）只核对了 **abs 摘要 + 目录**，其正文措辞细节未逐句取证，模仿时不要引用我的转述。
- **未核实**：arXiv 作者检索为什么只返回 8 条集体署名条目（推测与作者名字段写法有关，未查证）；R1 之后 arXiv 摘要与 Nature 版摘要的差异；各篇 PDF 的字体/行距/双栏排版规格；DeepSeek 是否公开 LaTeX 模板（`arxiv-style` 类）——均未找到官方声明。
- **未核实**：DeepSeek-V4、V4.1-Flash 的 arXiv 编号虽经 abs 页打开验证存在，但其编号（2606.19348 / 2609.19969）属未来时段，可能与页面渲染时间戳口径不一致；引用前建议再核一次。
