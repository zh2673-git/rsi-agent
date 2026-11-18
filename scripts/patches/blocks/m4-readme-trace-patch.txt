- `trace.read` 走 `traceOffsets` 行偏移索引 + `readEventLine` 精确读行（不再整体重读/全量解析）：文件
  `size`+`mtime` 命中缓存即按偏移直读所需页。`after=N` 返回第 N 条之后的事件，`next` 是**本页已消费
  游标**（UI 增量拉取），受 800 条/约 1MB 双预算分页，**不是** trace 总末尾。
- `trace.meta` 才提供**真实末尾绝对游标**：`total_events` = 完整有效事件数（`traceOffsets().length`，
  跳过损坏行），`end_cursor` 同值；另附 `exists`/`size`/`mtime_ms`。缺 trace 文件时返回
  `{ok:true, exists:false, total_events:0, end_cursor:0}`（**不是失败**）。服务端编排层（agent-loop）
  的回合游标必须用它，不能拿 `trace.read` 首页的 `next` 冒充总末尾——短 trace 下二者恰好相等，
  长 trace（>800 条）会漏算。
- `session.skills` 扫描**完整** trace（逐条 `readEventLine`，非仅首页），返回去重后的已加载技能
  （`type==="skill_loaded"` 且 `skill` 非空），供 agent-loop 恢复会话级技能作用域。
