# magpie 免费模型上游接入 Spec

## Why

rsi-agent 要真正跑起来并自迭代，瓶颈是模型成本与额度：评测循环是长跑，单供应商 429 就会打断整轮。magpie 作为本机回环网关，提供多源/多账户故障转移与协议互译，适合当"可选上游"。

本规格只做一件事：**把 magpie 接成可选上游，且不破坏 rsi-agent 的独立运行**。magpie 不是免费模型来源，免费额度来自 magpie 内配置的 provider。

## 目标与非目标

目标：
- 免费云端额度经 magpie 供给 rsi-agent（`provider: openai` + base_url 覆盖即可，零协议改造）。
- 评测可溯源：每一轮记录实际回答模型；漂移不污染基线。
- magpie 密钥与 agent 之间建立账户边界。

非目标（明确不做）：
- 不内嵌 magpie 二进制（那是 dsh 的分发模式）。
- 不搬 dsh 的免费车道（非官方端点，条款与维护风险）。
- 不修改 `runtime/` 快照（保持 react-agent v0.1.21 的 2 处适配）。
- 不改 magpie 源码。

## 拓扑

```
账户 A（magpie-run，计划任务常驻）
  magpie serve --addr 127.0.0.1:3425          # 只有网关，不暴露 /api
  %USERPROFILE%\.config\magpie\providers.json # 免费额度 key（0600）

账户 B（日常账户，rsi-agent）
  run.cmd → LLM_BASE_URL=http://127.0.0.1:3425/v1
  读不到 A 的 profile；只能经回环 HTTP 消费
```

## What Changes

- 新增 `config.magpie.json`：magpie 档（base_url、`retry_attempts: 1`、模型 id 占位）。
- 新增 `scripts/magpie_check.py`：Phase 0 硬门 + 冒烟（端点/回环/管理面/隔离/chat/stream/tools/usage/abort）。
- `policies/ledger.schema.json` 与 `scripts/ledger.py`：账本增 `llm` 段（provider/model/models/drift/usage/evidence）。
- `scripts/run_evals.py`：从产物收集回答模型，写进 scorecard；同轮多模型判定漂移，`ok=false` 且拒绝写基线。
- `run.cmd`：配置里出现 `127.0.0.1:3425` 时探测网关，不可达只提示不阻断。
- `README.md`：新增接入说明与验收命令。

## Impact

受影响代码：`scripts/ledger.py`、`policies/ledger.schema.json`、`scripts/run_evals.py`、`run.cmd`、`README.md`。
新增：`config.magpie.json`、`scripts/magpie_check.py`。
不受影响：`runtime/`（运行时快照）、`skills/`、`scripts/rsi_common.py`。

## ADDED Requirements

### Requirement: 可选上游接入

rsi-agent SHALL 在不改 `runtime/` 的前提下，通过 `config.magpie.json` 把 LLM 请求指向回环 magpie 网关。

#### Scenario: 网关可用
- **WHEN** `magpie serve --addr 127.0.0.1:3425` 运行且 `config.magpie.json` 中 model 为真实 id
- **THEN** `run.cmd "你好"` 得到回答，退出码 0

#### Scenario: 网关未启动
- **WHEN** 配置含 3425 但端口未监听
- **THEN** `run.cmd` 打印一行提示后继续启动（不阻断 mock/直连场景）

### Requirement: 评测可溯源（R1）

评测 SHALL 记录回答模型；同一轮出现多个模型时 SHALL 判定漂移并使结果不可晋升。

#### Scenario: 模型稳定
- **WHEN** 产物每行带相同的 `llm.model`
- **THEN** scorecard `llm.drift=false`，可按常规晋升

#### Scenario: 模型漂移
- **WHEN** 产物出现两个不同的 `llm.model`
- **THEN** scorecard `ok=false`、`llm.drift=true`、`promotion.eligible=false`，`--set-baseline` 返回 `E_LLM_DRIFT` 且不写基线

### Requirement: 重试不叠加（R2）

magpie 档 SHALL 把 `agent.retry_attempts` 降为 1，故障转移交给 magpie。

#### Scenario: 唯一上游被禁用
- **WHEN** 在 magpie 中禁用唯一 provider 后发起单轮
- **THEN** agent 一次失败即报错，magpie 用量只记 1 次尝试

### Requirement: 密钥隔离（R6）

运行 magpie 的账户 SHALL 与运行 rsi-agent 的账户不同，且 magpie 只以 `serve` 形态暴露网关。

#### Scenario: 隔离成立
- **WHEN** 在账户 B 执行 `python scripts/magpie_check.py --magpie-user magpie-run`
- **THEN** `isolation` 为 ok（读不到 A 的 providers.json），`admin_face` 为 ok（`/api/providers` 不可达）

#### Scenario: 隔离不成立
- **WHEN** 当前账户可读 `%USERPROFILE%\.config\magpie\providers.json`
- **THEN** `isolation` 为 fail，脚本退出码 1，禁止上线

## MODIFIED Requirements

### Requirement: 账本字段白名单

原有白名单只允许 task/skills/steps/signals/cost 等字段；本次追加 `llm`（对象，含 provider/model/models/drift/usage/evidence），其余字段与校验不变。

## 验收（P/Q/I）

- **P**：`python scripts/magpie_check.py --skip-smoke` 退出码 0（端点 + 回环 + 管理面 + 隔离全过）。
- **Q**：`--skip-smoke` 之外跑全量冒烟，chat/stream/tools/usage/abort 均 ok；同技能一次 eval 能读出模型。
- **I**：`python -m unittest discover -s tests` 全绿；`python scripts/skill_validate.py --all --mode full` 不退化为 fail；`runtime/` 无 diff。
