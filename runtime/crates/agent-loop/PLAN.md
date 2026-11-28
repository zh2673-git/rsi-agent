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

## 审计报告 8 项优化再评估（2026-11-19，project-dev 优化模式）

依据 `outputs/实现过程效率与积分消耗审计报告.md`（11-18）的 8 项清单，逐项核实代码现状并
实测，结论分三类：**已落地 / 代码已实现仅配置关 / 代码未实现**。

### E. 已落地（无需再做）
- #2 轮末压缩丢 system：`compaction.rs:148-165` 已规范化 sys_pos 并保留。
- #4 重试责任统一：adapter 独占，`http_attempts` 已暴露（`openai_compat.py:116-147`）。
- #5 工具结果单次序列化：`tools_exec.rs:262-282` 结果只 `to_string()` 一次、全文不入库。
- #8 trace 全量重放：`skills.rs:385-386` 已改增量。

### F. 代码已实现、仅配置关（改 config.json 即可，零代码风险）
- #3 硬预算 + 进展检测：`budget.rs` 的 `StopReason{Tokens,Deadline}`、3 个停车检查点、
  K508 预算停、`no_progress_repeat_limit` 同参连续重复熔断全部已实现且有 react_mocks 回归
  （`:1416-1493`、`:2496-2534`）。链路 `config.json → AGENT_ENV_MAP(host/config.rs:347-366)
  → env → AgentLoopConfig::from_env` 通。断点只在根 `config.json`：`budget_secs=0`、
  `token_budget=0`、无 `no_progress_repeat_limit`（缺省 0=禁用）。
  - **v0.1.35 已补**：`no_progress_repeat_limit` 进 `AGENT_NUMERIC_KEYS` / `agent_config_view`
    （host/src/web/api/config.rs）并在 Web 设置面板有输入框，不再只能改文件或手工 PUT。
  - 决策（2026-11-19，经无人值守场景再评估后定稿）：根 `config.json` agent 段——
    - `compact_trigger 40→80`、`compact_keep 30→10`：**保留**（纯省 token，不影响任务能否跑完）。
    - `no_progress_repeat_limit` 新增 `4`：**保留**（仅"同工具+完全相同参数连续 4 次"才熔断，
      不误伤换 offset/pattern/old_string 的真实探索；精准对治参数完全不变的空转）。
    - `budget_secs`：**0（禁用）**——曾试开 `900` 后撤销；v0.1.35 起**代码缺省也是 0**
      （agent-loop `config.rs` 与 host `web/api/config.rs` 三处缺省统一），新装用户不再
      继承 900s/300s 的历史缺省。原因：软收敛到点后
      `chat.rs:1419-1446` 注入 wrap_up 指令、剥掉工具（`chat.rs:835`），要么模型交文本收敛、
      要么 `chat.rs:891-907` 强制交进度报告，**两者都 finish 且 turn=done，任务就地终结**；
      而全仓无"收敛后自动续做"机制（ask_user/queue/resume 均需外部再发消息，
      `chat.rs:1129-1172`/`queue.rs:68-87`/`contract.rs:144-148`）。无人值守下 = 15 分钟
      腰斩未完成任务且没人续做，与目标冲突。
    - **回退点**：如需恢复最初行为，`compact_trigger→40`、`compact_keep→30`、删除
      `no_progress_repeat_limit` 键（`budget_secs` 本就是 0，无需改）。
    - 验证：JSON 合法；`AGENT_ENV_MAP`(host/config.rs:347-366) 含四键，配置→env 链路通。
      需**重启 Host** 生效；`no_progress_repeat_limit` 不在 Web 面板回显，只能改文件/手工 PUT。

  - **已评估不做：靠 budget/熔断防「循环烧 token」**。用户担心参数微变式渐进探索
    （read_file 换 offset、grep 换 pattern、edit 换 old_string）反复烧 token。查证：这类
    每次 arguments 都不同，**不满足 no_progress 的"完全相同参数"判据**（`chat.rs:1107-1113`），
    任何阈值都抓不到；强行降低阈值只会误伤真实工作。工具层经审计**无制造循环的设计**
    （截断带 `[truncated]` 标记、`_raw` 残片防线、offset 提示、SYSTEM.md「同因不重试超过一次」），
    压缩层 `## PENDING` 强制保留未完成项与放弃路径（`compaction.rs:76-84`），反而是防烧钱的。
    故：省 token 走 compact 参数，空转走 no_progress 精准熔断，不用 budget 腰斩。

### G. 代码未实现 / 收益需重估（已评估，结论如下）
- #1 bash 双扫描 —— **已评估不做（收益已由 P6 剪枝兑现）**。
  - 审计报告 6.3 复测 `per_bash=24.94s`、外推 9,900 次省 68.6h，是 **P6 剪枝之前**的旧数据。
  - 本次实测（2026-11-19，本工作区 45,638 条目）：
    `pre(with_content)=0.859s`、`post(stat-only)=0.719s`，**双扫描合计 ≈1.6s**。
  - `bash.py:112-130` 的 P6 注释亦写明 with_content 11.0→0.50s、stat-only 11.3→0.45s。
  - 即剩余可省 ≈1.6s/次，9,900 次外推 ≈4.4h，远小于报告的 68.6h；且现有唯一开关
    `BASH_WRITE_TRACE=off` 关掉追溯可能影响 undo。权衡后**不再投入**（边际收益低、有正确性风险）。
- #6 bash 与专用工具重叠（78.4% `cd &&`、48.4% 可替代）—— **已评估暂不做**。属使用侧习惯
  （模型选 bash 而非专用工具），改内核会侵入工具路由语义；优先靠 no_progress 熔断压住重复调用。
- #7 cache-aware 路由 —— **已评估不做**。全仓无实现痕迹，且需改模型选择策略（与当前
  auto 组 smart 路由、缓存命中记账 budget.rs:106-168 分属两套机制）；收益不确定性高，
  优先级低于 F 类配置启用。**若后续要做，应独立立项于 llm_adapter/PLAN.md**。

### 时空闭环复核
- init/destroy：预算与熔断均为 per-chat 状态（`ChatBudget`/`repeat_streak`），随 chat 结束释放，无泄漏。
- 主循环死循环：`max_rounds` 上限 + 预算检查点 3 处 + 熔断，启用配置后不可无限循环。
- 跨层直访：配置经 AGENT_ENV_MAP 单向注入 env，无跨层直访内存。

### 验证
- 本轮仅追加文档结论，无代码改动；`cargo test -p react-agent-host --lib` 99 passed 仍成立。
- 实测脚本为临时文件，已删除。
