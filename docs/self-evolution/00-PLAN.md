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


