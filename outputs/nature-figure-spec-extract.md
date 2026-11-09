# Nature 图表规范 → 可机械执行条目提取

来源（均为 nature.com 官方页，2026-11 抓取）：
- `nature.com/nature/for-authors/formatting-guide`（Formatting guide，含 Table / Figure legends / Extended Data 节）
- `nature.com/nature/for-authors/final-submission`（Final submission，含 Lettering / Sizing / Line weights / DPI）
- `research-figure-guide.nature.com/figures/preparing-figures-our-specifications/`（Graphs / Text / Resolution / Scale bars）
- `research-figure-guide.nature.com/figures/building-and-exporting-figure-panels/`（Sizing / Panel arrangement / Accessibility / Wong 色板）
- `nature.com/documents/Extended_Data_guide.pdf`、`nature.com/documents/Final_guide_to_authors.pdf`、`nature.com/documents/nature-paper-composition.pdf`
- `nature.com/documents/nr-reporting-summary-flat.pdf`（Statistics 表单，逐条硬要求）
- `nature.com/nature-portfolio/editorial-policies/reporting-standards`（Data / Code availability）

---

## A. 图注（figure legend）结构

| # | 硬要求 | Nature 原句 | 对技术报告的借鉴价值 |
|---|---|---|---|
| A1 | 图注 = 一句整图标题 + 逐 panel 简述 + 符号定义，三段式固定顺序 | "Each figure legend should begin with a brief title for the whole figure and continue with a short description of each panel and the symbols used." | 把「是什么 / 每个子图 / 符号」拆成三个位置，可用正则分三段校验；DeepSeek 现状的 caption 常把三者混成一段。 |
| A2 | 图注里**必须**定义误差棒与全部统计量 | "All error bars and statistics must be defined in the figure legend, as discussed above." | 一句可机检的硬话：图注内出现 `±`/`bar`/`error` 就必须出现 `s.d.`/`s.e.m.`/`CI` 之一。 |
| A3 | 图注不得超过 300 词，且不得复述方法细节 | "Legends should be fewer than 300 words each." + "If the paper contains a Methods section, legends should not contain any details of methods." | 给出上限与「细节下沉」方向：报告正文有第 3 章方法时，图注不该再讲实现。 |
| A4 | 能进图注的文字就不要压在图上；比例尺代替放大倍数 | "Where possible, text, including keys to symbols, should be provided in the legend rather than on the figure itself." + "Scale bars should be used rather than magnification factors." | 图内文字量是可量化指标（图内标签数 vs 图注词数）；图像类图必须带 scale bar 而非 "×200"。 |
| A5 | 比例尺/文字不得压进像素层，须独立可编辑层 | "please do not flatten the scale into the image. Keep the scale bar and any text on a separate, editable layer." | 对应工程侧的「文字用矢量层、不烧进位图」，可直接写成导出脚本的强制项。 |

## B. 排版：字号 / 线宽 / 分辨率 / 栏宽 / 字体

| # | 硬要求 | Nature 原句 | 借鉴价值 |
|---|---|---|---|
| B1 | 字号区间 5–7 pt（panel 标签 8 pt 例外） | "Maximum text size for all other text should be 7 pt; minimum text size should be 5 pt." | 双向阈值（上下限都有），比「字号别太小」可执行得多。 |
| B2 | 线宽 0.25–1 pt（final size） | "Line weights and strokes should be set between 0.25 and 1 pt at the final size (lines thinner than 0.25 pt may vanish in print)." | 线宽是可从绘图 rcParams 直接读出的数值门禁。 |
| B3 | 照片类图 ≥300 dpi（在线校样上限 450 dpi），禁止插值伪增 | "All photographic images must be supplied at a minimum of 300 dpi at the maximum size they can be used." + "Artificially increasing an image's resolution in an artwork program will not improve its quality." | 导出 dpi 是文件元数据可查项；同时禁掉「放大再号称高清」这条常见作弊。 |
| B4 | 栏宽 89 mm 单栏 / 183 mm 双栏 / 120–136 mm 一栏半，整体深度 247 mm（另有页面最大高 170 mm） | "Nature's standard figure sizes are 89 mm wide (single column) and 183 mm wide (double column). The full depth of a Nature page is 247 mm. Figures can also be a column-and-a-half where necessary (120–136 mm)." | 定宽出图，杜绝「按屏幕比例出图、投稿再缩」；**注意** formatting-guide 另写 90/180 mm + 170 mm，官方两个页面数值不一致，工程化时应以 89/183 为准。 |
| B5 | 无衬线、全篇同一字体（Helvetica/Arial） | "Lettering should be in a sans-serif typeface, preferably Helvetica or Arial, the same font throughout all figures in the paper." | 「全篇同一字体」是跨图一致性检查，可用字体名集合去重判。 |
| B6 | 图型硬清单：必须有轴线与刻度、轴标签带单位括号；禁网格线/图案/阴影 | "We require: Axis lines and tick marks to be included; All axes to be labelled with units in parentheses, e.g. Data (unit)" / "We avoid: Background gridlines … Patterns" | 正反两列（require / avoid）本身就是 checker 的规则表结构。 |

## C. 子图（panel）标注

| # | 硬要求 | Nature 原句 | 借鉴价值 |
|---|---|---|---|
| C1 | 小写、直立、粗体、8 pt，不带括号 | "Separate panels in multi-part figures should each be labelled with 8 pt bold, upright (not italic) a, b, c." | 明确落到「大小写 + 斜体 + 字号」三属性，可逐项查；与 DeepSeek 惯用的 `(a)` 括号式不同。 |
| C2 | panel 按字母序排列，且尽量少留白、居中 | "panels in an alphabetical order wherever possible" + "minimizing white space and with panels in the centred on the page" | 字母序是可机检的（读图内标签序列）；留白率可从布局框算。 |
| C3 | 多 panel 只在逻辑相连时使用；各 panel 需能同倍率缩小仍清晰 | "Figures should not contain more than one panel unless the parts are logically connected; each panel of a multipart figure should be sized so that the whole figure can be reduced by the same amount" | 反「拼图凑数」条款：panel 数与正文引用次数可交叉校验。 |
| C4 | Extended Data panel 用 `"a"`, `"b"`，与正文图同一套标注习惯 | "For figures with multiple panels, label parts "a", "b", etc" (Extended Data guide) | 正文图 / 扩展图标注体系必须同构，避免两套规律。 |

## D. 统计报告

| # | 硬要求 | Nature 原句（Reporting Summary, Statistics 节） | 借鉴价值 |
|---|---|---|---|
| D1 | 每组/每条件的精确 n（离散数字 + 单位） | "The exact sample size (n) for each experimental group/condition, given as a discrete number and unit of measurement" | 把 n 写成「数字 + 单位」，而不是含糊的 "several runs"。 |
| D2 | 说明是独立样本还是同一样本重复测量 | "A statement on whether measurements were taken from distinct samples or whether the same sample was measured repeatedly" | 直接对应 ML 报告里的「seed 数 vs 重复评测同一 checkpoint」。 |
| D3 | 必须给中心趋势 + 离散度/不确定度类型 | "A full description of the statistical parameters including central tendency (e.g. means) … AND variation (e.g. standard deviation) or associated estimates of uncertainty (e.g. confidence intervals)" | 误差棒类型不是可选项，而是必填字段。 |
| D4 | 检验统计量 + 效应量 + 自由度 + 精确 P 值 | "the test statistic (e.g. F, t, r) with confidence intervals, effect sizes, degrees of freedom and P value noted" + "Give P values as exact values whenever suitable." | 禁 `p<0.05` 糊弄，要精确值；这条最容易被机检抓。 |
| D5 | Methods 必须有独立 statistics 小节 | "we encourage the inclusion of specific subsections for statistics, reagents and animal models." | 给「统计口径」一个固定落点，免得散落正文。 |

## E. 色彩与可访问性

| # | 硬要求 | Nature 原句 | 借鉴价值 |
|---|---|---|---|
| E1 | 用经过验证的色盲友好色板（引 Wong 2011），并给出具体 hex 值 | "An accessible colour palette to be used (for example Wong, B. Points of view: Colour blindness. Nature Methods 8, 441 (2011).)" | 规范直接给 8 个 hex（`#000000 #e69f00 #56b4e9 #009e73 #f0e442 #0072b2 #d55e00 #cc79a7`），可写进绘图默认色板并被脚本强制。 |
| E2 | 禁红/绿组合，禁彩虹色标 | "Avoiding red/green combinations and rainbow scales helps readers with colour blindness to distinguish datasets and interpret data correctly." | 颜色可机检：解析所有 fill/line 颜色，判是否落在红绿扇区、是否用了 jet/rainbow colormap。 |
| E3 | 不用图案区分，改用纯色/灰度可辨 | "We avoid: Patterns" + 推荐 "Solid colours used to differentiate sectors." | 灰度化后仍可辨 = 可自动算（转灰度后 ΔL 阈值）。 |
| E4 | 文字高对比（>4.5:1），禁彩色文字，用 keyline/图例代替 | "High contrast text (>4.5 contrast ratio) should be used" + "Coloured text; keylines, keys, etc. should be used instead" | 对比度是纯算术，最容易做成 CI 门禁。 |
| E5 | 目标 WCAG 2.1 AA | "Nature.com adheres to level AA of the Web Content Accessibility Guidelines (WCAG 2.1) wherever possible." | 给了一套外部成熟标准当基线，不必自造。 |

## F. 表格规范

| # | 硬要求 | Nature 原句 | 借鉴价值 |
|---|---|---|---|
| F1 | 三线：列头上下一横线 + 表底一横线 | "Add a horizontal rule above and below column headings and at the bottom of the table." | 三线表被写成「三条线」的具体位置，可直接映射 booktabs 的 `\toprule/\midrule/\bottomrule`。 |
| F2 | 禁竖线；块间用空白而非线分隔 | "Use spaces rather than rules to separate blocks of data, but horizontal rules can be used to improve clarity in certain cases." | 「不用 rule 用空白」是可检的（统计表格竖线数量）。 |
| F3 | 表题在**表上**：一行、粗体；符号与缩写在**表下**脚注 | "Tables have a short, one-line title in bold text." + "Symbols and abbreviations are defined immediately below the table" | 上下分工写死了：title 在上、定义在下，不会两头混。 |
| F4 | 表内文字 7 pt、无衬线、单页内、单栏 89 mm / 双栏 180 mm；正文表禁彩色 | (Extended Data guide) "All text should be sans-serif typeface, preferably Helvetica or Arial and please use 7-pt text." / "Colour is not permitted in main [tables]" | 表格也有字号上限与栏宽，等于给表格套了和图相同的物理约束。 |
| F5 | 脚注用字母上标，不用符号堆砌 | "Footnotes can be used in table; alphabetical superscript letters are used." | 脚注编号规则固定，可正则查。 |

## G. 数据可用性 / 代码可用性

| # | 硬要求 | Nature 原句 | 借鉴价值 |
|---|---|---|---|
| G1 | 所有原创研究必有 Data availability statement，且覆盖「最小数据集」 | "must make the conditions of access to the "minimum dataset" that are necessary to interpret, verify and extend the research in the article, transparent to readers." | 「最小数据集」是可验收的对象定义：不是「代码开源了」就算完。 |
| G2 | 自定义代码须有独立 Code availability 段，位置在 Data availability 之后、References 之前 | "a statement must be included under the heading "Code availability" … Code availability statements should be provided as a separate section after the data availability statement but before the references." | 章节顺序写死 → 可机检标题序列。 |
| G3 | 代码进带 DOI 的仓库并在参考文献里正式引用 | "Code should be deposited in a DOI-minting repository such as Zenodo or Code Ocean and cited in the reference list" | 把「给个 GitHub 链接」升级为「可引用、可归档、可复现」。 |
| G4 | 数据集本身也要正式引用（DataCite 最小项：作者/标题/仓库/标识符），DOI 写全 URL | "Datasets that have been deposited in repositories should be included as formal citations in the article reference list." | 数据集是一等公民引用，不是脚注。 |
| G5 | 大文件不放 SI，走仓库 | "Providing large datasets in supplementary information is strongly discouraged and the preferred approach is to make data available in repositories." | 反「附录塞大表」条款。 |
| G6 | 提供句式模板（六种），限制滥写 | "The datasets generated during and/or analysed during the current study are available in the [NAME] repository, [PERSISTENT WEB LINK TO DATASETS]." | 模板化 → 机器可判这句是否合规（含仓库名 + 可解析链接）。 |

## H. Extended Data 与 Supplementary 的分工

| # | 硬要求 | Nature 原句 | 借鉴价值 |
|---|---|---|---|
| H1 | 分工按「载体」不按「重要性」：图→Extended Data，非图材料→SI | "Supplementary Information should not contain figures (any figures additional to those appearing in print should be formatted as Extended Data figures)." | 一条二元判定规则即可把内容分流，避免作者自选。 |
| H2 | 数量上限 10 个 ED display item，每项 ≤1 页 | "A maximum of ten Extended Data display items (figures and tables) is typically permitted." | 附录也有预算上限，可数。 |
| H3 | ED 图不经美术编辑，作者须自套 style guide | "Extended Data figures are not edited or styled by Nature's art department; for this reason, authors are requested to follow Nature style as closely as possible" | 直接结论：凡是「不会被排版方修」的部分，规范性反而要更严。 |
| H4 | 正文必须逐项点名引用 ED / SI | "authors are asked to refer to discrete items at an appropriate place in the main text (for example, Extended Data Fig. 1 and Extended Data Table 1)." | 「每个附录项在正文至少被引一次」= 现成的 orphan 检查。 |
| H5 | Methods 里不许放图/表 | "The Methods section cannot contain figures or tables (essential display items should be included in the Extended Data or exceptionally in the Supplementary Information)." | 章节与图表的归属关系写死，可机检。 |
| H6 | ED 图分辨率反而**上限** 300 ppi、≤10 MB | "Images should be supplied at maximum 300 p.p.i.; exceeding this limit will make the files too big … File size should not exceed 10 MB" | 在线件是带宽受限的，与印刷件方向相反的阈值——套规范时不能一刀切。 |

---

## 总结：DeepSeek 风格技术报告缺失、且能机械检查的 3 条

对照本工作区 `skills/deepseek-paper`（`references/05-图表规范.md` + `tools/paper_lint.py` 的 G1–G12 + `tools/paper_figure.py`）现状：

1. **图注里的统计口径声明（Nature D1–D3 / A2）**
   DeepSeek 报告的 caption 公式只有「是什么 + 怎么测 + 一句结论」，`05-图表规范.md` 全文没有 error bar / n / 重复数 任何字样；`paper_lint` 的 G8 只查「caption ≥2 句」。机检方案：若 caption 或图数据含 `±` / `error` / `bar` / 多 seed 曲线，则同段必须同时出现 `n=` 与 `s.d.`/`s.e.m.`/`95% CI` 之一，否则 FAIL；训练曲线类图额外要求「seed 数 + 聚合方式」。

2. **图的物理参数区间（Nature B1–B4 + C1）**
   规范是双侧阈值：字号 5–7 pt、线宽 0.25–1 pt、dpi ≥300、宽 89/183 mm、panel 用 8 pt 小写直立粗体。而现役工具自己就越界：`paper_figure.py` 里 `font.size: 9`（超 7 pt 上限）、`savefig dpi` 默认 200（低于 300）、`figsize` 默认 7.0 in（178 mm，卡在双栏 183 mm 之下但非标）、拟合线色 `#C0504D` 是红色（撞 E2 禁红绿）。机检方案：出图后读 PNG/TIFF 的 DPI 元数据 + 读 rcParams 快照，逐项比区间；`paper_lint` 加一条扫 caption 里 `(a)` 与 `a` 混用。

3. **独立的 Data / Code Availability 段 + DOI 化仓库（Nature G1–G4）**
   `02-章节骨架.md` 的附录五件套（贡献致谢/消融/全公式/辩论/补测）里没有这两段；`paper_lint` 的 G4 只查「摘要末句有 github 链接」，等于把可用性降级成一句广告。机检方案：标题序列必须出现 `Data Availability` 且紧随 `Code Availability`、位于 References 之前；两段内的链接须匹配 `doi.org/` 或 `zenodo.org/record/` 形态，并各在参考文献里有一条对应条目。
