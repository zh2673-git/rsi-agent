---
name: rsi-board
description: 任务看板与灵感看板的写作规范：何时建任务、怎么写人财物（模型/力度/技能/工具）、每步谁干（owner）、怎么写验收、状态怎么迁移、@引用怎么解析、任务↔对话怎么反查、习惯画像记什么。Invoke when 用户交代一件成规模的事（多步交付/改造/调研）要先立计划再动手，或消息里出现 @T-xxx / @I-xxx 引用，或用户问「任务看板/灵感/进度/习惯」怎么用。
origin: user
---

# 任务看板（人财物分配 + 进度）写作规范

本技能只讲**怎么想、怎么写**。真正的写盘通道是 `scripts/board.py`（bash 调 CLI），
不是技能工具：技能工具装载后默认未启用，依赖它会把闭环断在「用户点一下配置」上。

数据落在 `WORKSPACE_ROOT/.rsi/board.json`，UI 左栏实时显示（20s 轮询），
`GET/POST /api/board` 由 host 提供；用户能在 UI 里记/归档灵感，**任务的建与推进只归你**。

## 1. 什么时候建任务（判断，不是仪式）

建：多步交付、要跨多轮对话才能做完、要动多个文件/模块、结果需要被核对、
用户明确说了「做/改/加/调研/升级」且不是一句话能答完。
不建：一次问答、一个命令、一个文件的小修、纯信息查询。

拿不准时问自己一句：**这件事有没有「做完」这个状态？** 没有就不建。

## 2. 四问（人的思维模式）——建任务时必须先答

| 问 | 落到字段 | 写法要求 |
|---|---|---|
| 这事怎么做？ | `goal` + `plan[]` | goal 一句话；plan 3-8 步，每步可判定完成。**写不出 plan = 还没想清，别开工**。 |
| 每步谁干？（复杂度判断） | `plan[].owner` | `self`（要本轮上下文的活）/`subagent`（可自包含、产物是**结论**而非改动）/`skill`（没有现成能力，要先造技能/工具）。缺省 `self`——**不写 ≠ 委派**。 |
| 成立什么部门/角色？ | `resourcing.skills[]` | 用**已有**技能名（先看技能目录）。没有合适的技能，正是「值得造技能」的信号（走 creat-skill）。 |
| 用多少人/多强的模型？ | `resourcing.model` + `effort` | `current`（留在此模型）/`cheap`（机械、量大、不需判断）/`strong`（架构、评审、归因）。effort = small/medium/large。 |
| 要什么物力（工具）？ | `resourcing.tools[]` | 核心步骤所需的工具（bash/write_file/grep/image_gen…）。核心步骤没有工具 = 不可执行，如实说，不要伪造。 |
| 要不要拆成几件？ | `parent` | 只有**子件能各自独立验收**时才拆。子件验收条件与父任务相同 → 拆了只是把进度条切两段，别拆。 |

`owner` 是**决策记录**，不是调度指令：写下 `subagent` 不会自动派发，你得真的调 `task`。
但它让「这一步该不该委派」变成可核对的东西——收工时能数出来几步交出去了。

**委派的真实代价**：子代理是全新上下文，不知道这次对话发生过什么。所以「需要本轮上下文
才能做的步」一律 `self`；把整件事都标 `subagent` 只会得到一堆重新摸索的答案。

外加**好坏标准**（两层，缺一层就是自述）：

- `acceptance[]`：1-3 条**人读**的可核对条目（能跑出结果、能看到界面、能不报错）；
- `checks[]`：1-3 条**机跑**的证明，能在工作区里真的跑出 pass/fail：

```json
"checks": [
  {"id": "c1", "kind": "cmd",  "name": "pytest 全绿", "target": "python -m pytest tests -q", "timeout_secs": 120},
  {"id": "c2", "kind": "file", "name": "产物落盘", "target": "outputs/report.md"},
  {"id": "c3", "kind": "grep", "name": "旧入口已删", "target": "postChat", "scope": "runtime/crates/host/web-dist/vendor"},
  {"id": "c4", "kind": "manual", "name": "用户确认文案"}
]
```

- `cmd` 退出码 0 = pass（cwd = 工作区）；`file` 只看存在；`grep` 在 `scope` 下做子串命中；
  `manual` **永远 skip**——待人判，你别给自己判过。
- 跑：`python scripts/board.py eval <ID>`。它写 `evaluation.verdict`，**检查一挂就把
  `verifying/done` 退回 `doing`**。
- 有 `checks` 却 `verdict≠pass` 就 `done`，CLI 会打 `warning`：那是自证，不是证据。

进 `verifying`/`done` 时 `acceptance` 为空也会 `warning`（提示不阻断——「改个错别字」
写不出有意义验收，硬闸只会逼你编造）。

## 3. 命令速查

```bash
python scripts/board.py list [--status doing] [--compact]
python scripts/board.py show T-20261107-01
python scripts/board.py stats
python scripts/board.py task-upsert --file plan.json      # 新建/更新（- 读 stdin）
python scripts/board.py task-status T-20261107-01 doing --note "开始改 Rust"
python scripts/board.py task-progress T-20261107-01 3/5 --note "路由已通"
python scripts/board.py task-append T-20261107-01 --artifact outputs/x.md
python scripts/board.py insp-add "左栏不该是会话列表" --tags ui,idea
python scripts/board.py insp-adopt I-20261107-01 T-20261107-01
python scripts/board.py check-add T-20261107-01 --file c.json   # 追加一条检查
python scripts/board.py eval T-20261107-01 [--only c1,c2]        # 跑检查写结论
python scripts/board.py digest --skill project-dev --brief        # 同类任务归纳
python scripts/board.py resolve "接着 @T-20261107-01"             # 引用解析成上下文块
python scripts/board.py link T-20261107-01                        # 哪几轮对话提过它
python scripts/board.py layout [--file layout.json]               # 读/写左栏章节
python scripts/board.py insp-edit I-... --text "改后的原话" [--tags a,b]   # 改灵感
python scripts/board.py insp-rm I-... [--force]                   # 删灵感（已采纳需 --force）
python scripts/board.py task-rm T-... [--force]                   # 删任务（子任务摘 parent）
```

`task-upsert` 的 JSON（省略 `id` 即新建）：

```json
{"title": "左栏改为任务看板", "goal": "UI 不再分会话层级", "priority": "P1",
 "plan": [{"step": "数据契约"}, {"step": "Rust 路由"}, {"step": "前端"}],
 "resourcing": {"model": "current", "effort": "large",
                "skills": ["project-dev"], "tools": ["bash", "write_file"]},
 "acceptance": ["GET /api/board 返回任务与灵感", "左栏无会话列表"]}
```

## 4. 状态机与四个写入时刻

```
planning → doing → verifying → done
                ↘ blocked（写 --note 说清卡在哪，解阻后回 doing）
                ↘ cancelled（做废了；写 --note 说明原因）
```

**只在四个时刻写看板**：建任务、阶段迁移、阻塞、完成。
其余时间靠 plan 步态累积（`task-progress` 自带 `planning → doing` 的自动推进）。
不要每轮刷看板——那是形式主义，纯烧 token，也不会让用户多知道任何事。

## 5. @引用解析

用户在消息里写 `@T-…` / `@I-…` 就是要你**先读**这件事再动手。

**任务与灵感的详情现在自动装载**：`@T-…`/`@I-…` 出现时，宿主已把该条目的
目标/计划/验收/检查结论/人财物/产物（灵感则是原文/标签/被采纳情况）拼进你的
system prompt 的「Board references」段。**不要再去 `board.py show` 一遍**——那是
重复劳动，多引用时还会变成 N 次工具往返。

对**间接**拿到的文本（排队消息、文件内容、历史记录）用 `board.py resolve "<text>"`，
它给出同一套上下文块。

拿到引用后：

1. 是任务 → 延续它的 goal/plan，不要另起炉灶；有新结论就更新它；
2. 是灵感 → 判断值不值得做：值得就 `task-upsert` 建任务 + `insp-adopt <I> <T>`（双向关联），
   不值得就在回答里说清为什么不采纳（不要默默略过）；
3. 引用 ID 不在看板上 → prompt 会明确说 `not on the board`，别猜内容，问用户或忽略。

## 6. 同类归纳与看板章节（C 轮新增）

- **开工前查同类**：这件事看着眼熟，先 `board.py digest --skill <name> --brief` 看以前怎么做
  （计划形状、产物、哪一步挂过），别从零重造。
- **收工后留准**：`plan` / `resourcing` / `artifacts` 写准。以后的 digest 只等于你现在写下的东西。
- **归纳不进对话**：digest 是检索，查完就用，不要把整块粘进回答或每轮 prompt。
- **左栏章节**（`layout.sections`）：三类 kind —— `tasks`（group_by: status/priority/skill）、
  `metrics`（验收指标：未跑/通过/不通过）、`inspirations`。顺序由 kind 钉死
  （任务→指标→灵感），**没有自由排布**。要加/改章节用 `board.py layout --file`。

## 6.5 习惯画像（D 轮新增）——与看板的分工

看板记「这件事的人财物与进度」，画像记「**跨事的规律**」。两者都落 `.rsi/`，谁也别越界。

```bash
python scripts/profile.py brief                     # 有界摘要（每轮已自动注入，不必手动读）
python scripts/profile.py section-add --file s.json # 写/覆盖一个章节（同 id 覆盖）
python scripts/profile.py note --file n.json        # 追加一条观察（满 60 丢最旧）
python scripts/profile.py section-rm <id>; python scripts/profile.py note-rm <N-...>
```

**写什么**：能活过本次对话的结论——用户明说的偏好、反复纠正的点、某个模型在哪类活上
反复失败、本工作区的既有约定与踩过的坑。

**不写什么**：本轮琐事（"用户问了好"）、密钥/令牌、看板已经记的东西（任务/进度/验收
归看板）、聊天原文（trace 有全量）。**观察是素材，章节是结论**——同一个主题反复出现时，
把它从 notes 提炼成 section，而不是继续加 note。

## 7. 边界（与其它层的分工）

- 看板是**人读的管理视图**，不是执行日志：trace 记过程，账本记证据，看板记「人财物 + 进度」。
- 不把看板整块塞进回答或每轮 prompt：用户能在左栏看见；需要时读 `show` 单个条目。
- `todo` 工具管**当前这轮**的细项，看板管**跨轮交付**的条目。别在两个地方维护同一份清单。
- 看板数据不进 `ledger/`（账本只追加、只存证据），不做自动派发（那是编排器的事）。

## 验收

- [ ] 建任务时四问都答了（plan/resourcing/acceptance 非空），且 plan 步可判定；
- [ ] plan 里有需要「不需要本轮上下文、产物是结论」的步时，标了 `owner: subagent`；
- [ ] 有可跑标准时写了 `checks`，收尾前跑过 `eval` 且 `verdict=pass`；
- [ ] 状态只在四个时刻迁移，`blocked` 带 note；
- [ ] `verifying`/`done` 有 acceptance 或有明确理由为空；
- [ ] 收到 @引用**没有**重复 `show`（已自动装载），间接文本才用 `resolve`；
- [ ] 灵感被采纳走 `insp-adopt` 双向关联；
- [ ] 没有把看板内容整块复述进回答。
