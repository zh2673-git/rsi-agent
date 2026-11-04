# v0.1.22 — 回灌 rsi-agent 运行时改进 + Phase 1 装配接缝

> rsi-agent（本项目的 RSI 发行形态，内嵌本仓运行时快照）在补丁层沉淀的五轮活体改进，
> 经归属判定后整树回灌上游正式版；同时合入 Phase 1 装配接缝。commit `edca021` + `9519a6b` + `9b7ed30` + `31092ab`。

## agent-loop（ReAct 编排）
- budget 硬/软闸分层 + 效率画像补发；同会话并发闸；append 熔断 K503
- LLM / tools 双闸 env 可配；空答案自愈；secrets mtime 失效刷新
- Phase 1 接缝：HostSpec / `assemble_with`（发行形态装配解耦）、skillkit（技能契约纯函数单一事实源）、LoopPolicy 策略钩子（默认关闭）

## plugins
- **tools**：bash UTF-8 解码、参数 clamp + 审计、edit 白空间归一自愈、web 缓存预算、核心写保护前缀闸（`tools.allow_core_write`）
- **llm_adapter**：`http_status` 结构化 + 退避重试
- **memory**：trace sidecar 索引 O(页)、原子写

## host
- 杀进程树（instances）、sandbox-run 注释、前端会话重置统一入口

## 测试卫生修复（嵌入环境实跑暴露的上游债）
- secrets 测试 `CONFIG_FILE` 环境泄漏 → 临时路径方案（`7ddb14f`）
- `e2e_full_react_mock` 显式清除宿主注入的用户级 env（`WORKSPACE_ROOT` / `CONFIG_FILE` / `SKILLS_DIR`）——InProcess 循环读测试进程 env 的脆弱前提被击穿

## 内核
- 消费 [agent-kernel v0.1.8](https://github.com/zh2673-git/agent-kernel/releases/tag/v0.1.8)（P6 契约显式化：deadline/priority 绑定透传）

## 验证
check 干净 · agent-loop lib 24/24 · react_mocks 40/40 · conformance 3/3 · host lib 23/23 · e2e 七目标 11/11 · py_compile 全过
