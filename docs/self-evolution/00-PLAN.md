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
| P1b | host | commit point 后的兜底（原案：版本化 bin/host-vN.exe + watchdog；落地案收窄：**接力看门狗**，覆盖「旧进程收尾一跳失败」这一实际可达残差——exit(0) 若因镜像句柄/挂起未遂，无进程收拾残局） | ☑ 2 补丁（p1b-watchdog-*）：self_update_start 在 exit(0) 前孵化解耦接力进程——marker 25s 内被清（正常交接）即自杀，超时判收尾失败，RSI_SELF_UPDATE_RELAUNCH=1 重拉新二进制（走 run_inner 90s 退避）；web::run_inner 识别 RELAUNCH 显式 warn 示警（不静默换血）；bin/ 版本化布局降级为观察项（隔离构建已等效隔离产物）。期间退役 self-update-1/3 补丁（同区域改写后幂等失配，按 P5b 先例 retired/ 留档） | cargo check PASS + apply 两轮幂等 0 FAIL（活体接力随下次自更新端到端验证） | 交接 commit point 前的收尾失败不再悬死系统；失败不重启不报警保持 fail-safe（旧进程可能仍在服务）。残差收窄：commit point **后**新进程崩溃仍 v1 接受（marker 已清、接力已退出） | ☑ |
| P2 | agent-loop | 稳定性包：A1 per-session 互斥（409）；A2 append 失败阈值熔断；A4 deadline 收敛为单一 env `LLM_STEP_DEADLINE_SECS` | ☑ 11 补丁（loop-p2-*，含 test-init 伴生锚点） | cargo check + cargo test 46/46 + py_compile + dry-run 0 FAIL | 同会话双击拒绝并发（K409）；持久层故障熔断不再静默烧 token；deadline 改 env 即两侧同步 | ☑ |
| P3 | llm_adapter | 健壮性包：错误结构化（error.code 携带 HTTP 状态/异常类型）；provider 内指数退避重试（429/5xx，上限 2 次）；借鉴 codex 错误分类 | ☑ 2 补丁（llm-p3-*）：err_from_resp 按 HTTP 数值归类（429/5xx→LLM_TRANSIENT）+ error.http_status；_chat_once 幂等单请求重试（429 尊重 Retry-After/5xx 指数退避，最多 2 次额外尝试） | py_compile + dry-run 0 FAIL（活体重试随 host 重启验证） | 瞬态故障不再靠英文文案正则判死；限流/抖动单请求内自愈，不再整轮重来 | ☑ |
| P4 | memory | 检索升级：trace.offset 索引（行号→字节偏移 sidecar，追加式）；persist 原子 tmp+rename；空会话读到半文件时告警而非静默 | ☑ 5 补丁（mem-p4-*）：trace.read 改 size+mtime 索引偏移直读（稳态 O(页)，替代每 300ms 全量重解析）；persist tmp+rename 原子写；损坏会话文件响亮告警 | node --check + dry-run 0 FAIL（活体行为随 host 重启验证） | 大 trace 轮询 CPU 消耗从 O(全文件) 降至 O(页)；崩溃不再产生无告警的半文件 | ☑ |
| P5 | tools | 快照成本：bash 前后双遍历改 mtime 缓存增量对比；清理 *.patchbak 残留；技能工具输出过 secrets 脱敏后再回传 | ☑ 收窄为 1 补丁（files-p5-noise）：target-selfupdate 进 _NOISE_DIRS（P1 隔离构建目录若不排除，数千构建文件+约 20MB exe 会进每次 bash 快照扫描与 pre-copy 缓存）；*.patchbak 经核实是 --revert 锚点备份（gitignore 已覆盖），**决策保留不删**；增量快照与技能工具脱敏降级为观察项（当前 32MB/4000 文件闸已控损） | py_compile + 文本断言 + dry-run 0 FAIL | 自更新目录不再拖累每次 bash 快照 I/O；剪枝同时惠及 list_dir/grep | ☑ |
| P6 | kernel | 协议演进（大，跨语言）：deadline 字段接线；错误码枚举扩展；大 payload 自动分片约定（联动 P4） | ☑ 收窄为 3 补丁（p6-*）：deadline/priority 在 **guest 绑定层**显式透传（Python `HasField` 判未设→None；TS proto-loader camelCase 归一）+ kernel.proto Envelope 字段注释固化语义（deadline_ms=相对毫秒时长非绝对时间戳，经 v0.1.7 内核源码 to_proto 实证）。错误码扩展与分片约定降级为后续项（unary 单桶下无分片需求，外部内核依赖冻结） | pb2 HasField 行为实测 + ast 语法 + tsc --noEmit PASS（wire 格式不变，无需再生成 pb2） | 需要硬截止/优先级的插件在绑定层直接可读，契约字段不再被绑定层静默丢弃 | ☑ |
| P7 | 前端 | session-reset 集中化（一个 resetSession() 清全部状态，消灭手工清 N 变量）；innerHTML 全量 esc 审计脚本化 | ◐ 3 补丁（fe-p7-*）：resetSessionFeed()/resetStreamState() 集中重置入口（补上 streamBuf/roundCards 跨会话泄漏）已落地；innerHTML 全量 esc 审计脚本化未做（49 处手工 esc 纪律维持现状） | node --check + dry-run 0 FAIL | 新会话不再串台旧回合卡缓冲；esc 审计仍靠纪律 | ◐ |
| P8 | skills | 补 evals 基线（skill-eval 纪律）：project-dev / rsi-steward 各 3 案例，防技能迭代退化 | ☑ 双基线落定：project-dev 6 案例（全 assert，output=SKILL.md 契约原文摘录、source 标注——案例退化=技能契约被改）；rsi-steward 4 案例（3 assert 契约摘录 + 1 judge 留 pending 待外部裁判）；ledger/baseline.json 各自 pass_rate 1.0 | run_evals --set-baseline 全 decided（rsi-steward 3/3 决定案例）+ 二轮复跑无回归无退化 | 技能契约改动会被案例网当场拦下；晋升资格按规矩留 false（仍需 E1-E3 外部信号） | ☑ |

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

## 4. 第二轮迭代（N1-N4，2026-11-04；数据源 = trace 复盘 + 用户实测三问）

> 出发点：不重复第一轮清单，以**当前运行状态**重新评估。trace（46 chat / 2472 调用）显示 bash 1027 次
> 中 68.8% 可被专用工具替代（python 373 / powershell 109 / dir 86 / chcp 62 / findstr 45…）；
> 用户实测暴露空答案与停实例孤儿两类缺陷；版本口径双轨经 specs 取证为有意设计（见 N4）。

| # | 模块 | 目标与动作 | P | Q | I | 状态 |
|---|---|---|---|---|---|---|
| N1 | agent-loop | **空答案自愈**（用户切网实测复现）：`finish_reason=="length"`（截断，上下文末尾无正文可用，不重试）→ K502 升级为定向文案 + "reason" 字段；其余空内容（切网瞬断 / 上游异常）→ 追加一条 nudged user 消息就地续跑一轮（models 不换、不烧轮次），仍空才按 K502 收敛 | ☑ 2 补丁（n1a-finish-length + n1b-nudge-retry）：空分支迁出 finish() 内联进主循环工具分支（chat.rs:507 后），空答案时 finish_reason=length→带 reason 硬收敛；否则 observe+push "上一轮回复为空（可能网络瞬断），请直接给出最终答复。" 继续；锚点语义不变（wrap-up/verify 分支不受影响） | cargo test 47/47（新增 nudge 不吞错误单测）+ dry-run 0 FAIL | 切网瞬断从「整轮白跑」变为「自动续跑自愈」；截断给出可行动错误码 | ☑ |
| N2 | host | **停实例杀进程树**（审计 H1 存量）：`taskkill /PID n /F` 孤儿化 python/node guest 子进程 → 端口释放但下次 spawn 撞占；补 `/T` | ☑ 1 补丁（n2-taskkill-tree）：instances.rs:423 args 加 "/T"（一行改动，windows-only 命令与现有平台语义一致） | cargo test（instances 模块）+ 活体验证随下次停实例 | 面板停实例不再留孤儿进程占内存/占端口 | ☑ |
| N3 | tools | **bash 输出解码升级**（数据驱动：chcp 62 次 + 乱码历史）：沙箱/直跑两侧把 base64 原始字节按 UTF-8 优先解码，非法字节段以 `\xNN` 转义保留（原样可读，零信息丢失），locale 解码仅作兜底；描述补「无需 chcp 探测」引导 | ☑ 3 补丁（n3a-decode-utf8 + n3b-desc + n3c-docstring）：bash.py `_decode_output()` 新函数（strict utf-8 → 逐字节 `\xNN`）+ 两侧调用点替换 + docstring/描述同步；sandbox-run.rs 注释同步（行为注释：解码语义已上移调用方） | py_compile + 单测（纯 ASCII/UTF-8 中文/GBK 字节三态断言）+ dry-run 0 FAIL | 消除每会话约 60 次的 chcp 65001 仪式调用与 GBK 乱码（utf-8 输出直接可读，非 UTF-8 字节显式转义可见） | ☑ |
| N4 | docs | **版本双轨口径固化**（不改代码）：Cargo `0.1.21` = 上游 react-agent 快照版本号（specs/independent-runtime 明言快照不改），git tag v0.0.x = rsi-agent 发版序号——两条线独立演进，发版只动 tag 与 release 不动 Cargo | ☑ PLAN 本节记录 + release notes 注明双轨口径 | 文档一致性（无代码改动） | 消除「版本漂移」误判；后续发版不再纠结 Cargo 号 | ☑ |

N 轮数据附注：substitutability=68.8%（707/1027）印证 P4 描述引导仍被高频绕过——专用工具引导文案强化
（N3b）是低成本高杠杆项；空答案 9 次/46 chat 均为非收敛出口，N1 直击该画像。

### N 轮验证记录（2026-11-04）

- **重放事故与修复**：验证期误跑 `--revert`（文档语义=全量还原），按共享 `.patchbak` 把 9 个运行时文件
  打回**首补丁之前**的快照（越过 git HEAD，丢已提交功能）——用 `git checkout` 恢复后多遍 apply 重建；
  根因之一是 15 个 stale `.patchbak`（首补丁时的远古快照）滞留树中，已全部清除（当前基线 = git HEAD +
  补丁重放，.patchbak 仅为回滚锚点，异常滞留即毒源）。
- **结构性修复**：`apply-tool-patches.py` 加 **ROOT 包含护栏**（apply/revert 均加）——内置补丁路径在
  exec_module 时按真实 ROOT 烘焙，测试 `patch.object(ROOT, fake)` 拦不住元组旧路径，T1 契约测试曾借
  stale 备份误还真实文件（bash.py 丢函数、files.py/index.html 回退），护栏后测试隔离彻底；E7 测试
  PATCHES 计数断言 11→8 同步。
- **退役（P5b 先例）**：P4a/P4b/E7-C2A 三补丁锚点被后到补丁拆散（指纹失配）但终态内容均在位
  （IMPORTANT 引导两分支、finish 失败出口 summary），转 `retired/` 或内置注释退役。
- **_decode_output v3**：v2 定长窗扫法有死循环（尾部截断不推进）与吞字（失败窗误并后续合法字节，
  `end` 尾 `d` 被转义）两病——均由回归用例抓出；改为**按首字节定长**切分（ASCII 直出；C2-DF/E0-EF/
  F0-F4 按 2/3/4 成段试解码；失败只转义当前字节），任何分支指针必推进 ≥1。纠错：GBK「你」=C4 E3
  并非合法 UTF-8（E3 不可作续字节），旧「U+0123 重合」说法作废。
- **E7 测试期望更新**：N1a 自愈使空答案失败路径 rounds/llm_calls 1/1→2/2（nudge 续跑的成本如实上报，
  e7-test-rounds-nudge 补丁）。
- **验证矩阵**：py 39/39（含解码 6 例）· agent-loop 66/66 · host lib 23/23 · cargo check 干净 ·
  补丁层 61 OK / 0 FAIL 幂等稳态。host 全量链接测试因运行中的宿主进程锁 exe 未跑（check+lib 测试覆盖）。

## 5. 第三轮迭代（O1-O4，2026-11-04；数据源 = 活体 trace 复盘 v0.0.4）

> 出发点：重启后活体已运行在 N1-N4 之上（run.cmd=cargo run，exe 13:15 构建含全部 Rust 补丁），
> 以**本会话 trace**（s-mvzz0e2s，2717 次工具调用 / 9.3MB / 跨 30h）重新评估，不拘泥前两轮清单。
> 画像：ok=false 共 113 次（bash 65 / grep 17 / edit_file 14 / read_file 9），其中**同因重犯**占大头——
> bash 多行拒绝 ≥10 次、grep context 超界 5 次（开发 agent 自身也连撞两次，现场复现）、K502 长命令
> 60s 闸 3 次、edit 近似位置提示后仍走「read→重试」两步路。结论：硬拒绝只在首次有效，重犯即纯烧 token；
> 工具层应从「报错教育家」升级为「就地自愈」。

| # | 模块 | 目标与动作 | P | Q | I | 状态 |
|---|---|---|---|---|---|---|
| O1 | tools | **参数越界自愈**：`optional_int` 越界从 BAD_ARG 硬拒绝改 clamp 到最近合法端点 + 模块级 `params_adjusted` 记录；grep 结果前缀透出「⚠ 已按上下文上限取 N」提示（最高频违约者定点透传）；schema 描述同步「超出自动取上限」 | ☑ 2 补丁（o1a-optional-int-clamp + o1b-grep-clamp-hint） | py_compile + 新测试套（clamp 两端/中值不动/负数下端/grep 提示透出）+ dry-run 0 FAIL | grep/edit 等 5+ 次/轮的越界重犯从「报错→改参→重调」三步变一步；审计通道 `params_adjusted` 可观测 | ☑ |
| O2 | tools | **edit_file 自愈窗口**：EDIT_NO_MATCH 时用 `_line_candidates` 的命中行做**白空间归一重试**（每行 strip + 内部空白折一，空行折叠，唯一命中才应用）——模型最常见失败（全角空格/不可见字符/行尾差异）就地修复 | ☑ 2 补丁（o2a-import-functools + o2b-edit-fuzzy2） | py_compile + 新测试（全角空格归一命中/多命中不适用/正常编辑不受扰）+ dry-run 0 FAIL | 14 次编辑失败中的高频类（空白不一致）从两步路变一步；命中不唯一仍保守报错 | ☑ |
| O3 | agent-loop | **TOOLS_DEADLINE 可配**：`Duration::from_secs(60)` 常量改 `fn tools_deadline()` 读 env `TOOLS_DEADLINE_SECS`（<30s 回退 60），tools_exec/skills 调用点同步；lib.rs 头注同步五闸总览 | ☑ 3 补丁（o3a-fn + o3b-test + o3c-doc） | cargo test（新增 env 缺省/下限回退两测）+ check 干净 | 重构建/重索引/全仓扫描类命令不再被 60s 硬闸 K502（本 trace 实录 3 次） | ☑ |
| O4 | tools | **web_read 大文档缓存预算**（设计修正：缓存本存全文，真痛点是 >256K 长文档完全绕过缓存、每次翻页重新出网）：单条容量 256K→1M 字符 + 缓存总量 8MB 预算；行为对模型零感知（offset/limit 语义不变） | ☑ 2 补丁（o4-web-cache-budget + o4-web-cache-put-big） | py_compile + dry-run 0 FAIL（翻页行为由现有契约保证） | 本会话 web_read 483 次占工具调 17.7%，大文档翻页不再反复出网 | ☑ |

O 轮数据附注：bash 1133 次（占 41.7%）仍居首，但其中「python 单行探针」类已被 N3 后的专用工具
引导持续压低；本轮不动引导（边际递减），聚焦重犯自愈。web_read 483 次为第二名（17.7%）——O4 预取
是其最痛处（长文档 6+ 次翻页）。

### O 轮验证记录（2026-11-04）

- **验证矩阵**：py 48/48（新增 O 轮自愈 10 例：clamp 四态 / grep 提示透出 / 白空间归一编辑含歧义不猜）
  · agent-loop 67/67（新增 tools_deadline env 三态串行测）· host lib 23/23 · cargo check 干净 ·
  补丁层 20 补丁全幂等（0 FAIL / 0 SKIP）。
- **O1 哲学现场复现三次**：开发 agent 自身 grep context 超界连撞两次、bash timeout_ms 超上限一次——
  活体插件跑的还是旧代码（补丁需重启生效），迭代动机无需再证。
- **测试自身踩坑**：同文件三个 edit 并行发出互相覆盖（两处 setUp 丢失）→ 同文件编辑必须串行；
  文件类测试首版撞 WORKSPACE_ROOT 越界护栏（tempdir 在工作区外）→ 按契约在 setUp 内临时重定向 env；
  歧义用例首版构错（归一后实为单命中，自愈正确触发）→ 改双窗口真歧义。
- **退役（P5b 先例）**：LOOP-P2-DEADLINE-FN 终态（llm_step_deadline fn）在位、锚点被 O3a 拆散 →
  `retired/`。
- **O4 口径修正**：落地时核实缓存本就存全文——痛点实为 >256K 长文档完全绕过缓存，方案从「预取」
  修正为「大文档缓存预算」（容量 1M 字符 + 总量 8MB），PLAN 里程碑行的「预取」表述按实际落地为
  缓存放宽口径理解。
- 生效条件：以上全部为补丁层改动，**需重启 host**（cargo 重编 + 插件进程重启）后进入运行时；
  O3 的 Rust 侧在下次 cargo run 重编时生效。

### O 轮回灌上游（2026-11-04）——「rsi 补丁 → react-agent/agent-kernel 正式版」

- **动机**：73 个外挂补丁中 60 个是通用组件修复，长期漂移会让 runtime 快照与上游渐行渐远；
  用户裁决：反向根据实践经验优化上游，让三仓一起迭代。
- **落地**：
  - **react-agent v0.1.22**（edca021 + 9519a6b + 9b7ed30）：agent-loop 八文件整树移植
    （P2/N/E/O 全系含其地基层 budget/secrets/skills）、tools/llm_adapter/memory 插件、
    host 通用五件（instances 杀树/sandbox-run 注释/前端重置入口）；并合入在途的
    Phase 1 接缝（assemble/skillkit/LoopPolicy）。版本 0.1.21→0.1.22，tag 已推。
  - **agent-kernel v0.1.8**（0bc4720）：P6 契约显式化三件（proto 注释 + py/ts guest
    deadline/priority 透传），cargo 29 suites 全绿，tag 已推；rsi runtime 内嵌 triple 同步。
  - **rsi-agent**：runtime 重嵌入 v0.1.22（代码树与上游逐字节一致，verified）；内核依赖
    v0.1.7→v0.1.8；**60 个补丁退役**进 retired/（P5b 先例），13 个 rsi 专属补丁留守
    （checkin×6 / watchdog×2 / self-update×2 / x1×2 / files-p5-noise）。
- **附带修复（回灌过程暴露的上游测试卫生债）**：secrets 测试 CONFIG_FILE 环境泄漏
  （改为临时路径方案）；e2e_full_react_mock 显式清除宿主注入的 WORKSPACE_ROOT/CONFIG_FILE/
  SKILLS_DIR——InProcess 循环读测试进程 env，「进程无这些变量」的脆弱前提被用户级环境
  变量击穿。
- **验证矩阵（最终稳态）**：rsi-agent py 48/48 · runtime agent-loop lib 24/24 +
  react_mocks 40/40 + conformance 3/3 · host lib 23/23 · cargo check 干净 ·
  补丁层 13 活跃全幂等 0 FAIL · react-agent v0.1.22 同矩阵全绿（另含 e2e 七目标）。
- **运维提醒**：runtime 已含全部改动，重启 host 即生效（不再依赖补丁重放路径）；
  此后新迭代从「补丁先行」改为「上游正式版优先，rsi 仅留发行形态专属补丁」。

## 6. 第四轮迭代（Q 轮，2026-11-06；数据源 = `outputs/rsi-agent-前端交互与记忆模块优化方案.md`）

> 目标：运行中可追加指令、切会话瞬时显示、同端口新对话不受老任务拖累、记忆分层与非破坏性压缩。
> 落地路径：`runtime/` 写保护 → 全部核心改动走 `scripts/patches/q-round/*.json` 外挂补丁，
> 由 `scripts/apply-q-round.py --dry-run` 预演全中后正式应用（`.qpatchbak` 可 `--revert`）。

### 6.1 P·Q·I 验收表

| # | 目标与动作 | P（产物） | Q（质量门） | I（影响） | 状态 |
|---|---|---|---|---|---|
| Q1 | **前端队列 / 缓存 / per-session 状态**（问题 1A、2、3 P0） | `web-dist/vendor/q-session.js`（新）+ `app-core/app-events/app-stream/app-files.js` + `index.html` + `style.css`；`gateway.rs` SSE 帧加 `cursor` 字段 | `node --check` 6 文件全过；`pytest 53/53`；补丁 11 条全幂等 0 FAIL；SSE 帧仍是原事件对象（不新增事件 type） | Enter=排队、Alt+Enter=插队、Esc=停止并退回队列；切会话 `innerHTML` 瞬时显示 + `after=cursor` 增量追赶；A 运行中切 B 不再误禁用发送；回滚/删除清缓存防复活 | ☑ |
| Q2 | **memory 换底座、不换视图** | `memory_plugin.ts`：`events/<safe>.jsonl` append-only sidecar、`session.index.json`、`memory.recall`（≤5 条摘要）、30min TTL 逐出、`init/destroy` 对称 | `node --check` 过；`pytest 53/53`；`cargo test` 中 `e2e_ts_memory` 4/4 全绿（旧 get/summarize/rollback 断言不破） | `summarize` 追加 typed compaction 事件而不再丢原文（M1/M4/M10）；`session.index` 供列表/预取（M5）；`sessions` Map 有界（M6） | ☑ |
| Q3 | **服务端显式队列 / status / steer / 可配 inflight** | `agent-loop/src/queue.rs`（新）+ `lib.rs/chat.rs`（op 面、pump、轮次边界注入）+ `host/src/web/mod.rs`（`/api/chat/status`、`/api/queue`、`/api/queue/remove`）+ `config.rs/assemble.rs`（`AGENT_MAX_INFLIGHT`/`AGENT_MAX_TOTAL_INFLIGHT`）+ `q-session.js` 接持久队列 | `cargo check --workspace` 干净；`cargo test --workspace` 除 2 个**基线既有红**外全绿（agent-loop lib 24/24、react_mocks 40/40、conformance 3/3、host lib 23/23、e2e_ts_memory 4/4、e2e_web_gateway SSE/400/404 保留）；`pytest 53/53` | 队列跨标签页一致、可观测、可取消；steer 在轮次边界注入当前工作集（不新开 chat、不写 `user` trace 事件 → 回滚计数与事件 type 全集不污染）；裸并发 POST 同 session 仍 `K409` | ☑ |

### 6.2 方案与接缝

- **「显式队列 vs 隐式排队」不推翻旧裁决**（§2.4）：`00-PLAN.md:18,42` 否决的是「把两次并发裸 chat 串成隐式顺序」。Q 轮只有走 `/api/queue` 的指令才被单消费者 pump 串行化，裸 `/api/chat` 仍由 `chat.rs` 的 `session_chats` 闸 `try_lock` 失败即 `K409`；pump 自身也走同一闸（经 `host.call_plugin` 派发），不绕过。
- **「换底座、不换视图」**：`sessions/<safe>.json` 仍是 LLM 工作集与 `get/summarize/rollback` 的唯一视图（e2e 旧断言逐字保留），原文/压缩/回滚/UI 事件另写 append-only `events/<safe>.jsonl`。这样 M1「破坏性覆写」被消解，而回滚的「第 N 条 user 消息」物理截断语义与前端 `userTurns` 索引不变。
- **精确 cursor 是字段而非新事件类型**：`gateway.rs` 在原 SSE 帧上插 `cursor=after+i+1`，前端 `delete ev.cursor` 后照常 `render(ev)`；`FROZEN_EVENT_TYPES` 与 `render()` switch 均无需改动。
- **前向后兼容**：`q-session.js` 的 `postChat`/`interruptAndSend` 先试 `/api/queue`，旧 host（无该路由）返回 404 即回退本地「直发 + K409 有限重试 / 取消+重启」近似；`memory.recall`/`session.index` 为纯追加 op，agent-loop 的 5 个 memory op 面未变。
- **有界与闭环**：队列每会话 ≤20 项、单条 ≤64KB、pump K409 重试 120×250ms 后放回队首；`destroy()` 清全局队列；memory `init` 建目录/索引、`destroy` 清内存缓存；残留 steer 在 chat 出口转回 followup 队首，绝不静默丢失。

### 6.3 迭代记录（改了哪些文件 / 跑了什么命令 / 保留还是回退）

- **改动文件**：前端 7 文件（`q-session.js` 新建）、`gateway.rs`、`memory_plugin.ts`、`agent-loop/src/queue.rs`（新建）、`lib.rs`、`chat.rs`、`host/src/web/mod.rs`、`config.rs`、`assemble.rs`；测试/工具层 `tests/__init__.py`、`tests/test_q_round_contract.py`（新建）、`pytest.ini`、`scripts/apply-q-round.py`（新建）、`scripts/patches/q-round/**`、`skills/memory-recall/SKILL.md`（新建）、本文件。共 34 条零填充排序补丁，全部 `--dry-run` 锚点命中后应用。
- **命令**：`python -m pytest -q`（53 passed）、`python -m unittest discover -s tests -t .`（53 OK）、`node --check`（6 JS + memory_plugin.ts）、`cd runtime && cargo check --workspace`（Finished）、`python scripts/apply-q-round.py --dry-run`（0 FAIL，全幂等）、`python scripts/apply-tool-patches.py --dry-run`（历史 13 补丁不受影响）。
- **cargo test 基线对比**：`e2e_full_react_mock::full_react_loop_with_mock_llm_and_real_guests`（答案文本兜底 `outputs/data.xlsx` artifact 缺失）与 `e2e_web_gateway::web_config_center_and_skills_crud`（宿主进程 env 泄漏使 provider=`openai` 而非 `mock`）在**干净 HEAD 的 git worktree 上同样失败**——判定为本机环境/陈旧断言的基线既有红，非本轮回归；其余套件全绿。用 `CARGO_TARGET_DIR=target-q` 隔离构建目录，规避运行中 host 锁住 `debug/*.exe`（os error 5）。
- **结论：全部保留**，无回退。重启 host 后前端与 Rust 改动生效（memory 为 guest 进程，重启自动加载）。

### 6.4 已评估不做（防重复尝试）

- 会话树 / fork / clone（pi）：改 `rollback` 的「第 N 条 user」语义与前端 `userTurns` 索引，与本仓「物理截断回滚 + 文件撤销」冲突；
- SQLite / state_db（codex）：新增依赖，与「无 DB、fail-closed 简单底座」冲突，本轮用 JSON 索引；
- 把 memory `concurrent:false` 翻成 true：同步 fs 无锁 = 数据竞争，否决；
- 把 trace 与 model context 合并为单一事件源：需同改 `rollback`/`skills.rs` 重放/`render()`，列为 Q 轮之后的独立迭代；
- 同 session 裸并发隐式排队：旧裁决保留（见 §6.2）；
- SSE 新增 `cursor` 事件类型：会触发 `FROZEN_EVENT_TYPES` 冻结闸与前端 render 改动，改用帧内字段。

### 6.5 Q4 收尾：前端交互三症状修复（2026-11-06）

Q 轮 Phase 1-3 已提交（c85e87c，34 条补丁）。收尾阶段补 4 条补丁修三个实测症状，
关键点是把根因改在**缓存表示层**而不是逐元素打补丁。

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| Q4-10 | 切回缓存会话后「📝 文件变更」chip 点不开、抽屉条目定位不到工具卡、⇄ diff 取不到 args | `snapshotSessionFeed` 存 `feed.innerHTML` **字符串**，`restoreSessionFeed` 再 `innerHTML =` 解析回来——序列化/重解析丢掉节点上的 expando（`_fcpath`/`_fcround`/`_fcargs`、`chip._items`）与 `onclick` 闭包 | 快照改存**活 DOM 节点数组**（`[...feed.childNodes]`），恢复用 `feed.replaceChildren(...nodes)` 原样搬回；模块级指针 `turnTail`/`turnFcBox`/`turnSourceBox`/`turnArtifacts` 一并快照恢复，避免后续事件另起重复卡 |
| Q4-06 / Q4-11 | 待发队列缺「立即执行」；直接用 `send()` 会 push 到**队尾**，与「插队」语义相反 | 无插队入口，草稿误用 `send()` | 新增 `runQueueNow(i)`：`splice` 取出该项 → `unshift` 到队首 → 追加 `queueOpen` → 有在途则 cancel + abort 让 drain 尽快取队首；每条队列行加 `⏭` 按钮 |
| Q4-01 | 「⏭ 插队」按钮 hover 变全黑、文字不可读 | `.btn.ghost:hover` 只覆盖 `border-color`，`background` 仍继承 `.btn:hover` 的近黑 | `.btn.ghost:hover` 补 `background: var(--card-2)` |

- **顺带修正 drain 出队语义**：`s.queue.shift()` 是「盲目删队首」，插队/上移/删除与在途项并发时会误删他项、
  重复发送。改为按身份出队（`indexOf(item)` 再 `splice`）。该改动并入既有 `Q3-14` 的 `drain` 补丁块
  （同一个函数不拆两条补丁，否则后到的会覆盖前者的幂等基线）。
- **已删除的草稿补丁**：`44-q4-locate`（`locateFileChange` 回读 `data-*`）与 `45-tagfilecard`（`tagFileCard` 写
  `data-*`）——Q4-10 从表示层根治后不再需要 DOM 属性冗余；`46-index-interrupt`（移除 `#interrupt`）与
  `47-style-interrupt`——该按钮已正确绑定 steer 语义（Phase 3），移除会让 Q1-01 的幂等基线失效且丢失入口。
- **补丁脚本修正**：`apply-q-round.py` 的幂等判断由 `if patch in src` 改为 `if patch and patch in src`
  （空串是任何字符串的子串，删除型补丁会被永久误判为「已应用」），并新增删除型补丁分支——`patch == ""`
  且锚点已消失视为幂等 OK。
- **验证矩阵**：`apply-q-round.py --dry-run` 45 条 0 FAIL / 0 DRY（全幂等稳态）· `node --check` 6 个 JS 全过 ·
  `pytest -q` 53 passed · `cargo check --workspace` 零错误零警告。

### 6.6 Q5：插队交互归位（2026-11-06）

用户裁决：「composer 的 `⏭ 插队` 恢复为原来的**停止**按钮；拦截能力下放到待发队列行内——
每条给 `⏭ 立即执行` / `↑ 上移` / `× 删除`」。且明确 **⏭ = A**（打断当前任务立刻跑它），
不点则轮到它才跑。

- **致命前提（本轮真根因）**：`postChat` 把每条 `POST /api/queue` 后，服务端只回 `accepted`
  不等执行，`drain` 随即出队 → 本地待发队列**毫秒级清空**，行内三按钮来不及点。
  仅加按钮无效，必须让队列**本地驻留**：`drain` 改走 `postChatDirect`（Promise 覆盖整段执行，
  跑完才出队），删除只做转手的 `postChat`。Q5-02 删除型补丁接住这一步。
- **执行中那条的表示**：第 0 条 = 执行中（`st.draining && i === 0`），行加 `.qitem.running` 描边 +
  「执行中」标签，三按钮 `disabled`；其余条才是真待发。`↑` 在 `i === 1` 且 draining 时禁用，
  否则会把执行中的行顶成待发。
- **插入位置**：`runQueueNow` / `interruptAndSend` 回退路径都改成 `splice(s.draining ? 1 : 0, 0, …)`
  ——插到执行中那条**之后**，再 cancel + abort 让 drain 尽快轮到它（A 语义）。

| # | 改动 | 说明 |
|---|---|---|
| Q5-01 | `drain` 改 `postChatDirect` + 队列驻留 | 行内按钮的操作窗口来源 |
| Q5-02 | 删除 `postChat` | 转手即返回是队列清空的直接原因，已无引用 |
| Q5-03 | `renderQueue` 执行中行不给按钮 | 含 `↑` 不能顶掉执行中那条的护栏 |
| Q5-04/05 | `index.html` 撤 `#interrupt`、改 placeholder 与 qhead 文案 | composer 恢复纯「停止」 |
| Q5-06 | `style.css` 清 `#interrupt` 孤儿样式，补执行中/禁用样式 | 无死样式残留 |
| Q5-07 | `bindQueueUI` 解绑 `#interrupt` | 函数本体保留（契约测试要求），Alt+Enter 仍可用 |
| Q5-08 | `runQueueNow` 插到执行中那条之后 | 适配驻留语义 |
| Q5-10 | `interruptAndSend` 回退路径同样避开 index 0 | 否则 unshift 会把执行中行顶成待发 |

- **补丁基线处理（本轮主要工程成本）**：Q5 合法改写了 7 条旧补丁产出的区域，会让它们在
  `--dry-run` 中 FAIL/DRY，全量重放会重复插入（CSS 块、`runQueueNow` 定义）。按 P5b/O 轮先例
  **退役**（终态内容均已在位，锚点只是被后继补丁拆散）：`Q1-01`、`Q1-02`、`Q3-12`、`Q3-13`、
  `Q3-14`、`Q4-06`、`Q4-11` → `scripts/patches/retired/*.retired`。
- **验证矩阵**：`apply-q-round.py --dry-run` 40 条 0 FAIL / 0 DRY · `node --check` q-session.js &
  app-events.js 全过 · `pytest -q` **53 passed** · 终态核验：无 `#interrupt`、无 `postChat`、
  `#interrupt` 孤儿 CSS 已清、`#stop` 在位、`drain` 走 `postChatDirect`·生效需重启 host。

### 6.7 Q6：插队打断 vs 用户停止——原任务该不该回头（2026-11-06）

用户报障：「两个任务，一个在执行、一个在排队。排队的插进来做完了，**就回不去原来那个了**——
因为原来是直接取消的。插队这种情况，插队的做完应该自动回头继续之前被插队的任务；
除非之前那个是用户自己按停止取消的。」

- **根因（不在取消，而在出队）**：插队与停止走**同一条** `POST /api/chat/cancel` + `abort`，
  而 `drain` 拿到 `postChatDirect` 返回后**无条件出队**（`indexOf` + `splice`）。于是两条路径
  终态一致——原任务既没跑完，也没留在队列里，从界面与队列双双消失。判别依据不该是「有没有被
  取消」（两者都取消），而是**谁发起的取消**。
- **修复轴：把打断来源记在被打断那条 item 自己身上**，drain 按结局分流。
  - `markRunningStopped(sid)`（停止键 / Esc）→ `queue[0].stopped = true` → 出队即丢弃；
  - `markRunningInterrupted(sid)`（⏭ 立即执行 / Alt+Enter）→ `queue[0].interrupted = true`
    → 出队后**重新插回 index 1**（紧跟在插队条之后）：插队条跑完出队，它自然回到队首续跑，
    且仍优先于插队条之后的所有待发项 = 「做完插队的活就回头」。
  - 标记必须在 `abort()` **之前**落，否则 `postChatDirect` 的 catch 先跑、读不到来源。
- **`postChatDirect` 必须返回结局**：原来 `return;`（undefined），drain 无从判断是跑完还是被打断。
  改为返回 `"ok" | "error" | "aborted"`；且每轮尝试开头若已带 `interrupted/stopped` 立即返回，
  不再空转 K409 的 24×250ms 重试窗（否则续跑白等 6 秒）。
- **续跑不得重复落 user 消息（本轮第二处真实缺陷）**：`chat_run` 在轮次循环**之前**就
  `memory.append` user 消息并发 `trace` 的 `user` 事件（`chat.rs:287/295`）。直接重发会让
  memory 多一条 user、前端多一个气泡。故加 `resume` 标记贯穿四层：
  `q-session.js`（`item.pendingResume` → body.resume）→ `web/mod.rs`（透传
  `chat_payload["resume"]`）→ `contract.rs`（`ChatReq.resume: bool`，缺省 false 向后兼容）→
  `chat.rs`（`if !req.resume { …append + trace… }`，跳过落库直接基于现有工作集继续）。
- **有界**：`MAX_RESUME = 8`，超限放弃并提示——防「插队↔被插队」极端来回 ping-pong 无界重放。
- **可见**：待续跑那条加 `.qitem.resume`（虚描边）+「⟲ 待续跑」标签，让用户看见它没丢。

| # | 改动 | 说明 |
|---|---|---|
| Q6-01 | `q-session.js` 增 `MAX_RESUME` / `markRunningStopped` / `markRunningInterrupted` | 来源标记的两个入口 |
| Q6-02 | `postChatDirect` 返回结局 + 带 `resume` | 打断时立即让位，不空转重试窗 |
| Q6-03 | `drain` 结局分流 | 本轮的语义核心：续跑 vs 丢弃 |
| Q6-04 | `renderQueue` 加「⟲ 待续跑」 | 状态可见 |
| Q6-05/06 | `runQueueNow` / `interruptAndSend` 置 interrupted | ⏭ 与 Alt+Enter 两入口 |
| Q6-07 | `stopBtn` 置 stopped | 用户停止 = 丢弃 |
| Q6-08 | `style.css` `.qitem.resume` 虚描边 | 与执行中实描边区分 |
| Q6-10..12 | `resume` 贯穿 contract / chat / web | 防重复 user 轮次 |

- **补丁基线处理**：Q6 合法改写了 5 条旧补丁产出的区域（`Q1-08`、`Q5-01`、`Q5-03`、`Q5-06`、
  `Q5-08`），终态内容均由 Q6 承接 → 退役至 `scripts/patches/retired/*.retired`。
  另：`Q6-10` 初版锚点误命中 `MemoryMsg` 的同名字段块（两处都有
  `pub attachments: Option<Vec<Attachment>>`），`cargo check` 报 `E0063 missing field resume`
  才暴露；已给锚点补上 `fn default_session` 尾行使其唯一。`Q6-09`（单独补 `MAX_RESUME`）
  因上游补丁应用后锚点失效，已并入 Q6-01 的补丁块。
- **验证矩阵**：`apply-q-round.py --dry-run` **46 条 0 FAIL / 0 DRY** · `node --check`
  q-session.js & app-events.js 全过 · `pytest -q` **55 passed**（新增 2 条 Q6 契约断言：
  续跑/丢弃分流、resume 不重复落 user）· `cargo check --workspace` Finished 零错误 ·
  `cargo test --workspace --lib` 中 `agent-loop` 24/24 全绿；`host` 的
  `web::api::config::tests::agent_config_applies_to_env_and_validates_numbers` 在**并行全量**
  下红、单独跑绿——是既有测试间环境变量串扰（摘要在案），与本轮无关。
  分流逻辑另用等价 JS 脚本穷举三结局：`user-stop → [B]`、`interrupt → [B, A*]`、`ok → []`。
- **生效需重启 host**（前端 + Rust 双改）。

## 7. B 轮（2026-11-07）：单会话形态 + 任务看板 / 灵感看板

> 出发点不是「加面板」，而是用户对 agent 理想形态的第一个**结构性**要求：
> 「它应该具备人的思维模式……UI 其实不需要分会话层级，面对用户就是一个会话框……
> 左侧应该是任务看板，每个任务包含它对『人财物』的分配，以及具体进度……还要有碎片化灵感看板，可 @ 引入会话。」
> 完整方案与迭代记录：**`docs/self-evolution/01-单会话与任务看板.md`**（本质/时空契约/四层设计/数据规范/P·Q·I/活体验证）。

| # | 目标与动作 | P（产物） | Q（质量门） | I（影响） | 状态 |
|---|---|---|---|---|---|
| B0 | **补丁机制升级**（先解锁再动手）：外挂补丁支持 `create`（新建文件）+ `anchor_file`/`patch_file`（长块免 JSON 转义）；`--revert` 只删「补丁创建且未被演进」的新建文件 | `scripts/apply-tool-patches.py` v9；`tests/test_tool_contract.py` 新增 create 语义锁 | `pytest` 67 passed（新增 1 例覆盖新建/幂等/演进保护三态） | 新增 Rust 模块与前端文件也能走补丁通道，不必再动核心写授权 | ☑ |
| B1 | **看板数据契约 + agent 写入通道**：单写点 `.rsi/board.json`；任务状态机 `planning→doing→verifying→done`（+`blocked`/`cancelled`）；人财物四问字段；验收提示闸 | `scripts/board.py`（11 子命令）+ `skills/rsi-board/SKILL.md` | `pytest` 13 例（生命周期/枚举封闭/越界拒绝/坏板不覆盖/两侧按 id 合并/refresh 不删条目） | agent 有了「先想清怎么做再动手」的可核对载体；用户不再维护项目分类 | ☑ |
| B2 | **host 读 + 灵感写**：`GET /api/board`（整板 + 汇总 + 上限）、`POST /api/board`（`inspiration.add`/`inspiration.set`/`refresh`，**拒 task op**）；坏板 409 拒写 | `web/api/board.rs`（含 `civil_from_unix` 零依赖时间戳 + 6 单测）、路由与导出补丁 B2/B3/B7 | `cargo check` 零警告；host lib 29/29 | UI 与 agent 看到同一份文件；坏板不会被静默清零 | ☑ |
| B3 | **提示词纪律**：`task_board_section`（brief 常驻一行 / full 按需完整规范）+ `user_wants_task_plan` 触发判定；通道写死 `python scripts/board.py`（技能工具默认未启用，不能承载闭环）；仅工作区有 `board.py` 时注入 | `skills.rs`（B4a/B4b/B4c）、`chat.rs`（B5）、`lib.rs`（B6 两测） | agent-loop lib 26/26（含触发词正负例、CLI 存在性与两档注入） | 会办事的轮次自动获得四问模板，闲聊轮次零额外 token | ☑ |
| B4 | **UI 单会话 + 看板**：左栏换「任务看板 + 灵感」双区（分区顺序固定、组序由状态机定、无拖拽）；header 去会话名；`app-board.js` 分组渲染/详情/`@` 引用/20s 可见性轮询 | `index.html`（FE1-3）、`app-core.js`（FE4 单会话）、`app-board.js`（FE5 新建）、`style.css`（FE6） | `node --check` 4 文件全过；`pytest` UI 契约 4 例（无 sessions/newchat、组序固定、UI 不写任务、兼容层在位） | 左栏从「会话管理」变成「人财物与进度管理」，与用户的构想对齐 | ☑ |
| B5 | **活体验证**：独立实例 8799（独立端口/工作区/记忆），13 项端到端 | 见 01 文档 §5.3 | 全项符合预期；关键证据 = CLI 建任务与 UI 写灵感**互不吞条目** | 「两侧并发写同一份看板」这个最易错的设计点被实测证明可用 | ☑ |

**跨轮纪律遵守情况**：本轮 15 条核心补丁全部走 `scripts/patches/*.json`（`--dry-run` 0 FAIL），
`runtime/` 下的改动只可能来自补丁重放；本轮**未触碰** SSE 事件类型集合、`rollback` 语义、
`memory` 视图、`queue` 语义；新增依赖 0（Rust 侧自带日期换算，Python 侧纯标准库）。

**过程留档**：① B4b 首版插入点拆散了既有 P2 补丁锚点（`--dry-run` 报 FAIL），改插入点到
「自扩展段之后、产物段之前」而非退役 P2；② `write_file` 全量覆盖误伤过一个 19KB block 文件，
用已落地的 `runtime/` 同名文件 + `.bak` 逐字节比对还原——反证了「补丁终态即可复原的权威副本」。

**反哺上游的候选**（下一轮，非本轮范围）：`web/api/board.rs` 与 `app-board.js` 是通用 UI 能力，
`skills.rs` 的「按需注入长纪律段」模式已是第二次复用（B2 → 任务看板）——这两处可整体移植回
react-agent，作为「发行形态可挂 UI 视图 + 可挂按需提示段」的正式接缝。

## 8. C 轮（2026-11-08）：评价体系 / 引用装载 / 同类归纳 / 受约束的插件化看板

> 承接 B 轮：B 把「任务」提升为一等对象，C 让这个对象**可被证明、可被引用、可被归纳、可被装配**。
> 完整方案与迭代记录：**`docs/self-evolution/02-评价体系与看板插件化.md`**。

| # | 目标与动作 | P（产物） | Q（质量门） | I（影响） | 状态 |
|---|---|---|---|---|---|
| C1 | **评价体系**：`acceptance`（人读标准）之外增 `checks`（机跑证明：cmd/file/grep/manual）+ `evaluation`（verdict/pass/fail/skip）；检查失败把 verifying/done 退回 doing；有检查未跑就 done 打 warning | `scripts/board.py`（+eval/check-add，25.6→47.6KB） | `pytest` 8 例（四 kind 证据/降级/--only/NO_CHECKS）；活体 eval pass=2 fail=0 skip=1 | 「我说做完了」变成「跑给你看」；`manual` 永远 skip——agent 不能给自己判过 | ☑ |
| C2 | **@引用自动装载**：`board_ctx.rs`（渲染与 I/O 分离）在组装 system prompt 时解析 `@T-/@I-` 并拼入上下文；三结局（命中/全缺失→stale/无引用→空） | `board_ctx.rs`（新建）、`chat.rs`、`lib.rs`、`skills.rs` | agent-loop lib 29/29（引用形状 + 渲染三结局 + 通道分档，全纯函数不碰环境） | 引用是**输入的一部分**：不再需要模型先 `show` 一次，多引用不再是 N 次往返 | ☑ |
| C3 | **同类归纳**：`board.py digest`（--skill/--status/--brief + by_skill 聚合）；prompt 无引用但像交代任务时给在办摘要（≤12 条） | `board.py`、`board_ctx.rs` | `pytest` 1 例（过滤 + brief）；Rust 单测排除 done/cancelled | 「这类事以前怎么做的」可检索；摘要让模型先知道自己手上有哪些活 | ☑ |
| C4 | **受约束的插件化看板**：`layout.sections` 声明式章节（tasks/metrics/inspirations），白名单封闭 + **顺序按 kind 钉死**；GET 回显规整 layout + `by_verdict`；POST `layout.set` 逐项预校验 | `board.rs`（C1–C6 补丁：白名单/load/get/layout.set/doc/测试）、`app-board.js` 重写为布局驱动、`index.html` → `#board-sections`、`style.css` | host lib 31/31（含**跨语言同源测**：直读 board.py 校验白名单）；活体乱序重排 + 非法 kind/重复 id→400 | 加章节不改前端（插件化），能加什么由枚举决定（有约束）；`metrics` 直答「有多少活没跑过验收」 | ☑ |
| C5 | **活体验证**：独立实例 8799（独立端口/工作区），11 项端到端 | 见 02 文档 §5.3 | 全项符合；关键证据 = CLI 写布局/评价，host 读，前端渲染，三方结构一致 | 「同一份看板的布局与结论」跨进程一致 | ☑ |

**跨轮纪律**：C 轮 15 条补丁全走 `scripts/patches/*.json`（`--dry-run` 0 FAIL / 0 DRY）；未触碰
SSE 事件类型、`rollback`、`memory` 视图、`queue`；新增依赖 0。**退役** B5 与 FE1 至 `retired/`
（区域被 C-CTX-CHAT 与 FE8-SIDEBAR 合法改写，终态由 C 轮承接）。

**过程留档（四个坑，详见 02 文档 §5.5）**：① 补丁锚点互吞把 `layout.set` 改成半截 → 回 git HEAD
重拆成互不重叠的 C1–C8；② 多测共享进程 env 串扰 → `board_ctx` 拆纯函数渲染 + I/O 入口；
③ `.patchbak` 是同文件共享的、不是真相，基线只认 git HEAD；④ 删除型补丁的 `patch` 写占位注释，
不用空串（幂等判据会失效）。

**仍未做（下一轮候选）**：`resourcing.model` 真正影响调度（需处理同会话换模型的上下文/缓存语义）；
「物力自造」（按 plan 现造技能/工具 + 灰跑验收）；`metrics` 历史趋势（需按天快照，属数据层扩张）。

## 9. D 轮（2026-11-08）：五条构想的完整落地

> 来源：用户五条灵感 `I-20261107-01` … `05`，采纳进 `T-20261108-02`，要求「完整梳理落实，
> 形成方案并完整执行，过程中不需要再问」。
> 完整方案与迭代记录：**`docs/self-evolution/03-五条构想落地.md`**（含五条原话对照、
> 时空契约、逐条设计、四个坑的过程留档）。

| # | 目标与动作 | P（产物） | Q（质量门） | I（影响） | 状态 |
|---|---|---|---|---|---|
| D1 | **可编辑与删除**（I-02）：灵感 `insp-edit`/`insp-rm`（已采纳需 --force）、任务 `task-rm`（子任务摘 parent、灵感引用清空）、队列行 `✎` 编辑 / `⧉` 复制、回滚草稿保留 | `board.py`、`board.rs`（`inspiration.edit`/`.rm`）、`app-board.js`、`q-session.js`、`app-events.js`、`index.html` | pytest 8 例（部分更新/空文本/超长/adopted 拒绝/引用完整性/未完结 warning）；活体 1–3 + 回滚草稿 | 记错的东西能就地改、能删；打上去的指令不必整段重打 | ☑ |
| D2 | **看板弹窗**（I-03）：`▤ 看板` → `#board-win`，按 kind 分标签、任务卡默认全展开（人财物/计划/分解/验收/检查/产物/来源/上级） | `index.html`（骨架+按钮+脚本去重）、`app-board.js`（`renderBoardWin`/`winTaskCard` 等）、`style.css` | pytest 前端契约 4 例；活体页面/JS/CSS 200 且骨架在位；`node --check` 过 | 侧栏「一眼看进度」＋弹窗「摊开看细节」，同一份 layout 与数据，零额外请求 | ☑ |
| D3 | **习惯留存**（I-04）：`.rsi/profile.json`（章节 4 类 + 观察）+ `scripts/profile.py`（6 子命令）+ `profile_ctx.rs` 有界注入 + 提示词纪律段 | `scripts/profile.py`（新）、`agent-loop/src/profile_ctx.rs`（新，4 单测）、`chat.rs`、`lib.rs`、`skills.rs` | pytest 6 例；agent-loop 33/33（新增 4）；活体章节顺序 + brief 非空 | trace 存原文、profile 存结论；画像每轮有界注入，空画像不注入空壳 | ☑ |
| D4 | **任务↔对话**（I-05，采用 @ 形式）：`user` trace 事件带 `refs` 字段 + `GET /api/board/link` + `board.py link` + 弹窗 `⌕ 对话` | `chat.rs`（D5-USER-REFS）、`board.rs`（`get_board_link`）、`web/mod.rs`、`api/mod.rs`、`board.py`、`app-board.js` | pytest 3 例；活体 HTTP 与 CLI **同口径**（各 1 条、`user_index` 一致） | 一件活在哪几轮谈过可反查；关联键用用户明文写的 @，不靠模型登记 | ☑ |
| D5 | **分解与委派**（I-01）：`plan[].owner`（self/subagent/skill，缺省 self）+ `task.parent` + `decompose_hint` 提示词段（含「什么时候别拆」） | `board.py`（`PLAN_OWNERS`/`parent` 校验/`refresh` 补齐）、`board_ctx.rs`、`skills.rs` | pytest 4 例（缺省/闭枚举/跨语言同源/parent 形状与自指）；活体 host 读到 `owner=subagent` | 「考虑好复杂度」从自述变成可核对的字段：每步必须回答谁干 | ☑ |
| D6 | **验证矩阵** | 见 03 文档 §5 | `pytest 134`（基线 108）· agent-loop 33/33 + host 31/31（单线程口径）· cargo check 零警告 · 补丁 0 FAIL/0 DRY · `node --check` ×3 · 活体 **16/16** | 五项能力在活体上三方一致（CLI / host / HTTP） | ☑ |

**跨轮纪律**：D 轮 22 条补丁全走 `scripts/patches/d*.json`（`--dry-run` 0 FAIL / 0 DRY）；
未触碰 SSE 事件类型集合（`refs` 是**字段**不是新 type）、`rollback` 语义、`memory` 视图、
`queue` 语义；新增依赖 0（画像与 link 全用标准库/serde）。

**退役**：`B2`、`B3`、`C5-LAYOUT-OP`、`C-CTX-MOD`、`C-CTX-CHAT`、`FE2`、`FE7-BOARD` 共 7 条
区域被 D 轮合法改写（终态内容均由 D 承接），按 P5b/O 轮先例转 `retired/`；
`tests/test_board_contract.py` 的在位断言改为「活跃 ∪ retired 并集 + 退役留档单独断言」。

**过程留档（四个坑，详见 03 文档 §6）**：① **patch 是 anchor 的子串** → 幂等判据失效，
收缩型补丁必须有独占标记行；② 锚点取整段函数体导致 `E0428` 重复定义——锚点要像手术切口，
只取不重复的最小片段；③ **宿主 env 被子进程继承**，`board.py link` 读到另一个工作区的
trace → 判定顺序改为「工作区内实据 → env → 缺省」；④ **grep 检查把看板自己扫进去**
（marker 已写进 `.rsi/board.json`）→ 判文件内容的检查要把 scope 收到最窄目录。

**仍未做（下一轮候选）**：见 03 文档 §8（`resourcing.model` 真正影响调度、`owner: skill` 的
现造闭环、`metrics` 历史趋势、`config_agent_section_applies_to_env` 的 env 隔离修复、
弹窗内的任务编辑是否放开写权限需重新裁决）。

## 10. E 轮（2026-11-08）：知识落层判据 + 多域上下文

> 来源：用户灵感 `I-20261107-06`（知识该放哪一层）与 `I-20261107-07`（上下文怎么分域），
> 采纳进 `T-20261108-03`。用户原话要求「通盘考虑」——所以本轮一半的产物是**判据**，
> 不是代码：先证明七条既有通道已覆盖所有面（没有第八个面需要新容器），再动代码。
> 完整方案：**`docs/self-evolution/04-知识落层与多域上下文.md`**。

| # | 目标与动作 | P（产物） | Q（质量门） | I（影响） | 状态 |
|---|---|---|---|---|---|
| E1 | **落层判据**（I-06）：四问决策树（决定动作→内置工具 / 换仓仍成立→文档 / 一类活的做法→技能 / 有生命周期→看板·账本 / 否则→画像）+ 七条通道性格表 + **放错层的具体后果**表 | `docs/self-evolution/04-…md` §1-§3 | pytest 3 例（文档在盘、覆盖七通道、三问有唯一答案）；`自扩展途径` 段在位 | 下轮同类问题不必重新论证；判据的可执行性由「放错会怎样」保证，不靠形容词 | ☑ |
| E2 | **三问逐一作答**（I-06 原话）：记忆加载 = 内置（分三层，只有第 3 层该由模型决定要不要取）；推送 github = 技能为主 + 画像只放一句指针；内置技能 = 六件元循环（`origin: preset`） | 同上 §3 | 同上；`创建skill` / `推送至github` / `记忆加载` 三词各自命中 | 「通用偏好技能」这一危险抽象被明确否掉——没有触发场景的知识不该做成技能 | ☑ |
| E3 | **多域上下文**（I-07）：`profile v2` 全局 + 域两级（按**作用范围**而非角色分）、`use`/`domains`/`domain-rm` 三子命令、域块只讲 delta 并标注 `(overrides global)`、note ID 跨层唯一、v1 文件照读为纯全局 | `scripts/profile.py`（v2）、`profile_ctx.rs`（`active_domain`/`render_domain_block`，域块独立上限 700） | pytest 14 例（v1 兼容/粘性/环境变量优先/层隔离/上限/坏文件拒写/跨层 note 隔离）；Rust 5 单测 | 上下文能分而**不错域**；切域是显式动作，系统绝不猜 | ☑ |
| E4 | **提示词纪律段**：全局 vs 域按「换到别处会错还是会无关」判；禁止在域里重复全局事实；禁止自行 `use` 切域 | `profile_ctx.rs::profile_ops_hint`（full 段）、`skills/rsi-board/SKILL.md` §6.6 | pytest 2 例（技能验收项在位）；补丁幂等 | 判据同时进了提示词和技能——模型读到的是动作纪律，不是文档链接 | ☑ |
| E5 | **验证矩阵** | — | `pytest 153`（D 轮基线 134，+19）· agent-loop **38/38**（+5）+ host 31/31（单线程）· `cargo check` 零警告 · 补丁 0 FAIL/0 DRY | 两侧同源常量由测试锁住（域名上限/JSON 键名/覆盖标注文案/环境变量名） | ☑ |

**跨轮纪律**：E 轮 4 条补丁走 `scripts/patches/e*.json`；未新增依赖；
未新增 SSE 事件类型；`profile v1 → v2` 是**读兼容**而非迁移（旧文件字节不变即可用）。

**过程留档（两个坑）**：
① **锚点写成了「打补丁后的样子」** —— `--dry-run` 报 2 条 FAIL 才发现的：把 `patch` 内容
错填进 `anchor_file`，而 `_apply_one` 的幂等判据是 `if patch in src`，于是「锚点未命中」
与「已应用过」在错误的方向上互相掩盖。教训：**anchor 必须从 `read_file` 原样抄，不能按
记忆重写**；DRY 全绿之前不 APPLY。
② **写侧与读侧对域名形状的要求必须不同** —— 读侧要宽容（旧文件里的 `Work` 折成 `work`，
否则脏键凭空多出一个域），写侧要严格（`use Work` 必须报错，否则用户以为切到了新域却在
往旧域写）。用同一个 `_clean_domain` 会让其中一侧出错，故拆成 `_clean_domain`（读）与
`_strict_domain`（写）。

**仍未做（继承 D 轮 + 本轮新增）**：`resourcing.model` 真正影响调度；`owner: skill` 的现造闭环；
`metrics` 历史趋势；`config_agent_section_applies_to_env` 的 env 隔离修复；弹窗内任务编辑的写权限；
**域的可视化**（判断是低频操作，不做）；**域与任务自动关联**（故拒——那是自动推断换入口）。


## 11. F 轮（2026-11-08）：看板信息架构 + 记忆可见化 + 遗留清账

> 来源：用户三条反馈（`I-20261108-01`~`03`，采纳进 `T-20261108-04`）：
> ① 「看板直接放左侧，完成或实现了可以折叠起来自动归档；现在 UI 单调又混乱」；
> ② 前端不渲染的根因由用户定位并修复（`el` 同名覆盖，FE9）；
> ③ 「技能、工具、记忆、agent 与用户画像在 UI 上如何更科学合理，从用户便利视角」。
> 并追加要求「上一轮未做的直接都做掉」。

| # | 目标与动作 | P（产物） | Q（质量门） | I（影响） | 状态 |
|---|---|---|---|---|---|
| F1 | **左栏信息架构**（需求①）：状态组可折叠（落定组 done/cancelled 默认收起成一行，含条目数）；灵感按 open/adopted/archived 三层折叠；折叠态记 localStorage；活跃组头加深、折叠组头淡出 | `app-board.js`（`folded`/`setFold`/`tgroupHead`/`inspRow`）、`style.css`（`.tgroup.shut`/`.tchev`） | 无头 DOM 桩 22 项断言（默认值/用户选择记忆/localStorage/D8 按钮留存）；`node --check` | 「已完成的不该和进行中的一样占地方」——折叠点选在**组**而非任务，换视觉权重，一条信息不丢 | ☑ |
| F2 | **记忆可见化**（需求③）：`GET /api/profile` 全量读 + `POST /api/profile` **只支持删除**（note/section/domain）；设置新增「记忆」页（全局→域→观察三层 + 当前域标记 + 行内删除） | `web/api/profile.rs`（新，4 单测）、`web/mod.rs` 路由、`app-settings.js`、`index.html`、`style.css` | Rust 4 单测（域名形状跨语言同源/层隔离/404 不静默成功/RFC3339 形状）；活体 GET 三层返回 + 新增被拒 + 删除成功 + 域删 404 | 「写错一条比不写更糟」→ 能看能删不能手写；新增走观察，删除是用户的权力 | ☑ |
| F3 | **能力总览**（需求③主线）：设置抽屉顶部三列目录——你决定的（模型/工具/运行参数）· 它带的牌（技能/技能工具/MCP）· 它记得的事（画像/域）；点行跳页签 | `index.html`（`#cap-overview`）、`app-settings.js`（`renderOverview`/`ovGoto`）、`style.css` | 活体首页含 `cap-overview` + 7 个 `data-goto`；`node --check` | 主线按「谁做的决定」分，而不是「页签有几栏」——分类同时对应它们在上下文里的注入方式 | ☑ |
| F4 | **遗留清账**（用户「都做掉」）：① env 测试隔离（`env_lock` 进程互斥，去掉 `--test-threads=1` 依赖）② metrics 趋势（按 `updated_at` 分 7 天桶，**不新增数据层**）③ 补丁层幂等链修复 | `config.rs`（`env_lock`+3 处取锁）、`app-board.js`（`verdictTrend`/`trendBlock`）、`style.css` | cargo host **35/35 多线程默认跑法**全绿（原需单线程）；趋势 5 项断言 | ①把「隐式跑法要求」变成「显式代码约束」②趋势缺的不是数据是切片，因此不加文件不加表 | ☑ |
| F5 | **明确不做并写清理由** | 本文档 | — | `resourcing.model` 主会话换模型（要处理中途换模型的上下文与缓存语义，单独立项）；`owner: skill` 自动化（现造技能需人判）；弹窗任务编辑（B 轮写权限边界未重新裁决） | ☑ |

**跨轮纪律**：F 轮 25 条补丁走 `scripts/patches/f*.json`；未新增依赖；未新增 SSE 事件类型；
**未新增数据文件**（趋势是切片不是快照）；core 区全部经外挂补丁写入（`style.css` 等一次 write_file 被
`CORE_PROTECTED` 拦下后改走补丁，符合纪律）。

**过程留档（七个坑）**：

① **尾部锚点互相截断**：F1-CSS 与 F3-CSS 都锚在 `style.css` 末尾，第二条替换后第一条的幂等判据
（`patch in src`）失效 → 后者把前者的内容切掉一截（实测出现 `#board-sections > .board-` 半行残留）。
教训：**同一文件的多条尾部追加必须合并成一条补丁**（`F13-CSS`）。

② **锚点抢同一插入位**：D13 锚在 `POST /api/board` 之后，F2 的补丁把该行也包进去了 → 补丁成了
锚点的子串，两条互相截断，路由出现成对重复。教训：**新补丁要避让既有补丁已占据的插入位**，
F2 最终锚在 `/api/board/link` 之后。

③ **CRLF 与 LF 混用**：`write_file` 写块文件是 LF，仓库源码是 CRLF，补丁脚本按字节比较 →
锚点"看起来一样却命中不了"。教训：**锚点从目标文件字节级抽取**，不要手打。

④ **退役不是想退就退**：我把 D8 移进 `retired/` 后 `test_board_contract` 立刻失败——测试锁的是
「D 轮补丁必须留在活跃集」。正确做法（P5B-VERIFY 先例）：**转成幂等校验型**（锚点=终态片段，
命中即通过），既保留了「该能力仍在」的守护，又不干扰新补丁。

⑤ **备份不是版本管理**：反复 `copy .patchbak` 回滚时，备份可能比当前代码旧，导致重放后
出现 `BOARDWIN_KEY 已声明` 这种重复定义。教训：**回滚基线用 `git checkout --`**，`.patchbak`
只用于补丁脚本的即时撤销。

⑥ **锚点吞掉容器开始标签**（最危险，只有测试抓到）：`F3-MEM-PANEL` 的锚点取
`</div>
<div id="tab-agent" hidden>`，而补丁里没有把它补回来 → Agent 页容器消失。
症状是「点 Agent 页签没反应、也不报错」——比白屏更难察觉，因为其它四页都正常。
教训：**锚点若跨越结构边界（开/闭标签、大括号），补丁必须显式还原它**；
并用「容器数量 == 页签数量」这类结构性断言兜底（`test_all_five_tab_containers_intact`）。

⑦ **幂等判据会被后续补丁"吃掉"**：`D9-BOARD-WIN` 的 patch 是整块（含 `renderWinMetrics`），
`F4-TREND-HOOK` 改了这个函数 → 整块子串不再成立，补丁以为没应用过而重放，导致
`BOARDWIN_KEY 已声明`。教训：**整块型补丁在它覆盖的函数被改动后，必须转成校验型**
（锚点=一个不会被别人改的独占片段），否则幂等判据形同虚设。

**仍未做（下一轮候选，含理由）**：
1. `resourcing.model` 影响主会话调度——需处理会话中途换模型的上下文/缓存语义，不是加字段能解决的。
2. `owner: skill` 的现造闭环——「按 plan 现造技能 + 灰跑验收」缺自动化，且造得好坏需人判。
3. 弹窗内任务编辑——B 轮「任务归 agent 写」的边界若要放开，需重新裁决而非顺手加 op。
4. `style.css` 的历史重复块清理——删它会打断 C-STYLE / D17-STYLE-WIN 的幂等链，
   需先「把 C/D 补丁并入基线」再一次性删净（专门收口轮）。

## 12. G 轮（2026-11-08）：灵感主权 / 草稿存活 / 发送键 / 并行判定 / 双线结论

> 来源：用户三条灵感 `I-20261108-04`~`06`，采纳进 `T-20261108-05`。

| # | 用户诉求 | 落地 | 关键判据 |
|---|---|---|---|
| G1 | 灵感归用户，agent 只读，不要替用户总结 | `board.py` 删掉全部 5 个灵感写命令；写入只留在 host `/api/board`（= UI 唯一入口）；采纳关联记在 `task.inspirations`；`skills.rs` 提示词明确「灵感归用户」 | CLI 无 `insp-add`/`insp-edit`/… 子命令；`inspiration.add` 超 2000 字回 400 |
| G2 | 记灵感时界面不能因刷新打断输入 | `refreshSections` 先快照 `inspDrafts`/`inspFocus`，重绘后还原 | 轮询重绘后输入内容与光标位置不变 |
| G3 | 运行中发送键点不了 | `sendBtn.disabled` 不再随运行置真，改显示 `queued` 态 + `title` 提示 | 运行中点发送与按 Enter 等效（入队） |
| G4 | 不同任务能否并行，由 agent 自行判断 | 前置正确性：`BoardLock`（`O_CREAT|O_EXCL`，stale 15s），`main()` 按 `READ_ONLY_CMDS` 集中加锁；判定见 `outputs/g4-parallel-decision.md`：走 B 路线（agent 自行并行，工具波次本已 `join_all`），不做前端多会话、不拆 K409 闸 | 5 个并发 `task-upsert` 一条不丢 |
| G5 | 完成后要「专业确认 + 通俗结果」两条线 | `task.outcomes{brief,pro}` 落数据层；`check_acceptance_warning` 累积三条；`digest`/`refresh` 带结论；前端结论置顶、`pro` 默认折叠；`board_ctx` 引用时带结论；提示词加两段 | `GET /api/board` 回 `outcomes.brief`/`outcomes.pro` |

### 12.1 事故记录：误杀用户正在运行的实例（2026-11-08 11:46）

**现象**：用户报「你重新构建后运行了就把之前的 agent 进程杀掉了，但是没有重启」。

**根因（trace 可查证，`traces/main.jsonl` ts=1794109601202）**：活体验证脚本为清理自己起的
隔离实例，执行了

```
taskkill /IM react-agent-host.exe /F
```

`/IM` 是**按镜像名全量匹配**——把用户正在用的 PID 24876（`127.0.0.1:8710`）一起杀了。脚本里
没有、也不该有「重启用户实例」的代码路径，所以杀完就是彻底中断。

**为什么杀完没自己起来**：那条命令本意是杀「我等端口等不到的那个测试实例」，正确形态是
`/PID <我 Popen 的 pid>` 或直接 `proc.terminate()`。按名杀是错的工具，且**没有任何兜底**
会重新拉起用户实例——`run.cmd`/`cargo run` 是用户手动起的生命周期，agent 侧无从恢复。

**二次踩坑**：隔离脚本用 `RSI_PORT` 指定端口，但 host 只认 `WEB_ADDR`（`WebFrontend::from_env`），
于是新进程仍去 bind 默认 8710 → 撞上刚被杀掉的残留监听 → `os error 10048`，脚本等 90×0.5s
后放弃。两个错误叠加才表现为「杀掉 + 起不来」。

**修复与防复发**：

1. 活体脚本只用 `subprocess.Popen` + `proc.terminate()/kill()`，**只回收自己创建的那一个进程**；
   端口一律用 `WEB_ADDR`。
2. 纪律固化：**杀进程只按 PID，禁止按镜像名**——本机同名 exe 可能同时有用户实例与测试实例。
   已写入 `.rsi/profile.json` 观察项 `N-20261108-01`。
3. 活体验证一律用独立端口 + 独立工作区（`tempfile.mkdtemp`），不碰用户实例。

### 12.2 事故记录：设置页「记忆 / Agent」空白（H 轮，2026-11-08 13:00 定位）

用户报告「记忆和 agent 模块都是一样的，没什么其他内容，是不是什么东西没有正常显示」。
**不是数据问题、不是后端问题**——`GET /api/profile` 正常回画像，`app-settings.js` 的切换
逻辑也正确给 `#tab-memory` 设了 `hidden=false`。真因是 **DOM 结构错**：

`#tab-skills` 少一个收尾 `</div>`，导致 `#tab-memory` 与 `#tab-agent` 被**嵌进了默认
`hidden` 的 `#tab-skills` 内部**。切换逻辑把子面板的 `hidden` 设成 `false` 了，但祖先的
`hidden` 依然生效 —— 两个页签点开永远是空白，JS 层查不出任何异常。

**根因链（三个缺陷同源，全部来自 F 轮 f92f5f4）**：

1. `f3-ov.json` 的 anchor 是 `  <div class="body">`，patch 写成了**两层**同名 div
   → 设置抽屉多一层嵌套（`class="body"` 出现 2 次）。
2. `f3-mem.json` 的 anchor 取到 `    <div id="tab-agent" hidden>` 这**一行**，patch 却以
   `</div>` 开头 → 边界错位，把 `#tab-skills` 的收尾 `</div>` 吞掉。
3. `d-index-head.json` 与 `fe2-header.json` 的 patch **各带一组** `spacer/conn/status`
   → 顶栏整组重复，`id="conn"`/`id="status"` 各出现 2 次（`$()` 只取第一个）。

**为什么五道验证全绿却没抓到**：pytest 只测脚本契约，cargo 只测 Rust，补丁层只验
「锚点命中」不验「产物是合法 DOM」，`node --check` 只验 JS 语法。静态页的结构错误
**没有任何一道检查在看**。F 轮 commit message 里甚至写了「① 锚点吞掉容器开始标签」，
识别到了却没修就提交了。

**修复**：

- `f3-ov2.txt`：把 `body` 由两层改为一层（拔掉源头）；
- `d-index-head.txt`：patch 去掉自带的 `spacer/conn/status` 三行（只插按钮）；
- 新增 `X3-SKILLS-CLOSE`：补上 `#tab-skills` 的收尾 `</div>`；
- 新增 `X1-BODY-DUP` / `X2-HEAD-DUP`：收敛已产生的重复（repair 型）。

**顺带补上补丁引擎的两个缺口**（`scripts/apply-tool-patches.py`）：

- `repair: true`：删除型修复（删多余的一层/一行）应用后锚点必然消失，原 `anchor/patch`
  判据既判不出「已应用」也判不出「可应用」，只能永久 FAIL。repair 型改用「锚点不存在
  = 已修好」。
- `applied_marker`：插入型修复（如补一个 `</div>`）的原锚点被替换后也消失，用一段
  **只在修复后出现**的文本表达终态。

**新建防线**：`tests/test_static_structure.py`（5 项）——重复 id / 标签平衡 /
五页签同级 / body 容器唯一 / 切换逻辑与 DOM 页签集合一致。并做了**反证**：
把测试指向修复前的备份，四项检查全部触发失败，证明它真能抓住这个 bug。

**纪律**：
1. 静态页改动的验证不能只有「补丁锚点命中」——必须有一条断言在验**产物结构**。
2. 补丁的 anchor 不许取「会被 patch 自己改动的那一行」；patch 不许以 `</div>` 这类
   边界符号开头（正是它吞掉了别人的收尾）。
3. 修复型补丁必须声明它属于 `repair` 还是 `applied_marker`，否则会永久 FAIL，
   而永久 FAIL 的补丁通常被当成「噪音」忽略 —— 这是缺陷能长期潜伏的机制。

### 12.3 验证记录

- pytest **197 passed**（基线 174）· cargo agent-loop 38/38 + host 35/35 · 补丁 100 条 0 FAIL · `node --check` ×2；
- **活体隔离 e2e 10/10**（独立工作区 + `WEB_ADDR=127.0.0.1:8933`）：UI 写灵感 / 改灵感 / 超长拒 400 /
  CLI 无写命令 / CLI 写 outcomes / GET 回两条线 / 并发 5 写不丢 / agent 可读灵感；
- 全程未触碰用户实例：验证前后 `127.0.0.1:8710` 均为 PID 43484 且 `/api/board` 回 200。

**H 轮（2026-11-08 13:00，静态页结构修复）**：

- pytest **202 passed**（G 轮基线 197，+5 `tests/test_static_structure.py`）；
- cargo 默认多线程 **38/38 + 35/35**；
- 补丁层 **0 FAIL / 0 DRY**（含新 X1/X2/X3；且**二次 dry-run 全部 OK**，证明幂等）；
- **从 HEAD 干净态重放全部补丁可重建正确终态**（不只验证「当前文件对」，还验证「能重现」）；
- **反证**：把结构测试指向修复前的 `index.html.patchbak`，四项检查全部触发失败
  （重复 id `conn`/`status` 各 2、`</aside>` 隐式关闭两个 div、五页签出现 2 种父链、
  body 容器 2 个）——证明测试真能抓此 bug，不是摆设；
- **活体验证 ALL PASS**：直连用户真实实例 `127.0.0.1:8710` 取页面，重复 id 无、
  隐式关闭 0、残留未闭合 0、五页签 1 种父链、body 容器 1 个、`mem-body` 与
  `agent-max-rounds` 均在位。

## 13. 纪律复盘：project-dev 与「补丁 → 内化 → 拆分」秩序（2026-11-08）

这一节不是为了记又一次改动，而是回答一个反复出现的疑问：**这批工作到底算不算按
`project-dev` 走的项目级迭代？** 结论是「算，但偏离了一处，且补丁被误当成了纪律豁免」。

### 13.1 三种模式对位

`project-dev` 有三种模式：正向（从零做）、逆向（读源码还原）、**优化（存量迭代）**。
本仓库历轮（N/O/Q/B…H）都属于第三种。对位结果：

| project-dev 的硬性要求 | 本仓库实际 | 判定 |
|---|---|---|
| 方案落模块内 `PLAN.md`，含迭代轨迹 | 本文件 + 各轮小节，持续追加 | ✅ 遵守 |
| 跨模块节奏：规则层 → 时间层 → 工程面 | 基本是这个顺序 | ✅ 遵守（靠经验，未显式写） |
| 测试不绿不宣称完成，P/Q/I 判据 | pytest 258 + cargo + 补丁 dry-run 每轮跑 | ✅ 遵守 |
| 体量治理看域混杂，不看行数 | 从未做过拆分 | ❌ **未触发/未执行** |
| 验收由 checkable 证据给出，非自述 | G/H 轮已有反证验证（把测试指向坏文件必须变红） | ✅ 遵守 |

**唯一实质偏离 = 体量治理**。原因不是判断错，而是「补丁是唯一写入途径」被误读成了
「补丁也豁免治理」。

### 13.2 补丁的真实地位：**写入手段**，不是**纪律层**

`runtime/` 对 agent 是禁写区（`files.py::_CORE_BLOCKLIST` 首项即 `runtime`），
所以改动走 `scripts/patches/*.json` + `apply-tool-patches.py`。这只是把 `write_file`
换成「可预演、可回滚、可审计的补丁」，**没有降低任何一条验收要求**。

需要澄清的一层：补丁改的 `host` / `agent-loop` 是**本仓库自己的应用层代码**，
不是某个远端上游的副本（`runtime/kernel` 只有 `bindings`/`schema`/`LICENSE`，无 Rust 源码）。
所以「补丁内化到上游」要分两层：

1. **内化到本仓库源码**——补丁成熟后并入 `host`/`agent-loop`，补丁 json 退役。日常操作。
2. **内化到 kernel 契约**——在本仓库验证成熟的模式（如「波次并发」）沉淀为通用能力。罕见但重要。

下游积累推动上游改进，指的是第 2 层；而它要求「先有干净的自己」。

### 13.3 补丁密度才是拆分的信号（不看行数）

实测（2026-11-08，125 条外挂补丁）：

| 文件 | 补丁数 | 行数 | 每 N 行一个补丁 |
|---|---|---|---|
| `web-dist/vendor/app-board.js` | 17 | 1038 | 61 |
| `host/src/web/api/board.rs` | 16 | 1014 | 63 |
| `web-dist/index.html` | **15** | **276** | **18** ← 信号最强 |
| `agent-loop/src/skills.rs` | 9 | 486 | 54 |
| `web-dist/style.css` | 8 | 868 | 108 |
| `web-dist/vendor/app-settings.js` | 8 | 1083 | 135 |
| `host/src/web/api/mod.rs` | 6 | **131** | **22** ← 信号强 |

`index.html` 只有 276 行却挂 15 个补丁、`api/mod.rs` 131 行挂 6 个——**行数少而补丁密，
说明职责混杂而非文件过大**。这正是 `project-dev` 说的「域混杂」，而它正是漏做的那一项。

### 13.4 正确秩序（本轮踩坑得出）

顺序错了会连锁爆炸，本轮实际验证过：

```
① 冻结基线     apply-tool-patches.py --dry-run 全绿留档（本轮：125/125 OK，0 漂移，rc=0）
② 内化优先     成熟补丁并入源码，补丁 json 退役（锚点问题随补丁消失而消失）
③ 再拆分       在干净代码上按域拆（board.rs 的 post_board 363 行横跨 5 类 op）
④ 重建基线     新文件的补丁从零开始积累
```

**必须先内化后拆分**，否则拆分会让所有既有补丁锚点同时失效。

### 13.5 本轮真实事故：补丁排序与幂等判据（可复用教训）

排查「设置面板全废」时发现的真因不是 CSS/接口，而是 `app-settings.js`
**整段 F3 能力总览被插入两遍** → `node --check` 直接报
`Identifier 'ovSet' has already been declared`，整个文件的脚本不执行。

三层原因，每层都值得记：

1. **补丁体本身带重复**：`F3-CAP-JS` 的 patch 文本里就含两行相同的
   `$("mem-refresh").onclick = () => loadMemory();` —— 重复是补丁当初就打进去的。
2. **幂等判据失效**：`I07-UI-JS-TAIL` 的锚点是单行 `mem-reveal`，而终态文件里该行
   出现两处（分发块尾 + 能力总览块尾），应用后锚点仍命中 → **二次追加整块**。
   已改用 `applied_marker`（分发块标题，终态独有且只出现一次）。
3. **补丁按文件名排序**：`e*` 排在 `f*` 前面，导致「先删后加」→ 无限循环。
   修复型补丁若与追加型补丁作用于同一区域，**前缀必须排在追加型之后**（本轮改为 `z*`）。

另有一条工程纪律被这次事故重新验证：**`--revert` 是文件级回滚**，会把同文件上
其他已应用的补丁一并撤销。本轮 `--revert` 连带撤了 `style.css`、`publish.rs` 的补丁
并删掉 `profile.rs`，必须再跑一次完整 `apply` 才能恢复。**回滚前先 `--dry-run` 看影响面**。

新增的三条修复补丁（均为 `repair` 型，锚点不存在 = 已修好）：

- `Z1-APPSETTINGS-DUP`：删除末尾重复的整段 F3 块（锚点=重复块全文）
- `Z2-APPSETTINGS-DUP-BIND`：删除重复的 `mem-refresh` 双行绑定
- `Z3-APPSETTINGS-DUP-BIND2`：删除 F3 块尾与文件本体重复的 `mem-refresh`/`mem-reveal` 绑定

**为什么最终用 `repair` 而不是 `applied_marker`（这一条是重放验证逼出来的）**：
最初三条都用 `applied_marker = "── 内容分发面板"` 判终态，`--dry-run` 看着全绿、
`pytest` 也全绿。但做**从基线重放**验证时暴露了真相——把文件覆盖回首次应用前的
`.patchbak`（= 带重复块的坏态）再跑整链，结果仍是 1083 行坏文件：因为那个 marker
在**坏态里同样存在**，三条补丁被判「已应用」而全部跳过，一个都没修。

教训（比事故本身重要）：**「当前文件是对的」不等于「补丁链能重建它」**。
幂等判据必须能在「坏态 / 终态」之间做出区分；`applied_marker` 只适合挑选
「坏态绝不出现」的特征串，而删除型修复往往只能用 `repair`（锚点消失即修好）。

### 13.6 验证记录（2026-11-08 本轮）

- pytest **258 passed**（H 轮基线 202）；
- 补丁链 **0 FAIL / 0 DRY**，`rc=0`，二次 dry-run 全 OK（幂等）；
- `node --check` ×7 **全部通过**（修复前 `app-settings.js` 语法错）；
- 终态自检：`app-settings.js` 1022 行，`F3` ×1 / `ovSet` ×1 / `pubState` ×1 / `mem-refresh` 绑定 ×1；
- 看板 `T-20261108-14` 两项并发回归用例 **pass**（`concurrent_top_level_chats_both_can_delegate`、
  `batched_tool_calls_run_concurrently`）。

### 13.7 并行能力的事实更正（重要）

此前判断「缺并行判据」是**错的**。事实：

- 判据早已在提示词里：`agent-loop/src/board_ctx.rs:460 parallel_hint()`，并明确
  「不同文件/不同验证/无依赖 → 并行；同文件/同 target/有依赖 → 串行」；
- 内核早就是并发：`agent-loop` 自身 `Semantics::Concurrent`、`max_inflight=8`
  （`AGENT_MAX_INFLIGHT` 可配 2..128）、工具按 `chunks(wave)` + `join_all`；
- 同会话 K409 闸**按 `session_id` 隔离**（`chat.rs` 的 `session_chats: HashMap<sid, Mutex>`），
  跨会话并发没有内核级阻塞；
- `memory`/`assets` 的 `concurrent:false` **不是**跨会话瓶颈：`memory` 无内部锁、全 `*Sync`，
  且插件级串行只影响它自己的调用，不串行 `agent-loop`。

**真正的缺口在前端**：`q-session.js` 的 `runState`/`sessionCache` 虽是 per-session 表，
但页面只有一条 feed、一个当前 sid —— 后端能并行，UI 装不下第二个会话。
所以后续方向是「多会话槽位」，而不是「加并行判据」。

### 13.8 K 轮：锚点唯一性是补丁幂等的前提（本轮最重要的一条）

上一轮的 `repair` 型补丁解决了「删除型修复」的判据问题，但没有解决更根本的一层。
本轮排查 I-14（用户问「新开窗口左侧看板没变化」）时顺带发现：`style.css` 的看板样式
**整块出现了两遍**，`app-settings.js` 的 `showInstBadge(...)` **也出现了两遍**。
两者都不会报错——重复 CSS 是合法的（后一条覆盖前一条），重复赋值也是合法的
（`node --check` 全绿）。这类损伤只能靠结构契约发现。

**真根因：锚点不唯一 + `replace(anchor, patch, 1)` 只替换第一处。**

以 `C-STYLE` 为例：

```
锚点:  .ist { font-size: 10px; color: var(--faint); }   ← 产物里出现 3 次
patch: 同一行 + 一大段 C 轮样式
```

- 第一次应用：替换第一处，插进整段样式，另两处 `.ist` 还在；
- 第二次重放：`patch in src` 仍成立吗？——它被判「已应用」跳过，但**文件里仍有 2 个
  旧锚点**。一旦某次判定走偏（或锚点被别处改动），就会再替换一次 → 再插一份。
- 更糟的是连环：`D17-STYLE-WIN` 的锚点恰好是 `C-STYLE` 复制出来的那个 `.ist`，
  于是它把整块 D 样式复制了一份，**并把 C 块内容一起吞进副本**。

结果：`style.css` 从 676 行的正确内容膨胀到 868 行（看板块 ×2、`.ist` ×3、
C 轮规则散落在 D 块副本里）。

**纪律（写进 PATCHING 规范）：**

1. **锚点必须在整份目标文件里唯一。** 写补丁前先数一次：`grep -c "<锚点>" 目标文件`，
   结果必须 ≤1。行级锚点（`.foo { … }`）几乎总是重复的，要用「前后两行 + 特征」构成。
2. **patch 文本里不得重复锚点行。** 那等于"每应用一次多插一份"。本轮三条源头都有这毛病
   （`c-style-patch.txt`、`f3-cfgcache2.txt`、`f3-ovcss2.txt`），已各删一行。
3. **修复型补丁必须排在追加型之后**，否则修完又被加回来。工具层已支持 `order` 字段
   （缺省 0，小的先跑）；但正解是**修掉追加型源头**，让修复型无事可做。
4. **收敛型用 `converge: true`**：目的是「让重复块消失」，锚点不存在 = 已收敛，
   不该报 FAIL。它与 `repair` 的区别是仍带 patch 文本（留作文档）。
5. **换行必须归一化**：Windows 产物是 CRLF，而 `blocks/*.txt` 由 write_file 写出是 LF。
   不归一化时 `anchor in src` 恒为假 → 锚点未命中，或更坏：长句改短型被判已应用而静默跳过。
   工具层 `_read`/`_write` 已统一到 LF 口径。

**自动契约（不再靠肉眼）**：新增 `tests/test_patch_idempotency.py`，三条：

| 测试 | 防的是 |
|---|---|
| `test_patch_text_does_not_repeat_anchor` | 源头：patch 文本把锚点块写两遍 |
| `test_target_has_no_duplicate_patch_block` | 产物：锚点块出现次数 > patch 提供次数 |
| `test_no_duplicate_selector_rule` | CSS：完全重复的选择器规则（后一条覆盖前一条） |

白名单只有一条且必须给理由（`chat.rs` 的取消检查在轮次边界与波次循环内各一次，
语义不同、删任一都漏取消）——例外表不是掩盖问题的抽屉。

**本轮修复数据**：`style.css` 868 → 785 行（去重 3 块共 192 行）；
`app-settings.js` 1022 → 1020 行；补丁 dry-run **0 FAIL / rc=0**；
pytest **261 passed**（258 + 新增 3）；`node --check` ×7 全绿。

**一句话结论**：补丁工具只保证「锚点命中」，而**锚点命中 ≠ 补丁正确**。
唯一性、顺序、换行这三件事都不在工具的类型系统里，只能靠纪律 + 契约测试兜住。
