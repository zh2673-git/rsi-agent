# memory 插件改造计划（M 轮）

> 范围：长 trace 绝对游标、会话级技能恢复、system 保留规范化。**不改** `trace.read.next` 的
> 分页消费语义，不改 rollback / sidecar(`events/*.jsonl`) / `session.index` 语义。

## 背景（为什么改）

历史实现里，agent-loop 把 `trace.read(after=0).next` 当作「本回合终点游标」。这在短 trace 上
恰好正确（首页即全量），但单页受 **800 条 / 约 1MB** 双预算限制（见 `trace.read`），长 trace 必然
漏算：游标偏小 → 回合边界错位。根因是**没有一个 op 能在不改分页语义的前提下提供真实末尾游标**。

同时，会话级已加载技能也只能靠 agent-loop 用 `trace.read(after=0)` 逐页重放得到——首页之后的
`skill_loaded` 会被漏掉，且把 trace 分页细节泄漏到编排层。

## 本次改动（已落地）

### M1 `trace.meta`（新增 op）

- 返回：`{ok:true, exists, size, mtime_ms, total_events, end_cursor}`。
- `total_events` = 完整有效事件数 = `traceOffsets(file).length`（跳过损坏行）；`end_cursor` 同值，
  即**真实末尾绝对游标**。
- 缺 trace 文件 → `{ok:true, exists:false, size:0, mtime_ms:0, total_events:0, end_cursor:0}`
  （空状态而**非失败**，让 agent-loop 区分「尚无事件」与「读失败」）。
- `trace.read` 完全不变：`next` 仍是本页已消费游标。

### M2 `session.skills`（新增 op）

- 走 `traceOffsets` + `readEventLine` 扫描**完整** trace（不是只看首页）。
- 返回去重、保序的技能名（`type==="skill_loaded"` 且 `skill` 为非空字符串）。
- 供 agent-loop 恢复会话级技能作用域，替代原先逐页重放。

### M3 `summarize` 的 system 保留

- 不假定 system 在 `msgs[0]`（持久化历史里 system 可能在任意位置）。
- 全历史最多保留**一个** system：取最后一条、空内容视为无、置于压缩标记之前。
- 结果形状：`sys ? [sys, marker, ...kept] : [marker, ...kept]`。
- 与 agent-loop 的 system 规范化**同规则**（唯一、非空、置顶），避免压缩后再与动态 system 冲突。
- 保留既有孤儿 tool 防撕裂逻辑。

## 回退决策（保留项）

- `trace.read` 不改：它是前端增量拉取/网关追赶的消费游标，改成总末尾会破坏重放。
- 不重新设计 trace/turn 存储：turn 仍只存绝对游标，事件以 trace 为唯一真相，避免双写幽灵事件。
- `attachments` 仍是 Rust 侧 `contract.rs::MemoryMsg` 才有；TS `Msg` 丢弃不报错（前向兼容），
  README 的 `attachments?` 记录的是线契约（Rust 侧），非 TS 实现字段。

## 验证

- `runtime/crates/host/tests/e2e_ts_memory.rs`：>800 条 / ~1MB 后 `trace.meta` 末尾游标仍准；
  `trace.read.next` 仍只是本页消费位置；后续页 `skill_loaded` 仍能被 `session.skills` 恢复；
  system 位于不同位置时压缩后仍保留且只剩一个；rollback/sidecar/session.index 语义不变。
- 全仓 `cargo test`。

## 改动方式备忘

Memory 属 `_CORE_NEVER_ALLOW`，永不豁免写。全部改动经 `scripts/patches/*.json` 外挂补丁 +
`python scripts/apply-tool-patches.py` 落地（含本文件、`README.md`、`memory_plugin.ts`）。
