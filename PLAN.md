# rsi-agent 单一真相源 + 一键安装 / 更新（计划）

> project-dev **优化模式**（存量项目按方案迭代）。模式依据：不新建项目，只改既有模块。
> 涉及模块：`scripts/`、`run.cmd`、`runtime/`（核心区，一律经 `scripts/patches/*.json`）。

## 0. 目标

用户只做「双击一个文件」。

1. rsi-agent 是 runtime 的**唯一真相源**：在哪里改就在哪里生效，版本号只认 rsi-agent。
2. 可分发：一个 zip = 宿主 exe + 插件 + 内核绑定 + 技能 + 界面 + 脚本，解压即用。
3. 有更新**自动提醒** + **一键更新**：下载包 → 校验 → 交接换血；失败则旧进程继续服务。

## 1. 约束（不可绕过）

- `runtime/` 核心写保护区：只经 `scripts/patches/*.json` + `apply-tool-patches.py`。
- `config.json`、`plugins/memory`、`.git/` 不触碰。
- 沙箱内不跑 cargo、不做 git commit/push；cargo 由用户双击 `run.cmd` 触发。
- 兄弟仓 `../react-agent`、`../agent-kernel` 在工作区外：只读不写，改动留待回灌。

版本线：`runtime/Cargo.toml` 的 `workspace.package.version`（现为 0.1.29）。发布序号 = rsi-agent 的 git tag；宿主包版本独立顺延。

## 2. 设计思路（时空闭环三问）

- **空间**：新增状态仅两处——`.rsi/update-staging/`（下载包暂存）与 P2 的 `_JOBS` 表（插件进程内存，随进程销毁）。交接 marker 沿用既有 `%TEMP%/rsi-handover-ready-<port>.flag`。
- **时间**：更新 = 后台下载 → sha256 校验 → 触发交接 → 旧进程排水退出。任一步失败即中止，不进入交接。
- **规则**：解包路径必须落在安装根内（防穿越）；sha256 不符即中止；无显式开关不自动同步上游。

## 3. 大范围改动合理性说明（>50 行）

总新增约 350 行，分四块，每块对应一个用户目标，缺一块目标即不成立：

- 同步阀倒转（~10 行）：不倒转，则每次重启都会被上游覆盖，「在哪改就在哪生效」是空话。
- E22 补丁（4 处锚点）：guest stdout 是孤儿管道，非法 JSON 诊断一打印即整轮失败。
- 打包 + 免编译启动（~170 行）：当前无分发形态且依赖 Rust 工具链，无法一键安装。
- 更新检查 + 一键更新（~200 行）：现有自更新是「本机 cargo 构建」，无工具链用户不可用。

## 4. 步骤与验收（P / Q / I）

### 步 1a 倒转同步阀

- 改 `scripts/sync_runtime.py`：默认只报告差异不写入；`--force` 或环境变量 `RSI_SYNC_UPSTREAM=1` 才同步。
- 改 `run.cmd:59` 调用（保留「同步失败永不阻断启动」）。
- Q：不带参数跑 → 只打印、`.sync-stamp` 不变；带 `--force` → 行为同旧版。

### 步 1b E22 落 runtime

- 从 react-agent 工作树读改后文本，脚本生成 `scripts/patches/e22-*.json` + `blocks/e22-*.txt`。
- Q：`apply-tool-patches.py --dry-run` 锚点全中；apply 后 `.scratch/e22_smoke.py` 断言全过。
- I：`.patchbak` 存在，可 `--revert`。

### 步 1c 打包 + 免编译启动

- 新增 `scripts/release-bundle.py`：打包 exe、`runtime/plugins`（去 memory 数据）、`runtime/kernel`、skills（去缓存）、`web-dist`、scripts、desktop；附版本号与 sha256。
- `run.cmd` 加分支：无 cargo 且 exe 存在 → 跳过编译直接跑。
- Q：脚本产出 zip 与 `.sha256`；免编译分支在 `where cargo` 失败时不报错退出。

### 步 2 更新提醒 + 一键更新

- 检查逻辑放 rsi-agent 独有层（`scripts/update_check.py`），核心区只加最小补丁：`POST /api/self/update` 增加「包已就绪」分支——`.rsi/update-staging/ready.json` 存在时，跳过 cargo 构建，直接从包里换 exe 与文件后走既有交接。
- 前端横幅：`web-dist/index.html` 经补丁挂一段脚本，调 `/api/self/update` 比对版本后显示。
- Q： staging 无包 → 行为同旧版；有包且校验通过 → 新进程起来、旧进程退出。
- I：校验失败/包损坏 → 日志写明原因，旧进程继续服务。

### P2 后台任务原语

- 新建 `runtime/plugins/tools/tools/jobs.py`（`_JOBS` + `job_start` / `job_status` / `job_stop`），经 create 补丁。
- `tools_plugin.py` 3 行接入：import、并入 `_ALL`（缺省即启用）。
- watcher 在 agent-loop `chat.rs` 出口之后 spawn，经 `call_capability_as` 轮询，完成后入 followup 队列。
- Q：`job_start` 立即返回 job id；长命令结束后 followup 消息出现。

## 5. 已评估不做

- **「>5s 自动转后台」**：判定阈值武断、会改变所有工具调用的可预期性；由模型显式调 `job_start` 更可控。
- **kernel `host.rs` 孤儿管道根治**：属第三个仓，本次只在插件侧规避（E22）。
- **queue/interrupt 联动**：父会话取消不联动 `job_stop`，后台任务语义上应独立存活。

## 6. 回退点

每步独立可回退：1a 还原两文件；1b/步 2/P2 用 `apply-tool-patches.py --revert`；1c 删除新脚本与 `run.cmd` 分支。

## 7. 迭代记录

（每步完成后在此追加：改了什么、如何验证、保留/回退。）

### 2026-11-27 步 1a / 1b / 1c / 2a–2d（T-20261127-10）

| 步 | 改动 | 验证 | 状态 |
|---|---|---|---|
| 1a | `scripts/sync_runtime.py` 默认 report-only（`--force` / `RSI_SYNC_UPSTREAM=1` 才写）；`run.cmd` 同步失败不阻断 | 不带参跑 → 只打印、stamp 不变 | 保留 |
| 1b | E22 补丁 6 个 `scripts/patches/e22-*.json`（`base.py` / `openai_compat.py` 插件侧，非法 JSON 诊断不再打断 guest stdout） | dry-run 锚点全中；`.scratch/e22_smoke.py` 断言过 | 保留 |
| 1c | `scripts/release-bundle.py`（`git ls-files` 取 tracked 文件 + release exe，排除 config/memory data/target*/node_modules/outputs/`scripts/patches/`，zip 内写根 manifest + `web-dist/vendor/manifest.json`）；`run.cmd` 无 cargo 分支（exe 在 → 直接跑；exe 缺 → 打印 Releases 地址 exit 1） | 真跑 584 文件 7.8MB，sha256 一致；干跑两路径 rc 0 / rc 1 | 保留 |
| 2a | `misc.rs` 三处补丁 `upd-zip-{skipbuild,skipbuild-end,finalize}.json`：`zip_ready` 块跑 `update_check.py ensure` → staging exe 拷到 `target-selfupdate/release/`；`if !zip_ready {}` 包裹原 cargo 段；`zip_ready` 时派发 `finalize --wait <pid>` 等旧进程退出后落位 | rustfmt 无 parse error、括号平衡；**未经 cargo 编译**（沙箱挂起）——`release.cmd` 首次跑会重编，报错则回头修 `.scratch/upd_gen.py` | 保留，待编译验证 |
| 2b | `scripts/update_check.py`：`current` / `check` / `ensure` / `download` / `finalize --wait` | `check` 实测 rc 10（已最新）；download 隔离目录实测 OK；finalize 三路径（等退出 / 已不存在 / 超时）实测 | 保留 |
| 2c | 前端横幅 `upd-banner-{index,js}.json`：`vendor/app-update.js`（IIFE，读 `/vendor/manifest.json` → GitHub latest → 有 zip 资产且版本更新才显示）+ `index.html` 挂载 | `node --check` 过；在线 host 已服务 `app-update.js`（HTTP 200）；开发树 manifest 500 → 静默 | 保留 |
| 2d | `scripts/release.py` + 根目录 `release.cmd`：显式 pathspec 提交 → tag → exe 过期则 `cargo build --release` → 打包 → push → `gh release create` | 语法过；`exe_stale()` 判 True；坏版本号被拒 | 待用户双击 |

设计说明（相对 §4 步 2 原文）：原计划「从包里换 exe **与文件**」——实际 `download` 阶段已把非 exe 文件（插件 py / web-dist / skills / scripts）直接写回安装根（exe 被运行中进程锁住，只能去 staging，由交接后的 `finalize` 落位）。即文件更新在 `ensure` 阶段完成，exe 在交接后完成。限制：`scripts/patches/` 不在 zip 内，zip 用户的 runtime 永远是「已打补丁」形态，不能跑 `apply-tool-patches.py`。

回退：1a 还原两文件；1b/2a/2c `git checkout -- <file>` + 删 `vendor/app-update.js`（**不用 `--revert`**，全量会动其他补丁）；1c/2b/2d 删新脚本与 `run.cmd` 分支。

### 2026-11-27 步 2e：sandbox-run.exe 随包分发（T-20261127-10）

问题：`assemble.rs:313-324` 里 bash 沙箱助手路径 = `current_exe().parent().join("sandbox-run.exe")`，`config.rs:41-48` 找不到即 `BashSandbox::Denied`（fail-closed）→ `bash` 从 TOOLS_ENABLED 移除 → **zip 用户装完没有终端**。原打包与更新链只搬 host exe，助手必然缺。

| 改动 | 内容 | 验证 |
|---|---|---|
| `scripts/release-bundle.py` | 新增 `SANDBOX_EXE` 常量；打包前存在性检查（缺即报错，提示与 host 同包构建）；zip 内写 `runtime/target/release/sandbox-run.exe`；manifest `files` 计数 +2 | 打包实测 |
| `scripts/update_check.py` | 新增 `SANDBOX_EXE`；`download` 把助手与 host 一起落 `staging/runtime/target/release/`（不写安装根——新进程 `current_exe()` 就在 staging）；`finalize` 拷 host + 助手到安装根，**staging 两个 exe 都保留** | `.scratch/uc_sandbox_test.py` 端到端：`file:///` 造 zip → download → finalize，打印 `ALL OK` |
| `scripts/patches/upd-sandbox.json` | `misc.rs` `zip_ready` 块（`dst` 在 `:672`）原只拷 host 到 `target-selfupdate/release/` → 补 `sandbox_src` 拷贝 | 已 apply、幂等跳过、`rustfmt --check` 零输出 |

边界说明（回答「环境是否全部编译进去」）：**只免 Rust 工具链，不免解释器**。host exe 是纯 Rust 单体，但插件层 / kernel 绑定 / 技能全是 Python/TS **源码**，运行时靠外部解释器——`spawn.rs:13-30` 在 PATH 找 `python`/`node`，`spawn.rs:50-76` 以 `python script.py`（`PYTHONPATH=<kernel>/bindings/python`）和 `node --experimental-strip-types script.ts` 拉起。`assemble.rs:80-82` 默认 `memory` 插件是 `PluginRuntime::NodeTs`，故 **node 是硬依赖**；缺 node/python `assemble.rs:158-167` 直接 `bail!`。插件额外依赖仅 `grpcio`、`httpx`（`run.cmd` 自动 pip 装）。把 Python/Node 打进 zip 会让 8MB 变 ~150MB，且需处理 gRPC 原生扩展、PATH 隔离与杀软误报，本轮不做。

回退：`git checkout -- scripts/release-bundle.py scripts/update_check.py runtime/crates/host/src/web/api/misc.rs`（**不用 `apply-tool-patches.py --revert`**，那是全量回滚）。

### 2026-11-27 步 2f：真机解压实测暴露的四个 bug（T-20261127-10）

把 zip 解压到无 Rust 的目录、按用户路径真跑，才暴露下面四个——前三个都会让「双击即失败」，本机开发树里全都看不见。

| # | 文件 | bug | 为什么本机看不见 | 修法 |
|---|---|---|---|---|
| 1 | `scripts/release-bundle.py` | `z.writestr(...)`（写 `web-dist/vendor/manifest.json`）落在 `with ZipFile(...)` **块外** → `ValueError: Attempt to write to ZIP archive that was already closed` | 该段是本轮新加，从未在修好前跑完整打包 | 移进 `with` 块内 |
| 2 | `scripts/release-bundle.py` | 前端仍按源码路径 `runtime/crates/host/web-dist/` 打包，而 `web/mod.rs:126-165` 只在 `current_exe().parent()/web-dist` 找（另一候选是编译期 `CARGO_MANIFEST_DIR` 绝对路径）→ **zip 用户整页 500** | 开发树命中的是编译期烧进 exe 的构建机路径，返回 200 是假象 | 新增 `WEB_DIST_SRC/DST` + `web_files()`：重定位到 `runtime/target/release/web-dist/`，`INCLUDE` 移除旧路径 |
| 3 | `run.cmd:68-86` | zip 内没有 `runtime/Cargo.toml`，但用户机器**有** cargo → `NO_CARGO` 不成立 → 走 `cargo build`，报 `could not find Cargo.toml` 必失败 | 开发机有 Cargo.toml，永远进不到这条分支 | `NO_CARGO` 判据改为「cargo 缺失 **或** `runtime/Cargo.toml` 缺失」 |
| 4 | `scripts/release-bundle.py` | `release.cmd` 不在 zip 内（`INCLUDE` 只列了 `run.cmd`）→ 用户拿到包也没有发布入口 | 本机一直在仓库根直接跑它 | 加入 `INCLUDE` |

顺带修掉的三个：`scripts/update_check.py:203` 的 `NameError`（改名遗留，`str(dst)` → `dst_dir / EXE`，端到端测试抓到）；`update_check.py` 新增 `runtime/target/release/` 下**非 exe 文件**（web-dist）同时写安装根与 staging 的分支，且 `finalize` 改为保留整个 staged exe 目录（否则交接后的新进程读不到自己旁边的 `web-dist/`）；`scripts/release.py` 因 host 运行时会锁住自身镜像，改为**自动降级构建到 `runtime/target/alt`** 并从那里打包（原来 `SystemExit` 拦住，而用户双击时 host 通常正在跑）。

验证（全部在 `.scratch` 隔离目录，无 Rust 工具链的模拟环境）：
- 解压新 zip → `run.cmd`：日志 `[sync] sibling react-agent not found; skip` → **没有** cargo 行 → `bash 沙箱就绪` → `web 网关就绪: http://127.0.0.1:8798`。
- `GET /`、`/style.css`、`/vendor/manifest.json`、`/vendor/app-update.js` 全 200（`bad=0 of 14`，含 9 个 `/vendor/app-*.js` 与 monaco）。
- `POST /api/chat` 带 `session_id` + `run: echo ...` → `steps:[{tool:"bash"}]`、`answer:"SANDBOX_OK"`，证明 zip 布局下 bash 沙箱真的可用。
- `python .scratch/uc_sandbox_test.py` → `ALL OK`（新增 web-dist 落两处的断言）。
- `python scripts/release.py --version 0.1.27 --no-commit --dry-run` → 识别运行中 host PID → 建到 `runtime/target/alt`（27.5s）→ 打包 533 文件 7.9MB。

回退：`git checkout -- scripts/release-bundle.py scripts/release.py scripts/update_check.py run.cmd`。

### 2026-11-27 步 3：环境内置 + 一键安装包（T-20261127-11）

用户目标从「免 Rust」升格为「免一切」：双击一个 exe 装好，机器上不需要 Python / Node / cargo。做法是把便携 CPython 3.11 + Node 22 打进安装包，`run.cmd` 只把它们前置到**本进程** PATH（不写系统 PATH / 注册表）。

| 件 | 内容 | 验证 |
|---|---|---|
| `scripts/fetch-runtime.py` | 拉 python-build-standalone 与 node-win-x64 到 `runtime-env/{python,node}`；`_pip_ready()` 跳过重复 pip；写 `runtime-env/runtime.json` 指纹（python/node 版本 + 文件 sha256 表） | 135.7MB 落地；重复跑 no-op |
| `scripts/runtime-sitecustomize.py` | 内置 `sitecustomize.py`，把 `runtime/kernel/bindings/python` 塞进 `sys.path`，免 `PYTHONPATH` | 装后 `import agent_kernel_sdk` 成功 |
| `scripts/build-installer.py` | 从 `release-bundle.py` 的 `app_entries()`/`env_entries()` 取**同一份**文件表生成 per-user NSIS 脚本（`$LOCALAPPDATA\Programs\rsi-agent`、`RequestExecutionLevel user`、LZMA solid、`OutFile` 用绝对路径）；makensis 缓存在 `runtime-env/.tools/` 不入库 | 41.8MB / 2111 文件 / 153.9MB payload / 0 warning |
| `run.cmd` | 内置运行时探测：`runtime-env\python\python.exe`、`runtime-env\node\node.exe` 存在即前置 PATH，不再找系统解释器；启动最初先调 `apply-env-update.ps1` 应用暂存运行时 | 装后启动冒烟通过（PATH 只留 System32） |
| `scripts/apply-env-update.ps1` | 启动前解包 `.rsi/update-staging/runtime-env.zip`（此时无 python/node 在跑）；按 `env.json.sha256` 校验，单文件被锁只记失败不全盘崩，失败保留 zip 下次再试 | `.scratch/test_apply_env.py` → `ALL OK` |
| `scripts/update_check.py` | 新增 `stage_env()`：指纹变了才下 `runtime-env.zip` 到 staging（**故意不解包**——python.exe/node.exe 是运行中镜像）；`finalize` 清理循环保留 `runtime-env.zip` + `env.json` | `.scratch/test_stage_env.py` → `ALL OK` |
| `scripts/build-installer.py` | 补 `_manifest_entries()`：装出来的树必须有根 `manifest.json`（`update_check.py current_version()` 读它，安装树无 `.git`）与 `web-dist/vendor/manifest.json`（前端横幅读它）。**两个源文件都必须叫 `manifest.json`**——NSIS `File` 按源文件名落盘 | 装后 `update_check.py current` = `0.1.27`；`vendor/manifest.json` 存在且 `{"version":"0.1.27"}` |
| `scripts/release.py` | 新增 `--with-env`（连带上传 `runtime-env.zip` + `.sha256` + `runtime-env.json`）与 `--with-installer`（构建并上传 `setup.exe` + `.sha256`）；git add 清单补齐新脚本 | `py_compile` + 干跑 |

三件产物分工（写进 README §更新是怎么发的）：**setup.exe**（~42MB，只给新用户）+ **app zip**（~8MB，每次更新都下）+ **runtime-env.zip**（~53MB，仅运行时指纹变化时下）。

验证：`.scratch/inst3` 静默安装 2112 文件、PATH 只留 System32 启动到 `web 网关就绪`；`llm-adapter 探测失败（软依赖，继续）: 探测超时（>8s）` 是既有已知非 bug（`assemble.rs:104-111`，`soft:true` 只 warn）。

回退：删 `scripts/{fetch-runtime,build-installer,runtime-sitecustomize,apply-env-update}.*`、`runtime-env/`，`git checkout -- run.cmd scripts/update_check.py scripts/release.py`。

