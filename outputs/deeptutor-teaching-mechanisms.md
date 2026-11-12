# HKUDS/DeepTutor 教学能力机制事实清单

基线：`main` 分支，版本字符串见 `deeptutor/__version__.py`，README 最新 release v1.7.2。能力清单的权威来源不是 README 而是模块清单 `deeptutor/modules/manifests/*.json`（含 `stages` / `tools_used` 字段）。

- 能力注册表：https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/core.json
- 能力目录（注意：与题述不同，实际子目录是 `mastery` / `solve` / `reading` / `ask_questions` 等，没有 `deep_research`、`mastery_path`、`visualize` 同名目录）：https://github.com/HKUDS/DeepTutor/tree/main/deeptutor/capabilities

## 0. 总体架构事实

- 十个能力不各自写流水线，多数是「同一个 agent loop + 自己的工具集 + 自己的系统提示块」。`capabilities/__init__.py` 原文：A loop capability is "chat engine + decoupled capability logic"：it reuses the full chat tool surface and adds its own owned tools + a system prompt block on top when active, instead of running a bespoke pipeline。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/capabilities/__init__.py
- 代码注释反复写同一条设计公理：the intelligence lives at the loop's exit — the model decides what to read and what to cite — while the deterministic parts … are engine calls behind tools。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/capabilities/reading/mode.py
- 十个能力对应的 `stages`（清单原文）：chat=[exploring, responding]；ask_questions=[responding]；deep_solve=[responding]；deep_question=[ideation, generation]；deep_research=[rephrasing, decomposing, researching, reporting]；visualize=[analyzing, generating, reviewing, concept_analysis, concept_design, code_generation, code_retry, summary, render_output]；math_animator=[concept_analysis, concept_design, code_generation, code_retry, summary, render_output]；mastery_path=[responding]；immersive_reading=[responding]；video_lesson=[code_generation, render_check, render_output]。

## 1. chat

- 问题/输入输出：Agentic chat: an exploring agent loop with tools, followed by a respond stage that streams the answer。工具：brainstorm / web_search / paper_search / zotero_search / reason / geogebra_analysis / imagegen / videogen。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/core.json
- 实现仅 6 行：`ChatCapability.run` 直接调用 `AgenticChatPipeline`。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/chat/capability.py

## 2. ask_questions

- 目的：Ask the user high-value questions to fill in missing context, then complete the original request with their answers。工具只挂 `ask_user` 一个。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/core.json
- 机制：不是苏格拉底式追问，而是「上下文补全式访谈」。`AskQuestionsCapability` 设 `context.metadata["ask_questions_mode"]=True` 并以 `initial_tool_choice="ask_user"` 启动 chat pipeline。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/capabilities/ask_questions/capability.py
- 提示词硬约束原文：Begin this selected turn by calling `ask_user` exactly once … Ask 1–4 specific, high-information questions in one call … never repeat a question the user already answered … After the user answers, continue the original request in the same turn。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/capabilities/ask_questions/prompts/en/system.md

## 3. deep_solve

- 目的/输出：Multi-step problem solving driven by the chat agent loop；stages 只有 responding。工具：solve_plan / solve_finish_step / solve_replan + rag / exec / geogebra_analysis / reason。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/solve.json
- 机制：无独立 pipeline，`DeepSolveCapability` 标记 `solve_mode` 并把 max_rounds / max_replans / temperature / max_tokens 注入 chat loop；确定性部分是 `SolveSession` 持 plan、per-step gate、replan 预算（the deterministic spine (commit to a plan, don't skip steps, bounded replan) is engine state read and written through tools）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/capabilities/solve/capability.py
- 论文给出的三阶段（比代码里的 stages 细）：Stage ① Personalized Investigation（先调查再定计划，把 q 分解成 meta-questions）、Stage ② Step-by-step Guided Solving（self-notes + hierarchical compression + adaptive replanning）、Stage ③ Evidence-based Iterative Writing（每条外部事实带可追溯引用）。https://arxiv.org/html/2604.26962v3

## 4. deep_question

- 目的/输出：Fast question generation (Template batches -> Generate)；CLI 别名 `quiz`；工具 rag / web_search / exec。stages=[ideation, generation]。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/questions.json
- 真实步骤（`pipeline.yaml` 三大阶段 + 一次修复）：Explore（agentic loop，`THINK`/`TOOL`/`FINISH` 三标签协议）→ Plan（首行 `PLAN` + JSON {analysis, templates[]}）→ 逐题 quiz_step（严格 JSON schema）→ repair（schema 不合时单次修复）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/question/prompts/en/pipeline.yaml
- 题型与规模：choice（恰好 A/B/C/D 四项）/ concept（true-false）/ fill_in_blank（题干必含唯一 `____`）/ short_answer / written / coding；difficulty 仅 easy/medium/hard；plan 必须产出恰好 {num_questions} 条且 topic 两两不同。同上。
- 个性化线索：prompt 内含 "Prior quiz history" 段，要求把最早几轮当诊断（which sub-topics, which difficulty, which question type 答错），后续检索偏向弱项且不重复旧题。同上。
- 论文：两阶段（④ Personalized Idea Generation + evaluator-driven filtering/ranking → ⑤ Critic-Guided QAE），关键设计是 validator 与 generator 不共享推理链（because the validator shares no reasoning chain with the generator, it must independently verify correctness）；coding 题额外沙箱执行。https://arxiv.org/html/2604.26962v3
- Bloom 分类法：未查到。pipeline.yaml / idea_agent.yaml 全文无 bloom/taxonomy。

## 5. deep_research

- 目的/输出：Agentic-loop deep research with iterative report generation。stages=[rephrasing, decomposing, researching, reporting]；工具 rag / web_search / paper_search / preprint / research_audit / research_lit / exec。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/research.json
- 是「先分解再检索再综述」，且分两段交付：首轮返回 `outline_preview`（子题目由用户编辑确认），第二次调用带 `confirmed_outline` 才进入 Phase 3+4。per-block research loop 用 `THINK` / `TOOL` / `APPEND` / `FINISH` 四标签。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/research/capability.py
- 四种模式 × 四档深度（notes / report / comparison / learning_path；quick / standard / deep / manual），子题目数 auto=2/4/6、manual=2/3/4；每模式有 `min_section_length` 与后置校验 `validate_output`（notes 必须有 `> **Definition` 与 Key Takeaway；comparison 必须有 Markdown 表格；learning_path 必须有 Checkpoint）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/research/mode_strategy.py

## 6. visualize

- 目的/输出：Generate a validated visualization with any installed visualizer type, or render a Manim animation/storyboard artifact。工具只有一个 `submit_visualization`。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/visualize.json
- 构件：不是生成位图，而是生成可渲染代码/JSON。内置 visualizer：svg / mermaid / mindmap / chartjs / html，另加 manim_video / manim_image（转交 Manim 子进程），bundled geogebra。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/visualizers/builtin.py
- 对应校验器（可机检要求）：SVG 必须含 `<title>` 与 `<desc>`；HTML 必须是完整文档且含 viewport、`<button>/<input>/<select>` 之一、reset、`aria-label` 或 `<label>`；chartjs 的 type 走 8 项白名单且每个 dataset 需 label + 非空 data；geogebra 命令 2–100 条 + 必填四边界 view。同上。
- 安全：visualize turn 把可调用内置工具收窄到 `_VISUALIZE_SAFE_BUILTINS`（rag / kb_files / read_source / read_memory / list_notebook / read_skill / web_fetch / ask_user），刻意排除 exec / write_memory / cron 等。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/visualize/capability.py
- 自定义 visualizer 是声明式 zip 包（visualizer.json + index.html + renderer.js/css），跑在无网络的 script-only sandbox，payload 先过本地 JSON Schema。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/visualizers/README.md

## 7. math_animator

- 目的/输出：Generate math animations or storyboard images with Manim；依赖 `manim>=0.19.0` + 可执行 `ffmpeg` / `latex`；stages=[concept_analysis, concept_design, code_generation, code_retry, summary, render_output]；默认 output_mode=video、quality=medium。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/renderer-manim.json
- 与 visualize 的关系：visualize 的 manim_video/manim_image 分支复用同一个 `MathAnimatorPipeline`（代码注释：Mirrors `MathAnimatorCapability.run`）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/visualize/capability.py

## 8. mastery_path

- 目的/输入输出：Mastery-based tutoring: a dedicated agent loop drives an adaptive mastery path with a hard, per-type mastery gate and spaced review。挂 17 个 `mastery_*` 工具（prepare_lesson / status / quiz / grade / assess / build / revise / profile / switch …）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/mastery.json
- 学习阶段枚举（`LearningStage`）：diagnostic → explain → feynman_check → practice → error_diagnosis → review → completed。错误分类 `ErrorType`：structural / deviation / application / metacognitive。知识点类型 `KnowledgeType`：memory / concept / procedure / design。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/models.py
- 掌握度门（硬阈值）：memory / procedure 走量化门 0.9；concept / design 走质性门（Feynman 式讲解由 `mastery_assess` 判定）。原文：QUANTITATIVE_GATE = {MEMORY: 0.9, PROCEDURE: 0.9}，注释 ~0.9 mirrors Alpha School's "90% before you advance"。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/policy.py
- 推进机制：没有阶段计数器，`next_objective` 的优先级是 ①有待答问题 ②有到期复习 ③第一个未掌握目标 ④全部完成；action 取值 answer_pending / review / probe / teach / practice / assess / complete。原文：advancement is *computed from what is mastered*, never tracked by a stage counter … an objective the learner has already proven is skipped (the "test out" / compression path)。同上。
- 掌握度算法：`compute_mastery` = 近期加权正确率（权重 0.5/0.7/0.85/0.95/1.0），加低置信封顶（1 次作答 ≤0.5、2 次 ≤0.8）。模块 docstring 明确这是可替换点：To plug in a richer model (e.g. an IRT/BKT estimate or a tuned spec), replace `compute_mastery` alone。→ BKT/DKT 未实现。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/mastery.py
- 间隔重复：`SpacedRepetitionScheduler` 持 stability / difficulty / retrievability / desired_retention，retrievability = exp(-elapsed/stability)，按知识类型给默认间隔序列（memory [0,1,3,7,14,30,60] 天、concept [3,7,14,30]、procedure [3,7,14]、design [14,28]），desired_retention 限 0.7–0.99、默认 0.9；`forgetting_risk` 综合逾期天数、错题、lapse 次数。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/scheduler.py
- 题库侧是另一套：docs-for-dev/PRACTICE.md 原文「该版本采用可解释、可测试的 **SM-2 风格冷启动规则**」，「它没有训练每位用户的遗忘曲线，也不声称已实现 FSRS」；反馈 Again/Hard/Good/Easy → 1 天 / ×1.2 / ~3 天 / 更长，最长 365 天。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/docs-for-dev/PRACTICE.md
- 掌握度持久化：有数值化持久化。存储已从每路径一个 JSON 迁到工作区级 SQLite（`mastery.sqlite3`），主表 `mastery_paths(path_id, state_json, revision, …)` 走 compare-and-swap；另有 `mastery_interactions`（题目/答案事务与幂等）、`mastery_topic_meta`、`mastery_topic_sources`、`mastery_events`。数值字段 `LearningProgress.mastery_levels: dict[str, float]` 与 `qualitative_mastery: dict[str, bool]` 存在 `state_json` 里。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/storage.py
- 出处路径：workspace 的 `learning/` 目录（`get_workspace_dir() / "learning"`，经 `prepare_mastery_v2_root` 做 V1→V2 迁移）。同上。

## 9. immersive_reading

- 目的/输出：Read a document alongside the assistant, which cites the exact page or section behind every claim。工具：reading_list_tabs / reading_switch_tab / material_outline / search_material / read_material / view_figure / reader_goto / reader_annotate / web_search / exec / reason。stages=[responding]。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/reading.json
- 机制：没有专有流水线。原文 There is no bespoke pipeline: the standard agentic chat loop IS the reader … the *loop capability* activates on whether a document is actually open（模式选了但没开文档 → 就是普通 chat turn）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/capabilities/reading/mode.py
- 是否「分段+提问」：默认不是。段落级动作靠 5 个 reading extension 提供（`deeptutor.reading_extensions` entry points）：read_aloud / guided_learning / vocabulary / quiz / translation。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/reading.json
  - guided_learning：从一段已验证选文生成「一句话焦点 + 恰好 3 步」，步骤 8–280 字，且必须 Do not give the final answer，方向固定为 定位证据 → 建立联系 → 用自己的话表达。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/reading/study_guidance.py
  - quiz：恰好 3 道单选、每题 4 个互异选项；`evidence` 字段必须能在当前可见文本中找到（`evidence_key(...) not in context_key` 即报错），展示前移除。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/reading/quiz.py

## 10. video_lesson

- 目的/输出：Generate an animated video lesson (Remotion) that plays in the browser；依赖 `edge-tts` + 可执行 `node` / `npm`；stages=[code_generation, render_check, render_output]；无工具（tools_used 为空）。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/video-lesson.json
- 机制：写 TSX（Remotion）源码 → npm 编译 + 逐帧检查 → 输出单文件 `lesson.html` 播放页；`MAX_ATTEMPTS=4`、编译通过后再跑至多 `MAX_LAYOUT_ROUNDS=2` 轮版式碰撞修复；编译好的 bundle 会先备份，版式修复失败不回退已可用的课。旁白用 edge-tts，`narrated` 标记是否真的有音轨。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/agents/video_lesson/capability.py

## 11. 需要核实的事实

| 事实 | 判定 | 出处 |
|---|---|---|
| 关联论文 | 真。arXiv:2604.26962，标题《DeepTutor: Towards Agentic Personalized Tutoring》，Tech Report，v3 2026-07-09 | https://arxiv.org/abs/2604.26962 |
| HKUDS = HKU 的实验室 | 真，但全名不是 "HKU Data Science Lab"。GitHub 组织名称为 "✨Data Intelligence Lab@HKU✨"，location Hong Kong，blog sites.google.com/view/chaoh | https://api.github.com/orgs/HKUDS |
| 论文作者单位 | The University of Hong Kong；作者 Bingxi Zhao*, Jiahao Zhang*, Xubin Ren, Zirui Guo, Tianzhe Chu, Yi Ma, Chao Huang | https://arxiv.org/html/2604.26962v3 |
| 论文评测 | 自建 TutorBench（五学科大学课程 + profile 驱动学生模拟器）；自报 personalized metrics 平均 +10.8%，agentic reasoning 在五个 backbone 上 +29.4% | https://arxiv.org/abs/2604.26962 |
| kb 检索栈 | 全都有：`pageindex>=0.2.10`、`llama-index>=0.14.12`、`bm25s>=0.3.14`、`llama-index-retrievers-bm25`、`llama-index-vector-stores-faiss`、`faiss-cpu` | https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/modules/manifests/knowledge.json |
| 检索管线 | `services/rag/pipelines/` 下 8 种：llamaindex / pageindex / graphrag / lightrag / lightrag_server / ima / weknora / kiwix | https://api.github.com/repos/HKUDS/DeepTutor/contents/deeptutor/services/rag/pipelines |
| 融合方式 | 知识图谱 + 稠密向量的双索引，候选集 reciprocal rank fusion（RRF）后去重截断 | https://arxiv.org/html/2604.26962v3 |
| KB 类型 | indexed（默认）/ 连接式：obsidian、linked、subagent、lightrag_server、ima、weknora、marginnote4、kiwix | https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/knowledge/kb_types.py |
| mastery 有数值持久化 | 真，SQLite `mastery.sqlite3` + `mastery_levels` 浮点字典 | https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/storage.py |
| 学生模型 / 学习者画像 | 有两套并存：(a) 路径内 `LearnerProfile`（prior_knowledge / target_level / time_budget / preferences / teaching_strategy=probe_first|teach_first / teaching_preferences / teaching_observations）；(b) 跨界面三层记忆 L1 `trace/<surface>/<date>.jsonl` → L2 `L2/<surface>.md` → L3 `L3/{recent,profile,scope,preferences}.md` | https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/models.py ；https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/services/memory/paths.py |
| 论文与代码的画像差异 | 论文描述的是 Trace Forest（三级节点树 + D_s/D_w/D_r 三个记忆 agent + TraceToolkit 的 SearchTrace/ListTraces/ReadNodes）；代码里落地的是 Markdown 三层记忆 + 路径内 LearnerProfile，未见名为 Trace Forest / TraceToolkit 的实现 | https://arxiv.org/html/2604.26962v3 ；https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/services/memory/store.py |

## 12. 学习科学依据：写在注释里的原话

- mastery learning / 90% 门：`policy.py` — The gate is the heart of mastery-based learning … ~0.9 mirrors Alpha School's "90% before you advance"。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/policy.py
- 诊断优先 + test-out：同上 — an objective the learner has already proven is skipped (the "test out" / compression path)。
- 间隔重复：`scheduler.py` 模块名 `SpacedRepetitionScheduler`；PRACTICE.md 自述 SM-2 风格、不声称 FSRS。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/scheduler.py
- Feynman 式自述：`LearningStage.FEYNMAN_CHECK`、`mastery_assess` 是 "a Feynman-style explanation judged by the tutor"。https://raw.githubusercontent.com/HKUDS/DeepTutor/main/deeptutor/learning/policy.py
- scaffolding / ZPD / 形成性评价 / 认知负荷：只在论文里显式引用（Wood et al. 1976 scaffolding；Vygotsky 1978 ZPD 用于决定讲解深度与语气；Black & Wiliam 1998 与 Shute 2008 支撑闭环；Ainsworth 2006 / Mayer 2003 支撑「表征选择是教学行为」）。代码注释未见这四个词。https://arxiv.org/html/2604.26962v3
- 未查到：Bloom 分类法、BKT/DKT 实现、苏格拉底式追问（ask_questions 是上下文补全访谈而非诘问）、刻意练习（deliberate practice）。
