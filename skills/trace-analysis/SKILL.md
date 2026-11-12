---
name: trace-analysis
description: Query agent trace jsonl (tool distribution, writes, errors, multiline-bash, bash-substitutability, chat summaries) with fixed subcommands instead of writing throwaway probe scripts. Use when asked to 统计工具调用/分析本次会话/trace 里有没有 X/为什么这么慢/调用效率复盘/bash 用得该不该.
origin: user
---

# trace 查询（免写脚本）

本技能只有一个目的：**把「临时写个 python 脚本数一下 trace」这件事消灭掉**。
那类脚本每次重启都会重新长出来（落进 `outputs/_scratch_*.py`），既污染产物目录，又让每个问题
多花 2 次工具调用（write_file + bash）。这里给出固定查询，一条命令拿结果。

## 何时用

- 「统计本次会话的工具调用分布 / 哪件工具用得最多」
- 「trace 里有没有空输出 / 失败调用 / 重试」
- 「为什么这次这么慢 / 多少轮 / 花了多少 token」
- 「有没有多行 bash 被截断」（D1 缺陷的日常巡检）
- 「bash 用得该不该 / 哪些 bash 调用本该用专用工具」（`substitutability`）
- 复盘调用效率（配合 `specs/call-efficiency`）

**不要**再 `write_file` 新建脚本，也不要往 `outputs/` 落盘。

## 怎么用（bash 单行，勿带换行）

```
python skills/trace-analysis/trace_query.py summary   --trace s-mvzz0e2s
python skills/trace-analysis/trace_query.py toolmix   --trace s-mvzz0e2s
python skills/trace-analysis/trace_query.py writes    --trace s-mvzz0e2s
python skills/trace-analysis/trace_query.py errors    --trace s-mvzz0e2s
python skills/trace-analysis/trace_query.py multiline --trace s-mvzz0e2s
python skills/trace-analysis/trace_query.py calls     --trace s-mvzz0e2s --round 40
```

`--trace` 可给三形态，自动解析：
- 会话 id（`s-mvzz0e2s`）→ `runtime/plugins/memory/data/traces/<id>.jsonl`
- 相对/绝对路径（`runtime/.../traces/web.jsonl`）
- `--latest`：取 `traces/` 下最新修改的 jsonl（不给 `--trace` 时的缺省行为）

## 子命令与输出

| 子命令 | 输出 |
|---|---|
| `summary` | 每轮 chat 的 `chat_summary`：rounds/calls/llm_calls/tokens/stopped_by/failure_rate |
| `toolmix` | 工具名计数 + bash 首 token 细分（powershell/python/findstr/dir/…） |
| `writes` | `file_change` + `artifact` 的路径与**目录分布**（一眼看出是否在往 outputs 堆中间物） |
| `errors` | `ok:false` 的 tool_result + bash `exit_code != 0`（含截断后的输出前 80 字符） |
| `multiline` | **含换行符的 bash 调用清单**（cmd.exe /c 只跑首行 → 这些是静默截断嫌疑） |
| `calls` | 按 round 升序的调用序列 `round/tool/参数摘要`，可 `--round N` 过滤 |
| `substitutability` | bash 可替代率：first_token 命中「内置工具可替代」映射的比例 + 桶分布 + 每桶样本。`python -m`（pytest/pip 等模块运行）豁免不计——那是 bash 本职 |

全部输出单个 JSON 对象：`{"ok":true,"trace":...,"<子命令名>":...}`；
文件不可达/格式异常 → `{"ok":false,"error":{...}}`（**不抛 traceback**，模型可直接读错误改参数）。

## 边界

- 只读：不写任何文件（这正是它存在的意义）。
- 容忍字段缺失：全部 `.get()` + 默认值，trace 格式演进只降低统计精度，不报错。
- 不解析 `result_truncated` 里嵌套的完整 payload 之外的东西；嵌套 JSON 解析失败按「原始字符串」处理。
- 大文件按行流式读取，不做全量 `json.loads`（trace 可到几十 MB）。

## 配套工具（可选启用）

`tools.json` 声明了 `trace_query_tool`（执行器 `exec_query.py`，协议：stdin JSON → stdout JSON，
子命令白名单防注入）。技能经 `skill_install` 安装后，该工具进入工具池；**用户技能工具需在
设置界面（Skills 页）批准启用**。bash 直调 `trace_query.py` 始终可用，两者等价——启用工具的
意义是「问统计」时无需 bash 参与。

## 验收标准

一次 trace 查询合格，当且仅当：

1. **零新建脚本**：全程未 `write_file` 新脚本、未往 `outputs/` 落盘。自检：`git status --porcelain` 里无 `outputs/_scratch_*.py` 之类新增。
2. **输出可解析**：stdout 是单个 JSON 对象，含 `ok` 字段。`ok:false` 时带 `error.code`，且**无 traceback**（有 traceback 即不合格——那说明错误没被收敛成模型可读的形状）。
3. **口径可复核**：给出的每个数字都能用另一条子命令或原始 jsonl 复算。例：`toolmix` 的各工具计数之和应等于 `summary` 的 `calls` 总量；`multiline` 的条数应与 `calls` 里含换行的 bash 条数一致。
4. **只读**：不修改任何 trace 文件（`git status` 对 traces 目录零改动）。

反例（一律判不合格）：为回答「统计一下」而新建 `.py` 探针；把大 jsonl 全量 `json.loads` 进内存后报 OOM/超时；报错直接抛 traceback 让调用方猜。
