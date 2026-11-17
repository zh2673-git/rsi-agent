# rsi-agent v0.0.21

本版覆盖 `v0.0.20..v0.0.21` 区间的**全部 6 笔提交**，262 个文件，+19,076 / −385。

主题：**模型目录不再是手工维护的静态表**。本版把「模型从哪来、为什么少了几个、
路由组怎么管、哪些登录渠道真的可用」这四件事从「靠人记」变成「由 `/v1/models`
单一事实源推导」，并顺手把测试套件从 413 passed / 2 failed 推到 **419 passed / 0 failed**。

区间构成（6 笔）：

| 类别 | 提交 | 说明 |
|---|---|---|
| 运行时内核 | `bf007b4` | token 预算 / 压缩 / 工作集裁剪 / 并行提示 + 看板 schema 契约（80 文件） |
| 宿主与前端 | `469412f` | 模型目录自动同步 + 路由组管理 + 动态登录签到（P1/P2/P3）（77 文件） |
| make-video | `886b5e3` | P11/P12 四层分类与模板契约 + 动效语法修复（86 文件） |
| 文档 | `923fc6f` | 本轮实现报告与既有调研笔记归档（10 个 .md） |
| 调用点规格 | `a103bad` | `task-upsert --help` 印出字段规格 |
| 测试修复 | `9d2674e` | 修两条 HEAD 既有失败：判据选错 + 用例读真实时钟 |

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

实测 `magpie groups` = **8 组**；模型下拉 **97** 项（96 + `__custom__`）；路由组成员
多选 88；routing 11；stays 5。

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

实测 `:8711/api/upstream/providers` = **9**（8 usable + `qwenwork-enterprise`
`usable=false`）。

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

## 8. 测试：413 passed / 2 failed → **419 passed / 0 failed**

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
| `python -m pytest tests -q` | **419 passed / 0 failed** |
| `cargo test -p react-agent-agent-loop` | **127 passed**（76 lib + 1 conformance + 2 contract + 48 react_mocks） |
| `cargo test -p react-agent-host --lib` | **99 passed** |
| `scripts/verify-model-sync.py --gw 3425 --rsi 8710` | exit 0，**96/96**，含 8 个 `auto/*` |
| 补丁链 `--dry-run` | **280 行 / 280 OK / 0 FAIL**（全部 `applied_marker` 命中，幂等跳过） |
| 浏览器端到端 | 27 pass / 0 fail |

判据与用例的改动都做了**变异验证**：把被测逻辑改坏，确认新判据会红；改回，确认复原。

---

## 升级注意

- 本版**不改** `Cargo` 版本线，不动 `v0.0.20`；
- 模型同步**不带** `?provider=` 覆盖，**不静默替换**用户当前模型；
- Magpie 的 provider/model/group 管理一律走 CLI，Host 不直接读写 `providers.json`；
- `auto/beam-free` 不可恢复（上游已无该模型），其余 8 个 `auto/*` 可用。

## 与其他 Release 的关系

`v1.4.x` 是 **make-video 技能**的独立发布线，与本应用线 `v0.0.x` 并行，互不覆盖。
本版区间内的 make-video 改动（`886b5e3`）属技能内部演进，细则见该线各自的 Release。
