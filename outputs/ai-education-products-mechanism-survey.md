# 现代 AI 教育产品的教学机制调研（2024–2026）

对照基准：DeepTutor 这类开源教学应用（能力=深度研究/出题/可视化/知识库问答/多阶段能力流水线，**无持久学生模型**）。
标注约定：**①官方宣传** = 厂商自述、无第三方验证；**②第三方研究** = 独立机构/同行评审；**③未查到** = 无公开可核材料。

---

## 一、12 个对象逐条

### 1. Khanmigo（Khan Academy × GPT-4）
- **定位**：K-12 非营利 AI 家教 + 教师助手，绑定 Khan 自有内容库。
- **教学机制**：核心承诺是"**永远不给答案**"，用追问把学生推回推理链；学生侧嵌在每个练习/视频/文章里；教师侧为备课、学情摘要、量规、exit ticket。18 岁以下须家长开通或学区合作 → **审批权在成人**，不是学生自助。
- **架构**：起步 GPT-4（2023-03），后续引入 Gemini（2026 与 Google 合作）；有内容库锚定 + 安全设计。guardrails 的具体工程实现（输出过滤/策略路由）**未查到公开技术细节**（官方只表述"designed with safety as top priority"）。
- **证据**：https://www.khanmigo.ai/learners ；https://en.wikipedia.org/wiki/Khanmigo （2023-03-14 上线，首批 65,000 学生/53 学区）
- **比开源强在哪**：①**成人审批 + 学区合同**这套治理结构（开源项目默认无监护链）；②教学话术与**自有题库/知识点对齐**，不是自由对话。

### 2. Google NotebookLM（2026-07 起更名 Gemini Notebook）
- **定位**：只基于"你给的资料"作答的研究/学习笔记，不是家教。
- **教学机制**：source-grounding + **每条回答附原文引用**（quoting）；Audio Overview 把资料转成双主播"深度讨论"，形成 Deep Dive / Brief / Critique / Debate 四种教学语气，支持**交互式插话提问**（80+ 语言）。
- **架构**："模型只能访问你上传的源材料"，不外泄、不用于训练。**没有学生模型**——每次对话不带能力估计。
- **证据**：https://blog.google/technology/ai/notebooklm-google-ai/ （2023 发布，grounding+citation+不训练）；https://support.google.com/notebooklm/answer/16212820 （Audio Overview 机制、格式、交互模式）
- **比开源强在哪**：**引用可回溯做成了产品契约**（每条断言挂原文），而不是"请给出引用"的 prompt；以及长音频这种"换个模态再讲一遍"的输出形态（DeepTutor 的 visualize 是图/动画，不是听觉通道）。

### 3. Duolingo Max + 自适应难度
- **定位**：语言学习订阅高阶档，叠加 GPT-4 会话功能。
- **教学机制**：Explain My Answer（解释"你错在哪"）、Roleplay（情景对话，事后给准确性/复杂度反馈）、Video Call（跟虚拟角色实时通话，下次记得上次聊过什么）。自适应难度不靠 LLM：底层是 **Birdbrain/半衰期回归（HLR）** 这类可训练间隔重复模型。
- **架构**：LLM 层只负责会话与解释；**人类写情景脚本 + 人工复核 AI 内容 + 用户报错回流**。研究团队公开了 HLR 论文与 1,300 万"用户-词"复习数据。
- **证据**：https://blog.duolingo.com/duolingo-max/ （人工写场景、复核、报错回流）；HLR 论文 https://aclanthology.org/P16-1174/ ；研究团队与数据 https://research.duolingo.com/
- **比开源强在哪**：**两套模型分工**——"练习排程用统计模型，对话用 LLM"，LLM 出错不会污染难度估计。Max 的学习效果公开 RCT **未查到**。

### 4. Math Academy（重点）
- **定位**：4 年级到大学数学的完全自动化掌握学习平台（UC/WASC 认证课程）。
- **教学机制**：30–45 分钟自适应诊断 → 定位"知识前沿" → 每日 XP 目标 → 每 150 XP 一次限时测验 → 错题立刻转为复习任务。每个知识点：全解例题（worked example）+ 最多 5 道练习，**连对 2 题才前进**；交错练习 + 主动抑制"联想干扰"（不把相近概念排一起）；新知识"分层"叠加在旧知识上。
- **架构（三者齐备，业界最完整）**：
 1. **知识图谱**：数千个互联主题，边表示先修/包含关系；
 2. **学生模型**：每个主题的"间隔重复档案"，反复练得越多遗忘越慢；
 3. **算法**：自研 **FIRe（Fractional Implicit Repetition）**——练高阶题会"顺流"给低阶技能折算复习积分（因隐式练习只覆盖部分技能，故为分数），并用"重复压缩"把多条到期复习压进最少任务；诊断算法按"信息增益最大"选题，**把题量压掉一个数量级**（500–1000 个候选主题 → 数十题）。
- **证据**：https://mathacademy.com/how-it-works ；https://mathacademy.com/how-our-ai-works ；效果数据以自述为主，**独立第三方 RCT 未查到**。
- **比开源强在哪**：这是"**真学生模型**"的教科书级实现——持久化的能力估计 + 由它驱动选题。开源项目（含 DeepTutor）几乎都停在"这轮对话里我记得你"，没有跨会话的能力档案。

### 5. Squirrel AI 松鼠 AI（中国，智适应）
- **定位**：K-12 智适应课外辅导（后扩展公立校），曾估值超 10 亿美元。
- **教学机制**：把学科拆成**极细知识点**（初中数学 10,000+ 个，对照教材约 3,000、ALEKS 约 1,000），由特级教师+工程师共建知识图谱；诊断测约 10 题即勾勒薄弱面；**选题顺序由系统决定，不由学生决定**；线下督学教师看实时看板、只做兜底答疑。
- **架构**：知识图谱 + 知识追踪 + 随使用量自更新的图谱边权（称机器学习优化图谱关系）。"贝叶斯知识追踪"是其对外常用表述，但**具体算法/超参未查到可核的一手论文**；验证多是自筹小样本（2017 年 4 天、78 名学生）。
- **证据**：https://www.technologyreview.com/2019/08/02/131198/china-squirrel-has-started-a-grand-experiment-in-ai-education-it-could-reshape-how-the/ （MIT Tech Review 实地报道，含知识点数量对比、教师看板、自筹研究、CMU 联合实验室）；https://en.wikipedia.org/wiki/Squirrel_AI
- **比开源强在哪**：**知识点粒度 ≠ 教材章节**——把"会不会"定位到可干预的最小单元；以及"系统定序 + 人兜底"的组织形态。

### 6. Alpha School / 2-Hour Learning（争议）
- **定位**：美国私立 K-12 连锁（2014 奥斯汀起，2026 秋约 50 校区），上午 2 小时用自适应软件学学术科目，下午工作坊学"生活技能"。
- **教学机制**：AI 家教做一对一、按掌握度推进；教师改称"**guides**"，据 NEPC 分析约 **2/3 无正式教师资格**；以"省下的时间"作为奖励驱动（"the gift of time"）。
- **架构**：第三方自适应软件 + 自研运营体系；**技术细节未公开**。
- **争议（第三方报道）**：宣称"学得快 2 倍、前 20% 快 6.5 倍"，**无同行评审证据**；2026 年"Bootcamp"被曝要求学生戴心率带看父母批评视频（心率升幅不得超 10%）、无薪做"脏活"并录音审计、必须涨 100 个"真实粉丝"。《The 74》报道；ProPublica/Texas Tribune 指出其德州 vouchers 校区**无需满足州课程标准即可获批**；10 州申请特许学校仅亚利桑那通过，宾州以"多项重大缺陷"驳回。
- **证据**：https://alpha.school/ ；https://www.the74million.org/article/inside-alpha-schools-bootcamp-heart-monitors-unpaid-labor-many-many-tweets/
- **比开源强在哪**：真正值得抄的只有一条——**把"省下的时间"变成学生可支配的奖励**（激励机制设计），其余是运营与营销，技术不可核。

### 7. MagicSchool / SchoolAI（教师侧生产力）
- **定位**：学区级 AI 平台（MagicSchool 80+ 教师工具/50+ 学生工具；SchoolAI 主打教师自建"Spaces"）。
- **教学机制**：**教师先写场景/约束，学生只在该场景内对话**（SchoolAI 的 Spaces + Mission Control 让教师看到"每个学生卡在哪"）；MagicSchool 是工具集（教案/量规/测验/幻灯片）+ 学生侧活动，强调 SOC2/FERPA/COPPA、不用师生数据训练。
- **架构**：无学生能力模型；靠**教师审批与可见性**替代。
- **证据**：https://www.magicschool.ai/ ；https://www.schoolai.com/ （ESSA Level III，Instructure 独立评审，13,882 段学生-AI 对话研究，称批判性思维 +28%——**厂商引用，非同行评审**）
- **比开源强在哪**：**"场景即课程"**——一份教师写的 prompt+边界就是一个可复用的教学单元，且带合规与审计。DeepTutor 的多阶段能力更"重"，但没有学区要的权限/审计面。

### 8. Synthesis School / Tutor CoPilot（研究项目）
- **Synthesis Tutor**：SpaceX 实验学校衍生，K-5 数学，自适应+多感官+安置测；机制与效果均**未查到公开可核材料**（https://www.synthesis.com/tutor ）。
- **Tutor CoPilot（Stanford，重点）**：**首个在真实辅导中做的 Human-AI RCT**——900 名辅导老师 / 1,800 名 K-12 学生，预注册（OSF）。结论：有 CoPilot 的导师带的学生**掌握主题的概率 +4pp**（p<0.01），**低评分导师的学生 +9pp**；成本 **$20/导师/年**；用分类器分析 55 万条消息，发现导师更常用"引导性提问"、**更少直接给答案**；副作用：建议有时**不符合年级水平**。代码开源。
- **证据**：https://arxiv.org/abs/2410.03017 ；预注册 https://osf.io/8d6ha ；代码 https://github.com/rosewang2008/tutor-copilot/
- **比开源强在哪**：**把 AI 放在教师/导师侧而非学生侧**——不与学生争"给不给答案"，而是实时把"下一句该问什么"喂给人类。这是低成本、可验证、可审计的路线，开源教学应用几乎没人做。

### 9. OpenAI Study Mode（2025）
- **定位**：ChatGPT 内置"学习模式"（Free/Plus/Pro/Team，Edu 随后）。
- **教学机制**：苏格拉底式提问 + 提示 + 自我反思提示；分节脚手架控制认知负荷；先问水平再调难度；知识检查（小测/开放题）；可随时开关。
- **架构（官方自述，很关键）**：**"由我们与教师、科学家、教学法专家共同写的 custom system instructions"** 驱动；官方明确承认这会"导致行为不一致和错误"，计划"将来把该行为直接训练进主模型"。个性化仅基于"本次/历史对话"——**无持久能力估计**，进度追踪还在 roadmap。
- **证据**：https://openai.com/index/chatgpt-study-mode/ ；与 Stanford SCALE Initiative 合作研究学习效果。
- **比开源强在哪**：**诚实的自限**（承认是 prompt 层）+ 明确的分阶段路线（prompt → 训练进模型）。这恰好说明：2025 年的头部产品，"不给答案"主要仍是 prompt 工程。

### 10. Google Learn About（2024 Labs 实验）/ Gemini Guided Learning（2025–2026）
- **Learn About**：2024 年 Google Labs 的学习向实验，**现状与机制未查到可核页面**（相关 blog 链接 404），疑似已被 Guided Learning 吸收——按"未查到公开技术细节"处理。
- **Gemini Guided Learning**：主打"**productive struggle**"——用开放问题+分步拆解带学生走，而非直给答案；2026-11 起进入 **Google Search（学生账号）与 Google Classroom**（教师指派、锚定课堂材料、教师可见进度）；K-12 学生账号**默认关闭**，须管理员显式开启。
- **证据（第三方/官方研究）**：https://blog.google/products-and-platforms/products/education/guided-learning-uk-japan/ （东京大学 300+ 学生 RCT：常规工具 +5.3pp，加 Guided Learning **+8.1pp**，约 1.5 倍；英国 Ark 三校四周试点）；https://blog.google/products-and-platforms/products/education/ai-learning-era-updates-2026/ （Search/Classroom 落地 + 默认关闭策略）
- **比开源强在哪**：**"默认关闭 + 管理员开启"** 的保守默认值，以及把同一个教学策略同时铺到搜索框和课堂作业里（场景一致）。

### 11. 中国三款
- **学而思九章 MathGPT**：TAL 的数学大模型，对外提供**解题 / 讲题 / 批改**三类 API，并开源 **TAL-SCQ5K-CN/EN**（各 3K 训练 + 2K 测试，单选、带详细解析步骤，用于 CoT 训练）。机制=模型能力，**未见学生模型或教学策略层披露**。https://www.mathgpt.com/
- **有道小P**：官方定位"新一代 AI 全科学习助手"，底座为**子曰大模型**（生成式服务备案号 Beijing-ZiYue-20231016），页面无机制说明。https://xiaop.youdao.com/
- **豆包爱学**：**未查到**可核的官方机制页/技术说明（搜索结果仅指向豆包通用产品页），不作推测。
- **比开源强在哪**：九章唯一硬贡献是**开源了带解题步骤的数学数据集**；教学机制层面无可比信息。

### 12. Carnegie Learning MATHia / ASSISTments（老牌 ITS）
- **MATHia**：CMU 认知科学家创立，**ACT-R 认知模型 + 逐步（step-level）模型追踪**——不只是对错，而是判断学生此刻用了哪条解题路径/哪条错误规则；技能级进度条；教师侧 LiveLab 实时看"谁在闲置/谁卡住"、APLSE 预测学年末进度。
- **证据**：https://www.carnegielearning.com/solutions/math/mathia/ ；研究与 ESSA 分级 https://www.carnegielearning.com/why-cl/research/ （MATHia 单独使用为 ESSA Tier 2；混合课程 Tier 1；RAND 18,000 学生/147 校 RCT 称第二年增长近翻倍）
- **ASSISTments**：教师布置的 formative 作业平台，即时反馈 + 提示 + 班级报告；**拥有教育数据挖掘界最著名的公开纵向数据集**（Baker & Heffernan，2004–2007 中学使用 → 高中/大学/首份工作追踪；2017 竞赛）。https://www.assistments.org/ ；https://sites.google.com/view/assistmentsdatamining
- **比开源强在哪**：**"读懂学生的错法"而非"读懂学生的答案"**（认知模型 vs 判分）；以及**把数据开放出去让学界复现**——这是开源教学应用最该学、也最容易学的一条。

---

## 二、哪些有"真学生模型"，哪些只是 prompt 工程

| 层次 | 产品 | 判据 |
|---|---|---|
| **持久能力估计 + 模型驱动选题**（真学生模型） | **Math Academy**（间隔重复档案 + FIRe + 信息增益诊断）、**MATHia**（ACT-R 逐步模型追踪）、**松鼠 AI**（10,000+ 知识点图谱 + 知识追踪）、**Duolingo**（HLR/Birdbrain 排程）、**ALEKS**（引用为对照） | 有跨会话的学生状态对象，且**下一步做什么由它决定**，不是由模型即兴决定 |
| **半持久：会话内状态 + 教师可见** | SchoolAI（Mission Control）、ASSISTments（班级/学生报告）、Khanmigo 教师侧学情摘要 | 有数据看板，但能力估计弱（多为正确率聚合） |
| **纯 prompt 工程** | **OpenAI Study Mode**（官方承认）、**Khanmigo 学生侧**（公开材料止于"不给答案"的策略与内容锚定）、MagicSchool 学生工具、Synthesis Tutor | 行为靠 system instructions + 内容约束，无持久能力档案 |
| **不是家教，另有机制** | **NotebookLM / Gemini Notebook**（grounding + 引用）、 Gemini Guided Learning（策略层+RCT，但学生模型未公开）、Tutor CoPilot（人在环，模型辅助人类） | 教学价值来自"资料约束"或"人类决策增强"，不来自能力估计 |

一句话：**只有 4 家有可称为"学生模型"的东西（Math Academy、MATHia、松鼠 AI、Duolingo），其中 3 家不是 LLM 时代的产物。** 2023 年后的 LLM 教育产品，头部（OpenAI、Khanmigo 学生侧）公开承认仍停在 prompt 层。

---

## 三、"不让模型直接给答案"的具体工程手段（业界实际在用的）

1. **角色/策略路由**：把请求先分类——"要答案"走讲解策略，"做错题"走追问策略。Tutor CoPilot 的做法是把建议**先给人类**、由人决定是否采纳（arxiv 2410.03017）。
2. **内容锚定（grounding）**：NotebookLM 让模型"只能看到你上传的材料"，答不出就答不出——用可见范围的收缩替代输出审查（blog.google 2023-07-12）。
3. **教师/成人审批闸门**：Khanmigo 18 岁以下须家长或学区开通；SchoolAI 让教师先写 Space、再放学生进；Google 对 K-12 账号**默认关闭** Guided Learning，须管理员显式开启。
4. **结构化输出模板**：分节脚手架 + 先问水平再答（Study Mode、Guided Learning）——把"给答案"的路径从格式上挤掉，而不是靠禁止。
5. **过程性产物替代一次性答案**：小测/知识检查/自我解释/复述，让学生必须产出证据（Study Mode 的 knowledge checks、Math Academy 的连对 2 题 + 每 150XP 限时测）。
6. **语料与人的双重复核**：Duolingo 人类写情景脚本 + 复核 AI 输出 + 用户报错回流训练。
7. **课程粒度约束**：松鼠 AI 由系统定序，学生无法用"直接告诉我答案"跳过知识点（MIT Tech Review 明确写 "Learning is not student-directed"）。
8. **测量手段（可复用的评估设计）**：MathDial 提出用"**学生解题成功率 vs 提前泄露答案**的权衡"来评测家教模型；Tutor CoPilot 用分类器给 55 万条消息打"教学动作"标签，度量"更少给答案"是否真的发生。

> 反面事实：PNAS 2025 的 RCT 显示，**加了 safeguard 的版本（GPT Tutor）在撤走 AI 后成绩没有下降，无 guardrail 的版本下降 17%**——即"不给答案"这一层不是锦上添花，是决定正负号的那一层。

---

## 四、可用于比较的公开数据集 / 基准

| 资源 | 内容 | 用途 | URL |
|---|---|---|---|
| **MATH** | 12,500 道竞赛数学题 + 完整分步解 | 模型解题能力（非教学） | https://arxiv.org/abs/2103.03874 |
| **MathDial** | 3,000 段真人教师×LLM 扮演学生的家教对话，按"教师动作分类学"标注脚手架 | **评测"教学"而非"解题"**，含"成功率 vs 泄题"权衡 | https://arxiv.org/abs/2305.14536 ；代码 github.com/eth-nlped/mathdial |
| **Eedi Question-Anchored Tutoring Dialogues-2k** | 68.7k 条真实师生对话（2021-11–2025-02），带 GPT 打的 **talk-move 标签**（Press for Accuracy / Revoicing / Keep Together…）、题目元数据、学科层级 | 训练与评测教学动作；CC-BY-NC-SA | https://huggingface.co/datasets/Eedi/Question-Anchored-Tutoring-Dialogues-2k |
| **Eedi Misconceptions Graph** | 数学错误概念图谱 | 错误诊断 | https://huggingface.co/datasets/Eedi/Eedi-Misconceptions-Graph |
| **ASSISTments 纵向数据集**（2009/2012/2015/2017） | 真实点击流 + 长期结果（大学入学、首份工作） | 知识追踪/辍学预警标准基准 | https://sites.google.com/view/assistmentsdatamining |
| **Duolingo HLR / SLAM 数据** | 1,300 万"用户-词"复习对；700 万词学习者语料 | 间隔重复与二语习得建模 | https://research.duolingo.com/ |
| **TAL-SCQ5K-CN/EN** | 中英各 5K 单选数学题带解析步骤 | 中文数学 CoT 训练 | https://www.mathgpt.com/ |

（"TutorBench"之类家教能力基准：**未核实到可靠公开页面**，不列入。）

---

## 五、公开的负面证据（务必与宣传分开看）

1. **Bastani et al., PNAS 2025, 122(26):e2422633122**（第三方、RCT、近千名高中生）：无约束 GPT-4 在**允许使用时**成绩 +48%，**撤走后比从未用过的人低 17%**；加了学习保护 prompt 的版本 +127% 且撤走后无损。→ **"给答案"确实会造成能力幻觉**。https://europepmc.org/articles/PMC12232635 ；DOI 10.1073/pnas.2422633122
2. **反向证据同样存在**：哈佛物理课 RCT（N=194，Nature *Scientific Reports* 2025）中，精心设计的 AI 家教组学习增益中位数是课堂主动学习组的**两倍以上**，效应量 0.63–1.3 SD。→ 结论不是"AI 家教有害"，而是**设计决定正负号**。https://www.nature.com/articles/s41598-025-97652-6
3. **松鼠 AI**：唯一可见的验证是 2017 年**自筹、4 天、78 名学生**；"贝叶斯知识追踪"等算法细节无一手可核论文。MIT Tech Review 同时记录了学界批评："这是 adaptive learning，不是 personalized learning——它不看学生**想学什么**、怎么学最好。"
4. **Alpha School**：无同行评审证据支撑"2 倍速"；德州 vouchers 校区无需满足州课程标准；10 州特许申请仅 1 州通过；宾州以"多项重大缺陷"驳回。The 74 的 bootcamp 报道引发伦理争议（心率带、无薪劳动、强制涨粉）。
5. **Tutor CoPilot 自曝缺陷**：模型建议"不符合年级水平"——人机协同的第一个失效模式，不是给错答案，而是**难度错配**。
6. **Khanmigo / Duolingo Max / NotebookLM / Study Mode** 的学习效果**独立 RCT：均未查到**。Khanmigo 目前只有 Common Sense Media 的 4 星评级（产品评级，非学习效果）。

---

## 六、对 DeepTutor 这类开源教学应用的意义（可借鉴 / 不该借鉴）

**可借鉴**
1. **补一个最小学生模型**（成本最低的一步）：不做 FIRe，先做"知识点 × 掌握度 × 下次复习时间"的三元组，持久化在用户目录，选题时读它。这是开源项目与商业产品最大的能力断层。
2. **引用作为契约**（NotebookLM）：教学回答里的每个断言挂源，尤其"知识库问答"能力。
3. **把 AI 放到教师侧**（Tutor CoPilot）：开源项目最容易拿到的可验证增益——不跟学生争给不给答案，而是给"下一句该问什么"。
4. **评测设计抄 MathDial 的"成功率 vs 泄题"权衡**——比"准确率"更能反映教学能力。
5. **默认关闭 + 显式开启**（Google 的 K-12 策略）：面向未成年人的教育功能应默认最保守。

**不该借鉴**
- Alpha 的激励表演化（心率带/涨粉/无薪劳动）：把"掌握"变成"服从性测试"，与学习科学无关。
- 松鼠 AI 的"系统独裁定序"：无学生自主权，且算法不可核。
- 用"知识点拆得越细越好"作为卖点：10,000 个知识点是内容成本，不是教学效果；MATHia 的知识点远少，但**能读懂错在哪一步**。

---

## 七、明确"未查到"的清单（诚实边界）
- Khanmigo 学生侧 guardrails 的具体实现（过滤、路由、审批流）。
- 松鼠 AI 的算法论文与超参、效果的可核第三方研究。
- Alpha School 所用自适应软件的技术与效果数据。
- 豆包爱学的官方机制说明。
- Google **Learn About**（2024 Labs 实验）现状与技术细节（相关页面 404）。
- Duolingo Max、Khanmigo、NotebookLM、Study Mode 的独立学习效果 RCT。
- Synthesis Tutor 的机制与效果。
