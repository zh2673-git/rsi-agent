# failure-fixes — deepseek-paper

> 每条必须带 case_id（对应 evals/cases.jsonl）。

| case_id | 现象 | 根因 | 改法 | 是否生效 |
|---|---|---|---|---|
| c2 | 单次单 benchmark 就写「显著优于所有基线」 | 主张强度未与证据强度绑定 | 03 §3.1 动词表 + 04 §4.5 强度分级；`outperforms` 类入 G12 账本交叉 | 已生效（lint G12 可拦） |
| c4 | 把 PLAN.md 当结果、把 commit 当「更好」的证据 | 未区分计划/实施/测量 | 04 §4.1 输入分级表；evidence_scan 把全部条目置 todo | 已生效 |
| c3 | 项目顺利时编造消融与失败 | 把「像论文」理解成「必须有难点」 | 五条挖掘线穷尽后允许降级主张（写设计选择与成本账），不虚构 | 已生效（写入 SKILL 纪律 1） |
| c6 | 手写表里数字与正文不一致 | 数字两处手抄 | 05 §5.5 强制走 templates/05-图表数据.json → paper_table 生成 | 已生效 |
| c7 | 工具能跑但结果全绿（假阳性） | lint 缺负例校验 | 用 .scratch 坏稿回归，G1–G11 全 FAIL，确认可拦 | 已生效 |
| c8 | 4 列表 `Draft \| Gates \| Verdict \| Defect` 里，`Gates failed` 列的最高值被加粗，等于把最差档标成最好 | `paper_table` 硬编码 `data_start = start + 2`，假定必有「类别列 + benchmark 列」，标签列少一列时数据列整体左移一列；mixed-direction 列（越低越好）也无从声明 | 加 `data_start` 显式覆盖（默认行为不变），并在 templates/05 写明何时必须给；同时把「同表内不混放相反方向的指标」写成 caption 纪律 | 已生效（本篇表 2 拆掉 `Gates failed` 列后重测） |
| c9 | 故障注入脚本「改了但没改」：锚点文本随论文演化失效，`str.replace` 静默无变化，测量结论仍报旧值 | 脚本无断言 | 注入处加 `must_change()`，文本未变即 `SystemExit`；测量结果落 `data/measurements.json` 再从该文件抄数字 | 已生效（本篇 4 个变体均复跑确认） |
| c10 | `paper_table` 生成的 markdown 首行已是 `**Table: <caption>**`，再手动加 `**Table 2: ` 前缀会得到 `Table 2: Table: …` | 工具输出与正文编号职责混淆 | 正文装表时先剥掉工具首行的 `Table: ` 前缀再补编号 | 已生效 |
| c11 | 技能有完整的工程产物（tools/evals/registry）却说不出「为什么是流水线、为什么是标准档」——成熟度、算子、档位三项在全目录零命中 | v0.1.0 直接从 20 篇语料反推目录，跳过了 creat-skill 的还原与契约两步（先有壳后补理） | 补 `registry/skill-contract.md`（九节契约）+ `registry/profession-map.md`（角色谱系/工件链/裁决权/反例/假设清单），SKILL.md 路由表挂上两条 | 已生效（c11 用例可判；契约 §2 写明不选角色制的理由） |
| c12 | 中文阅读版跑 `paper_lint` 得 `FAIL ['G1','G5','G6','G7','G9']`，看起来像稿子不合格 | 门禁锚点全为英文句式（`N on <Benchmark>`、`our main contribution includes:`、`In the remainder of this paper`、`(Section N)`、`related work` 章名、`Note that the aforementioned`），语言不匹配被误读成文体缺陷 | 中文版定位为**阅读版**，文首写明「不要对中文版跑门禁」并附实测失败清单；权威稿仍为英文并过 G1–G12。若要中文投稿，须先给 `paper_lint` 加中文句式等价表并按存量优化闭环回归 | 已生效（c12 用例可判；中文版声明已落盘） |

## 用例覆盖映射（c1–c12 → 条目）

| case | 对应条目 | 说明 |
|---|---|---|
| c1 | — | 正向能力锚点（定体裁→建账本→挖点→机检），无对应缺陷史 |
| c2 | c2 | 主张强度越权 |
| c3 | c3 | 项目顺利时编造失败 |
| c4 | c4 | 把计划/commit 当结果 |
| c5 | — | 正向能力锚点（G11 孤儿图定位），无对应缺陷史 |
| c6 | c6 | 手写表数字漂移 |
| c7 | c7 | 门禁假阳性（绿 ≠ 可交） |
| c8 | c8 | 混放相反方向指标 + `data_start` 左移 |
| c9 | c9 | 注入脚本静默无变化 |
| c10 | c10 | 表编号前缀重复 |
| c11 | c11 | 有壳无契约（成熟度/算子/档位缺失） |
| c12 | c12 | 中文版门禁语言不匹配被误读为文体缺陷 |

