# rsi-agent v0.0.22

本版覆盖 `v0.0.21..v0.0.22` 区间的**全部 9 笔提交**，384 个文件，+6,617 / −187。
其中前 2 笔（`187a119` 登录按钮三层契约、`ef3e906` v0.0.21 说明勘误）落在 `v0.0.21` tag
**之后**、已被 v0.0.21 说明写过；本版真正新增的是其后 **7 笔 / 376 文件 / +6,154 −168**。

主题三条线：**长会话不再越跑越贵**（绝对游标 + 轮末压缩闸 + 预算账分层）、
**请求对上层可解释**（`http_attempts` / `provider.capabilities`）、
**发行形态可重放**（整条补丁链 340 个文件入库，`--dry-run` 全量幂等）。

区间构成（`git log --oneline v0.0.21..HEAD`，新→旧）：

| 类别 | 提交 | 说明 |
|---|---|---|
| 补丁 marker 修复 | `bb15543` | 4 条既存补丁补 `applied_marker`（4 文件） |
| 测试判据 | `493c156` | 幂等判据保行首缩进 + 契约测试放行 repair/converge 空 patch（2 文件） |
| 补丁链入库 | `a69ae1e` | 340 个补丁文件（119 JSON + 219 block + 2 PLAN block）（336 文件） |
| tools 性能 | `1f62108` | bash 快照遍历改 `scandir` + 下钻前剪枝，单次 22s → 1s（6 文件） |
| llm_adapter | `7edaee6` | `http_attempts` 请求观测 + provider 能力声明（标题第三项「路由粘性」未实现，见 §4）（9 文件） |
| memory | `b7d1801` | `trace.meta` / `session.skills` 两个纯追加 op + 压缩时 system 保留规范化（3 文件） |
| agent-loop | `159b5f8` | trace 绝对游标 + 会话级技能作用域 + system 保留统一 + 长会话成本与熔断（16 文件） |
| v0.0.21 说明勘误 | `ef3e906` | 路由组/模型/登录三处数字与实测对齐（2 文件，已在 v0.0.21 说明内） |
| 登录按钮契约 | `187a119` | 按已装插件动态渲染 + 三层契约（8 文件，已在 v0.0.21 说明内） |

---

## 1. 长会话成本：O(N²) 的根因不是模型，是我们自己重发

### 症状

单个会话跑到 371 轮时，累计 `cache_read` 47.3M。上下文只在 **chat 开头判一次**，
中途只增不减——每一轮都把越来越长的历史整段重发给模型，成本随轮数平方增长。
用户看到的不是「某次调用很贵」，而是「这个会话越用越贵」，无从归因。

### 修法

- **轮末压缩闸**：把压缩判定挪到 `messages.extend(round_msgs)` **之后**——每轮结束就把旧史
  摘要掉，让下一轮上下文回到有界大小；
- **同参重复阈值缺省 0 = 禁用**（默认不改变既有行为，需要时显式开）；
- **无进展熔断**：连续失败 ≥3 才熔断（容忍偶发抖动），已产出内容仍在 trace 与前端可见；
- **token 预算硬停 + 墙钟软收敛**（`budget::StopReason`）。

### 预算账 P4b：扇出场景下 spent 不再失真

`spent` 改为两层：**外层 = 根会话 id，内层 = 链会话 id**。此前子代理扇出时所有消耗记在
链会话名下，父会话预算闸看不到真实支出——预算是「按会话算」的，记账口径必须先对齐。

---

## 2. trace 绝对游标与会话级技能作用域

### 症状 A：游标偏小 → 回合边界错位

agent-loop 一直用 `trace.read(after=0).next` 当「本回合终点」。短 trace 上恰好正确
（首页即全量），但 `trace.read` 单页受 **800 条 / 约 1MB** 双预算限制——长 trace 必然漏算，
游标偏小，回合边界整体错位。

新增 memory op `trace.meta`，返回 `{ok, exists, size, mtime_ms, total_events, end_cursor}`：

- `end_cursor` = `traceOffsets(file).length` = **真实末尾绝对游标**（跳过损坏行）；
- 缺 trace 文件 → `{ok:true, exists:false, ..., end_cursor:0}`，**空状态而非失败**
  （让编排层能区分「尚无事件」与「读失败」）；
- `trace.read` 语义**完全不变**：`next` 仍是本页已消费游标——它同时是前端增量拉取与网关追赶的
  消费游标，改成总末尾会直接破坏重放。

### 症状 B：第 800 条之后的 `skill_loaded` 静默丢失

会话级技能集原本靠 agent-loop 用 `trace.read(after=0)` 逐页重放得到。首页之后的
`skill_loaded` 全部漏掉，且把 trace 分页细节泄漏到编排层。

新增 op `session.skills`：走 `traceOffsets` + `readEventLine` 扫描**完整** trace，
返回去重保序的技能名。agent-loop 改为直接调用，不再自己重放。

---

## 3. system 保留：4 个裁剪点 + 压缩，同一套规则

### 症状

历史里可能有多条 system（持久化历史里 system 不在 `msgs[0]` 是常态），各裁剪点各写一套
判断。压缩后再与动态 system 冲突时，模型收到两个互相矛盾的 system，行为不可预期。

### 修法

规则统一为：**历史 system 视为陈旧丢弃，全历史至多保留一条（取最后一条非空），置于压缩标记
之前**。落到 5 处：

| 位置 | 侧 |
|---|---|
| `apply_history_limit` | Rust |
| `trim_workset_by_tokens` | Rust |
| `halve_window` | Rust |
| 轮末压缩 | Rust |
| `summarize` | TS（memory） |

`summarize` 结果形状：`sys ? [sys, marker, ...kept] : [marker, ...kept]`，保留既有孤儿 tool
防撕裂逻辑。两侧**同规则**，避免压缩后再打架。

---

## 4. 请求可解释：`http_attempts` + `provider.capabilities`

### L7 请求观测缺失 HTTP 尝试次数

provider 内部重试（openai_compat 的 429 退避循环、流式 `stream_options` 不受支持时的降级重放）
此前对上层**完全不可见**——最终只看到一次「成功/失败」，看不到真实打了几次上游，
「这次为何慢/贵」无法解释。

- `norm(...)` 末增可选形参 `http_attempts=None`，**有才写**（`if http_attempts is not None`），
  缺省不写键 = **未观测**，与「1 次成功」严格区分；
- 只有**存在重试循环**的 pack 上报（`openai_compat`），`anthropic` / `ollama` / `mock` 不传；
- **刻意不写进 `UsageAcc::to_value()`**：后者同时喂 `assistant.usage` 与 `chat_summary.tokens`，
  改它会破坏冻结的四字段线契约。改在 `assistant.metrics` / `chat_summary` 顶层单列（null = 未上报）。

### L8 provider 能力未声明

各家对流式 / 工具 / 图片 / 嵌入 / 原生窗口（num_ctx）的支持差异只隐含在实现分支里，
UI 与选路只能靠试错。

- `registry._validate` 支持可选 `capabilities`（`{能力名: bool}`），四 pack 补声明；
- 新增只读 op `provider.capabilities`，缺失 = 空 dict = **未知合法**；
- **capabilities 不做运行期分派闸**——它是声明，不是开关。让声明去决定行为，等于把
  「某家不支持」变成「某家不能用」，那是另一种形式的硬编码。

### 任务级路由粘性：本笔提交标题写了，代码里没有

`7edaee6` 的提交标题是「http_attempts 请求观测 + provider 能力声明 + **任务级路由粘性**」，
但该笔 diff 的 9 个文件里**没有**任何路由粘性实现（逐行查过：无 sticky / pin / route 相关改动；
`README.md` 里那段讲的是 `provider` 优先级 `payload > LLM_PROVIDER > mock`，是既有语义，不是粘性）。

如实记在这里：**本版没有做路由粘性**，标题第三项是笔误。功能若要做，属于新的一笔。

---

## 5. bash 单次调用 22 秒 → 1 秒（21.9× / 24.5×）

### 症状

`bash.py` 的 W16 文件追溯（`BASH_WRITE_TRACE`，默认开）在**每次**命令执行前后各扫一次快照区。
本机实测（快照区内 23,496 个文件）：

| 阶段 | 改造前 | 改造后 | 提速 |
|---|---|---|---|
| `_scan_zone(with_content=True)` | 11016.7 ms | 503.3 ms | **21.9×** |
| `_scan_zone(with_content=False)` | 11264.1 ms | 460.1 ms | **24.5×** |

即每次 bash 调用从 ~22.3s 降到 ~1.0s。**这是每次工具调用都付的成本**，是全仓最贵的一次遍历。

### 三处浪费

1. **排除目录走了再丢**：`outputs/`、`.stream`、`MEMORY_DATA_DIR`（实测 21,308 个 undo 快照
   文件）等噪音目录，原实现全部下钻遍历后逐文件 `continue` 丢弃——白扫约 21,500 个文件
   （44,963 → 剪枝后 23,496）；
2. **`workspace_root()` 每文件调一次**：内部是 `Path(...).resolve()`（有 syscall），
   实测 0.14ms/次 × 23,496 ≈ 3.3s/次扫描；
3. **`os.stat()` 每文件一次额外 syscall**：`DirEntry.stat()` 在 Windows 上直接来自
   `FindFirstFile`。

### 改法（`p6-bash-scan-perf-1.json`，order 176）

`os.walk` → `os.scandir` 显式栈 + **下钻前剪枝**（命中排除目录即不下钻）+ `workspace_root()`
提到扫描级 + `DirEntry.stat()`；超 2MB 文件不再做纯浪费的 pre-copy（`_snapshot_change` 本就
对它返回 None）；目录符号链接不下钻（对齐 `os.walk(followlinks=False)`）。

### 等价性是逐键比对的，不是「看起来一样」

改造前先冻结基线（23,496 条 `rel -> (mtime,size)` dump 到 `.scratch/p6_baseline_before.json`），
改造后逐键比对：`manifest_equal=True`、`extra=0 / missing=0`、`stat_listing_equal=True`。
端到端（隔离小工作区）：create / modify / delete **三类变更 undo 全部 True**；
`>2MB` 文件在清单中、不在内容缓存中、缓存整体仍有效。

### 顺带记下的职责边界（P6-2，决策记录）

**本轮不给 bash 加写闸。** 描述层已大量劝阻（`_description()` 明写「do NOT use it for file
operations」），但代码层不阻止——这是有意的：构建与测试本身就会产生文件，把 bash 关成只读会让
`cargo test`、`npm install` 这类正常调用失败。真实防线不在「禁止 bash 写」，而在**可追溯 + 可回滚**：
bash 的写入以 `changes[]` 返回、由 agent-loop 转发成 `op=bash` 的 `file_change` 事件，
与 write/edit 走**同一条 undo/回滚链路**。若将来要收紧，正确做法是「对核心区路径的 bash 写做 deny」
（复用 `_is_core_path` + `allow_core_write`），而不是全面禁写。

---

## 6. 补丁链入库：发行形态可重放

核心区（`runtime/` 整树、`plugins/memory`、`config.json`）不可直写，本版**全部改动**都以
`scripts/patches/*.json` + `blocks/` 的形式留下可重放记录。本版入库：

- **340 个新补丁文件**：119 个 `.json` + 219 个 block `.txt` + 2 个 PLAN block `.md`；
- 覆盖 M1–M10（trace.meta / session.skills / summarize system）、P1–P3（游标、裁剪、压缩）、
  P4b 18 条（预算账、子代理签名）、P4c 24 条（检查点、summary、无进展熔断）、
  P5 31 条（usage 观测、capabilities、README）、P6 2 条（bash 性能、tools PLAN）；
- 688 个 block 引用**零缺失、零 `.bak` 引用**（脚本扫过全部 `*.json`）。

### 两条文档债（chat.rs）

| 补丁 | 现象 | 处置 |
|---|---|---|
| `p4c-chat-dup-checkpoint1-1`（order 174） | 「停车检查点①」注释块 4 行**两两重复** | `converge` 型去重为一份（坏块消失即完成，锚点不存在不报 FAIL） |
| `p4c-chat-reindent-observe-1`（order 175） | 轮末 observe/K503 块 7 行 **ind8**，而注释头本就 ind12 | 7 行各 +4 空格，纯空白改动、语义零变化 |

D-2 的边界是断言逼出来的：生成脚本首版对 8 行统一断言 `lead == 8`，在注释头那行抛
`AssertionError: ('lead not 8', 12, ...)` —— 正是这个断言暴露了真实边界（7 行 +4，不是 8 行 +4）。

### 4 条既存补丁的 marker 修复（`bb15543`）

`p0b6-round-compact` 改 `converge` 型；`p0c1-trim-workset` / `p0c2-perceive-trim` /
`p1d3-batch-hint` 各补**唯一** `applied_marker`。原缺 marker 的后果是「锚点一旦漂移就永久 FAIL
且无法幂等跳过」——补丁链一旦开始冒 FAIL，真 FAIL 就没人看得见了。

---

## 7. 测试判据的两处修正（`493c156`）

### A. `_norm` 由 `strip()` 改 `rstrip()`

`strip()` 连**行首缩进**一起抹掉，于是把「同一构造出现在不同嵌套层次」的不同调用点折叠成同一段
文本。实测代价：`chat.rs` 有 4 处 `return self.finish(...)` 分布在两个嵌套层次
（主循环 20 空格 / 收敛轮 16 空格），P4c 给 4 处都补了 `None,` 实参后，
`p4c-chat-finish-h2a-1` 与 `-h2b-1` 的 patch 全文在产物里「出现 4 次」——**4 处全是合法调用点**，
没有一处是重复插入。

这类假阳性不能靠白名单压：白名单键是 `(文件, 锚点首行)`，加一条 `("chat.rs", "return self")`
就等于放弃对这 4 处真重复的检测，越压越瞎。保留行首缩进后：真重复（同一处被写两遍）仍是 2 次，
照样报；跨层次的合法同构调用点不再折叠。代价是「补丁被插到错误的缩进层次」不再由本判据兜住——
那属于锚点漂移，`apply-tool-patches.py` 在锚点未命中时已经 FAIL，不靠这里。

`GuardHasTeeth` 的 `PATCH` / `ANCHOR` 同步加 4 空格缩进，让反向用例仍能证明「真重复会报」。

### B. repair / converge 型补丁的 `patch` 合法为空

`test_tool_contract` 原本无条件断言「补丁体不能为空」，而 `repair` 的语义就是「锚点存在则删掉」
（不需要替换文本），`converge` 保留「原本想写成什么样」作文档但允许收敛。改为仅在
**非 repair / converge** 时断言非空。

---

## 8. 三份模块级 PLAN.md

`runtime/crates/agent-loop/PLAN.md`、`runtime/plugins/memory/PLAN.md`、
`runtime/plugins/tools/PLAN.md` 三份模块级 PLAN 落盘，记录**已落地**的改造与依据
（`docs/00–07` 是方案层，不动）。同时更正 `llm_adapter/PLAN.md` 里一处历史笔误：
它原写「格式对齐 `crates/agent-loop/PLAN.md`」，而该文件当时**从未存在**。

> 一条给后来人的教训：`p6-tools-plan-doc-1.json`（create 型）的幂等判据是**整文件内容一致**
> （`apply-tool-patches.py` 该处用的是 `marker` 而非 `create_marker`）。所以任何后续改动
> `tools/PLAN.md` 的补丁，都必须同步刷新 `blocks/p6-tools-plan.md`，否则全量 `--dry-run` 会冒
> `FAIL 目标文件已存在且内容不同`。本版已按此同步过一次。

---

## 验证

| 项 | 结果 |
|---|---|
| `cargo test --workspace`（`.scratch/run_clean.py`，剥 16 个泄漏环境变量） | **19 suite 全绿 / 260 passed / 0 failed** |
| └ agent-loop lib / conformance_check / contract_conformance / react_mocks | **83 / 1 / 2 / 50** = **136** |
| └ host lib / main / sandbox-run | **99 / 0 / 1** |
| └ e2e_full_react_mock / e2e_live_llm / e2e_llm_mock / e2e_mcp_tools | **2 / 1 / 1 / 1** |
| └ e2e_python_tools / e2e_react_compaction / e2e_subagent / e2e_system_prompt | **4 / 1 / 1 / 1** |
| └ e2e_ts_memory / e2e_web_gateway / doc-tests ×2 | **10 / 2 / 0** |
| `python -m pytest tests -q` | **428 passed**（27.81s） |
| 补丁全量 `--dry-run` | **400 行 / 400 OK / 0 FAIL**（全部幂等跳过或已收敛） |
| bash `_scan_zone(with_content=True)` | 11016.7 → **503.3 ms**（21.9×） |
| bash `_scan_zone(with_content=False)` | 11264.1 → **460.1 ms**（24.5×） |
| 快照清单等价性 | `manifest_equal=True`、`extra=0 / missing=0`、create/modify/delete undo 全 True |

> 口径更正：v0.0.21 说明里的 `cargo test -p react-agent-agent-loop = 127 passed` 是**单包旧口径**。
> 本版按全仓 `--workspace` 统计，agent-loop 侧为 **83 + 1 + 2 + 50 = 136**。两个数字都对，
> 只是分母不同——不要拿 127 与 136 比出「涨了 9 条」的结论。

---

## 升级注意

- 本版**不改** `Cargo` 版本线（`runtime/Cargo.toml` 的 `version = "0.1.23"` 自 2026-11-01 未变），
  release 线走 git tag `v0.0.x`；
- 长会话成本修正**默认生效**（轮末压缩闸），但**同参重复阈值缺省 0 = 禁用**，需显式开启；
- `http_attempts` 与 `provider.capabilities` 都是**纯追加**：旧 provider 不上报 = 字段缺席 =
  未观测，不是 0 次；旧消费者不读也不受影响；
- `capabilities` **不做运行期分派闸**——它是声明，别拿它当开关用；
- `trace.read` 的 `next` 语义**未变**（仍是本页已消费游标）；要真实末尾请用 `trace.meta.end_cursor`；
- 补丁链入库后，**改动 `runtime/` 下任何文件都必须走 `scripts/patches/*.json`**，并在改完后跑
  一次全量 `--dry-run` 确认 0 FAIL；改 `*/PLAN.md` 时记得同步刷新对应 block；
- **升级后请重启 Host**：本版改动分布在 agent-loop / memory / llm_adapter / tools 四个插件，
  跑着旧进程只会看到旧行为。

## 与其他 Release 的关系

`v1.4.x` 是 **make-video 技能**的独立发布线，与本应用线 `v0.0.x` 并行，互不覆盖。
本版区间内的 make-video 改动属技能内部演进，细则见该线各自的 Release。
