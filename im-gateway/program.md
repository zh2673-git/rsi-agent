# im-gateway program.md — 探索

> 首个落地平台：钉钉 Stream 机器人 + QQ 官方机器人（用户 2026-11-21 拍板）。
> 首行声明：探索（精简方案 + 代码，不铺完整文档树）。

## 目标
把手机 IM 消息桥接到本仓库 host 的 agent，让用户在钉钉/QQ 里发一句话就能拿到 agent 回复。agent 侧零改动，不碰受保护的 `runtime/crates/**`。

## 本质（时空契约三问）
- **空间归属**：网关是独立目录 `im-gateway/` 的独立 Python 包；会话状态与 msg_id 去重表在进程内（本轮单实例先内存实现，M2 再换持久化）。host 的 session 由 host 独占，网关只持有 session key 字符串。
- **时间流形态**：事件驱动。IM 适配器收到消息 → 归一化 Envelope → 异步任务调 host；**关键**：`POST /api/chat` 只返回 `{"ok":bool}`，回复文本来自 `GET /api/events` 的 SSE `assistant.answer` / `stream_delta.text`。所以每个请求 = 「POST 提交」+「SSE 订阅到本轮 assistant 收敛」两条并发链路，用 asyncio.Event 汇合。
- **规则拦截**：白名单（只允许配置的用户/群触发）在网关入口拦截；msg_id 幂等去重；频控队列 MVP 先做串行 per-session；凭据从环境变量/配置读，不进日志。

## P / Q / I
- **P（前置）**：Python 3.11 ✅；dingtalk-stream / qq-botpy / httpx / aiohttp 已装 ✅；host 127.0.0.1:8710 在跑 ✅。
- **Q（后置）**：单元/集成测试覆盖 Envelope 归一化、session key 映射、msg_id 幂等、白名单、host 桥接（mock host）；两个平台 adapter 能在无凭据下 import 且注册正确回调。
- **I（不变量）**：不改主仓库任何受保护文件；`pytest tests -q` 全绿不回归；无遗留后台进程；凭据不落日志/不进 git。

## 目录映射（第 0 级）
```
im-gateway/
  program.md
  README.md              # 对外契约：怎么配、怎么跑、支持哪些平台
  im_gateway/
    __init__.py
    config.py             # 配置/凭据读取（环境变量优先）
    envelope.py           # 统一消息结构 + 平台归一化
    session.py            # session key 映射 + msg_id 幂等 + 白名单
    host_client.py        # POST /api/chat + SSE /api/events 桥接
    core.py               # Gateway.handle(envelope)：编排主链路
    adapters/
      __init__.py
      dingtalk.py         # ChatbotHandler → Envelope → reply_text
      qq.py               # botpy.Client on_at_message_create → Envelope → reply
    run.py                # 入口：按配置启动选中的平台
  tests/
    test_envelope.py
    test_session.py
    test_core.py
  requirements.txt
  config.example.json
```

## 关键契约（已从源码核实，非猜测）
- POST `/api/chat` body `{"session_id","message"}` → `{"ok":bool}`（`runtime/crates/host/src/web/mod.rs:532`，前端 `q-session.js:313-325`）。
- GET `/api/events?session=&after=` SSE：`assistant` 事件 `.answer`（最终文本）/`stream_delta` 事件 `.text`（增量）/`.kind`（reasoning|正文）（`app-events.js:29-74`、`app-stream.js:202-215,290-308`）。
- 钉钉 SDK：`Credential(client_id, client_secret)` → `DingTalkStreamClient` → `register_callback_handler(ChatbotMessage.TOPIC, handler)` → handler.process(callback) 里 `ChatbotMessage.from_dict(callback.data)`、`self.reply_text(text, incoming_message)`（`README` 官方示例）。
- QQ botpy：继承 `botpy.Client`，`on_at_message_create(self, message)`，`message.reply(content=...)` / `self.api.post_message(...)`；`intents=botpy.Intents(public_guild_messages=True)`；`client.run(appid, token)`（官方 README）。QQ 机器人是频道/群 @ 触发，私信走 `on_direct_message_create`。

## 约束
- 网关不写任何 `runtime/**`、`config.json`、受保护 plugin 目录。
- 凭据只从环境变量或 `im-gateway/config.local.json`（.gitignore）读。
- session key 只用 ascii 字母数字 + `-_.`：前缀 `dt-`（钉钉）/ `qq-`（QQ）+ 平台会话标识的 sha256 前 12 位。
- 长回复按平台单条上限分段（钉钉/QQ 保守取 4000 字符/段，QQ markdown 更短再降）。
