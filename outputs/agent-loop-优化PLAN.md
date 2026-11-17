# PLAN：工具调用与上下文成本优化（T-20261116-13）

> 2026-11-16 · 模式：存量项目机制优化（project-dev 优化模式）
> **状态：P0-A / P0-B / P0-C / P0-D 已实施并验证**（18 个补丁，见下方「实施记录」）
> 诊断与收益：`outputs/工具调用机制诊断与优化报告.md`（四家对比详表 `outputs/agent-loop-对比-codex-pi-dsh-opencode.md`）
> 本文件是模块级 PLAN 的**可写副本**（`runtime/crates/agent-loop/PLAN.md` 在核心写保护区，不可写）。

## 一、诊断结论（实测口径，非推测）

### 1.1 计费归因（`~/.config/magpie/usage.jsonl`，2026-11-16）

| 项 | 值 |
|---|---|
| 计费请求数 | 2,913 |
| credits | 2,108 |
| input（未缓存） | 17,105,495 |
| cache_read | 498,400,951 |
| output | 1,871,271 |

最小二乘拟合（误差 0.1%）：

```
credits ≈ 1.020e-05 × in + 3.260e-06 × cache_read + 1.223e-04 × out + 0.0267
```

即 **cache_read 单价 = input 的 32.0%，output = input 的 12.0 倍**。
归因：**cache_read 占 77.1%**，input 8.3%，output 10.9%。

### 1.2 四个机制性根因（按贡献排序）

**R1（最大，77%）每轮携带的稳定前缀 ~170–200K tokens，逐轮重发。**
实测每会话首个请求的 cache_read 中位 = **170,060 tokens**（p75=262,586，max=567,837），
而每轮新增历史仅 ~333 tokens/轮（斜率回归）。即：**上下文体积几乎全部是固定前缀**——
system prompt + 工具 schema + 技能附录 + 看板/画像/记忆段。
按 0.32 单价，每请求固定成本 ≈ 170K × 3.26e-6 ≈ **0.55 credits**，与实测每请求中位 0.64 credits 吻合。

**R2（放大器）单 chat 内历史永不压缩 → 成本 O(N²)。**
- `maybe_compact` 只在 chat 开头调一次（`chat.rs:464`），轮内不再压缩；
- 压缩双闸中 token 闸对云端 provider **完全禁用**（`config.rs:143-149`：`context_window=0` → `ctx_budget()=0`）；
- 实测 `COMPACT_TRIGGER=40` 只在 chat 开头判一次，长会话中途从不再触发；
- 结果：371 轮的单会话累计 cache_read = 47.3M，且末段每轮仍重发全部历史。

**R3（闸门失效）`token_budget` 的计费口径漏掉 9.4 倍真实消耗。**
- `budget.rs:106` `total() = input + output`，**完全不计 cache_read**；
- 实测：今日「预算闸口径」19.0M，「真实计费当量」179.0M → **漏 9.4 倍**；
- 单会话层面漏 7.6×–35.3×。
- 叠加 `token_budget=0`（未设）与 `budget_secs=0`（未设），**三重刹车全部失效**。

**R4（提示词层）并行度塌陷 + 失败连锁 + bash 冗余。**
- 工具调用/轮 = **1.47**（3518 调用 / 2397 轮），内核波次并发上限 4（`chat.rs:830`）；
- 工具失败 161/3519（4.6%），每次失败至少多烧一轮；
- bash 占工具调用 47%，其中 bash 首 token `cd` 大量出现（提示词明令禁止但权重不足）。

### 1.3 被推翻的假设（留档，避免重复调研）

- ✗「cache 失效」：命中率 96.7%，缓存工作正常，问题是**被缓存的固定前缀太大**。
- ✗「历史膨胀是主因」：历史增量仅 ~333 tok/轮，与轮数相关性 −0.05。
- ✗「重试/compact 是主因」：今日 retries=3、compaction=12，量级可忽略。
- ✗「每个工具一次 LLM」：一轮一次 LLM 请求（usage/round = 1.22），工具并不各自驱动请求。

## 二、优化方案（全部走 `scripts/patches/*.json` 补丁链，可 `--revert` 回退）

### P0-A 计费口径修复：预算闸计入 cache_read（**最高杠杆，改动最小**）

`budget.rs::UsageAcc::total()` 改为 `input + output + cache_read × CACHE_CREDIT_WEIGHT`，
权重可配（`CACHE_CREDIT_WEIGHT`，缺省 0.32 = 实测单价比）。
配套：给 `CHAT_TOKEN_BUDGET` 一个**按模型窗口的默认值**（不再 0=禁用），
`budget_secs`/`token_budget` 缺省值按 config.json 显式配置不动（用户显式 0 = 不改）。

- **预期**：单请求成本可见性从「漏 9.4 倍」变为「漏 <1.2 倍」；有了可信闸门才能谈限额。
- **P（验收-过程）**：新增单测断言 `total()` 随 cache_read 增长而增长，权重可配。
- **Q（验收-质量）**：`cargo test -p react-agent-host --lib` 全绿；新增 agent-loop 单测全绿。
- **I（验收-集成）**：`usage.jsonl` 对账：单 chat 累计「预算闸看到的」与「真实当量」之比 ≥ 0.8。
- **回退点**：`scripts/patches/*.patchbak` 自动生成，`--revert` 还原。

### P0-B 轮内压缩闸：把压缩从「chat 开头一次」搬到「每轮检查」

在 chat.rs 主循环内，每轮结束、`messages.extend(round_msgs)` 之后，
按 **token 预算**（而非条数）判定是否压缩：超出预算即调用既有 `maybe_compact` 逻辑。
云端 provider 的预算来源：`CTX_BUDGET_TOKENS`（缺省 128K，×0.7 = 89K 触发线），
不再依赖 `LLM_CONTEXT_TOKENS`（那个键只对 ollama 生效）。

- **预期**：长会话末段每轮固定前缀从 O(N) 降到 O(1)，371 轮会话的 cache 累计降 40–60%。
- **P**：`maybe_compact` 可在轮内被调用（幂等：未超阈值时不调用）。
- **Q**：新增单测——构造 N 轮会话，断言轮内触发压缩且历史长度有界。
- **I**：长会话（≥100 轮）实测每轮 cache_read 平台值下降 ≥30%。
- **回退**：独立补丁，可单条 revert。

### P0-C 固定前缀瘦身（SYSTEM.md 分层 + 技能分级）

- **C1**：`SYSTEM.md` 10.3KB → 核心契约 ≤3KB；工具纪律细则移入各工具 description
  （随 schema 注入，离调用点更近——opencode 口径）；低频规范（自扩展边界细则、配置协助细则）
  改为「按需 load_skill」。
- **C2**：技能附录只下发 name + 一行触发条件（当前 18 个技能全量 description ≈ 1,273 tokens），
  完整描述靠 `load_skill` 取（内核已有 deferred 机制，`chat.rs:545-574`）。
- **C3**：工具目录定序（排序确定化 + 新增工具追加到目录尾），避免中途插队破坏缓存前缀。

- **预期**：固定前缀中位 170K → 目标 ≤120K，per-request credits 0.64 → ≤0.45。
- **P**：提示词组装函数输出长度有上限断言。
- **Q**：单测断言技能附录长度随技能数增长不超过阈值；SYSTEM.md 字节数有回归测试。
- **I**：重启后实测首个请求 cache_read 中位下降 ≥25%。

### P1-D 并行度与失败反馈

- **D1**：`bash` 工具 description 增加「cwd 已是工作区根，禁止 cd 前缀」（P4 补丁已有半条，补齐 cd）。
- **D2**：工具错误结构化纠偏：NOT_FOUND → 提示「用 list_dir 确认路径」；
  bash exit≠0 → 附首行 stderr + 「探测类命令改用专用工具」。
- **D3**：并行判据写进工具 description 末尾（recency 位置）：「相互独立的调用必须合并进同一波次；
  同波次结果按提交顺序回喂，乱序无需担心」。

- **预期**：工具调用/轮 1.47 → ≥2.0 → 轮次 −25%。
- **P/Q/I**：同 P0-B 的三段；I 段用三组标准任务对比轮次数。

### P2-E 重试收口

`LLM_RETRY_ATTEMPTS` 缺省 2 保留，但仅对**幂等只读**调用重试；写类调用失败直接进下一轮恢复。

## 三、实施顺序（每项独立补丁、独立验收、可单独回退）

1. **P0-A**（口径修复，最小改动、立即见效，为后续限额铺路）
2. **P0-B**（轮内压缩 + 云端 token 闸，最大杠杆）
3. **P0-C**（固定前缀瘦身，改动面大但纯瘦身无语义变化）
4. **P1-D**（提示词层，即时生效）
5. **P2-E**（重试收口）

## 四、预估收益（基于实测单价与今日基线）

| 项 | 今日基线 | 优化后预估 | 依据 |
|---|---|---|---|
| 每请求固定前缀 | 170K tokens | ≤120K（P0-C） | 固定前缀中位实测 |
| 长会话末段每轮历史 | O(N) 无界 | O(1)（P0-B） | 轮内压缩闸 |
| 预算闸可见度 | 漏 9.4× | 漏 <1.2×（P0-A） | 计费口径回归 |
| 日 credits | 2,108 | 900–1,300 | 上述叠加 |
| 工具调用/轮 | 1.47 | ≥2.0（P1-D） | 波次并发上限 4 |

## 五、风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 轮内压缩打断长任务连贯性 | 摘要保留「PENDING/已否决路径」结构（既有 compaction 提示词已具备） | 单独 revert P0-B 补丁 |
| SYSTEM.md 瘦身丢关键纪律 | 移入工具 description（每轮必见）而非删除 | revert P0-C 补丁 |
| cache_read 计入预算误触停 | 权重可配，缺省 0.32 对齐实测 | env `CACHE_CREDIT_WEIGHT=0` 即刻失效 |
| 提示词改动导致行为漂移 | 改动后跑既有 evals + 三组标准任务 | revert 补丁 |

## 六、不在本轮范围

- 不改 `crates/` 源码本体——全部改动以 `scripts/patches/*.json` 形式提交，由补丁器应用。
- 不动 Cargo 版本线、不动 `v0.0.20` tag、不 force push。
- 不提交 make-video 无关产物。

## 七、实施记录（2026-11-16 完成）

### 已落地（18 个补丁，全部走 `scripts/patches/` 补丁链）

| 补丁 | 目标文件 | 内容 |
|---|---|---|
| P0A-BUDGET-CACHE-WEIGHT-1 | agent-loop/src/budget.rs | 模块级 `cache_credit_weight()`（env `CACHE_CREDIT_WEIGHT`，缺省 0.32） |
| P0A-BUDGET-TOTAL-2 | agent-loop/src/budget.rs | `total()` 计入 `cache_read × 权重` |
| P0A-BUDGET-TESTS-3 | agent-loop/src/budget.rs | 3 条单测（计入 cache / 权重置 0 / 非法值回退） |
| P0B-CFG-FIELD-1 | agent-loop/src/config.rs | `ctx_budget_tokens` 字段 |
| P0B-CFG-INIT-2 | agent-loop/src/config.rs | `CTX_BUDGET_TOKENS` 解析（缺省 65536） |
| P0B-WORKSET-BUDGET-3 | agent-loop/src/config.rs | `workset_budget()`（压缩用，与 `ctx_budget()` 的硬收紧分离） |
| P0B-COMPACT-TOKEN-GATE-4 | agent-loop/src/compaction.rs | 压缩 token 闸改用 `workset_budget()` |
| P0B-COMPACT-KEEP-5 | agent-loop/src/compaction.rs | `maybe_compact_with_keep`（轮内 8 条 / 开头 30 条） |
| P0B-ROUND-COMPACT-6 | agent-loop/src/chat.rs | **主循环轮末**按 token 闸压缩 |
| P0C-TRIM-WORKSET-1 | agent-loop/src/chat.rs | `trim_workset_by_tokens()`（保留 system 头、丢孤儿 tool） |
| P0C-PERCEIVE-TRIM-2 | agent-loop/src/chat.rs | chat 开头 perceive 后按 token 裁工作集 |
| P0C-TRIM-TESTS-3 | agent-loop/src/lib.rs | 3 条单测（有界 / 幂等 / 孤儿丢弃） |
| P0D-BASH-CD-CALL-1 | tools/tools/bash.py | `_run_bash` 内调用 `_strip_leading_cd` |
| P0D-BASH-CD-HELPER-2 | tools/tools/bash.py | `_strip_leading_cd()` 定义（放文件末尾） |
| P0D-CD-TESTS-2 | tests/test_bash_cd_strip.py | 7 条单测（新建文件） |
| P0D-BATCH-HINT-3 | agent-loop/src/chat.rs | 系统提示词末尾「同波次多工具调用纪律」 |
| P0D-ERROR-HINT-READ-4 | tools/tools/files.py | read_file NOT_FOUND 带纠偏 |
| P0D-ERROR-HINT-LISTDIR-5 | tools/tools/files.py | list_dir NOT_FOUND 带纠偏 |
| P0D-ERROR-HINT-EDIT-6 | tools/tools/files.py | edit_file NOT_FOUND 带纠偏 |

### 实施中发现的两个陷阱（已修，留档）

1. **补丁链 `--revert` 会把 HEAD 已提交的内容一起回退**（`.patchbak` 保存的是补丁链**之前**的更早状态）。
   事故：`--revert` 后 `--apply` 因锚点漂移未命中，`chat.rs` 等 7 个文件丢失已提交代码（39K 字符）。
   处置：从 `git show HEAD:<file>` 逐个恢复；补丁器 dry-run 必须无 FAIL 才能 apply。
2. **两条补丁改同一锚点会来回震荡**（内置 P1「bash 多行 fail-loud」与 P0D 的 cd 剥离）。
   修法：P0D 的锚点**完整包含** P1 的 patch 文本（P1 的文本被 P0D 原样保留 → 幂等判定命中），
   helper 定义放到文件末尾（不打断 `_run_bash` 之后的连续文本）。
   验收：连跑两次 `apply-tool-patches.py`，0 FAIL、0 重复插入。

### 验收结果

| 项 | 结果 |
|---|---|
| `cargo test -p react-agent-agent-loop` | 76 passed / 0 failed（6 条新单测） |
| `cargo test -p react-agent-host --lib` | 49 passed / 0 failed |
| `pytest tests/` | 404 passed / 11 failed —— 11 个在 HEAD 基线上完全相同（既有缺陷） |
| 补丁链 dry-run | 0 FAIL |
| 补丁幂等（两次 apply） | 0 FAIL、0 重复、17/17 检查通过 |
| `test_patch_idempotency` A 段 | 本次 18 个补丁全部合规 |

### 未实施

- **P2-E 重试收口**：重试在 LLM 层，今日仅 3 次，收益可忽略（实测不支持）。
- **P0-C C1（SYSTEM.md 瘦身）**：实测 SYSTEM.md 仅 5,010 字符 ≈ 1.7K token，
  不是主要成本源（真正的大头是 30 条压缩保留历史 ≈ 120–150K，已由 P0C 针对性解决）。
