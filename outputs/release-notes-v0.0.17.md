## 三能力落地：RAG / 深度研究 / 教学

本版把架构方案里的三条能力从「文档」变成「可运行的 CLI + 技能」，全部走 `skills/` 与
`scripts/` 通道，**未改内核**。

---

### 1. RAG / 检索（`scripts/index.py`）

```bash
python scripts/index.py build                    # 增量建索引
python scripts/index.py search "<问题>" --k 5    # bm25 排序，返回 path:line + 片段
python scripts/index.py stat
python scripts/index.py bench "<q1>" "<q2>" ...  # 与 grep 基线对比
```

**FTS5 + CJK bigram，不是向量库**——语料差三个数量级（可检索单元几 MB vs 向量库的千万级文档）；
中文无 CJK tokenizer，二元组建索引 + 查询侧同样切，`bm25()` 给的就是相关性排序；`sqlite3` 是标准库，零新依赖。

关键实现：按 markdown 标题切块（命中能直接打开那一节）、原文落旁表 `chunk_text`（FTS 表存的是
bigram 串不可读）、增量按 `(path, mtime_ns, size)`、同文件最多 2 条结果、查询用 `OR` 保召回。

**P0 判据（先证明增量再付出成本）**：8 条真实风格查询，grep 只在 **1/8** 上够用（5 条零命中、
2 条命中过多），FTS5 **8/8** 有命中且 top1 相关。这个数字就是索引存在的理由。

提示词接入（`E11` 补丁）：`memory_ops_hint` 扩一段——按内容找历史用 `index.py search`，
精确标识符和代码仍用 `grep`/`symbols_search`。

---

### 2. 深度研究（`scripts/research.py` + `deep-research` 技能）

```bash
python scripts/research.py new "<主题>" --questions "q1" "q2" ...
python scripts/research.py --topic <t> add --url U --title T --quote "原文摘录"
python scripts/research.py --topic <t> done <idx> --note "一句话结论"
python scripts/research.py --topic <t> resume     # 断点恢复
python scripts/research.py --topic <t> check <报告>.md
```

缺的从来不是搜索工具（`web_search`/`web_read`/`task` 并行子代理本来就够），是**研究这件事的持久状态**：

- 撞预算墙（`CHAT_BUDGET_SECS` 缺省 900s）后从哪继续 → `resume` 给「下一个待办 + 已有结论」；
- 报告里的断言有没有出处 → `check` 三条机检判据；
- 读了哪些没用上 → `unused` 字段。

**`check` 三条判据**（退出码，不是建议）：

| 判据 | 抓什么 |
|---|---|
| 引用 `[S*]` 在账本里存在 | 编造引用 |
| 每条账本条目至少被引用一次 | 读了没用 |
| 事实性段落无引用标记 | 无出处断言 |

「事实性段落」= 长度 ≥30 字的正文/列表项；标题、代码块、表格、引用块不计。

---

### 3. 教学（`scripts/lesson.py` + `teach-material` 技能）

```bash
python scripts/lesson.py <主题> init --from outputs/<源>.md
python scripts/lesson.py <主题> goal add "<目标>" --check "<检验问题>"
python scripts/lesson.py <主题> concept add "<概念>" --after "<前置>" --body "正文"
python scripts/lesson.py <主题> concept order      # 拓扑序；成环退出码 1
python scripts/lesson.py <主题> exercise add "<题干>" --answer "<答案>" --goal O1
python scripts/lesson.py <主题> build --out outputs/课件-<主题>.md
python scripts/lesson.py <主题> check
```

**先做「产课件」不做「当导师」**：甲（跨会话学习者模型/判掌握/推下一步）受益者只有一个人、
投入全新建、适配度低；乙（把结论变成可验收材料）输入输出都在已有通道。等真有人按课件学并要求
按水平调整，再谈甲。

四件事都可判，这才区别于「文档改个标题」：目标必须带检验问题、概念用 Kahn 拓扑序（成环**拒绝出稿**）、
练习必须挂目标且有答案、总判是 `check` 退出码。

---

## 验证

| 项 | 结果 |
|---|---|
| `cargo test --workspace`（runtime） | 19 binary **连续三轮全绿** |
| `index.py` | 285 文件 / 1533 块 / 3MB；增量二次 build 全 skip |
| `index.py bench` | grep 够用 1/8，FTS5 命中 8/8 |
| `research.py` | plan/add/done/resume/list/check 全链路；编造引用 S9、读了没用 S2、无出处段落三类均检出 |
| `lesson.py` | 拓扑序正确；A↔B 成环退出码 1 且拒绝出稿；目标无检验/练习未挂目标/无答案三条 errors 全检出 |
| `skill_validate` | `deep-research` ok、`teach-material` ok |

## 升级注意

- 首次使用检索需跑一次 `python scripts/index.py build`（后续增量）。
- `.rsi/index/`、`.rsi/research/`、`.rsi/lessons/` 都是派生工作区，可随时删除重建，不入库。
- 研究/课件的**交付物**落 `outputs/`，工作文件留在 `.rsi/` 下。
