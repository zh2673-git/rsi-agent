# v0.0.5 — 工具层自愈（O1-O4）

> 第三轮自迭代。数据源：活体 trace（2717 次工具调用 / 9.3MB / 跨 30h，v0.0.4 运行实况）。
> 核心洞察：`ok=false` 共 113 次，其中**同因重犯**占大头（bash 多行拒绝 ≥10 次、grep 参数超界
> 5 次、60s 硬闸 K502 ×3）——硬拒绝只在首次有教育意义，重犯就是纯烧 token。本轮把工具层从
> 「报错教育家」升级为「就地自愈」。

## 行为变化

### O1 参数越界自动钳制（clamp）
`read_file/grep/list_dir/web_read` 等全部整型参数（limit/offset/context/max_results/timeout_ms…）
越界不再报 `BAD_ARG` 拒绝，自动钳到最近合法端点并继续执行；grep 结果透出
「参数已自动修正: context_after 30→10」提示，修正对模型可见、不产生静默偏差。
每调用独立窗口，跨调用不串。

### O2 edit_file 白空间归一自愈
`old_string` 精确/行尾容错都未命中时，新增一层白空间归一匹配（行首尾空白、全角空格、
连续空格数差异自动吸收）；**唯一**命中 → 就地替换并返回 `match_mode: "whitespace"`；
多处命中维持原报错（保守不猜）。模型最常见的「看起来一样但就是说不匹配」一步修复。

### O3 工具闸可配
`TOOLS_DEADLINE_SECS` 环境变量覆盖默认 60s 工具执行闸（<30s 视为误配回退 60）。
重构建、全仓索引、大扫描类命令不再被硬闸掐断（本 trace 实录 3 次 K502）。

### O4 web_read 大文档缓存预算
单条缓存容量 256K → 1M 字符，缓存总量 8MB 封顶。>256K 的长文档此前完全绕过缓存、
每翻一页重新出网（web_read 占本轮工具调用 17.7%），现在整篇入缓存、翻页零出网。

## 质量门

- Python 48/48（新增自愈回归 10 例：clamp 四态 / grep 提示透出 / 白空间归一编辑 + 歧义不猜）
- agent-loop 67/67（新增 tools_deadline env 三态测试）· host lib 23/23 · cargo check 干净
- 补丁层 20 个外挂补丁全幂等（0 FAIL / 0 SKIP）；LOOP-P2-DEADLINE-FN 按 P5b 先例退役

## 运维

- 全部为补丁层改动：**重启 host 生效**（Rust 侧下次 `run.cmd` 重编时生效）
- O 轮完整决策与验证记录：`docs/self-evolution/00-PLAN.md` §5
- 版本口径不变：git tag = rsi-agent 发版序号；Cargo 0.1.x = 上游快照版本（双轨独立）
