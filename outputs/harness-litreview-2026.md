# Harness / 执行环境 / 工具契约 文献调研（判新颖性用）

> 检索时间 2026-11-07。检索窗口名义为 2024–2026 初，但 arXiv 已收录至 2026-11，**2026 年 8–11 月是本方向集中占位期**，判断新颖性必须以 2026-11 为界。
> 说明：本文件由子代理调研结果整理（子代理未落盘，此处补记，内容为其返回摘要）。

## 1. Harness / scaffold 差异对同一模型的影响

| 工作 | 年份 / 出处 | 研究的问题 | 关键发现 | 是否量化成本/浪费 |
|---|---|---|---|---|
| SWE-agent (ACI) | 2024, arXiv:2405.15793 | 接口设计（ACI）是否影响表现 | 自定义 ACI 显著提升编辑/导航/测试能力，给出 ACI 组件消融 | 摘要未量化（未核实正文数字） |
| The AI Scientist | 2024, arXiv:2408.06292 | 全自动科研流水线 | 每篇论文 < $15；可行性由端到端 harness 决定 | 是（$/paper） |
| Agentless | 2024, arXiv:2407.01489 | 是否真需要复杂自主 agent | 三阶段无 agent 流程 SWE-bench Lite 32.00%，$0.70 | 是（$/instance） |
| AI Agents That Matter | 2024, arXiv:2407.01502 | 只报准确率的评测缺陷 | 提出 accuracy–cost 联合优化 | 是（cost 为一等指标） |
| OpenHands | 2024 / ICLR'25, arXiv:2407.16741 | 通用平台 + 沙箱 + 评测接入 | 跨 15 个 benchmark | 部分 |
| HAL (Holistic Agent Leaderboard) | 2025, arXiv:2510.11977 | 标准化 harness + 三维分析（模型×scaffold×benchmark） | 21,730 rollouts / $40k；发现更高 reasoning effort 在多数 run 里降低准确率 | 是（总 $ 与 2.5B token） |
| SWE-Effi | 2025, arXiv:2509.09853 | 资源约束下 agent 有效性重排 | effectiveness 取决于 scaffold 与 base model 的整合度；提出 token snowball 与 expensive failures；token 预算与时间预算存在明确 trade-off | 是（双预算） |
| **What Does a Harness Buy? Tokens, Mostly** | 2026-10, arXiv:2610.04433 | 模型固定时 harness 买到什么 | 5 模型 × 3 生产 harness on SWE-bench Verified（447 任务）：换 harness 翻转的任务数与同 harness 重跑一样多（13%）；唯一超过噪声的 harness 效应是**损失**（OpenCode 最多 −9pp）；**同模型同任务每任务成本最多差 3×**，差异由首轮 system prompt + tool schema 前导决定、被步数放大 | **是，核心即成本归因** |
| **The Harness Is the Model** | 2026-11, arXiv:2611.06116 | 模型固定，harness 是否改变合规行为 | 4 模型 × 5 harness × 3,120 episodes：池化 87.3–92.1%，但单模型内最好/最差 harness 差 **11.5pp**，足以让排名从第一到第四 | 否（合规为主） |
| An Empirical Study of Harness Design for Coding Agents | 2026-09, arXiv:2609.20804 | 组件级 harness 消融（planning / action space / context） | 176 个匹配设置；context 管理收益来自防溢出；planning 对弱模型是准确率脚手架、对强模型是省钱；**bash-only 接口对 bash 熟练模型成本显著更低** | 是 |
| Benchmarks as Software (Terminal-Bench 2.1) | 2026-11, arXiv:2611.08417 | 基准维护债 + 资源预算是否属测量规格 | 审计出 ~30% 任务有问题；修复后准确率 +10pp、排名最多移动 3 位；**固定 wall-clock 会实质改变结论**（延长时间上限把 20pp harness gap 抹平，把 30pp gap 缩到 5pp） | 是（墙钟预算） |
| kw-bench | 2026-10, arXiv:2610.36405 | 同模型跨 4 harness 在知识工作上差异 | DeepSeek v4.1 Flash 上两个模型无关 harness 得 0.542/0.528，两个实验室 harness 得 0.00/0.00 | 部分 |
| MetaVul / Understanding Scaffolds / Life-Harness | 2026-10 / 2026-05, arXiv:2610.40721 / 2610.27157 / 2605.22166 | harness 可被搜索、优化、跨模型迁移 | harness 优化 +23~26pp 且跨模型迁移 +14.7pp；Life-Harness 报优化 token 少 8.5%/68.4% | 部分 |

## 2. 失败静默性（fail-silent）导致浪费

| 工作 | 年份 / 出处 | 研究的问题 | 关键发现 | 量化 |
|---|---|---|---|---|
| **Silent Failures in Agent-Tool Interaction**（ToolUniverse 审计） | 2026-09, arXiv:2609.26836 | agent→工具链「调用看起来成功但信息缺失」 | 15 个工具、7 类失败位点、**91 个已验证静默失败**；52 在 API 层、25 在 wrapper 层；会向下游放大 | 否（计数，不折 token） |
| **SilentProbe** | 2026-08, arXiv:2609.00035 | 生产 API 作工具时，200 + 可解析 body 掩盖语义失败 | 2,501 份 OpenAPI：仅 7.5% 声明枚举、15.2% 有任何机器可校验约束、**40.1% 把约束写在散文里**；机器可校验约束 111/111 诚实报错，散文约束 44/61 静默失败（p=2e-13）；12 模型跑完整 loop：**检出静默失败 12%、修复 0%、对用户断言假阴性 41%、编造数字 12%** | 部分（失败率，非 token） |
| When Errors Become Narratives | 2026-06, arXiv:2606.14589 | 生产 agent runtime 静默失败纵向分类 | 8 周 22 起事故 / 28 次显现；5 类分类含 **(A) environment and platform quirks**、**(C) error swallowing and dilution**；~70% 靠人看产品发现；审计是回归引擎不是预测引擎 | 否 |
| Look Before You Leap | 2026-08/09, arXiv:2609.11957 | 动作前确定性校验能否把静默失败变可恢复 | shell 静态校验器覆盖 9,930 命令 / 482 工具，抓 95.8% 非法命令（FP 10%）；**位置锚定编辑格式静默失败，内容锚定格式干净失败**；行号在错一行时污染 99.1% 文件 | 部分（FP 率） |
| Feedback That Backfires | 2026-08, arXiv:2608.23651 | 把失败反馈给模型的副作用 | （详见原文；本次未取到完整摘要） | 未核实 |

## 3. 预算 / 停止策略的类型化

本次检索**未命中**专门研究「token 成本闸（硬）vs 墙钟护栏（软收敛）应分型」的工作。相关内容只作为**评测口径的一部分**出现：

- SWE-Effi（2509.09853）：指出 token 预算与时间预算存在明确 trade-off，但未提出策略分型；
- Terminal-Bench 2.1（2611.08417）：证明固定 wall-clock 会改变 harness 间结论——**时间预算影响测量结论**，但仍是把预算当**测量参数**而非**策略对象**。

→ 这一条**目前是空白**，可作独立研究点。

## 4. 平台陷阱（cwd 丢失 / Windows `\\?\` 前缀）

- **未命中**任何论文专门研究「agent 工作目录静默丢失」或「Windows 扩展长度路径前缀对 agent 的影响」。
- 最接近的是 When Errors Become Narratives 的 **(A) environment and platform quirks** 失败类别（定性列举，无机制分析、无成本折算）。
- Silent Failures in Agent-Tool Interaction 的 wrapper 层失败（25/91）在机制上同源，但没有平台特有案例。

→ **具体到某个平台陷阱的一手归因链 + 成本折算，是空白**。

## 5. 哪些已被占 / 哪些仍是空白

**已被占（别当新贡献）**
1. 「harness/scaffold 显著影响 agent 表现」——SWE-agent(2024)、HAL(2025)、The Harness Is the Model(2026-11) 占满。
2. 「harness 决定成本，且差异来自 system prompt + tool schema」——**What Does a Harness Buy?(2026-10) 已是标题结论**。这条最容易被撞。
3. 「agent-tool 交互存在大面积静默失败」——Silent Failures(2026-09) 给出 91 例分类。
4. 「API 契约用散文写约束 → 静默失败」——SilentProbe(2026-08) 给出 p=2e-13 的强证据。
5. 「准确性必须与成本联合评测」——AI Agents That Matter(2024) 已立规范。

**仍是空白（可立）**
1. **预算策略的类型学**：成本闸（硬中止）与时长护栏（软收敛）目的不同、不应共用同一处理；**未见任何工作把它当作策略类型问题**。可给出「同任务同预算下，硬中止 vs 软收敛的成果留存率」对照。
2. **单一平台陷阱的完整归因链 + 成本折算**：从「canonicalize 泄漏 `\\?\`」→「bash 静默改在 C:\Windows 执行且 exit=0」→「模型 70.0% 命令自加 `cd /d`，消耗 16.0% 命令字符」，这条链无人做过。
3. **模型补偿行为的可测量化**：现有工作测「失败率」，不测「模型为绕开失败而付出的冗余动作量」。我们是把补偿行为当**一等观测量**。
4. **fail-silent 的成本归属**：现有工作把静默失败当**质量问题**，我们把它当**成本转移**（从环境转移到用户的 token 账单）。

## 6. 表述修正建议

1. 不要写「harness 影响成本」——已被 2610.04433 占。改写为「**当环境违约时，模型的补偿行为可被打成类型学并折算成确定成本**」。
2. 不要写「我们发现了静默失败」——已被 2609.26836 占。改写为「**我们给出一条完整归因链，把静默失败的成本落到具体字符比例**」。
3. 必须在 Introduction 显式区分 SilentProbe 的结论（模型检出率仅 12%、修复 0%）——我们的观察与之相容：**正因为模型检不出，它才选择无条件补偿**。这条相容性反而是个好论据。
