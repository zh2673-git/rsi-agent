# rsi-agent 模块级自我迭代计划（v1）

> 授权背景：用户指令（2026-11-03）——①形成计划；②逐模块对标 pi-agent / codex / claude-code / opencode / deepseek-harness 研究短板并自我迭代，不需逐步确认；③全程 git 推送留痕。
> 调研来源：五家外部架构对标（含 DeepSeek 官方 harness `dsh`，deepseek-ai/deepseek-harness）+ 内部逐模块审计（全部结论带文件:行号证据）+ 自更新机制深设计（nginx USR2 / systemd socket activation / opencode updater / claude code auto-update / codex update_loop）。

## 0. 对标结论摘要（各家长处）

| 项目 | 最值得借鉴 | 出处 |
|---|---|---|
| Codex CLI | 沙箱能力（sandbox mode）与审批策略（approval policy）正交分层；按平台分 crate 实现沙箱；专职 update 守护进程 + 安装脚本护栏标记 | github.com/openai/codex（codex-rs crate 清单、app-server-daemon/update_loop.rs） |
| Claude Code | 上下文经济学：compaction 防抖（单条超大输出压完即满→停手报错而非死循环）、工具 schema 延迟加载、subagent 隔离上下文、hooks 三档节奏 | code.claude.com/docs（how-claude-code-works / sub-agents / hooks） |
| opencode | client/server 分离 + OpenAPI spec 生成 SDK；会话操作全可编程化（fork/revert/summarize 均为 HTTP 端点）；Windows 自更新用硬链接保住运行中镜像可替换性 | opencode.ai/docs（server/sdk/cli）、sst/opencode updater.ts + retained-image.ts |
| pi (badlogic) | 核心故意残缺、一切皆扩展（连 compaction/权限门都是扩展写的）；session = JSONL 树（entry ID+parent，fork/clone 不丢历史，compaction 只插摘要条目）；交互态与自动化态零分叉 | github.com/badlogic/pi-mono、pi.dev/docs |
| DeepSeek harness | everything-is-a-plugin 无特权核心（model adapter/tool registry/session log/loop 本身全是插件）；profile/bundle 分层组合（YAML patch 按 id 覆盖） | github.com/deepseek-ai/deepseek-harness（architecture.md） |

## 1. 内部审计短板清单（证据齐备，按模块归组）

**agent-loop**：A1 同 session 并发 chat 无互斥（lib.rs:156-159/chat.rs:223-231）；A2 memory.append 失败静默分叉（chat.rs:207-214）；A3 瞬态错误判定靠英文关键词（budget.rs:17-30）；A4 跨语言 deadline 三处常量人工配对（lib.rs:114-123 ↔ llm_adapter/providers/base.py:32-40 ↔ config.rs:103）；A5 token 闸仅 ollama 生效（config.rs:89-95）；A6 压缩只在开局做一次（chat.rs:273）。

**host**：H1 停实例杀进程不带进程树 `taskkill /PID` 无 `/T`（instances.rs:422-425）→ python/node 孤儿进程；H2 请求体无上限（web/mod.rs:247-255）；H3 `PUT /api/config` 在 async handler 里 `std::env::set_var` 与在途 chat 竞态（api/config.rs:49）。

**memory**：`get`/`trace.read` 全量载入后切片，假分页 O(全文件)（memory_plugin.ts:124-127,249-264）；`persist` 整文件重写无原子性，崩溃可留半文件且读侧静默当空会话（:79-82,97）；无索引/无向量/无相关性召回。

**llm_adapter**：provider 层零重试（providers/ 目录 grep retry 0 命中，openai_compat.py:111 一次 POST 定生死）；异常兜底压成 `LLM_ERROR` 字符串靠正则文案反推类型（llm_plugin.py:73-74）；流式取消延迟无上界（iter_lines 阻塞中收不到 abort）；线程池泄漏靠 max_workers=16 治标（llm_plugin.py:188-191）。

**tools**：沙箱 = Windows 受限令牌 fail-closed（好），但文件系统无写边界靠快照留痕，bash 每次执行前后全工作区双遍历（bash.py:99-130，大工作区 I/O 税）；技能工具子进程输出原样回传，密钥脱敏是 agent-loop secrets.rs 单点防线（tools 侧 0 脱敏）；files.py.patchbak / app-settings.js.patchbak 残留在产物目录。

**kernel**：unary Envelope 单桶（双向流降级已写死协议注释 kernel.proto:9-13）；无背压（deadline/priority 字段 guest 绑定不读，guest.py:66-80）；4MB 上限是隐式契约靠注释口口相传；schema 演进无字段级兼容检测；错误码枚举 6 个与实际流通码表漂移。

**前端**：全局可变状态网 + 模块 load 顺序耦合（app-stream.js:5-40、index.html:173 注释自证）；49 处 innerHTML 靠手工 esc 纪律；session 切换手工清 8+ 状态变量易漏（app-events.js:30-35）。

**依赖方向**：kernel 不知业务插件、插件间无横向 import、host 唯一组合根——结构健康，不需要动。

## 2. 模块迭代路线（P/Q/I 验收；状态：☐待办 ◐进行中 ☑完成）

验收口径：P=产物（改了什么）、Q=质量门（怎么证明没改坏）、I=影响（可感知的改进）。

| # | 模块 | 目标与动作 | P | Q | I | 状态 |
|---|---|---|---|---|---|---|
| **P1** | host | **自更新交接机制**（本文件 §3）：隔离 target 构建 + 孵化新进程 + 就绪标记 + 等待换绑 + 排水退出；新增 `POST/GET /api/self/update` | 补丁 SELF-UPDATE-1..4（web/mod.rs bind 重试+marker；路由；misc.rs 端点；api/mod.rs 导出） | cargo check PASS + cargo test 23/23 + dry-run 0 FAIL（全补丁幂等终态） | 一条指令完成 build→交接→换血，失败自动留在旧版本；前端断线自愈无感 | ☑（端到端交接待 host 重启后触发验证，步骤见 §3.4） |
| P1b | host | 版本化 `bin/host-vN.exe` + 极简 watchdog（commit point 后新进程崩溃的兜底）；借鉴 claude code versions/ 布局 | ☐ | | | |
| P2 | agent-loop | 稳定性包：A1 per-session 互斥（409）；A2 append 失败阈值熔断；A4 deadline 收敛为单一 env `LLM_STEP_DEADLINE_SECS` | ☑ 11 补丁（loop-p2-*，含 test-init 伴生锚点） | cargo check + cargo test 46/46 + py_compile + dry-run 0 FAIL | 同会话双击拒绝并发（K409）；持久层故障熔断不再静默烧 token；deadline 改 env 即两侧同步 | ☑ |
| P3 | llm_adapter | 健壮性包：错误结构化（error.code 携带 HTTP 状态/异常类型）；provider 内指数退避重试（429/5xx，上限 2 次）；借鉴 codex 错误分类 | ☑ 2 补丁（llm-p3-*）：err_from_resp 按 HTTP 数值归类（429/5xx→LLM_TRANSIENT）+ error.http_status；_chat_once 幂等单请求重试（429 尊重 Retry-After/5xx 指数退避，最多 2 次额外尝试） | py_compile + dry-run 0 FAIL（活体重试随 host 重启验证） | 瞬态故障不再靠英文文案正则判死；限流/抖动单请求内自愈，不再整轮重来 | ☑ |
| P4 | memory | 检索升级：trace.offset 索引（行号→字节偏移 sidecar，追加式）；persist 原子 tmp+rename；空会话读到半文件时告警而非静默 | ☑ 5 补丁（mem-p4-*）：trace.read 改 size+mtime 索引偏移直读（稳态 O(页)，替代每 300ms 全量重解析）；persist tmp+rename 原子写；损坏会话文件响亮告警 | node --check + dry-run 0 FAIL（活体行为随 host 重启验证） | 大 trace 轮询 CPU 消耗从 O(全文件) 降至 O(页)；崩溃不再产生无告警的半文件 | ☑ |
| P5 | tools | 快照成本：bash 前后双遍历改 mtime 缓存增量对比；清理 *.patchbak 残留；技能工具输出过 secrets 脱敏后再回传 | ☑ 收窄为 1 补丁（files-p5-noise）：target-selfupdate 进 _NOISE_DIRS（P1 隔离构建目录若不排除，数千构建文件+约 20MB exe 会进每次 bash 快照扫描与 pre-copy 缓存）；*.patchbak 经核实是 --revert 锚点备份（gitignore 已覆盖），**决策保留不删**；增量快照与技能工具脱敏降级为观察项（当前 32MB/4000 文件闸已控损） | py_compile + 文本断言 + dry-run 0 FAIL | 自更新目录不再拖累每次 bash 快照 I/O；剪枝同时惠及 list_dir/grep | ☑ |
| P6 | kernel | 协议演进（大，跨语言）：deadline 字段接线；错误码枚举扩展；大 payload 自动分片约定（联动 P4） | ☐ | | | |
| P7 | 前端 | session-reset 集中化（一个 resetSession() 清全部状态，消灭手工清 N 变量）；innerHTML 全量 esc 审计脚本化 | ☐ | | | |
| P8 | skills | 补 evals 基线（skill-eval 纪律）：project-dev / rsi-steward 各 3 案例，防技能迭代退化 | ☐ | | | |

优先级依据：内部审计 Top10（影响/成本综合）——P1（解锁自我迭代本体）> P2 > P4 > P3 > P7 > P5 > P1b > P6 > P8。

## 3. P1 自更新交接设计（已按此实现）

### 3.1 Windows 三条硬边界（决定了方案形态）

1. 运行中 exe 镜像被锁（opencode retained-image.ts 注释、claude code WinGet 文档双证据）→ **不能边跑边重编替换自己** → 构建进隔离目录 `runtime/target-selfupdate/`（CARGO_TARGET_DIR 指过去），产物路径与运行中 exe 不同，天然避开镜像锁；
2. 无 SO_REUSEPORT（微软文档明确 SO_REUSEADDR 语义不确定且是劫持面）→ **等待-换绑**（nginx USR2 的 Windows 变体）：新进程反复重试 bind 直到旧进程退出；
3. fd 继承通道弱（tokio into_parts 是 WASI-only）→ 不传 socket，靠前端既有断线自愈（app-events.js 1s 防抖 + after 游标续传）覆盖亚秒级空窗。

### 3.2 交接时序（fail-safe：任何一步失败 = 旧进程继续服务）

```
POST /api/self/update（旧进程，立即回 202）
  后台任务：
  1. cargo build --release -p react-agent-host（CARGO_TARGET_DIR=target-selfupdate，首次数分钟）
  2. 孵化新 exe：env RSI_HANDOVER=1 + RSI_HANDOVER_MARKER=<temp 唯一路径> + WEB_ADDR 原样
  3. 新进程：装配内核+插件（成功后写 marker，bind 失败→200ms 起步指数退避重试，90s 超时）
  4. 旧进程轮询：marker 出现（= 新进程装配完成且正在抢端口）→ 排水 2s → 应答（若还在）→ std::process::exit(0)
  5. 新进程 bind 成功 = commit point；前端 SSE 断线自动重连续传
  失败分支：build 失败 / 新进程提前退出 / 60s 无 marker → 杀新进程、写日志、旧进程继续活
```

commit point（步骤 5）之后新进程立刻崩溃的残差：系统停服，需用户重跑 run.cmd——v1 接受，P1b watchdog 兜底。新进程 bind 超时（90s）同理。

### 3.3 安全边界（根信任不变量）

- 自更新只改**二进制产物**，不改更新机制本身；触发权 = HTTP 端点 = 任何能访问 127.0.0.1 的本机进程（无鉴权，与面板其他 /api 一致，本地单用户模型下接受）；
- 交接等待中的新进程拒绝再次自更新（409，防递归交接）；
- CORE_PROTECTED / 永不豁免项（config.json、plugins/memory、.git）不受影响——换的是身体不是刹车；
- 全程日志落 `%TEMP%/rsi-selfupdate-<port>.log`，git 历史留痕（本仓库即审计日志）。

### 3.4 验证步骤（用户侧触发，因会终止当前运行体）

1. `python scripts/apply-tool-patches.py --dry-run` 应显示 0 FAIL（全部幂等跳过）；
2. 应用后重启 host（旧代码生效新代码需一次普通重启）；
3. 之后任意时刻 `curl -X POST http://127.0.0.1:8710/api/self/update` → 观察日志 `GET /api/self/update` → 面板自动重连即成功；
4. 回滚：`python scripts/apply-tool-patches.py --revert`。

已知残留（v1 接受）：POST 无请求级互斥，交接 2s 排水窗口内连点会多起一次隔离构建，两个新进程抢端口自动收敛（输者 90s 超时退出）；commit point 后新进程立刻崩溃需手动重跑 run.cmd（P1b watchdog 兜底项）。
