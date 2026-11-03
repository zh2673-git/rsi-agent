# Tasks：计划完成度校验

> 上游 spec：`specs/plan-completion/spec.md`
> 前置：`specs/tool-call-integrity`（已完成并回归通过）
> 并列：`specs/call-efficiency`（本 spec 承接其 §E6 立项与 §E7 观测遗留）

## 阶段 A：解析器（P，纯函数）

- [ ] A1 新建 `runtime/crates/agent-loop/src/plan_scan.rs`：`PlanItem` / `PlanScan` / `scan_plan`
- [ ] A2 规则实现：行首 `- [ ]`/`- [x]`/`- [X]`；`section` 取最近 `## `；**跳过 ``` 围栏内行**
- [ ] A3 在 `lib.rs` 挂 `mod plan_scan;`，导出 `pub use plan_scan::{scan_plan, PlanScan};`
- [ ] A4 单测 ≥5：空文本 / 混合勾选 / 围栏跳过 / 无段名 / 大写 X
      **验收**：`cargo test -p react-agent-agent-loop plan_scan` 全绿

## 阶段 B：挂载（P，改 `chat.rs`）

- [ ] B1 计划路径解析：`cfg.plan_file` → 本 chat 最后一次读过的 `specs/*/tasks.md` → 跳过
      （fail-open，解析失败不报错）
- [ ] B2 新增 `PLAN_REMINDER`（含前 10 条未勾选项原文 + 「共 N 条」概括），放进 `lib.rs` 常量区
- [ ] B3 在 `chat.rs:440` 分支、`verify_before_final` **之后**加提醒：`plan_reminded` 一次性、
      `continue` 注入
- [ ] B4 `answer_covers_plan()`：关键词命中 **且** 至少提到 `min(3, N)` 条未勾选项 → 放行
- [ ] B5 二次收敛**无条件放行**（防死循环），剩余数留给 `chat_summary`

## 阶段 C：观测补齐（Q 前提）

- [ ] C1 `budget_stop` 也写 `chat_summary`（`ok:false, stopped_by:"tokens"`）
- [ ] C2 空答案出口（K502）同样补 `chat_summary`（`stopped_by:"error"`）
- [ ] C3 `finish` 的 `chat_summary` 增 `plan_unchecked: Option<usize>`、`plan_path: Option<String>`
- [ ] C4 确认 `FROZEN_EVENT_TYPES` **不需要改**（新增字段，不新增事件类型）

## 阶段 D：配置

- [ ] D1 `AgentLoopConfig.plan_file: Option<String>`（`PLAN_FILE` env，默认空）
- [ ] D2 `config.rs` 解析 + `config.example.json` 补 `agent.plan_file: ""`
- [ ] D3 显式设置时**只用**该文件（禁用自动探测），避免历史遗留未勾选项误报

## 阶段 E：验收

- [ ] E1 P 项：`scan_plan` 单测 + 事件断言（恰好 1 条 `policy/plan_completion`、第二次不发）
- [ ] E2 Q 项：3 未完成 / 2 完成 → `ok:true` + `answer` 保留 + 1 次提醒 + `plan_unchecked==3`
- [ ] E3 Q 项：无计划 → 不发事件 + `plan_unchecked==null`
- [ ] E4 Q 项：预算中止 → trace 存在 `chat_summary` 且 `stopped_by=="tokens"`
- [ ] E5 I 项：**既有 64 项测试全绿**（`cargo test` 全量，零回归）
- [ ] E6 I 项：`cargo build -p react-agent-agent-loop` 无新警告
- [ ] E7 **重启宿主后复测**（否则测的是旧二进制，见 call-efficiency §E2 教训）

## 迭代记录

- 2026-11-03 06:4x：立项。由 `specs/call-efficiency` §E6（原「只登记不实施」）与 §E7 观测遗留
  合并而来。已核实的事实基础：全仓 `findstr /S /C:"tasks.md" *.rs` 仅命中 `lib.rs:538` 一条
  测试字符串 → **代码里无一处读取计划文件**；`verify_before_final`（`chat.rs:444`）默认关闭且
  只扫关键词；`budget_stop`（`chat.rs:630`）只写 `error` 不写 `chat_summary`。
