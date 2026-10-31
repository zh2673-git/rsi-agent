---
name: rsi-steward
description: RSI 生产线编排器：判断该不该造技能，带技能走完 Intake→Recall→Decide→Author→Validate→Evaluate→Execute→Verify→Retro→Promote 十阶段，把证据写进账本。Invoke when 任务要新建/改造/评估/晋升/退役技能，或要把一次真实工作沉淀成可复用能力；一次性小任务不触发。
origin: preset
---

# rsi-steward — 技能生产线编排

你**不直接替用户干活**；你负责让一次工作变成可复用、可验证、可回退的技能资产。
编排细节读 `references/`；评判口径交给 `skill-eval`；执行任务本身交给正常工具。

## 何时用 / 何时不用

| 用 | 不用 |
|---|---|
| 新建技能、改造存量技能、审计技能 | 一次性问答、查资料、改一个错字 |
| 同类任务重复出现且有稳定判据 | 信息不足（先取信息，不造） |
| 要给技能建案例、评分、基线、晋升 | 只是语气/措辞微调（直接改） |

## 十阶段状态机

| 阶段 | 动作 | 产物 | 失败去向 |
|---|---|---|---|
| Intake | 写任务卡：目标 + 验收 | `task.json` | 反问用户 |
| Recall | 查 active 技能 + 账本 | 候选列表 | 无候选 → Decide |
| Decide | 判定造/改/直接做，写理由 | 决策记录 | 直接 Execute |
| Author | 还原专业 → 契约 → 落盘 → 写案例 | 技能目录 | 回退草稿 |
| Validate | 静态校验 | 报告 | 修到通过或 Abort |
| Evaluate | 跑案例 + 基线对比 | scorecard | candidate / Abort |
| Execute | 用技能执行任务 | 任务产物 | Verify 失败 |
| Verify | 逐条核对验收 | 通过/失败 | Retro |
| Retro | 生成 failure-fix（带 case_id） | registry 更新 | Promote |
| Promote | 状态迁移 + 记账 | active/candidate | 保持原状态 |

状态只允许：`draft → candidate → active → retired`，禁止跳步，只走 `skill_state.py`。

## Decide 门槛（必须写理由）

| 条件 | 结论 |
|---|---|
| 已有 active 技能覆盖 ≥80% | 复用/改旧，不新建 |
| 同类任务 ≥2 次且有稳定判据 | 造 |
| 一次性任务、无稳定判据 | 直接做，不造 |
| 只是信息不足 | 先取信息，不造 |
| 已有技能只差少量规则 | 改旧版，不新建 |

**禁止**把「模型不会」当成「需要造技能」。

## 工具接口（只看 JSON，不读全文）

```powershell
python scripts/skill_validate.py --skill skills/<name> --mode full
python scripts/run_evals.py --skill skills/<name> --suite evals/cases.jsonl --baseline ledger/baseline.json
python scripts/ledger.py query --skill <name> --keyword <词> --limit 5
python scripts/ledger.py append --record <work.json>
python scripts/skill_state.py promote --name <name> --signal E1 --human
python scripts/skill_state.py snapshot --name <name> --version <ver>
python scripts/skill_ab.py --skill <name> --a <active> --b <candidate>
python scripts/usage_report.py            # 退役候选；执行加 --apply --yes
python scripts/rsi_routine.py scan --auto-propose
python scripts/rsi_routine.py queue
python scripts/health_report.py
python scripts/dashboard.py
```

- 错误统一 `{code, path, message}`；失败要能定位到文件/字段/案例 id。
- 召回只返回摘要与路径，≤5 条；不把整本账本塞进上下文。

## 证据分级与晋升

| 级别 | 证据 | 可晋升 |
|---|---|---|
| E1 | 用户明确确认/修正 | 是 |
| E2 | 确定性测试/eval 通过 | 是 |
| E3 | 真实任务结果可观察 | 是 |
| E4 | 另一模型盲评 | 仅辅助 |
| E5 | 同模型自评 | 否 |

晋升必须同时满足：validate 通过、eval 无旧案例退化、至少一条 E1/E2/E3。
无外部信号最多 `candidate`；`legacy` 技能不可自动晋升；改工具/核心层额外要用户确认。

## 单点改动纪律

一次只改一层：认知层（规则/判断）、执行层（工具/代码）、流程层（步骤/路由）。
改多层无法归因，必须拆成多轮；每轮先建基线，再改，再回归。

## 验收

- [ ] 坏技能（缺验收段/引用断链/案例不足）被 `skill_validate` 拒绝；
- [ ] 低分候选不晋升，原因写进账本；
- [ ] 一次真实失败产出带 `case_id` 的 failure-fix；
- [ ] 下一次同类任务召回命中该经验，且上下文只增摘要；
- [ ] 账本无对话全文、密钥、个人信息；状态迁移无跳步。

## 路由

| 要做的事 | 去读 |
|---|---|
| 写案例、rubric、基线、判分 | load `skill-eval` |
| 还原专业、角色/工件转译 | load `creat-skill` |
| 项目级方案与 P/Q/I | load `project-dev` |
| 状态表与晋升规则细节 | `policies/lifecycle.md`、`policies/promotion.md` |
