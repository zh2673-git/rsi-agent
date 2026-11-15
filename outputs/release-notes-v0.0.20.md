# rsi-agent v0.0.20

三个用户看得见的宿主缺陷，一次收口。都是**真实故障**，不是重构。

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

## 补丁链同步

- 新增 V14 七条 + V15 四条规格与块文件（发行快照改动要能随仓库重放）
- V14 那三条「加插队键」的补丁移入 `scripts/patches/retired/` 留档——不移的话
  补丁链重放会把按钮又加回来
- V15 四条用 `repair: true`：**删除语义必须用 repair**（锚点不存在 = 已修好），
  替换型删完后锚点消失会永久报「锚点未命中」

## 验证

```
apply-tool-patches --dry-run        # 233 项全 OK、0 FAIL，重放幂等跳过
node --check                         # app-events / app-core / q-session / app-board 全绿
pytest tests/test_v14_queue_board_contract.py -q   # 15 passed
pytest tests -q                     # 392 passed, 2 failed
```

那 2 条失败是**基线既有**，与本版无关：
`contract_conformance.rs` 的重复块判据、`memory_consolidate` 的时间窗判据。

线上 8710 实例静态资源已确认：无 `#interrupt`，行内 `⏭` 链路完好。

## 影响面

- 前端改动，宿主运行时读盘且返回 `no-store`：**刷新浏览器即生效，不用重启**
- 无 Rust 侧改动，无 breaking change
- 看板仍是一本账；工作区只是任务归属标签
