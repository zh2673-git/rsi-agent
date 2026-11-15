# rsi-agent v0.0.20

本版覆盖 `v0.0.19..v0.0.20` 区间的**全部 12 笔提交**。三件用户看得见的宿主缺陷一次收口，
外加区间内尚未单独发版的两笔运行时/技能提交。

区间构成（12 笔）：

| 类别 | 提交 | 说明 |
|---|---|---|
| 本版主体 | `b63b93d` `fb6a043` `8d79d0c` `9468f87` `1257b9c` `2c0fc7c` | 插队语义归位 + 看板筛选折叠全量 + 补丁链 + 契约测试 + 发行说明 |
| 运行时修复 | `025bb95` | 技能注册表编码容错 + 技能段降级（**含 Rust 运行时改动**） |
| 技能登记 | `a1fba3d` | `sync_skills` 登记 project-dev-skill 三门技能 + tdd 文档与工具对齐 |
| make-video | `1ad1cda` `75bb120` `f6154cf` `3588c35` | v1.4.0–v1.4.3，已由独立 Release 覆盖（见文末「与其他 Release 的关系」） |

---

## 1. 插队键不插队：Alt+Enter 走的是 steer 软注入

### 症状

用户按下 Alt+Enter「插队」，看到的是：当前任务继续跑，我的话排在后面。

### 根因

Q 轮 Phase 3 把 Alt+Enter 改道到服务端 steer：`POST /api/queue target=steer`，
服务端把文本放进 steer 缓冲，`chat_run` **下一轮开头**注入工作集
（`chat.rs:629-645`）。steer 的语义是「追加一条」，**不取消当前任务**。

更糟的是它成功后直接 `return`，把后面那套硬插队逻辑整段跳过。

### 修法

硬插队逻辑其实**早就存在**（Q6，commit `f2a683a`）：打断当前 → 插队条插到它
前面 → 插队条跑完出队 → 被打断那条回到队首续跑。故删去 steer 分支，
Alt+Enter 一律走硬插队路径：

```
markRunningInterrupted(session)  →  /api/chat/cancel  →  s.abort?.abort()
```

被打断的那条标 `pendingResume`，插队条跑完后自动回头续跑，上限 `MAX_RESUME=8`。

**steer 的服务端能力保留**（`queue.rs` + `chat.rs`），供将来「不打断当前、只想
追加一句」的场景显式调用——只是不再由 Alt+Enter 触发。

## 2. 插队入口收回待发队列行内

### 背景与变更

V14 曾按「composer 缺一个能插队的入口」补了一个独立的「插队」按钮。用户明确
否决：插队入口应统一留在待发队列行内。

V15 撤掉那四处改动（`index.html` 的 `<button id="interrupt">`、`app-core.js` 的
`interruptBtn` 声明、`app-events.js` 的 `onclick` 绑定、`style.css` 的样式），
composer 恢复为「停止 / 发送」。

语义不变：

| 操作 | 行为 |
|---|---|
| Enter / 点发送 | 新任务照旧自动进入待发队列 |
| 队列行内 `⏭` | 硬插队：打断当前 → 本条先跑 → 被打断者回头续跑 |
| Alt+Enter | 硬插队快捷键（无可见按钮，语义与行内 `⏭` 同一套） |

## 3. 看板筛选条是纯装饰 + 弹窗被 limit 截断

### 症状

「全部 / 已完成 / 未完成」点下去按钮变亮，列表一条没少；专门点进看板标签，
也只能看到 30 条。

### 根因

两处都是同一类错：过滤那一步传的是 `sec.filter`（章节配置里的静态值 `"all"`），
而不是用户点的 `boardFilter`。弹窗另外还叠了一层 `layout.limit` 截断。

### 修法

- 筛选条抽成共用 `filterBar()`，侧栏与弹窗挂同一份、共用同一个 `boardFilter`
- 侧栏过滤改走 `taskVisibleInSection(t, sec)`，弹窗改走 `taskVisible(t, boardFilter ?? "all")`
- 弹窗不再受 `limit` 截断（侧栏 `limit=30` 仍生效：窄栏省空间，弹窗是
  「摊开细看」的宽面，截断在这里只有「翻不到底」的坏处）
- 弹窗按状态分组，组头可折叠（沿用侧栏 `.tgroup` 视觉语言，类名 `.bw-group`）

## 4. 技能注册表编码容错 + 技能段降级（`025bb95`）

### 症状

一个技能文件的尾部混入了 19 字节 GBK 脏数据，`skills.list` 整条 K500——Web「技能」页与
`GET /api/skills` 全不可用。更严重的是：agent-loop 的 `skills_appendix` 在取不到技能列表时
直接 `return String::new()`，把**看板纪律段、@T-/@I- 引用装载、分解与并行规则一起吞掉**，
模型连「有看板这回事」都不知道。

### 根因

- 数据层：`assets_plugin.py` 的 `read_text(encoding="utf-8")` 抛 `UnicodeDecodeError`，
  而旧代码只捕 `OSError`——编码坏掉不在捕获范围里，一条坏技能拖垮整个注册表
- 提示词层：技能段的失败被当成「整段提示词都不要了」，**连坐**了后续所有段

### 修法

- 数据层：assets 三处 `read_text` 改捕 `(OSError, UnicodeDecodeError)`，
  单个技能编码坏只跳过它，其余技能照常返回
- 提示词层：`skills_appendix` 由 `return String::new()` 改为 `match` 降级，
  失败只让**技能段**退化（不注入 Available skills），并 `tracing::warn!("技能段降级")`

不变量（写进 `tests/test_assets_encoding.py`）：**看板可用性不得挂在技能注册表上**。

### 这笔改动需要重编译 Rust 宿主

它改的是 `runtime/crates/agent-loop/src/skills.rs` 与 `lib.rs`，属于运行时改动，
不是前端资源。**宿主必须重新编译并重启才生效**——只刷新浏览器不生效。

## 5. 技能登记与 tdd 文档对齐（`a1fba3d`）

`sync_skills` 登记 project-dev-skill 三门技能（project-dev / repo-explorer / tdd），
并同步 `skills/tdd/SKILL.md` 的文档与工具调用面。纯文档与登记脚本改动，无运行时行为变化。

## 补丁链同步

- 新增 V14 七条 + V15 四条规格与块文件（发行快照改动要能随仓库重放）
- V14 那三条「加插队键」的补丁移入 `scripts/patches/retired/` 留档——不移的话
  补丁链重放会把按钮又加回来
- V15 四条用 `repair: true`：**删除语义必须用 repair**（锚点不存在 = 已修好），
  替换型删完后锚点消失会永久报「锚点未命中」
- nw7a–nw7e 五条覆盖第 4 节的编码容错与降级边界，`b4b-skills-append.json` 同步更新

## 验证

```
apply-tool-patches --dry-run        # 233 项全 OK、0 FAIL，重放幂等跳过
node --check                         # app-events / app-core / q-session / app-board 全绿
pytest tests/test_v14_queue_board_contract.py -q   # 15 passed
pytest tests -q                     # 392 passed, 2 failed
cargo test -p react-agent-agent-loop --lib          # 69 passed, 0 failed
```

那 2 条 pytest 失败是**基线既有**，与本版无关：
`tests/test_memory_consolidate.py::RecallReadsTimestampOnlyTest::test_recall_window_filters_by_days`
（时间窗判据）与
`tests/test_patch_idempotency.py::ArtifactNotPolluted::test_target_has_no_duplicate_patch_block`
（`contract_conformance.rs` 重复块判据）。

cargo 一项里含第 4 节新增的回归用例 `board_section_survives_skills_list_failure`。

线上 8710 实例静态资源已确认：无 `#interrupt`，行内 `⏭` 链路完好。

## 影响面

- **前端改动**（第 1–3 节）：宿主运行时读盘且返回 `no-store`，**刷新浏览器即生效，不用重启**
- **运行时改动**（第 4 节）：改了 `agent-loop` 的 Rust 源码，**需重新编译并重启宿主**才生效
- 无 breaking change；steer 的服务端能力保留，只是不再由 Alt+Enter 触发
- 看板仍是一本账；工作区只是任务归属标签

## 与其他 Release 的关系

区间内的 4 笔 make-video 提交已由**独立 Release** 覆盖，内容不重复记载：

| 提交 | 对应 Release |
|---|---|
| `1ad1cda` | `make-video-v1.4.0` |
| `75bb120` | `v1.4.1` |
| `f6154cf` | `v1.4.2` |
| `3588c35` | `v1.4.3` |

第 4、5 节的两笔（`025bb95` / `a1fba3d`）此前**没有**对应的独立 rsi-agent Release，
故在本说明中完整记载。
