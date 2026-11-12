# AI 教学系统的理论体系与经典算法（工程对照）

标注：**【共识】** 教科书级、有多篇元分析支持；**【有争议】** 证据不一致或边界强；**⚠** 文献存在但我未逐条核对元数据（DOI/页码/年份），引用前请自行验证。

---

## 一、学习科学理论

**1. Bloom 2-Sigma【有争议：当上限，不当 KPI】**
主张：一对一辅导 + 掌握学习比常规班级授课高约 2 个标准差。
文献：Bloom (1984). The 2 Sigma Problem. *Educational Researcher* 13(6), 4–16. doi:10.3102/0013189X013006004
落地：2σ 来自小样本合并，后续复现多在 0.4–0.8σ（VanLehn 2011 估人对人辅导 ≈0.79σ）。可复现的是三条：高频反馈、掌握门槛、个性化序列。

**2. Mastery Learning / Carroll 模型【机制=共识；大规模实施=有争议】**
主张：Carroll 把成绩定义为"实际用时/需要用时"；Bloom 由此提出足够时间 + 形成性测验 + 矫正环节，达标才前进。
文献：Bloom (1968) *Learning for Mastery*；Carroll (1963). A Model of School Learning. *Teachers College Record* 64(8), 723–733 ⚠
落地：课程切成"知识点—掌握阈值—可重试"单元。工程上必须有掌握判定（见二）与重教路径，否则只是把进度条拖慢。

**3. ZPD + scaffolding【ZPD 不可测=有争议；scaffolding 操作化后=共识】**
主张：教学应落在独立做不到、有协助能做到的区间；Wood/Bruner/Ross 把协助拆成六件事：招募兴趣、降自由度、维持方向、标记关键特征、控挫败、示范。
文献：Vygotsky (1978) *Mind in Society*（无 DOI）；Wood, Bruner & Ross (1976). *J Child Psychol Psychiatry* 17(2), 89–100. doi:10.1111/j.1469-7610.1976.tb00381.x
落地：提示强度做成 0–4 级离散梯度（复述问题→指方向→指步骤→给局部→给答案），失败升级、成功降级。不要试图量化 ZPD。

**4. Cognitive Load Theory【效应=共识；三分类可测量性=有争议】**
主张：工作记忆有限，内在负荷（材料复杂度）、外在负荷（呈现浪费）、相关负荷（图式建构）三者约束设计。
文献：Sweller (1988). *Cognitive Science* 12(2), 257–285. doi:10.1207/s15516709cog1202_4；Sweller, van Merriënboer & Paas (2019) *Educ Psychol Rev* ⚠
争议：三类负荷无法独立测量，"相关负荷"被批循环论证（de Jong 2010 ⚠）。当设计检查表用，不当可计算指标。
落地：单屏信息量上限、图文邻近、去冗余（同内容文字+朗读通常有害）、样例优先。

**5. 间隔效应 + SM-2 / FSRS【间隔效应=共识；调度算法=工程最优解，无"正确算法"】**
主张：同样复习次数，分散优于集中；最优间隔随目标保持期变长（Cepeda 2006：35 天保持目标 gap≈3–4 天，70 天≈8–12 天）。
文献：Cepeda, Pashler, Vul, Wixted & Rohrer (2006). *Psychological Bulletin* 132(3), 354–380. doi:10.1037/0033-2909.132.3.354
SM-2：Wozniak (1990) 硕士论文 + SuperMemo 文档，**非同行评审**，引用须说明。
FSRS：Ye, Su & Cao (2022). A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition Scheduling. *KDD '22*. doi:10.1145/3534678.3539081
落地：SM-2 规则简单可跑（ease-factor 更新）；FSRS 用 D/S/R 三变量 + 复习日志拟合。日志少用 SM-2 变体，单卡组 >1k 复习记录再上 FSRS。

**6. Retrieval Practice / Testing Effect【共识，效应最稳】**
主张：从记忆取出比重复输入更促长期保持；且学生主观感受与真实效果**相反**（fluency illusion：重读感觉更好但学得更差）。
文献：Roediger & Karpicke (2006). *Psychological Science* 17(3), 249–255. doi:10.1111/j.1467-9280.2006.01693.x；Karpicke & Roediger (2008). *Science* 319, 966–968. doi:10.1126/science.1152408
落地：默认交互是"先问后讲"，不是"先讲后测"；每轮至少一次复述或预测。

**7. Interleaving vs Blocking【有条件共识，边界敏感】**
主张：混合（ABCABC）比分块（AAABBBCCC）更能训练"判别题型选方法"，但主要对**易混淆的相似类别之间**有效。
文献：Rohrer & Taylor (2007). *Instructional Science* 35, 481–498. doi:10.1007/s11251-007-9015-8；元分析 Brunmair & Richter (2019). Similarity matters. *Psychological Bulletin* 145(11), 1029–1052. doi:10.1037/bul0000209（平均效应很小，被相似性调节）
落地：只在学生确实会混的相邻知识点上开 interleaving；单纯打乱题序不是 interleaving。

**8. Worked Example / 专长逆转【共识，边界清晰】**
主张：新手直接解题把工作记忆耗在手段-目的搜索上，先看完整例题学得更快；专长提升后例题帮助转负，该转为解题。
文献：Sweller & Cooper (1985). *Cognition and Instruction* 2(1), 59–89. doi:10.1207/s1532690xci0201_3；Kalyuga, Ayres, Chandler & Sweller (2003). The Expertise Reversal Effect. *Educational Psychologist* 38(1), 23–31. doi:10.1207/s15326985ep3801_4
落地：按学生模型动态切"例题:练习"比例（初学 3:1，熟练 0:1）——同一套内容的两个配置，不是两套课程。

**9. Socratic questioning【证据薄弱，不可当已验证教学法宣传】**
诚实说明：教育研究里**没有** retrieval practice 那样的大规模元分析支撑。可核的近亲证据：Graesser & Person (1994) 发现人类导师其实少问深究性"为什么"，多为短反馈+提示+断言（*AERJ* 31(1), 104–137, doi:10.3102/00028312031001104）。"苏格拉底法优于讲授"缺干净 RCT。
落地：把追问当 elicitation 手段（逼学生产出解释），增益来源是"学生说了多少"，不是提问风格。

**10. Self-explanation 与 Learning by Teaching【前者=共识；protégé effect=有争议，小样本不稳】**
主张：让学习者解释"这步为什么成立"显著提升理解；教别人/教虚拟学生提升投入。
文献：Chi, Bassok, Lewis, Reimann & Glaser (1989). *Cognitive Science* 13(2), 145–182. doi:10.1207/s15516709cog1302_1；Chase, Chin, Oppezzo & Schwartz (2009). *J Sci Educ Technol* 18, 334–352. doi:10.1007/s10956-009-9180-4
落地：固定 teach-back 环节，把解释文本做结构比对（缺哪个因果环节）。别把 protégé effect 当核心卖点。

**11. Formative Assessment【"反馈有效"=共识；效应量高度依赖反馈类型】**
主张：不评分、即时、指向"差距在哪、下一步怎么做"的反馈显著提升学习；只给对错或只给分数的反馈效应接近 0。
文献：Black & Wiliam (1998). *Assessment in Education* 5(1), 7–74. doi:10.1080/0969595980050102；Hattie & Timperley (2007). The Power of Feedback. *RER* 77(1), 81–112 ⚠
落地：反馈须含 feed up（目标）/feed back（差距）/feed forward（下一步）。产品里禁止"正确答案是 X"式反馈。

**12. Deliberate Practice【有争议，教育界误用严重】**
主张：专家水平来自有导师设计、即时反馈、反复修正弱点的高强度练习，而非天赋或单纯时长。
文献：Ericsson, Krampe & Tesch-Römer (1993). *Psychological Review* 100(3), 363–406. doi:10.1037/0033-295X.100.3.363
争议：Macnamara 等元分析发现练习时长只解释约 12% 表现方差（教育领域约 4%），并质疑 1993 研究的分析方法：Macnamara, Hambrick & Oswald (2014) doi:10.1177/0956797614535810；Macnamara & Maitra (2019) doi:10.1098/rsos.190327。"一万小时"是 Gladwell 的通俗化误读。
落地：可借鉴"针对弱点的即时反馈循环"，不是堆时长；不要用练习时长做质量指标。

---

## 二、学习者建模与知识追踪

**1. IRT / Rasch【共识，教育测量标准工具】**
主张：P(答对)=f(能力 θ − 难度 b)；Rasch 单参数 logistic，2PL/3PL 加区分度、猜对率。
文献：Rasch (1960) *Probabilistic Models*；Baker (2001) *The Basics of Item Response Theory*（免费在线）⚠
落地：每题校准需 ≥200 次作答量级；冷启动只能靠 LLM 预估难度，不可当测量值。IRT 是静态标定，不做逐题实时更新。

**2. BKT【共识基线，四参数】**
主张：每知识点 4 参数——L0 初始掌握、T 学习转移、G 猜对、S 失误；HMM 前向算法逐次更新 P(掌握)。
文献：Corbett & Anderson (1995). *UMUAI* 4(4), 253–278. doi:10.1007/BF01099821（会议版 1994，文献常引 1994）
落地：EM 拟合历史日志。先上它——最便宜、可解释、能算"何时该复习"。

**3. PFA【共识，优于 BKT 的场景明确】**
主张：用累计成功次数与失败次数做 logistic 回归，比 BKT 更贴合"练得越多越强"，天然支持跨知识点。
文献：Pavlik, Cen & Koedinger (2009). Performance Factors Analysis. *AIED 2009*, 531–538. doi:10.3233/978-1-60750-028-5-531
落地：特征就是 (知识点, 累计成功, 累计失败)，一天能实现；小数据下比深度模型稳。

**4. DKT 及质疑【有争议：方法学争议大于效果争议】**
主张：Piech 等用 LSTM 把作答序列映射为每步每知识点的掌握概率，声称优于 BKT。
文献：Piech et al. (2015). Deep Knowledge Tracing. *NeurIPS 28* ⚠
质疑：Xiong et al. (2016). Going Deeper with DKT. *EDM 2016* ⚠；Gervet et al. (2020). When Is Deep Learning the Best Approach to KT? *JEDM* 10(3) ⚠。复现结论：多数公开数据集上 DKT **不优于** BKT，AUC 提升通常 0.01–0.03，可解释性差、冷启动差、训练不稳。
落地：不要当默认。只在序列长、知识点标注缺失、可解释性要求低时考虑。

**5. KT 现状：DKVMN / SAKT / AKT / LLM-KT【进展快，无定论】**
- DKVMN（Zhang, Shi, King & Yeung, WWW 2017, doi:10.1145/3038912.3052580）：key=知识点，value=掌握状态的记忆矩阵。
- SAKT（Pandey & Karypis, AAAI 2019 ⚠）：纯 self-attention，按相关历史题加权。
- AKT（Ghosh, Heffernan & Lan, KDD 2020, doi:10.1145/3394486.3403282）：Rasch 式距离嵌入 + 单调注意力，**当前强基线**。
- LLM-KT（2023–2025）两条路：LLM 当结构增强/编码器（如 SINKT, CIKM 2024, doi:10.1145/3627673.3679760）；或 LLM 直接零样本预测——⚠后者普遍弱于训练好的 KT，但能处理无标注、开放式作答。
判断：LLM 现在更适合"生成知识结构 + 标注难度/知识点"，不是"替代 KT 做概率预测"。

**6. 知识点图谱 / 先修图【成熟度分层】**
- 专家人工标注：最可靠、最贵（ITS 时代标准）。
- 教科书结构抽取：目录层级 + 交叉引用，中等成本。
- 数据驱动：从日志学先修（A 未掌握则 B 必错 → A 先于 B），Chen et al. (2018). Prerequisite-Driven DKT. *ICDM*. doi:10.1109/ICDM.2018.00019
- 形式化：Knowledge Space Theory（Doignon & Falmagne, doi:10.1017/9781139245913.006）给出"知识状态=可达题目集合"的定义，实用部分就是闭包/前置检查。
- 数据集：MOOCRadar（SIGIR 2023, doi:10.1145/3539618.3591898）提供细粒度知识点与习题标注。
落地：LLM 抽图 + 人工抽检 + 前置闭环检查（图中 A→B 则 A 未掌握不推 B）。不要信全自动抽图。

---

## 三、对话式教学的架构模式

**1. ITS 四组件（VanLehn）【共识，架构范式】**
主张：外循环选下一题，内循环管单题内步骤级反馈；核心是**步骤级（step-based）**分析——优于答案级，且与人类辅导效果相当（interaction plateau）。
文献：VanLehn (2006). The Behavior of Tutoring Systems. *IJAIED* 16(3), 227–282 ⚠；VanLehn (2011). *Educational Psychologist* 46(4), 197–221. doi:10.1080/00461520.2011.611369
落地：LLM 教学系统最常见的失败是"只有外循环"（不停换题）或"只有答案级判定"。必须先定义 step schema。

**2. AutoTutor：期望-误解定制对话【共识（有学习增益），增益来自要点覆盖而非语言智能】**
主张：领域答案预分解为 expectation（应有要点）+ misconception（常见错误）；学生自由作答时语义匹配判断覆盖了哪些要点，缺失的用提示、追问、断言逐条补齐。
文献：Graesser et al. (1999). AutoTutor: A simulation of a human tutor. *Cognitive Systems Research* 1(1), 35–51. doi:10.1016/S1389-0417(99)00005-4；Graesser et al. (2005). *IEEE Trans Education* 48(4), 612–623. doi:10.1109/TE.2005.856149
落地：**LLM 时代最该抄的架构**——把 rubric（expectation/misconception 列表）显式写出，让 LLM 只做"匹配 + 选对话动作"。可解释、可评测、可回归。

**3. Why-Atlas / 自然语言辅导的语义匹配【历史价值大于现状】**
主张：Why/AutoTutor 系列在 Newton 力学上验证了自然语言对话辅导可行，核心是把学生输入映射到"期望要点/误解"的语义相似度（LSA 时代）。
文献：Graesser 等 Why/AutoTutor 报告（约 2004 年 CogSci 会议）⚠**具体出处与页码未能核实，不要引用为"已证实优于人类辅导"**。
落地：语义匹配今天换 embedding/LLM 判定即可，但匹配目标仍是那张 expectation 表——表在架构成立，表不在再好的 LLM 也只是聊天。

**4. 现代 LLM 辅导的三种形态【工程分层，非理论】**
(a) 单一 prompt：便宜、无状态，几乎无法保证教学一致性，适合答疑不适合教学。
(b) 多角色（tutor/student/critic 互演）：critic 检查泄题、超纲、自相矛盾；成本 2–3 倍，显著降低"直接给答案"。**属工程 trick，无学习科学背书**，实践中有效。
(c) 带学生模型的状态机：外循环（选目标知识点，来自 KT/先修图）→ 内循环（step 级判定 + 提示梯度）→ 状态写回 KT。**唯一能对教学效果负责的形态**，即 VanLehn 四组件的 LLM 重实现。
落地：以 (c) 为骨架，(b) 作内循环质量闸，(a) 只用于开放答疑。

**5.「不给答案」原则【有争议：assistance dilemma 是真实张力，非单边结论】**
主张：直接给答案更快完成任务，但减少学生自己生成的机会，长期收益下降——即时帮助与延迟收益方向相反。
文献：Koedinger & Aleven (2007). Exploring the Assistance Dilemma. *Educational Psychology Review* 19(3), 239–264. doi:10.1007/s10648-007-9049-0；因果证据见 Bastani et al. 2025（四-2）。
注意：证据支持"失败成本可承受时让学生先尝试"，**不是"永远不给答案"**；对低先验/高焦虑学生过度 withholding 可能有害（⚠交互效应证据弱）。
落地：提示梯度 + 尝试门槛（≥2 次不同错误才升级）+ 泄题检测（规则或 critic）+ 显式"我需要答案"出口（放弃记为事件写回学生模型）。

---

## 四、争议与失败教训

**1. 学习风格【已证伪，不要再提】**
主张：meshing hypothesis 在"按风格分组 + 交叉设计"的严格检验中几乎无支持；商业宣称的效益缺乏证据。
文献：Pashler, McDaniel, Rohrer & Bjork (2008). Learning Styles: Concepts and Evidence. *PSPI* 9(3), 105–119. doi:10.1111/j.1539-6053.2009.01038.x
落地："呈现偏好（要文字/要语音）"是 UX 功能，与"学习风格教学"是两件事，文案里不要混。

**2. 认知卸载与 AI 依赖【真实风险，因果证据刚出现】**
主张：把认知工作外包给工具会降低当下认知投入。土耳其高中实验：无护栏 GPT-4 辅导提升练习表现，却**降低**无 AI 时的考试成绩（约 −17%）；带护栏 tutor 版本消除负效应。
文献：Risko & Gilbert (2016). Cognitive Offloading. *TiCS* 20(9), 676–688. doi:10.1016/j.tics.2016.07.002；Bastani, Bastani, Sungu, Ge, Kabakcı & Mariman (2025). *PNAS* 122(26), e2422633122. doi:10.1073/pnas.2422633122（工作论文 2024：doi:10.2139/ssrn.4895486）；Fan et al. (2024). Beware of metacognitive laziness. *BJET*. doi:10.1111/bjet.13544
引用警告：Lee et al. (2025) 生成式 AI 与批判性思维（*CHI '25*, doi:10.1145/3706598.3713778）是**知识工作者自陈问卷，非成绩、非因果**；Gerlich (2025) doi:10.2139/ssrn.5082524 样本与测量受质疑 ⚠。
落地：护栏落到工程约束——延迟答案、强制先答、要求解释、AI 使用记为事件进学生模型。**评估必须测"无 AI 时的表现"**，否则测的是 AI 能力。

**3. 自动生成题目质量【共识：不加校验不可用】**
主张：长期问题是"流畅但不可回答、答案错、考察点漂移"；LLM 时代语言流畅不再是瓶颈，**正确性与认知层级对齐**仍是。
文献：Kurdi, Leo, Parsia, Sattler & Al-Emari (2020). A Systematic Review of Automatic Question Generation for Educational Purposes. *IJAIED* 30, 121–204. doi:10.1007/s40593-019-00186-y
落地检查表：答案可由材料唯一推出；干扰项须是真实误解而非随机；标注考察层级；去重防换皮同题；人工抽检（首版 100%，稳定后 10–20%）；监控错误率随生成批次漂移。

---

## 五、三条压缩结论

1. **骨架抄 VanLehn**：外循环 + step 级内循环 + 状态写回。LLM 只做语言，不做教学决策。
2. **学生模型先上 BKT / PFA**（可解释、便宜、够用），有日志再考虑 AKT / FSRS；DKT 不是默认选项。
3. **有强证据的教学法都是让学生产出的**：retrieval practice、self-explanation、teach-back、间隔复习。把这些替换成"讲得更清楚"的设计，都在赌一个已被反复否定的假设（fluency illusion）。
