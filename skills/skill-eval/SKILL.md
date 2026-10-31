---
name: skill-eval
description: 技能评测规范：设计可复现案例（assert/judge/human/test）、写 rubric、建基线、跑 run_evals 并给出晋升建议；强调盲评、旧案例不退化、同模型自评不作数。Invoke when 要给技能写案例、评分、建基线或判断改动是否变好。
origin: preset
---

# skill-eval — 技能评测

评测不是打分表演，是**用有限案例回放验证「修好新问题且不退化」**。
本技能只回答：案例怎么写、分怎么判、基线怎么比、结论能不能用于晋升。

## 何时用 / 何时不用

| 用 | 不用 |
|---|---|
| 新技能要写 3–10 条案例 | 技能还没契约（先回 creat-skill） |
| 改动后判断是否变好 | 一次性临时任务 |
| 建基线、比基线、给晋升建议 | 只想知道「大概好不好」 |

## 案例设计（每条必须有）

| 字段 | 约束 |
|---|---|
| `id` | 稳定不变；失败可复现的锚点 |
| `input` | 真实任务输入，不抽象成「示例 1」 |
| `expect` | 可观察的期望结果 |
| `rubric` | 判分维度（对应 rubric.md） |
| `signal` | `assert` / `judge` / `human` / `test` |
| `source` | 教材/用户/标准文档；禁止「模型认为」 |
| `check` | assert/test 必填：`{"kind":"contains|regex|exact","value":...}` |
| `weight` | 可选，默认 1 |

规则：

- 至少 3 条；候选/晋升前强制。
- **修 bug 可以加案例，不能删旧案例**；删除必须在账本记原因。
- 案例来源必须可追溯，否则不算证据。

## 判分口径

| signal | 执行 | 判定 |
|---|---|---|
| assert | 确定性检查 | pass/fail，优先使用 |
| test | 跑测试/脚本 | pass/fail |
| judge | 另一模型盲评 | 0–1 分；需 `--judge-cmd` |
| human | 人工确认 | 0/1 或明确结论 |

盲评纪律：裁判只看案例与产物，**不暴露版本、不看生产者理由、不参与生产**。
同模型自评（E5）只能提示，不能进入晋升条件。

## 基线

- active 技能首次评测即基线，写 `ledger/baseline.json`；
- 无基线不比较，只记录分数；
- 对比规则：旧案例 pass→fail = 退化（直接拦截）；总分低于基线 - 0.05 = 不通过；
- 新问题案例必须 fail→pass 才算修复。

## 命令

```powershell
python scripts/run_evals.py --skill skills/<name> --suite evals/cases.jsonl --baseline ledger/baseline.json
python scripts/run_evals.py --skill skills/<name> --outputs outputs.jsonl --judge-cmd "python judge.py"
python scripts/run_evals.py --skill skills/<name> --set-baseline
```

产物：`skills/<name>/evals/results/<version>.json`；晋升证据快照写 `ledger/evidence/`。

## 验收

- [ ] 新技能能写出 ≥3 条带来源的案例；
- [ ] 同版本重复评测结果稳定（确定性案例分数不变）；
- [ ] 旧案例退化会被判为不通过，并给出 case id；
- [ ] 低分候选不晋升，原因可追溯；
- [ ] 每条失败都能定位到案例 id 与产物路径。

## 反模式

| 反模式 | 修正 |
|---|---|
| 用「模型认为」当来源 | 换成用户原话/教材/标准 |
| 只写 judge 不写 assert | 优先补确定性案例 |
| 每版重写全部案例 | 保留旧案例，只增不减 |
| 自评后直接晋升 | 找 E1/E2/E3 外部信号 |
