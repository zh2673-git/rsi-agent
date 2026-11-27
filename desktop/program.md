# 探索

# rsi-agent 桌面薄壳（Tauri v2）— program.md

> 模式判定：正向（给存量系统新增一个前端壳，不改业务核心）。
> 依据：host 已同时提供静态 Web UI + `/api`（127.0.0.1:8710）；`Frontend` trait 是入口组件、host 是组合根；现有 UI 原样复用，只把"浏览器标签"换成"系统 WebView 窗口"。
> 前置已核实：WebView2 157 / Edge / Chrome 在机、crates.io 与 npm 可达、`desktop/` 可写、`runtime/` 写保护（host 侧改动走补丁链）。

## 1. 目标（一句话）

双击一个桌面图标 → 开一个原生窗口加载现有 Web UI（http://127.0.0.1:8710），host 由壳按需启动、只回收自己启动的实例；不引入第二套 UI，不改 host 业务代码。

## 2. 本质定义（时空契约三问）

- **空间归属**：壳是"入口组件"，拥有并管理一个 `host` 子进程句柄（PID）；`127.0.0.1:8710` 是共享服务地址，可被外部 host 占用。WebView 拥有窗口空间，不碰业务数据。
- **时间流形态**：顺序启动管道——`探测 8710 → 若无人服务则拉起 release host → 轮询 ready → WebView 加载 → 窗口关闭时回收自己拉起的 host`。
- **规则拦截**：只停止"自己启动且进程名匹配"的 PID（沿用 run.cmd 的 `magpie_pid.py` 规则），外部实例只复用不杀；编译期由 Rust 类型约束配置结构，运行期由 PID 名校验防止误杀。

## 3. P · Q · I（验收）

- **P 前置**：WebView2/Edge 在机、release host exe 存在或可由 run.cmd 逻辑构建、端口可用。❌ → 阻断。
- **Q 后置**：
  - Q1 `cargo build --manifest-path desktop/Cargo.toml` 成功；
  - Q2 壳启动后窗口加载 `http://127.0.0.1:8710/` 且 ready 探测通过（复用 `wait-host-ready.ps1` 的判据，成功码 200）；
  - Q3 关闭窗口只回收本壳拉起的 PID；外部 8710 服务存活时壳不拉起也不杀任何进程。
- **I 不变量**：既有 444 项 pytest 不回归；`runtime/` 零改动（补丁链除外）；不 kill 当前会话宿主与外部 magpie；端口仅绑 127.0.0.1 不放宽。
- 全 ✅ → 保留并发布；任一 ❌ → 回退（撤销 `desktop/`）。

## 4. 四层设计

| 层 | 内容 |
|---|---|
| 数据规范 | `HostProc{ pid, owned }`、`AppConfig{ url:String, repo_root:PathBuf, auto_start:bool }`；PID 用 `u32` |
| 数据存储 | 配置来自 `desktop/tauri.conf.json` + 环境变量 `RSI_REPO_ROOT`（默认 exe 上两级）；不写业务数据 |
| 数据流转 | `setup` 阶段探测/拉起 host → 轮询 ready → `WebviewWindow` 加载 URL；`on_exit`/窗口关闭事件里 `stop_owned` |
| 数据接口 | Tauri command `host_status() -> {running,url}`、`host_start()`；对外只有窗口与托盘 |

## 5. 第 0 级目录映射

- `desktop/Cargo.toml`、`desktop/src/main.rs`、`desktop/src/host.rs`、`desktop/tauri.conf.json`、`desktop/icons/` — 全部在可写区，不动 `runtime/`。
- host 侧若需新增 command，走 `scripts/patches/*.json`；本方案最小实现**不改 host**，因此无新增在役补丁。

## 6. 时空闭环三问

- init/destroy 配对：`setup` 里可能 spawn host → `on_exit` 里 `kill_owned`（带进程名校验）；无 spawn 则 no-op。
- 主循环：Tauri 事件循环，可正常退出，无不可退出死循环。
- 跨层内存：壳只持 PID 与 URL，不访问内核业务内存。

## 7. 已知不做（已评估）

- 不做进程内嵌 host（要拆 `runtime/` 核心，写保护 + 高风险，留作路径 B）。
- 不做 Electron（重复背 Chromium，内存劣势）。
- ~~不打包 python/node 环境（发行体积与维护成本另立任务）。~~ **已做**：`scripts/fetch-runtime.py` 拉便携 CPython 3.11 + Node 22 到 `runtime-env/`（135.7MB），`scripts/build-installer.py` 出 per-user NSIS 单 exe（42MB，免管理员），`run.cmd` 只把它们前置到本进程 PATH。见 PLAN.md §7 步 3。

## 8. 补丁退役 / 回灌路径

- 本轮三个 `pf-retry-*-default-1.json` 原为**在役**补丁（agent-loop/host-web/example 的 retry 默认值 2→1），**现已退役**，移入 `scripts/patches/retired/*.retired`。
- 回灌产物：`scripts/patches/upstream/react-agent-retry-default-1.patch`（面向 react-agent 上游 `crates/` 路径）。
- 退役闸门（四条全真才退役，缺一不可）——**已全部满足**：
  1. ✅ patch 已在 `zh2673-git/react-agent` 上游 main 落地并 push：commit `948badd fix(llm): reduce agent-loop retry default to 1 (provider layer already retries)`（`d4fedb3..948badd`）。
  2. ✅ rsi-agent `runtime/` 快照已含该默认值：agent-loop / host-web / config.example 的 `retry_attempts` 均为 1（本仓库早前由补丁应用，值与上游一致；快照另带 RSI 专属适配，故未整树覆盖）。
  3. ✅ `python scripts/apply-tool-patches.py --dry-run` 对三份 pf-retry JSON 全部报「已应用过（幂等跳过）」，无 FAIL。
  4. ✅ 三份 JSON 已移入 `scripts/patches/retired/`，README 已登记上游 commit，本表即为退役记录。
- 当前状态：**四闸门全绿，补丁已退役**。新克隆从 `runtime/` 快照直接得到 retry=1，无需重放这三份补丁。上游 commit：`948badd`。
