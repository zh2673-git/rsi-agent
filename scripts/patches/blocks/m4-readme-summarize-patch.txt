- 结果 = （可选）唯一的规范化 system + 一条压缩标记消息 + 最近 `keep_last` 条（默认 10）。
- **system 保留（M3）**：不假定 system 在 `msgs[0]`（持久化历史里的 system 可能位于任意位置）；全历史
  **最多保留一个** system（取最后一条、空内容视为无），置于压缩标记之前，绝不留多个——多个 system
  会与 agent-loop 的动态 system 冲突。与 agent-loop 的 system 规范化同规则。
- **防撕裂**：切片后丢弃开头的孤儿 `tool` 消息（其 `assistant(tool_calls)` 载体已被裁掉），
  否则历史里会出现没有归属的 tool 结果，模型会困惑。
