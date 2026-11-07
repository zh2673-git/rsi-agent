---
name: deepseek-paper
description: 把项目记录写成 DeepSeek 官方技术报告风格的论文：先从项目里挖研究点建证据账本，再按 DeepSeek 骨架/措辞/图表规范成稿并机检。Invoke when 要写论文/技术报告/把项目沉淀成论文，或要模仿 DeepSeek 论文风格。
origin: user
---

# deepseek-paper — DeepSeek 风格论文生产线

一句话：**证据先于主张，骨架先于措辞**。你不写「感觉像论文」的文章，你写能被账本追到数字的 DeepSeek 式技术报告。

## 何时用 / 何时不用

| 用 | 不用 |
|---|---|
| 有想法 + 项目记录，要成稿论文/技术报告 | 只写博客/周报/README |
| 要模仿 DeepSeek 的措辞、骨架、图表 | 用户已给完整 LaTeX 只要润色（直接改） |
| 要判断「我这稿像不像 DeepSeek」 | 只要摘要一段（直接套 `templates/03-摘要填空.md`） |

## 六道工序（顺序不可跳）

| # | 工序 | 产出 | 判不过的信号 |
|---|---|---|---|
| 1 | **定体裁** | 体裁判定（T/M/A/S）+ 骨架清单 | 论文要报全账却选了 M；或设了独立 Related Work 却选了 T |
| 2 | **建证据账本** | `evidence-ledger.json`（`evidence_scan` 出骨架，人补 claim/value/scope） | 正文有数字但账本 status=todo |
| 3 | **挖研究点** | 5 条挖掘线各轮一遍，每条写成 `<机制名>: <收益>` | 挖出 3 个以上「主研究点」（还在堆料） |
| 4 | **搭骨架 + 写** | 按 `references/02` 逐章填必写件 | 某章无证据 → 回工序 2 |
| 5 | **出图表** | `paper_table` / `paper_figure` 生成，不手写 | 图/表未被正文引用 |
| 6 | **机检 + 移交** | `paper_lint` G1–G12 全绿 + 评分 ≥14/20 | 有 FAIL 门禁 |

## 工序 3 的五条挖掘线（本技能的判断核心）

| 线 | 问什么 | 出什么 | 落在哪 |
|---|---|---|---|
| 异常 | 哪个现象和预期不一致？为什么？ | 反直觉可复现观察（最强） | Discussion |
| 取舍 | 放弃了什么？代价多少？ | 带代价的权衡 | 正文机制段 |
| 复用 | 哪个自研件被多处复用？ | 可画成图的机制 | Architecture 主节 |
| 失败 | 哪些尝试无效？原因？ | `Unsuccessful Attempts` | Discussion 章 |
| 成本 | 比常规省了什么？省多少？ | 成本表 + 一句省 X% | Infrastructures |

**一条线最多出一个主研究点。** 写不出 `<机制名>: <收益>` 双段式小节名的，还不是研究点。

## 硬纪律（违反就不像）

1. **没 artifact 的主张不进正文**：无对照实验的只能写 `we design/adopt`，禁止比较级。
2. **动词按创新归属选**：`pioneer`（自称首创）> `propose`（新架构/算法）> `introduce`（首次引入）> `design`（自研工程件）> `adopt`（沿用已验证件）。借来的写成 `propose` = 最严重错配。
3. **数字成对/带口径/可复算**：`N total parameters, of which M are activated for each token`；成本给 GPU hours + 单价假设。
4. **必报失败**：M 类设 `Unsuccessful Attempts` 专节，T 类 ≥1 条进 Discussion，每条带机制解释。
5. **禁用清单零容忍**：`to the best of our knowledge`、`novel`、`we argue that`、裸 `state-of-the-art`、`the author(s)`。
6. **三种体裁都不许单独设 Related Work**（A 类除外）。

## 工具（只看 JSON，别读脚本）

```
evidence_scan  扫项目 → 账本骨架（全部 todo，等人判定）
paper_table    表数据 JSON → booktabs LaTeX + Markdown（自动 best 加粗/second 下划线）
paper_figure   图数据 JSON → PNG（三线网格 + 单一强调色）
paper_lint     明文 → G1–G12 门禁报告 + 排版指纹
paper_render   Markdown → 单文件 HTML + DOCX（交付给人读的形态）
```

工具吃 `templates/05-图表数据.json` 的格式；**不许手写表里的数字**。

### 工序 6.5 交付渲染（别让用户读 `.md` 源码）

`paper_render` 把成稿转成**可直接打开**的形态。Markdown 是工作格式，不是交付格式——
用户说「正常看」时指的是 HTML（浏览器双击）或 DOCX（Word 打开）。

| 产物 | 特点 | 用途 |
|---|---|---|
| `.html` | 单文件、图片 base64 内联、自带目录锚点、`@media print` 样式 | 双击即读；`Ctrl+P` 直接存 PDF；可单文件发人 |
| `.docx` | A4、1.5 倍行距、页码、中文 `eastAsia` 字体（宋体正文 / 微软雅黑标题）、三线表、图内嵌 | 投稿附录、评审批注、Word 里改 |

**三条纪律**：

1. **图用图片语法、表用内联 Markdown 表**。`[表 1](tables/table1.tex)` 这种链接在 md 里点开
   只有 LaTeX 源码，用户看不到数据；`.tex` 只作投稿原件保留，正文必须内联。
2. **题注写成 `**表 N：…**` 单独段落**，渲染器据此识别为 caption，不会混进正文。
3. **渲染后必须验**：HTML 里 `<table>`/`<img>` 数要与源文件一致；DOCX 要能被 `python-docx`
   重新打开且 `inline_shapes`/`tables` 数正确。**OOXML 元素顺序错了 Word 会报「文件已损坏」**
   ——`w:pBdr` 必须排在 `w:spacing` 之前（`paper_render` 已处理，手改时别破坏）。

## 输出约定

产物一律写 `outputs/<论文名>/`：`01-素材卡.md`、`02-证据账本.json`、`03-大纲.md`、`04-论文.md`、`figures/`、`tables/`、`lint-report.json`。

## 验收

- [ ] `paper_lint` G1–G12 全绿，或余项在 `lint-report.json` 写明理由并经用户确认；
- [ ] `references/06-质检与反例.md` 评分项 ≥14/20；
- [ ] 正文每个数字能追到账本 `status: ok` 的条目；`outperforms` 类断言 100% 有 `compare` 证据；
- [ ] 摘要 / 贡献组 / 结论三段式三处数字一致；
- [ ] 图表由工具生成且每张被正文引用；
- [ ] 至少 1 条失败尝试带机制解释。

## 路由

| 要做的事 | 去读 |
|---|---|
| 判体裁、看 20 篇谱系 | `references/01-语料与体裁.md` |
| 搭章节、找每章必写件 | `references/02-章节骨架.md` |
| 定动词、写句子、避禁用词 | `references/03-措辞指纹.md` |
| 建账本、挖研究点、定主张强度 | `references/04-证据与主张.md` |
| 出图出表、写 caption | `references/05-图表规范.md` |
| 跑门禁、看反例 | `references/06-质检与反例.md` |
| 查 DeepSeek 论文原句/出处（20 篇取证） | `registry/ds-corpus-evidence.md` |
| 查本技能为什么这样设计（成熟度/算子/档位/单元失败信号/裁决优先级） | `registry/skill-contract.md` |
| 查行业还原（角色谱系/工件链/裁决权/真实反例/未验证假设） | `registry/profession-map.md` |
| 填素材 / 填账本 / 填空摘要 / 填图表数据 | `templates/01-项目素材卡.md`、`templates/02-证据账本.json`、`templates/03-摘要填空.md`、`templates/04-贡献与结论填空.md`、`templates/05-图表数据.json` |
