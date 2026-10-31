# 晋升与回退规则

## 证据分级

| 级别 | 证据 | 可用于晋升 |
|---|---|---|
| E1 | 用户明确确认/修正 | 是 |
| E2 | 确定性测试或 eval 通过 | 是 |
| E3 | 真实任务结果可观察 | 是 |
| E4 | 另一个模型盲评 | 仅辅助 |
| E5 | 同模型自评 | 否 |

## 晋升闸门（全部满足才 active）

1. `skill_validate --mode full` 通过（结构/引用/验收段/案例/契约）；
2. `run_evals` 有结果：旧案例无退化，总分 ≥ 门槛（默认 0.80），决定案例 ≥ 3；
3. 至少一条 E1/E2/E3 外部信号；
4. 知识层（SKILL.md/references/evals）满足 1–3 可自动晋升；
5. 改工具层（`tools.json`）或核心层，额外需要用户确认（`--human`）；
6. `legacy` 技能不自动晋升，需要 `--human`。

命令：

```powershell
python scripts/run_evals.py --skill skills/<name> --set-baseline   # 首次建基线
python scripts/run_evals.py --skill skills/<name>                  # 候选评测
python scripts/skill_state.py transition --name <name> --to candidate
python scripts/skill_state.py promote --name <name> --signal E1 --human
```

## 不晋升时

- 保持 `candidate`，可用于「显式试用」；
- 原因写入 `evals/results/{version}.json` 与账本；
- 修复后重新 validate + eval，不允许只写 registry 不验证。

## A/B 对比（Phase 3）

`skill_ab.py` 只比较同一 suite 的两份 scorecard，judge 只收 `{case, output}`（盲评）。

| 结论 | 条件 |
|---|---|
| `reject` | 任一旧案例 pass→fail，或 B 分数低于 A - `[ab].tolerance` |
| `promote` | 无退化；修复案例 ≥ `[ab].min_fixed`；B `promotion.eligible=true` |
| `hold` | 其余（含 suite 不一致） |

A/B 结论是晋升的辅助证据，不替代 `skill_state.py promote` 的 validate + eval + 外部信号闸门。

## 例行提案（Phase 4）

- `rsi_routine.py scan` 识别用户修正（E1）、连续失败（E3）、评测退化（E2）、周期复盘（E5）。
- 知识点提案（`knowledge` 层）凭 E1/E2/E3 + eligible scorecard 可自动批准；
- 工具/核心层、以及只有 E5 的提案，必须 `approve --human`；
- **批准 ≠ 生效**：批准只授权修改，之后仍走 creat-skill → validate → run_evals → promote；
- 每个提案携带 `baseline`、`scorecard`、`rollback_point`；拒绝要写 `deny_reason`；
- 配额超限（`quota` / E5）只产生告警与复盘触发，不构成晋升证据，也不自动删除技能。

## 回退判据

任一触发即回退：

- active 技能真实任务连续 2 次失败；
- 触发误判导致明显错误；
- 评测发现旧案例退化。

动作：恢复上一版快照 → 状态回 active → 账本记录原因 → 修复后重新走晋升。

## 禁止

- 模型自写、自判、自晋升；
- 没有 case_id 的 failure-fix；
- 删除旧案例（需账本记原因）；
- 直接编辑 `state.json` 绕过迁移表。
