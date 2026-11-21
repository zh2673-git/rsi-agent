# RSI Agent IM 网关（钉钉 + QQ）

把钉钉机器人、QQ 官方机器人收到的消息桥接到本机 RSI Agent Host，让用户直接在 IM 里和 agent 对话。**agent 侧零改动**，只通过现有的 `POST /api/chat` + `GET /api/events`（SSE）两条链路。

## 已实现（M0）

- 钉钉：Stream 模式官方 SDK 长连接收消息，`reply_text` 回复，无需公网回调/验签。
- QQ：官方 botpy，频道/群 `@机器人` 触发（`on_at_message_create`），`post_message` 回复。
- 统一层：消息归一化、会话 key（安全 ascii）、`msg_id` 幂等去重、白名单、每会话串行、回复截断。
- 凭据：环境变量或 `config.local.json`（已被 .gitignore 忽略），绝不写日志。

## 未实现（M0 明确不做）

- QQ 私信 `on_direct_message_create`（需要额外 intent 与审核）；M0 只在频道/群 @ 触发。
- 飞书、企业微信、公众号（后续平台）。
- SSE 流式进度回推（M0 只回最终答案）、长回复分段、取消指令、频控队列、凭据轮换、审计日志、容器化。

## 前置

- Python 3.11+，依赖见 `requirements.txt`：`pip install -r im-gateway/requirements.txt`
- RSI Agent Host 已在本机运行（默认 `http://127.0.0.1:8710`）。

## 配置

三种来源，优先级 **环境变量 > 宿主设置面板 > 本地文件 > 默认值**：

1. **宿主设置面板（推荐）**：打开 Agent 界面的齿轮设置 → 「IM」标签页，填钉钉/QQ 凭据并保存。配置落在工作区根 `config.json` 的 `external_channels.im`，密码框留空 = 不修改，回显只显尾 4 位。保存后启动网关即生效。
2. **环境变量**（最高优先级，适合临时覆盖）：见下表。
3. **本地文件**：复制模板填写（已被 .gitignore 忽略，绝不入库）：

```bash
copy im-gateway\config.example.json im-gateway\config.local.json
```

环境变量：

| 变量 | 含义 |
|---|---|
| `RSI_HOST_BASE` | host 地址，默认 `http://127.0.0.1:8710` |
| `GW_ENABLE_DINGTALK` / `GW_ENABLE_QQ` | `1`/`true` 启用对应平台 |
| `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` | 钉钉 Stream 应用凭据 |
| `QQ_APPID` / `QQ_TOKEN` | QQ 机器人凭据 |
| `GW_ALLOW_USERS` / `GW_ALLOW_CHATS` | 逗号分隔白名单；留空不限制（建议生产配置） |
| `GW_MAX_REPLY_CHARS` | 单条回复最大字符数，默认 4000 |
| `GW_CHAT_TIMEOUT` | 单轮最长等待秒数，默认 300 |

钉钉凭据在钉钉开放平台创建 Stream 模式机器人获取；QQ 凭据在 QQ 开放平台创建机器人获取。**不要把密钥贴到对话里**；用上面的设置面板、环境变量或本地文件。

## 启动

在仓库根目录：

```bash
python im-gateway/run.py                       # 按配置开关启动所有启用平台
python im-gateway/run.py --platform dingtalk    # 只起钉钉
python im-gateway/run.py --platform qq          # 只起 QQ
```

启动日志打印脱敏配置（不打印密钥值）。

## 测试

```bash
python -m pytest im-gateway/tests -q
python -m pytest tests -q
```

## 目录

```
im-gateway/
  run.py                   # 入口
  config.example.json      # 配置模板（复制为 config.local.json）
  requirements.txt
  im_gateway/
    config.py              # 配置读取 + 脱敏视图
    envelope.py            # 平台消息归一化
    session.py             # 安全 session key + 幂等 + 串行
    host_client.py         # POST /api/chat + SSE /api/events
    core.py                # 编排：白名单 → 幂等 → host → 回复
    adapters/
      dingtalk.py          # 钉钉 Stream 适配器
      qq.py                # QQ botpy 适配器
  tests/                   # 单测
```
