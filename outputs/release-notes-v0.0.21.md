# rsi-agent v0.0.21

本版覆盖 `v0.0.20..v0.0.21` 区间的**全部 8 笔提交**，263 个文件，+19,298 / −385；
另有一笔**紧接 tag 之后**落在 `main` 上的收尾提交（`187a119`，8 文件 / +417 −10），
本文档把它一并写进来（否则「发行说明提到 `verify-login-buttons.py`、但 tag 里没这个文件」
会是个坑）。含该笔后合计 9 笔 / 270 文件 / +19,706 −386。

主题：**模型目录不再是手工维护的静态表**。本版把「模型从哪来、为什么少了几个、
路由组怎么管、哪些登录渠道真的可用」这四件事从「靠人记」变成「由 `/v1/models`
单一事实源推导」，并顺手把测试套件从 413 passed / 2 failed 推到 **428 passed / 0 failed**。

区间构成（8 笔，`git log --oneline v0.0.20..v0.0.21`）：

| 类别 | 提交 | 说明 |
|---|---|---|
| 发行说明勘误 | `0162db4` | 修正 v0.0.20 说明：覆盖完整 12 笔区间，去掉「无 Rust 侧改动」错误说法 |
| 运行时内核 | `bf007b4` | token 预算 / 压缩 / 工作集裁剪 / 并行提示 + 看板 schema 契约（79 文件） |
| 宿主与前端 | `469412f` | 模型目录自动同步 + 路由组管理 + 动态登录签到（P1/P2/P3）（77 文件） |
| make-video | `886b5e3` | P11/P12 四层分类与模板契约 + 动效语法修复（86 文件） |
| 文档 | `923fc6f` | 本轮实现报告与既有调研笔记归档（10 个 .md） |
| 调用点规格 | `a103bad` | `task-upsert --help` 印出字段规格 |
| 测试修复 | `9d2674e` | 修两条 HEAD 既有失败：判据选错 + 用例读真实时钟 |
| 发行说明归档 | `8a0d4cd` | 本文件（v0.0.21 发行说明） |

tag 之后补的一笔（也在本版口径内）：

| 类别 | 提交 | 说明 |
|---|---|---|
| 登录按钮三层契约 | `187a119` | 新增 `scripts/verify-login-buttons.py` + 9 条 pytest 契约 + `NW18B-TURNS-META` 补丁（8 文件） |

---

## 1. 模型目录自动同步（P1）

### 症状

用户在 Magpie 里加了一个 provider、拉回几十个模型，但 RSI 的模型下拉框还是旧的；
要手动去 `providers.json` 抄一遍，抄漏了就只能等下次「模型怎么不见了」的报错。

### 修法

`/v1/models` 定为**模型目录的唯一事实源**，前端 `loadConfig` 按已保存配置自动同步：

- 先备一项「（自定义…）」，用户手选的模型**不覆盖**（同步是补目录，不是重置选择）；
- 当前模型不在新目录里时**不静默改成第一个**——静默替换会让用户以为「我选的模型
  自己变了」，比报错更难查；
- 同步失败**可见且可重试**（`#llm-model-sync` 状态行），并发请求合并成一次；
- 保存后 `await loadConfig()`，不并发触发第二次 `fetchModels()`（两次竞态会让下拉
  框闪回旧列表）。

实测：网关 `:3425/v1/models` = **96**，`:8710/api/models` = **96**，分布
`trae-cn 30 / opencode-zen 24 / workbuddy 16 / kilo 13 / kiro 5 / auto 8`。

### Trae 侧补齐

`trae-cn` 从 24 个暴露到 **30 of 94**，新增 `minimax-m3.1-flash`、`minimax-m3.1-max`、
`minimax-m3`、`minimax-m3-max`、`minimax-m2.1`、`minimax-m2`。全程走 Magpie CLI，
不直接编辑 `providers.json`。

---

## 2. 路由组可管理（P2）

新增 `routegroups.rs`（3060 行）：CLI 解析、成员白名单、auto 规范 id 预检、失败清理，
外加 7 条路由与 fixture 单测。

前端面板位置在 `#sec-llm` 之后、生图组头之前，复用 `.poolhead.collapsible` + `.poolbody`。

实测 `magpie groups` = **8 组**（DeepSeek V4.1 Flash / DeepSeek V4 Pro / MiniMax-M2.1 /
GLM-5 / GLM-5.3 / GLM-5.3-Flash / GLM-5.2 / MiniMax-M3.1-Flash，即 8 个 `auto/*`）；
`GET /api/routegroups/options` = **88** 个可加入成员、routing 11、stays 5；模型下拉
**97** 项（96 + `__custom__`）。

两条踩过的坑记在这里，免得后人重踩：

- **`options` 路由必须排在泛化 `/<id>` 之前**，否则 `/routegroups/options` 会被当成
  组 id 匹配掉；
- **`api/mod.rs` 的 re-export 追加在 skills 之后**，不能按字母序插进 publish/skills
  之间——那会让 `I07-REEXPORT` 补丁的幂等判据永久 FAIL。

---

## 3. 动态登录 / 签到渠道（P3）

### 症状

账号区列出的登录按钮是写死的清单。插件没装时按钮还在，点了报错；插件装了但没
可用 method 时，按钮还在，点了什么也不发生。

### 修法

`misc.rs` 新增 `checkin_provider` / `plugin_providers` / `method_usable` /
`usable_method` / `upstream_providers`，重写 `upstream_login`：

- 登录渠道**按已安装插件动态显示**（解析 `plugin list --json`，不凭退出码判断）；
- 无可用 method → 按钮灰显，`title` 给出终端命令（点了不动的按钮比没有按钮更糟）；
- 不再用「有没有 `checkin` 键」判断签到能力——那个键存在与否和能不能签到不是一回事。

实测（本轮用 `scripts/verify-login-buttons.py --build` 现场 `cargo build` 到 `.scratch/target` 再拉起，随机空闲端口，
不占用用户正在用的 `:8710`）`GET /api/upstream/providers` = **9** 个渠道
（8 个 `usable=true` + `qwenwork-enterprise` `usable=false`）：

```
workbuddy-ai / workbuddy / trae-cn / trae-global / kiro / qoder / qoder-cn / qwenwork   → usable
qwenwork-enterprise                                                                     → 灰显（需终端）
```

浏览器端逐项比对过：`#upstream-login-btns` 里 9 个按钮的**数量、顺序、文案、`disabled`
状态**与 API 返回逐一相同；`qwenwork-enterprise` 的按钮带 `title` 指向终端命令。

这条判据是三层落地的，缺一层就拦不住「前端又写死」：

1. 纯函数映射（前端按 API 生成按钮）+ `tests/test_login_buttons_contract.py` 的 9 条
   静态契约（不需要浏览器）——其中 `test_mapping_has_teeth` 把 `usable` 语义取反后
   必须与正解不等，保证判据自己有牙；
2. 源码契约：`index.html` 不得出现写死的 `upstream-login-*` 按钮（正则用 `(?!btns\b)`
   排除容器本身），`app-settings.js` 必须含灰显分支与 `plugin login` 提示；
3. `scripts/verify-login-buttons.py`（真浏览器）——上面的实测就是它跑出来的。

> 一个容易误判的坑，如实记下：如果你机器上跑着的 `react-agent-host.exe` 是这次改动**之前**
> 编译的，`/api/upstream/providers` 会返回 **404**，看起来像「P3 没实现」。实际是旧二进制
> 里根本没有这条路由（`strings` 比对：旧 exe 无 `/api/upstream/providers` 字面量，新 exe 有）。
> 重启 Host 即可，不是代码问题。本机就有一例：用户实例 PID 32756（exe mtime `11-17 14:07`，
> sha256 前 16 位 `391988da657c9898`）属旧二进制，该路由 404；本轮重建的
> `.scratch/target/debug/react-agent-host.exe`（sha256 `d9315738f7034c94`）实测 9 渠道全 200。
> 也正因如此，`verify-login-buttons.py` 增加了 `--build`：先 `cargo build` 再用新 exe，
> 不让「拿旧二进制验新路由」制造假阴性。

---

## 4. auto/&lt;model&gt; 路由

`auto/<model>` 形式的模型可创建并路由，本版验证了 8 个 `auto/*` 全部可用。

一个例外如实记下：**`auto/beam-free` 不可恢复**——opencode-zen 侧已无该模型，
不是路由层的问题。

---

## 5. token 预算与上下文压缩（`bf007b4`）

- `cache_credit_weight()` + `UsageAcc::total()`，成本口径 `input + 0.32 × cache_read + output`；
  `CACHE_CREDIT_WEIGHT=0` 为应急开关；
- `ctx_budget_tokens`（代码缺省 **65536**，注意 `p0b2-cfg-init.json` 描述里写 131072
  属文案不一致，以代码为准）+ `workset_budget()` + 压缩 token 闸 + 轮末压缩；
  `CTX_BUDGET_TOKENS=0` 为应急开关；
- `trim_workset_by_tokens()` 按 token 裁工作集；
- `_strip_leading_cd`：工具参数里前导 `cd` 一律剥掉；
- 并行提示 + 三个 NOT_FOUND 纠偏提示。

### 关于 num_ctx

区间内曾把一条 `num_ctx` 用例失败归因为本轮回归，**已用 HEAD worktree 反证不成立**。
真机制是 `tighten_for_context` 返回 `CONTEXT_OVERFLOW` → 请求没发出 →
`captured.last()` 停在 q1。修法是给夹具加 `AGENT_SYSTEM_PROMPT` 并显式 `set_var`
（`p0e1-numctx-fixture.json`），不是「跑用例时加个环境变量」。

由此定下一条测试纪律，写进本版：**任何压低 token 预算的用例必须同时钉死所有影响
预算的输入**（尤其 `AGENT_SYSTEM_PROMPT`），不得隐式依赖仓库文件体积。

---

## 6. 看板 schema：规格必须与调用点同框（BS1–BS5）

`tests/test_board_schema_contract.py` 要求 task-upsert 的 schema 在**两处**同时在位：
提示词 brief 档与 CLI `--help`。

BS1 只做了 brief 那半；CLI 那半从未实现——`task-upsert --help` 只印 usage，字段名、
枚举取值、`acceptance` 的结构全靠猜。后果是 `status:"in_progress"`、
`acceptance:"一整段字符串"` 这类错误要到 upsert 时才被拒，**错误信息离调用点很远**。

本版补齐 `TASK_UPSERT_HELP`，枚举用 `"|".join(TASK_STATUSES / ...)` **格式化**进来，
不手抄字面量（手抄的枚举迟早与常量表漂移，而撒谎的 `--help` 比没有 `--help` 更难查）。
配 `RawDescriptionHelpFormatter`，否则 argparse 会把预格式化的多行说明重新折行。

「常见拒因」三条直接写进帮助文本：`status:'in_progress'`（应写 doing）、
`id:'T-blind-full'`（id 由服务端生成）、`acceptance:"一整段字符串"`（必须是 checklist 数组）。

**由此确立「规格同框纪律」**：schema 必须同时在 CLI `--help` 与提示词 brief 在位，
枚举逐字一致，由 `tests/test_board_schema_contract.py` 守。

---

## 7. make-video P11/P12

- 四层分类与 15 份模板契约 + `.meta.json`；
- `CAMERA_MOVES` 单一事实源移到 `validators/scene.ts`，由 `schema.ts` 导入；
- 新增 `template-content.ts` / `template-contract.ts`；
- 10 风格各配 `.anti-patterns.md` / `.references.md`；
- 修复 `motion-lib.js` 的语法损坏（此前该文件的语法错误会让动效静默失效）。

---

## 8. 测试：413 passed / 2 failed → **428 passed / 0 failed**

区间结束时还有两条失败。它们是本轮之前就存在的（用 stash 反证过：把本轮全部改动
移走后照样红），但**不是「已知问题」，是测试自身的缺陷**，会持续制造噪声——
`413 passed / 2 failed` 一旦成为常态，真回归就没人看得见了。

### A. `test_target_has_no_duplicate_patch_block` 判据在数学上无效

旧判据：锚点在产物里出现的次数 > 在补丁文本里的次数 → 报污染。

`apply-tool-patches.py` 用的是 `src.replace(anchor, patch, 1)`，而 patch 文本里本身
就含一份 anchor。于是替换完成后，**anchor 在文件里的计数恒等于替换前**——这个量对
「补丁被应用了几次」完全不敏感。

后果是双向的：

- **抓不到真污染**：历史上 `style.css` 整段 5705 字节被写两遍那次，anchor 计数同样
  没变，这个判据照样是绿的；
- **稳定误报合法重复**：`KNOWN_LEGIT_REPEATS` 白名单就是为压这些误报而长的（`chat.rs`
  的两处 `check_cancel` 各有语义、必须都在）。白名单变长是判据选错的症状，不是解法。

真判据：**patch 全文在产物里出现几次 = 补丁被应用了几次**，>1 就是重复块。
实测这个判据在当前仓库报 0 条，而旧判据报 3 条（全部误报）。

判据抽成 `_dup_patch_blocks(specs, read_src)` 纯函数，配 3 条反向用例
（`GuardHasTeeth`）：应用一次不得报 / 写两遍必须报 / 基线多份 anchor 不得报。
不这么做的话，「换判据」和「把告警关掉」在测试结果上是同一件事。

### B. `test_recall_window_filters_by_days` 依赖运行当天的日期

夹具 `T1` 硬编码 2026-11-11，用例却调 `recall(days=0)`（= 只要今天）。`recall`
内部按 `now_utc()` 算 `days_ago`，于是这条用例**写就那天绿、一周后红**——把
「时间过去了」伪装成「代码坏了」，让人去修不该修的东西。

修法是把时钟钉死成夹具日期（`_freeze_today`），**而不是把窗口放宽到 30 天**：
放宽后 `T0` 也落进窗口，"窗口外的天不该出现" 就永远为真，用例变成空跑。

补一条 lint（`test_every_recall_call_freezes_the_clock`）守住整类问题。它立刻抓出
**第三个还没爆的时间炸弹**：`test_recall_hit_points_at_l2_path` 用 `days=30`，
2026-12-11 之后就会红。三条漏网用例一并钉住。

---

## 验证

| 项 | 结果 |
|---|---|
| `python -m pytest tests -q` | **428 passed / 0 failed**（原 419，本版新增 9 条登录按钮契约） |
| `cargo test -p react-agent-agent-loop` | **127 passed**（76 lib + 1 conformance + 2 contract + 48 react_mocks） |
| `cargo test -p react-agent-host --lib` | **99 passed** |
| `scripts/verify-model-sync.py --gw 3425 --rsi 8710` | exit 0，**96/96**，含 8 个 `auto/*` |
| `scripts/verify-login-buttons.py --build` | exit 0，API **9** 渠道 ↔ UI **9** 按钮逐一相同 |
| 补丁链 `--dry-run` | **281 行 / 281 OK / 0 FAIL**（全部 `applied_marker` 命中，幂等跳过；含本版新增的 `NW18B-TURNS-META`） |
| `GET /api/upstream/providers` ↔ UI 按钮 | **9 / 9**，顺序 + 文案 + `disabled` 逐一相同 |
| 浏览器端到端 | 27 pass / 0 fail |

判据与用例的改动都做了**变异验证**：把被测逻辑改坏，确认新判据会红；改回，确认复原。

### 本版范围内的一个遗留缺口（已在 tag 之后修复）

`contract_conformance.rs` 有两个测试函数各自设 `AGENT_STREAM_DIR`，但只有第一个
（`scripted_chat_fulfills_all_wire_contracts`）补了 `RSI_TURNS_DIR`。第二个
（`metadata_declared_tools_register_without_legacy_names`）没补，于是
`turns_root()` 沿 `RSI_HOME` → `WORKSPACE_ROOT` → `cwd` 回落，**把回合账写进仓库
真实的 `.rsi/turns`**——而 `.rsi/` 在 `.gitignore` 里，脏了也看不见。

`NW18` 补丁的 description 当时写「锚点全文出现 2 次，replace 会一次改完两处」，
这句话是错的：`apply-tool-patches.py` 用的是 `src.replace(anchor, patch, 1)`，
`count=1`，只改第一处。实测文件里 `RSI_TURNS_DIR` 只出现 1 次。

实测证据（本轮）：单跑该测试一次，`.rsi/turns` 从 112 个文件变 113，新增文件的
`session_id` 是 `r16`（正是该测试的会话 id）。补 `NW18B-TURNS-META` 后再跑，文件数
保持 112 不变。

该补丁的 `applied_marker` 是 `agent-loop-meta-turns-`，刻意与 NW18 的
`agent-loop-contract-turns-` 错开——两条补丁覆盖同一个文件的两处同文锚点，marker
若相同，幂等判据会互相冒充（第二条永远「已应用」）。

---

## 升级注意

- 本版**不改** `Cargo` 版本线，不动 `v0.0.20`；
- 模型同步**不带** `?provider=` 覆盖，**不静默替换**用户当前模型；
- Magpie 的 provider/model/group 管理一律走 CLI，Host 不直接读写 `providers.json`；
- `auto/beam-free` 不可恢复（上游已无该模型），其余 8 个 `auto/*` 可用；
- **升级后请重启 Host**：`/api/upstream/providers` 是本版新增路由，跑着旧 exe 会 404
  （现象像「功能没实现」，实为旧二进制，`strings` 可反证）。本机用户实例 PID 32756
  即属此列，重启即恢复。

## 与其他 Release 的关系

`v1.4.x` 是 **make-video 技能**的独立发布线，与本应用线 `v0.0.x` 并行，互不覆盖。
本版区间内的 make-video 改动（`886b5e3`）属技能内部演进，细则见该线各自的 Release。
