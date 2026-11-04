# v0.0.6 — 反向回灌上游：三仓联动（react-agent v0.1.22 / agent-kernel v0.1.8）

> 用户裁决：rsi-agent 的 73 个外挂补丁不应只活在发行形态里——按实践经验反向优化上游，
> 让 agent-kernel / react-agent / rsi-agent 一起迭代。

## 三仓各自拿到了什么

### agent-kernel v0.1.8（tag 已推，0bc4720）
- **P6 契约显式化**（rsi 居民活体迭代沉淀）：Envelope 字段注释显式化（deadline_ms 是相对
  时长毫秒非绝对时间戳；priority 沿用内核枚举）；Python/TypeScript guest 绑定把
  deadline/priority 原样透传进插件 envelope——契约字段不再被绑定层静默丢弃。
- 验证：cargo 29 suites 全绿 · py import OK · ts --check OK · wire format 零变化。

### react-agent v0.1.22（tag 已推，edca021 + 9b7ed30）
- **五轮活体改进整树回灌**：agent-loop（budget 硬软闸分层 + 效率画像补发、同会话并发闸、
  append 熔断 K503、LLM/tools 双闸 env 可配、空答案自愈、secrets mtime 失效刷新）、
  tools（bash UTF-8 解码、参数 clamp + 审计、edit 白空间归一自愈、web 缓存预算）、
  llm_adapter（http_status 结构化 + 退避重试）、memory（trace sidecar 索引 O(页)、原子写）、
  host（杀进程树、前端会话重置统一入口）。
- **Phase 1 装配接缝**：HostSpec/assemble_with（发行形态解耦）、skillkit（技能契约纯函数
  单一事实源）、LoopPolicy 策略钩子（默认关闭）。
- **测试卫生修复**（嵌入 rsi 环境实跑暴露）：secrets 测试 CONFIG_FILE 泄漏改临时路径方案；
  e2e_full_react_mock 显式清除宿主注入的用户级 env（InProcess 循环读测试进程 env 的
  脆弱前提被击穿）。
- 验证：check 干净 · lib 24+23 · react_mocks 40 · conformance 3 · e2e 七目标 11/11。

### rsi-agent v0.0.6（本仓）
- **runtime 重嵌入 v0.1.22**：代码树与上游逐字节一致（脚本 verified）；内核依赖 v0.1.8。
- **补丁大扫除**：60 个被上游吸收的补丁退役进 `retired/`；13 个 rsi 专属补丁留守
  （checkin×6 / self-update×2 / watchdog×2 / x1×2 / files-p5-noise）——补丁层从
  73 收敛到 13，且此后新迭代改为「上游正式版优先」。
- 验证：py 48/48 · runtime 全测试绿（24+40+3+23）· 补丁层 13 活跃全幂等 0 FAIL。
- **运维：重启 host 即全部生效**（runtime 已含全部改动，不再依赖补丁重放）。

## 版本口径
- rsi-agent v0.0.5→**v0.0.6**（机制性变化：三仓联动迭代 + 补丁大扫除，非新能力面，patch 顺延）
- react-agent 0.1.21→**0.1.22**（回灌 + 接缝）· agent-kernel v0.1.7→**v0.1.8**（契约显式化）
