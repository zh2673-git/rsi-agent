# Tasks：工具调用效率

> 上游 spec：`specs/call-efficiency/spec.md`
> 前置：`specs/tool-call-integrity`（规则层）已完成并回归通过
> 基线冻结：chat#3 = 217 调用 / 160 轮（2026-11-02 21:21 实测）

## 进度

- [ ] A1 配置收敛（P0，零代码）
- [ ] A2 重启后复测基线（验证 A1 + D1 收益）
- [ ] B1 提示词反向约束（P1，改 Rust）
- [ ] B2 技能附录按需注入（P1，改 Rust）
- [ ] C1 `list_dir` 递归根层跳过（P1）
- [ ] C2 `symbols_search` 无结果原因可辨（P1）
- [ ] C3 错误码三分（不可用 / 被脱敏 / 不存在）（P1）
- [ ] D1 `chat_summary` 效率指标入 trace（P2）
- [ ] D2 评估 `tool_failures` 是否参与收敛（P2，可能不做）
- [ ] E1 复测达标判定（Q）+ 不退化判定（I）

---

## 阶段 A：配置收敛（P0，零代码，热生效需重启）

### A1 配置收敛

改 `runtime/.instances/1102/config.json` 的 `agent` 段：

| 项 | 现值 | 目标 |
|---|---|---|
| `tool_result_limit` | 0 | 4000 |
| `compact_keep` | 194 | 10 |
| `budget_secs` | 0 | 900 |
| `max_rounds` | 1000 | **不动** |

- **验收**：三项改完；`python -c` 读回确认；重启后 `budget_secs` 生效（跑一个长任务
  确认 900s 到点收敛，或读 trace 的 `budget exhausted: wall clock`）。
- **回退**：原值备份为 `.bak`；三项独立，可单独回退。
- **注意**：`agent.*` 走 env 注入 agent-loop 构造期 → **必须重启**，不像 `tools.enabled` 热生效。

### A2 重启后复测基线

- 用**同等工作量**任务（一次工具层审计级）复测，不得用不同任务对比。
- 记录：`calls / rounds / bash 占比 / cd /d 外壳率 / grep+symbols_search 使用数`。
- **验收**：与 §2 基线并列成表，写回 spec §2 作为「A 后」对照列。
- 特别确认 **E3 收益**：`cd /d` 外壳率应从 96% 降到 ≤10%（D1 已修，重启才生效）。

## 阶段 B：提示词反向约束（P1，改 Rust，需重编译）

### B1 `DEFAULT_SYSTEM_PROMPT` 追加三条

`runtime/crates/agent-loop/src/lib.rs:134`：

1. 批量优先：独立无依赖的调用合并进同一轮（当前 69% 轮次只发 1 个）。
2. 专用工具优先：`grep`/`symbols_search` 查内容、`read_file` 读文件、`list_dir` 列目录；
   `bash` 仅用于跑测试/git/构建等真正需要 shell 的场景。
3. 收敛约束：同一目标两次尝试无新信息 → 换策略，不重复调用。

- **验收**：`cargo test -p agent-loop` 全绿；提示词快照用例（若有）同步更新。
- **风险**：模型过度保守 → 由 E1 的 I 项（任务质量不降）兜底。

### B2 技能附录按需注入

`skills.rs:44 skills_appendix()`：`## Skill self-extension` 段（约 1.5 KB）改为
仅在用户明确要求「造技能/打包工具」时注入；`## Artifact output` 保留（短且有硬约束价值）。

- **验收**：普通任务轮次的 system prompt 长度下降（记录 before/after 字符数）；
  提出「造技能」时该段仍出现（用例守护）。

## 阶段 C：专用工具可信度（P1）

### C1 `list_dir` 递归 `max_depth=1` 跳过根层文件

- 现象：`list_dir` 递归 `max_depth=1` 时根层文件被整层跳过，返回「无文件」。
- **验收**：`tests/test_tool_contract.py` 追加递归用例（先红后绿）；模型侧 bash `dir /b`
  使用数下降（E1 复测时观察）。
- **风险**：触及递归语义，其他调用方可能依赖旧行为 → 用例先行。

### C2 `symbols_search` 无结果原因可辨

- 现状：此仓库返回空列表，模型无法区分「没有匹配」与「工具坏了」→ 弃用（实测 0 次）。
- 目标：返回 `{ok:true, result:{matches:[], reason:"..."}}`，reason ∈
  {`NO_MATCH`, `UNSUPPORTED_LANGUAGE`, `PARSE_FAILED`}。
- **验收**：空结果时 reason 必填；`grep`/`symbols_search` 合计使用数 ≥5（Q 项）。

### C3 错误码三分

- 目标：`TOOL_UNAVAILABLE`（工具坏）/ `MASKED`（输出被脱敏）/ `NOT_FOUND`（真的不存在）
  三者可区分。当前 D6 的表现为「被脱敏 → 报文件不存在」，模型易误判。
- **验收**：脱敏命中时错误码为 `MASKED` 而非 `NOT_FOUND`。
- **关联**：`tool-call-integrity` spec 的 D6（未修，核心层 Rust）。

## 阶段 D：效率可观测（P2）

### D1 `chat_summary` 效率指标入 trace

`chat.rs:643` 的 metrics 已有 `llm_calls / retries / tool_failures`，补：

```json
{"type":"chat_summary","calls":N,"rounds":N,"single_call_rounds":N,
 "tokens":N,"failures":N,"wall_ms":N}
```

- **验收**：一次 chat 结束 trace 末尾出现该事件；字段可被脚本统计（无需解析全部事件）。

### D2 评估 `tool_failures` 是否参与收敛

- 现状：`chat.rs` 里 `tool_failures` **只进 metrics，无任何消费点**。
- 评估：连续 N 次失败是否应提前收敛。**可能结论是「不做」**——失败率仅 2.7%，
  提前收敛可能误杀「试错后成功」的正常探索。
- **验收**：给出结论（做/不做 + 理由），记入 spec「已评估不做」或实施。

## 阶段 E：终验

### E1 达标（Q）+ 不退化（I）

- **Q**：同类任务 ≤100 调用 / ≤80 轮；`cd /d` 外壳 ≤10%；`grep`+`symbols_search` ≥5。
- **I**：
  - `python -m unittest discover -s tests` → 24/24 OK（新增用例后相应增加）；
  - `python scripts/skill_validate.py --all --mode full` → 6/6 ok，无新增 warning；
  - `python scripts/conformance_gate.py --skill skills/tdd --smoke` → ok；
  - `python scripts/ledger.py verify` → violations = []；
  - **任务质量不降**：同一审计任务仍须产出全部 D1–D5 结论。

---

## 迭代记录

- 2026-11-02：spec 立项。基线冻结 chat#3 = 217 调用 / 160 轮（trace
  `s-mvz75po6.jsonl` 1.03 MB）。核心判读：**69% 轮次只发 1 个调用**（并行未用）；
  bash 占 65% 且 96% 带 `cd /d` 外壳（纯环境税 5353 字符 = bash 总量 26%）；
  专用检索工具近乎弃用（grep 2 / symbols_search 0）。三项配置把刹车拆了
  （`max_rounds=1000` / `tool_result_limit=0` / `budget_secs=0`），
  且 `compact_keep=194 > compact_trigger=40` 使压缩近乎失效。

## 快照同步必重放项

> 本 spec 的阶段 B 改动位于 `runtime/crates/agent-loop/src/{lib,skills}.rs`，
> 与 `tool-call-integrity` 的 `bash.py` 同属「运行时快照适配」范畴。

1. **`bash.py:_shell_cwd()`**（已有，`tool-call-integrity` T2 登记，第 4 处）。
2. **`lib.rs:DEFAULT_SYSTEM_PROMPT`**（阶段 B1）——若上游快照覆盖，提示词约束会丢失。
3. **`skills.rs:skills_appendix` 按需注入**（阶段 B2）——同上。

> 这三处必须随每次 `runtime/` 同步重放，否则「效率约束」会在下一次快照更新后静默消失。
> 阶段 A 是纯配置，不在重放范围内。
