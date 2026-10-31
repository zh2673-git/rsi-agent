# 技能生命周期

状态机只有四个状态，迁移边是白名单；**禁止跳步**，写状态只走 `scripts/skill_state.py`。

## 状态

| 状态 | 含义 | 可用性 | 可晋升 |
|---|---|---|---|
| `draft` | 草稿，结构或案例未齐 | 不可自动装载 | 否 |
| `candidate` | 结构通过 + 有 ≥3 条案例 | 可显式试用 | 满足证据后 |
| `active` | 已验证、有基线、有外部信号 | 默认可用 | — |
| `retired` | 退役，保留证据 | 不参与召回 | 可回 draft |

## 迁移表

| 从 | 到 | 触发 |
|---|---|---|
| draft | candidate | validate full 通过 + 案例 ≥3 |
| candidate | active | `skill_state.py promote`（validate + eval + E1/E2/E3） |
| candidate | draft | 评测失败或结构回退 |
| active | candidate | 发现退化，进入修复 |
| active | retired | 连续失败/零使用/用户决定 |
| retired | draft | 重新启用（保留历史） |

## 生命周期钩子

| 钩子 | 落点 | 动作 |
|---|---|---|
| `init` | 新建技能目录 | 生成 `skill.json` + `state.json`（draft） |
| `start` | 首次执行 | 账本记录 work_id + 加载技能 |
| `stop` | 任务结束 | 写 outcome / signals / cost |
| `destroy` | 退役 | 状态 retired，证据保留在 `ledger/evidence/` |

## 退役判据（Phase 3）

只对 `active` 技能计算退役候选，命中任一即列入（阈值见 `config/rsi.toml [retire]`）：

| 条件 | 默认阈值 | 说明 |
|---|---|---|
| 低成功率 | 使用 ≥5 次且成功率 <0.50 | 有统计意义才判 |
| 长期闲置 | 距最后使用/创建 ≥30 天 | 无记录时按创建时间 |
| 连续失败 | 尾部连续失败 ≥2 次 | 以账本 outcome 为准 |
| 评测退化 | 最近 scorecard 有旧案例退化 | 与晋升闸门口径一致 |

- 默认只出候选（dry-run）；执行必须 `usage_report.py --apply --yes`，批量退役等于一次人工确认。
- 恢复路径：`retired → draft`（`skill_state.py transition --to draft`），历史证据与快照保留。
- 退役不是删除：目录与 `ledger/evidence/` 不清理。

## 技能库配额（Phase 4）

- 阈值在 `config/rsi.toml [quota]`：`max_active`（默认 8）、`max_total`（默认 20）。
- 超限只产生 `kind="quota"` / E5 的告警与复盘触发（`rsi_routine.py scan`、月度健康报告），不自动删技能。
- 处置顺序：先复核退役或合并，再由人工决定是否新增；配额不构成晋升证据。

## 快照与回退

- 晋升前：`skill_state.py snapshot --name X --version V` 写 `ledger/evidence/{name}/{version}/`；
- 回退：`skill_state.py rollback --name X --version V` 恢复 `SKILL.md/skill.json/evals/`；
- 账本只追加，回退事件写 `ledger/feedback.jsonl`，不改旧记录。

## 不变量

- 没有 `skill.json` 的技能最多 draft；
- `legacy` 技能可直接用，但不可自动晋升；
- 任何状态变更后都要能回答「为什么」——原因进 `state.json` 或账本。
