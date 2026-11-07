# 交付索引 — 两篇论文 + 调研 + 证据

> 生成时间 2026-11-07（数字切点 2026-11-07T13:35:24）。论文与图表在本目录 `docs/papers/`，三份调研报告在 `outputs/*.md`（已入库）。

## 怎么读（按你想要的形态选）

每篇论文有 **4 种格式**，内容完全一致，按用途挑一个：

| 想做什么 | 打开这个 | 说明 |
|---|---|---|
| **浏览器里正常看** | `04-xxx.html` | **推荐**。双击即开，图片已内嵌、带目录锚点、排版好 |
| **Word 里看/改/评审批注** | `04-xxx.docx` | A4、页码、中文宋体/微软雅黑、三线表、图内嵌 |
| 打印或存 PDF | 同 HTML | 浏览器里 `Ctrl+P` → 另存为 PDF，打印样式已适配 |
| 投 LaTeX 模板 | `04-xxx.md` + `tables/*.tex` | `.tex` 是投稿原件，正文里表格已内联不必看它 |

**中文版就在这里**（之前只写了文件名没给链接，容易以为缺失）：

| | 中文版 | 英文版 |
|---|---|---|
| 论文 A | `04-论文A-Frozen-Strata-zh.html` / `.docx` / `.md` | `04-论文A-Frozen-Strata-en.*` |
| 论文 B | `04-论文B-Reconstructibility-Gap-zh.html` / `.docx` / `.md` | `04-论文B-Reconstructibility-Gap-en.*` |

四篇 × 3 种格式 = 12 个文件，全部已生成并实测可打开。

## 怎么查看图表

**HTML / DOCX（推荐）**：图已内嵌、表已排版，打开就是成品，无需任何操作。

**Markdown 源码**：图用 `![图 1](figures/fig1.png)` 图片语法，需支持渲染的编辑器而非纯文本查看——
VS Code `Ctrl+Shift+V` 预览、Typora / Obsidian / GitHub 网页直接打开。

- `figures/fig1.png` 1258×599 — 论文 A 图 1，三层代码规模
- `figures/fig2.png` 1227×599 — 论文 A 图 2，契约税
- `figures/figB1.png` 1219×626 — 论文 B 图 1，三层保真度

**表格**：在 md 里已内联为 Markdown 表格（不是链接），任何渲染器都能看到。原始 `.tex` 版在 `tables/`
下，供投 LaTeX 模板时使用。

> 修订记录 2026-11-07（二次）：用户反馈「md 里图表看不到、中文版找不到」。实测确认两处真缺陷：
> ① 表格原为 `[表 1](tables/table1.tex)` 链接，点开只见 LaTeX 源码；论文 B 的图误写成普通链接。
> ② 中文版存在但 INDEX 只列文件名、无链接，形同隐藏。
> 已修：表格全部内联、论文 B 图改图片语法、新增 `paper_render` 工具产出 HTML+DOCX。
> 实测：HTML 内 `<table>/<img>` 数与源一致（A 2/2、B 3/1），DOCX 可被 `python-docx` 重开且
> 表图计数一致，OOXML 元素顺序校验 0 违规。

## 一、先看这个

**`00-方向讨论.md`** — 方向裁决与文献重定位。先读它，否则会看不懂为什么最终写的是这两篇而不是原来那六个点。

**关键结论（v3）**：原先设想的几条主张在 2026 年被密集占位，其中一条被自己的实测推翻。因此最终成品不是「把六个点都写成论文」，而是：

- 一条主张被**证伪**（"无损压缩"），改写成一个可测量的缺口 → **论文 B**
- 其余被收窄/合并，加上新增的硬数据 → **论文 A**（跨层总账）

## 二、两篇论文

| | 论文 A | 论文 B |
|---|---|---|
| 标题 | Frozen Strata: Layered Self-Modification Governed by Immutability Boundaries | The Reconstructibility Gap: Auditing Lossy Compaction in Long-Lived Agent Sessions |
| 体裁 | T 技术报告（跨层总账） | M 方法论文（一个契约 + 一次测量） |
| 英文 | `04-论文A-Frozen-Strata-en.md` | `04-论文B-Reconstructibility-Gap-en.md` |
| 中文 | `04-论文A-Frozen-Strata-zh.md` | `04-论文B-Reconstructibility-Gap-zh.md` |
| lint | 10/12（G1/G2 体裁豁免，见 `lint-report-A.json`） | 10/12（同，见 `lint-report-B.json`） |
| 核心数字 | 1:24 内核比、4 条审计信号、70.0%/16.0% 契约税、56.2% 退役比、**闸门 9/11 正确并发现 2 处漏放** | 2.45% 保真度、5 条要求满足 1 条、15 次压缩/1 次回滚、432:1 最坏压缩 |
| 一句话卖点 | 自我改进系统的设计对象是「哪一层不许改」，冻结本身产出审计信号 | 声称「日志为真相源」的系统，在有损压缩之后能否重建——没人测过，我们测了 |

## 三、调研报告（判新颖性用，全部带可核验 URL）

| 文件 | 覆盖 | 对成品的作用 |
|---|---|---|
| `outputs/self-evolving-agents-litreview-2026.md` | DGM / Gödel Agent / ADAS / SICA / SEAL / 安全边界 20+ 篇 | 确认「冻结层」作为工程主张已被 Unfireable Safety Kernel 占满；确认「退役率」指标仍是空白 |
| `outputs/context-memory-literature-review.md` | ACE / pi / MemGPT / Zep / E-mem / ActiveGraph / 重放断言 | **直接推翻「无损压缩」**；确认「压缩×严格重放」交叉点空白 |
| `outputs/harness-litreview-2026.md` | harness 差异 / 静默失败 / 预算策略 / 平台陷阱 | 收窄 R1：harness 决定成本已被占，但「契约违约→补偿行为→成本折算」是空白 |

### 三条最重要的文献裁决

1. **"无损压缩"不成立** —— 自测：sidecar 保真率 2.45%，缺全部重建字段。已改写为论文 B 的"可重建性缺口"。
2. **"冻结层保安全"不能主张** —— `arXiv:2606.28639` 已证明监督者之塔无用，需靠设计限制重写 + frozen reference。论文 A 因此只主张"让缺陷可观测"，不主张安全。
3. **"harness 影响成本"已被占** —— `arXiv:2610.04433` 已是标题结论。论文 A 收窄到"契约违约的补偿成本"。

## 四、证据与图表

- **`02-证据账本.json`** — **28 条**证据（原 26 + E-GATE-02/03），全部 `status: ok`，每条附可执行的 `recompute`；切点 `2026-11-07T13:35:24` 记在账本 `meta.cut_point`。正文每个数字可追到条目 id（E-XXX-NN）。
- **图表**（全部由 `paper_table` / `paper_figure` 生成，无手写数字）：
  - `figures/fig1.png` — 三层代码规模（论文 A 图 1）
  - `figures/fig2.png` — 契约税（论文 A 图 2）
  - `figures/figB1.png` — 三层保真度（论文 B 图 1）
  - `tables/table1.tex`、`table2.tex` — 论文 A 表 1、2
  - **`tables/tableA3.tex` — 论文 A 表 3：晋升闸门混淆矩阵（E1 产物）**
  - `tables/tableB1.tex`、`tableB2.tex`、`tableB3.tex` — 论文 B 表 1、2、3

### E1 闸门混淆矩阵（本轮新增实测）

`scripts/e1_gate_matrix.py` —— 调**真实** `skill_state.promote()`，把账本重定向到临时目录，
不重写任何判定逻辑。

```
11 例：9 坏 + 2 好
  坏样本 9 → 拦 8（tp=8）      好样本 2 → 放 1（tn=1）
  漏放 fn=2   误拦 fp=0   准确率 0.8182
```

两个漏放不是噪声，是**发现的缺陷**：

| 漏放 | 症状 | 根因 |
|---|---|---|
| `probe-name-acceptance` | 无验收段却通过 validate | `ACC_RE` 全文搜索关键词，H1 标题 `<技能名>` 含 acceptance 即喂中 |
| `bad-self-eval-only` | 3 案例全 `judge` 仍晋升 | `promote()` 只查命令行 `--signal`，从不读 `cases.jsonl` 的 `signal` 字段 |

两处**均未修补**，论文如实报告——修补清单已写入 §8 未来方向。重算：`python scripts/e1_gate_matrix.py`。

## 五、本轮新增的实测数据（论文的地基）

| 测量 | 结果 | 复算方式 |
|---|---|---|
| 侧车保真率 | **2.45%**（491,611 / 20,041,120 字符） | `python scripts/e7_fidelity.py --paper` |
| 重建字段完备性 | 5 条要求满足 **1** 条 | 逐字段检查写路径 |
| 压缩事件 | **15 次，最坏 432:1**（761,547 → 1,764） | 同上（`worst_compression`） |
| 工具结果截断 | **2,223 / 13,344**（单会话峰 14.3%） | 同上（`memory_truncated_hits`） |
| cd 前缀率 | **70.0%**（3,760 / 5,368 次 bash） | `python scripts/e3_harness_tax.py --paper` |
| 前缀字符占比 | **16.0%**（201,868 / 1,261,369） | 同上（`prefix_share_pct`） |
| 真实 token 用量 | **229.42M** 输入输出 + 567.45M 缓存 | `chat_summary.tokens` 聚合 |
| 补丁存活 | **60 活跃 / 77 退役**（退役占 56.2%） | 文件计数 |
| 测试 | **55 passed**（pytest 6.97s） | `python -m pytest -q` |

> **一个切点，全部数字。** 上表所有 trace/events 统计都取同一事件时间切点
> `2026-11-07T13:35:24`（两个脚本的 `--paper` 即此值，按每行 `ts` 过滤），
> 因此结果对后续对话追加的行**永久不变**、可逐位复现。
> 早先版本曾用两个不同时刻分别统计 traces 与 events（13:26 / 13:31），
> 混算出的 2.44% 无法复算——这是本轮修掉的一个真实缺陷，两篇论文与账本已同步到 2.45%。
>
> trace 语料本身**不入库**（`runtime/plugins/memory/data/` 在 `.gitignore` 内，含本项目工作会话），
> 入库的是测量脚本；论文 B 的表述已据此改为「发布流程，不发布语料」。

## 六、诚实边界（写进 Limitations 的那几条）

1. `active` 技能 **0 个**、账本 **1 条**记录 → 闭环未在时间上收敛，正文动词已锁 `we design / we implement`，**没有** `we demonstrate that the system self-evolves`。
2. 无外部 benchmark → **全文零比较级断言**（`outperforms`/`surpasses` 各 0 处），G12 因此自动通过。这不是遗漏，是主动限制。
3. 单机、单用户、Windows-only、无多 seed。
4. 论文 B 是**单系统测量，不是 benchmark**，正文已显式限定"2.45% 刻画这套实现而非这类系统"。

## 七、下一步建议（按性价比排序）

| 优先级 | 动作 | 成本 | 收益 |
|---|---|---|---|
| ~~1~~ ✅ | ~~**E1 闸门混淆矩阵**：注入 6 类坏技能 + 2 个好技能~~ **已完成** | ~0（纯脚本） | 论文 A §6 从"设计陈述"变"11 例中 9 例正确"，并实测发现 2 处漏放 |
| 1 | **修补 E1 发现的 2 处漏放**：验收检查改为章节结构判定；`promote` 读取逐案例 `signal` | 低 | 漏放 2→0，闸门才敢称"可靠"；同一矩阵可直接作回归 |
| 2 | **E7 落地为测试**：把本轮的保真度探针 + E1 矩阵写成 pytest 案例 | ~0 | 论文 B 的契约变成可回归的验收 |
| 3 | **E2 四档隔离代价表**：同插件 × 四档 | 低（本机） | 论文 A 的 K1 从"支持四种"变"有代价曲线" |
| 4 | **E4 硬中止 vs 软收敛配对** | 中 | 补上论文 A §5 承认缺的那个实验 |
| 5 | **E5 外部基准**（SWE-bench-lite 20 例） | 高 | 唯一能解锁比较级断言、也是 G1 通过的唯一途径 |
