---
name: rsi-board
description: 任务看板与灵感看板的写作规范：何时建任务、怎么写人财物（模型/力度/技能/工具）、怎么写验收、状态怎么迁移、@引用怎么解析。Invoke when 用户交代一件成规模的事（多步交付/改造/调研）要先立计划再动手，或消息里出现 @T-xxx / @I-xxx 引用，或用户问「任务看板/灵感/进度」怎么用。
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
| 成立什么部门/角色？ | `resourcing.skills[]` | 用**已有**技能名（先看技能目录）。没有合适的技能，正是「值得造技能」的信号（走 creat-skill）。 |
| 用多少人/多强的模型？ | `resourcing.model` + `effort` | `current`（留在此模型）/`cheap`（机械、量大、不需判断）/`strong`（架构、评审、归因）。effort = small/medium/large。 |
| 要什么物力（工具）？ | `resourcing.tools[]` | 核心步骤所需的工具（bash/write_file/grep/image_gen…）。核心步骤没有工具 = 不可执行，如实说，不要伪造。 |

外加**好坏标准**：`acceptance[]` 1-3 条可核对条目（能跑出结果、能看到界面、能不报错）。
进 `verifying`/`done` 时 `acceptance` 为空会被 CLI 打 `warning`——那是自述，不是验收；
但它是提示不阻断（「改个错别字」写不出有意义验收，硬闸只会逼你编造）。

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

用户在消息里写 `@T-…` / `@I-…` 就是要你**先读**这件事再动手：

1. `python scripts/board.py show <ID>` 拿到详情；
2. 是任务 → 延续它的 goal/plan，不要另起炉灶；有新结论就更新它；
3. 是灵感 → 判断值不值得做：值得就 `task-upsert` 建任务 + `insp-adopt <I> <T>`（双向关联），
   不值得就在回答里说清为什么不采纳（不要默默略过）。

## 6. 边界（与其它层的分工）

- 看板是**人读的管理视图**，不是执行日志：trace 记过程，账本记证据，看板记「人财物 + 进度」。
- 不把看板整块塞进回答或每轮 prompt：用户能在左栏看见；需要时读 `show` 单个条目。
- `todo` 工具管**当前这轮**的细项，看板管**跨轮交付**的条目。别在两个地方维护同一份清单。
- 看板数据不进 `ledger/`（账本只追加、只存证据），不做自动派发（那是编排器的事）。

## 验收

- [ ] 建任务时四问都答了（plan/resourcing/acceptance 非空），且 plan 步可判定；
- [ ] 状态只在四个时刻迁移，`blocked` 带 note；
- [ ] `verifying`/`done` 有 acceptance 或有明确理由为空；
- [ ] 收到 @引用先 `show` 再动手，灵感被采纳走 `insp-adopt` 双向关联；
- [ ] 没有把看板内容整块复述进回答。
