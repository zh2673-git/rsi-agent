# v0.0.15 — 抄三机制：工具按需装载 / 记忆分层 / 回合持久化

> 路线 D：搬 DeepTutor 的机制，不集成它本身。三件事对应三个真实的痛——工具说明书吃光首轮预算、长会话「上周那件事」无从回答、断线就得重跑且模型不能中途问人。

## 一、工具 schema 按需装载

接满 MCP server 后工具定义能吃掉首轮预算的大头，而单轮真正调用的只有 1-2 件。

`ToolSpec.deferred` 标了的工具**不进下发清单**，系统提示词里只留一行名字摘要；模型调保留工具 `load_tools` 报名后，schema 自下一轮下发。

**关键边界：只影响下发，不影响调用。** 模型凭记忆直接调也能通——封了这条路就得先花一次往返报名，比省下的 token 更贵。端到端用例 `deferred_call_still_works_without_loading` 专门锁这条。

默认只对 MCP 工具开（`tools_plugin.py` 的 list 分支）。**技能工具不标**：通常 1-3 件，且刚 `load_skill` 就期待可见，藏起来会让「装了却看不见」这个老坑复活。

- 名字摘要上限 60 个（超出报 `+N more`）——一行涨成三十行就又变成税
- 报名结果**只回名字不回 schema**：schema 下一轮随清单下发，回喂一遍等于同一条信息花两遍 token，且 `tool_result` 另有 8000 字符上限会腰斩成残缺 JSON

## 二、记忆分层 L2/L3

trace 是 append-only 全文（单会话可达几十 MB），profile 是结论，中间缺一层「那天干了什么」。

`scripts/memory_consolidate.py` 把 trace 压成 `.rsi/memory/L2/<YYYYMMDD>.md`，`L3/index.json` 只存元数据。

| 约束 | 做法 |
|---|---|
| 确定性 | `render_day(parse_day(x))` 逐字节幂等，每次 `build` 当场自验；时间只进 `index.generated_at` |
| 召回不读正文 | `recall` 的 `bytes_read` 恒等于 index 大小（可核对的量，不是注释） |
| 分天边界 | 按 UTC 分天，跨午夜会话切开——不切会把两天的活算给一天 |
| 有界 | 12KB/天、12 会话、6 提问、20 文件；截断**显式标注**（静默截断会把「就这么多活」变成假事实） |

`memory_ctx.rs` 把「最近 7 天有哪些活、各多大」注入提示词（≤900 字符），要细节让模型按天打开 L2。`days_ago` 服务端算好——让模型拿今天减 `20261103` 是它最容易错的算术之一。自带 `civil_days`（Howard Hinnant 算法），不引 chrono。

## 三、回合持久化 + `ask_user` 暂停

turn 存 `.rsi/turns/<id>.json`，**只存 trace 游标不存事件**——一份真相，回滚语义天然一致（自己再存一份副本，截断 trace 时副本就成了幽灵）。

- **seq 是 trace 绝对下标**，补播直接把 `after_seq` 交给既有的 `trace.read(after=N)`，零换算（每回合从 0 就要两端各换算一次，是「客户端服务端各算一遍」类 bug 的产地）
- 状态机 `running → paused → running → done|failed|cancelled`；`mark_terminal` 只从非终结态迁移且**保持第一次结论**（成功不能被后续 cancel 改写）
- **暂停点必须在波次末**：同波次还有别的工具并行跑，提前挂起会让结果随收敛丢失
- `valid_turn_id` 白名单防路径穿越；保留 24 条/会话，只淘汰终结态（删 running/paused 等于让前端失去补播目标）

`ask_user` 是保留工具，命中即波次末收敛为 `paused` 且**不进下一轮 LLM**——那会花钱让模型自己说「我在等回答」。回复按 `tool_call_id` 接回同一回合。

`turn/replay` 只回游标区间不回事件，`turn/list` 列表。做成 agent-loop 的 op 而不是 host 路由：host 在禁写区，且补播本质是纯读。

### 两个真 bug，由端到端用例抓到

1. `apply_reply` 原先整体覆写 `pending` 把 `question` 丢了 → 模型只看到答案，不知道在答哪一问
2. 暂停回答只写了 memory、没 `push` 进本轮 `messages` → 本轮模型根本看不见（实测「回答消失」）

## 顺带修好

`.gitignore` 里的 `tools/` 没有锚定根目录，连带忽略了 `runtime/plugins/tools/` 整棵（内置工具实现）。改成 `/tools/`。

## 验证

| 项 | 结果 |
|---|---|
| `cargo test -p agent-loop` | lib 68 / conformance 1 / 另有 2 / react_mocks **47** 绿 |
| `pytest tests -q` | **373 passed** |
| 补丁链 `--dry-run` 二次 | **0 FAIL / 0 DRY**（幂等） |
| 全仓 `cargo check` | **Finished，零 warning** |
| 端到端（隔离实例 `:8711`） | `ok` / `turn_id=t-1794372368141-4634c0` / `status=done` / 游标 `3 → 6` |
| `memory_consolidate.py build` | 10 天 / 36 会话 / 59225 事件，幂等校验通过 |
| `recall --days 7` | `bytes_read 3318 == index 3318` |

## 已知失败（非本版引入）

`num_ctx_passthrough_follows_context_window`（`react_mocks.rs:1925`，断言 `num_ctx` 为 4096，实得 `Null`）在**干净 HEAD 上同样失败**，已用 `git stash` 三路反证（stash src / stash tests / stash all）确认。不顺手修，也不假装它通过。

## 遗留

- host 侧还没有 `/api/turns` 路由。补播目前经 agent-loop 的 `turn/replay` / `turn/list` op 可达，前端要接时再加薄路由。
- `ask_user` 断线重连后，前端尚未渲染提问卡。
- **需重启一次 host**：补丁改的是 `runtime/` 下的 Rust 源码与 `tools_plugin.py`，必须重编才生效。

## 升级方式

```bash
git pull
python scripts/apply-tool-patches.py --dry-run   # 预演，应 0 FAIL / 0 DRY
python scripts/apply-tool-patches.py             # 应用，自动备份 .patchbak
# 重启 run.cmd
```

回滚：`python scripts/apply-tool-patches.py --revert`（走 `.patchbak`，**不要**先 `del *.patchbak`）。
