## 发行侧 38 条改进回灌上游

把 rsi-agent 长期挂在补丁集里的发行形态通用改进（与业务语义无关的部分）整体并入上游，
补丁集因此从 240 条降到 202 条。

---

### 按需装载工具（deferred tools）— 12 条

工具 schema 随**每一轮**请求重发。MCP 每接一台 server 就是十几件工具的完整 JSON Schema，
而单轮真正用得上的通常只有 1-2 件——其余是纯 token 税，且长会话里这笔开销与任务难度无关。

- 新增 `deferred` 标记：`Some(true)` = 该工具**不进下发的工具清单**，系统提示只留一行名字摘要。
- 保留工具 `load_tools({"names":[...]})` 报名后，schema 下一轮随清单下发。**结果只回名字不回 schema**
  ——回喂一遍等于同一条信息花两遍 token，且 tool_result 另有 8000 字符上限会把大 schema 腰斩成残缺 JSON。
- 新增 `crates/agent-loop/src/tools_defer.rs`：`deferred_line()`（摘要行，上限 60 个名字，超出报 `(+N more)`）
  与 `result` 系列纯函数，可单测。
- **判据边界**：只影响**下发**，不影响**调用**。模型凭记忆直接调一个 deferred 工具照样成功
  （`tools.call` 不看该标记）——「猜中即可用」，不惩罚直觉。
- 缺省（未声明）→ 照常下发，既有工具行为零变化。

### 回合持久化与中途暂停 — 15 条

把「一次请求」升级为**可寻址、可恢复的对象**。

- 新增 `crates/agent-loop/src/turn.rs`：`TurnStore` 保存 `turn_id`、trace 游标区间、`paused` 暂停态、
  补播视图。纯状态机，可单测（含 `turn_id` 白名单，阻止路径穿越）。
- 新增保留工具 `ask_user`：模型向用户提问并**暂停回合**——与「把问题写进最终答复然后结束」的区别是
  回合不结束，用户回答后按 `tool_call_id` 接回同一条 tool 结果，**工作集不重建**。
- `ChatReq` 增 `turn_id` / `tool_reply` 两个可选字段：
  - `turn_id` 给了就复用该 turn（暂停后回复走这里），没给就新开一条；
  - `tool_reply` 必须带 `tool_call_id` 而不是只给文本——回复要作为**那一条 tool_call 的结果**接回去，
    否则模型看到的是「一个没有对应调用的孤立 tool 消息」，严格函数调用协议下直接报错，
    宽松协议下模型会重新规划、把已有进度丢掉。
- 两者都 `#[serde(default)]`，向后兼容所有既有调用方。

### 工具纪律 — 8 条

- `bash` 多行命令 fail-loud（`MULTILINE_UNSUPPORTED`）：`cmd.exe /c` 只跑首行，其余行静默丢弃且
  退出码仍为 0——这是最隐蔽的一类缺陷，宁可报错。
- trace 精读查询、`web_read` 预算、compaction pending 标记、memory_plugin 契约对齐。

### 测试密闭性 — 3 条

- `EnvGuard` RAII：env 类测试改用守卫对象，panic 安全还原。
- F4 系列补 `env_lock()`：`std::env` 是**整个进程共享**的，三个测试各自「保存→改→断言→还原」同一批键，
  并发时 A 的还原会踩掉 B 刚设的值——测试随即随机失败，且失败信息指向断言处，看起来像逻辑错误。
  以前靠 `--test-threads=1` 规避，那是**用跑法掩盖缺陷**：CI 或 IDE 单点运行一次就复现。
  这把锁把「隐式的跑法要求」变成「显式的代码约束」。

### 其他

- `.gitignore` 补 `.rsi/`：跑 `cargo test` 会在 crate 目录下生成派生工作区（board/profile/turns），
  不忽略会被误提交。

---

## 验证

`cargo test --workspace`：19 个 test binary 全绿，**136 passed / 0 failed**
（回灌前 111 passed，本版新增 25 个测试：`tools_defer` 4 个、`turn` 10 个、回合/延迟装载端到端用例等）。

## 与 v0.1.23 的关系

v0.1.23 交付 embedding 双通道；本版交付 38 条回灌。两者独立，可分别升级。

## 升级注意

- 新增 `ask_user` / `load_tools` 两个保留工具名；若有自定义工具用了这两个名字，需改名。
- `ChatReq` 新增两个可选字段，缺省行为与旧版完全一致；旧客户端无需改动。
