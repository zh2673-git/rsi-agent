# rsi-agent v0.0.26

本版覆盖 `v0.0.25..v0.0.26` 的 2 个文件 / +68 −11（均在 `runtime/plugins/llm_adapter/`）。

一句话主题：**网关把上游账号故障吞成"200 空流"导致长任务报"流式响应正文为空"——流式侧增加自动重试换号，不再一次失败就中断。**

## 1. 现象与根因
- 现象：长任务工作一段时间后报 `[llm.chat] openai 流式响应正文为空（账号额度/登录态/网关异常）`。
- 根因：Magpie 网关在**流式模式**下把上游 401/429/502 吞成 `200 + 空 SSE`（非流式会明确报错）。usage 记录显示故障窗口内 workbuddy 429 额度用尽、qoder 429 credits 0/0、trae 旧号 401、qoder-cn/qwenwork 502/499 几乎同时挂掉，smart 路由选中坏账号即命中空流。v0.0.25 的 `LLM_EMPTY` 防护只是如实上报，不是 bug。

## 2. 修复（openai_compat.py）
- `_stream_once` 空流判定提前到 `sink.end()` 之前：空流不写 end 事件，外层重试复用同一 sink 不串台；返回 `LLM_EMPTY` + `http_attempts`。
- 429/5xx（`LLM_TRANSIENT`）不在内层写 `sink.error`，避免重试时前端气泡闪错。
- `_chat_stream` 包**瞬态重试循环**：遇 `LLM_EMPTY`/`LLM_TRANSIENT` 重新请求同一网关（= 网关重新 smart 路由换号），最多 5 次（实测 auto 组 5 成员曾 4 个坏，撞健康号概率从 ~49% 提到 ~67%），退避 1/2/3/4s，`PROVIDER_DEADLINE-15` 总时限守卫防越过内核 K502；确定性错误（401 等 `LLM_ERROR`）不重试。复用同一 sink：start 只写一次、最终失败才写一次 error。

## 3. 网关侧尝试（已回滚）
曾摘除明确 429 的 workbuddy/qoder 成员，结果剩余 3 成员全超时、端到端 8/8 失败——摘除减少冗余反而更糟，**已回滚**（5 成员全恢复）。结论：网关账号池整体故障时只能靠重试撞健康号，代码侧重试是主 remedy。

## 4. 验证
| 项 | 结果 |
|---|---|
| 离线 mock 测试（空流 4 次后成功 / 429 重试成功 / 持续空流 5 次失败 / 401 不重试 / 时限守卫提前停） | 5 项全过 |
| `py_compile openai_compat.py` | 通过 |
| `cargo test -p react-agent-host --lib` | 99 passed, 0 failed |

## 升级注意
- Python 插件改动需**重启 Host** 才加载。crate 版本 `0.1.23` 与 release tag `v0.0.x` 是两套独立编号。
- 本版不解决网关账号本身的额度/登录态问题——那些需在 Magpie 侧充额度/重新登录。
