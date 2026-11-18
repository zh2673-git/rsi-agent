# agent-loop 改造计划（P4c / P6 轮）

> 范围：`crates/agent-loop/src/*.rs`。本文件记录**已落地**的改造与其依据，不改
> `docs/00–07`（那是方案层）。改动一律经 `scripts/patches/*.json` 落盘（核心区不可直写）。

## 已落地改动

### A. trace 绝对游标 / 会话技能作用域 / system 保留（P4b–P4c 主链）

- `trace.meta` 的 `end_cursor` 取代「`trace.read(after=0).next` 充当末尾」——长 trace 分页
  下首页不再等于全量。
- 会话级技能集来自 Memory 的 `session.skills`（全量扫描），不再由 agent-loop 逐页重放 trace。
- system 保留规则统一到 4 处裁剪点（`apply_history_limit` / `trim_workset_by_tokens` /
  `halve_window` / compaction）：历史 system 视为陈旧丢弃、至多保留一个且置首。

### B. 长会话成本（P4c）

- 轮末压缩闸（在 `messages.extend(round_msgs)` 之后）：超工作集预算就把旧史摘要掉，
  让下一轮上下文回到有界大小——此前历史只在 chat 开头判一次，长会话中途只增不减
  （成本 O(N²)，实测单会话 371 轮累计 `cache_read` 47.3M）。
- 同参重复阈值缺省 0 = 禁用。

### C. 预算与无进展熔断（P4b/P4c）

- token 预算硬停 + 墙钟软收敛（`budget::StopReason`）。
- 无进展熔断：连续失败 ≥3 才熔断（容忍偶发抖动），已产出内容仍在 trace 与前端可见。

### D. chat.rs 两处文档债（本轮补丁 174/175）

**D-1「停车检查点①」注释块逐字重复两遍 → 去重为一份**

- 补丁：`scripts/patches/p4c-chat-dup-checkpoint1-1.json`（order 174，`converge: true`）。
- 现象：`for _round in 0..max_rounds` 的循环体开头，`// 停车检查点①：每轮开头——取消
  （硬中止，用户意愿最高）优先，` 与 `// 其次预算：token 硬停，墙钟软收敛（见
  budget::StopReason）。` 这两行**各出现两次**（4 行里两两重复）。
- 处置：保留一份。用 `converge` 而非 `repair`：收敛型仍带 patch 文本（保留「本该写成什么样」
  作文档），且**坏块消失即视为完成**，锚点不存在不报 FAIL。
- 终态：`// 其次预算：…` 全局只出现一次。

**D-2 轮末 observe/K503/extend 块缩进错位（8 空格，应为循环体 12 空格）**

- 补丁：`scripts/patches/p4c-chat-reindent-observe-1.json`（order 175，
  `applied_marker = "            messages.extend(round_msgs);"`，12 空格）。
- 现象：`// LOOP-P2/A2：每轮工具/观察结果必须落持久层` 这个**注释头本来就是 ind12**，但
  其下的 `if !self.observe(...)`、`&& self.append_fails...`、`{`、`return json!({...K503...})`、
  `}`、`messages.extend(round_msgs);` 共 7 行是 **ind8**——注释头挂在体之上却不同层。
- 旁证：紧邻的 `:1191` `}`（收束技能工具并集 `if`）是 ind12，其后压缩闸整块 ind12，
  停车检查点② / ②c 也是 ind12。故 ind8 是错位，不是风格。
- 边界怎么定的：生成脚本首版对 8 行统一断言 `lead == 8`，在注释头那行抛
  `AssertionError: ('lead not 8', 12, ...)` —— 正是这个断言暴露了真实边界（7 行 +4，
  不是 8 行 +4）。重写后只对 7 行加 4 空格。
- 语义零变化：纯空白改动，无 token/逻辑影响；`cargo check` + 全仓测试通过。

## 补丁纪律（本仓核心区不可直写）

- 追加/插入型：必须给**全局唯一** `applied_marker`（教训：`p5-stream-norm-1` 曾因同名片段
  误判，已加后缀）。
- 删除型：用 `repair`（patch 可空）或 `converge`（保留 patch 作文档）；repair 必须配
  `applied_marker`。
- 锚点：由 python 按行号切片逐字节取自源码，先断言 `src.count(anchor) == 1`。
  **不要「修复」已消失的 repair 锚点**——锚点不存在 = 已修好。
- 新补丁放 `scripts/patches/` 顶层（`_load_external` 用 `pdir.glob("*.json")`，子目录不读）；
  长文本放 `blocks/`。
- 新文件用 `create: true` + `content_file` + `create_marker`。

## 验证记录（本轮）

- `cargo test --workspace`（`.scratch/run_clean.py`，剥 16 个泄漏环境变量）：**19 suite 全绿**，
  0 FAILED / 0 panicked / 0 `error[`。agent-loop lib **83 passed**、conformance_check 1、
  contract_conformance 2、react_mocks 50。
- `python -m pytest tests -q`：**428 passed**。
- 补丁幂等：174 二次执行为 `OK 已收敛`，175 为 `OK 已应用过（applied_marker 命中）`，
  全量 `--dry-run` 的 `FAIL` 计数为 **0**。
