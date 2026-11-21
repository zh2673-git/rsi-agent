# IM 通道配置实施 PLAN（T-20261121-08）

## 模式判定
优化模式（既有 IM 网关 + 宿主设置面板的产品化迭代）。

## 四层契约
- UI：设置抽屉新增「IM 通道」tab；密码字段留空不改、只显尾 4 位。
- API：`GET/PUT /api/config` 新增 `external_channels` 段（通用外部通道配置）。
- 持久化：host `config.json` 增 `external_channels`；字段级 merge；secret 脱敏回显。
- 网关：`im-gateway` 配置优先级 env > host config > local > default。

## P/Q/I
- P：host 配置 API 补丁 + UI 补丁 + 网关适配 + react-agent 通用能力回灌 + 双仓发布。
- Q：im-gateway 15+ 测试、主仓 444、node --check、补丁 dry-run、react-agent 测试、真实 IM E2E（用户凭据）。
- I：面板可填凭据；网关读 host 配置；同会话不返回旧答案；通用能力进入上游。

## 迭代记录
- R1 2026-11-21：修 correctness blocker（SSE cursor gate），15 passed。
- R2 2026-11-21：host external_channels GET/PUT + IM tab + 网关读取 host 配置。
- R3 2026-11-21：补丁 dry-run/apply/verify + react-agent 通用能力回灌。
- R4 2026-11-21：双仓 commit/push/tag/release（rsi-agent v0.1.12 / react-agent v0.1.27）。
- R5 2026-11-22：自动连接——新增监管进程（`supervisor.py` + `supervise.py`），由 `run.cmd` 随 host 启停，配置变化自动拉起/重载/停止各平台网关，崩溃 ≥30s 后重连；修 `run.py` 子线程事件循环（botpy/dingtalk SDK 必须在主线程）、`qq.py` botpy `secret=` 参数、`supervisor.py` Windows `os.kill(pid,0)` → `OpenProcess/GetExitCodeProcess`；新增 5 个监管测试（23 passed），实机冒烟确认 QQ 网关推进到平台登录（初报 `code=100016`）。
- R6 2026-11-22：QQ 连调。出口 IP `49.64.55.221` 交叉验证（`ifconfig.me` / `icanhazip.com`），用户加白名单后 `code=100016`/`code=11298` 均解除，botpy 登录、`/users/@me`、`ws_identify`、`READY`、心跳全部正常，机器人名 `zh2673_分身`（appid `102887376`）。但群 @ 无响应：正式与沙箱原始 WS 抓包都只收到心跳 `op=11`，无 `GROUP_AT_MESSAGE_CREATE`。补 `public_messages` intent + `on_group_at_message_create` 回调 + 群消息归一化 + 日志（本地 commit `a450ecb`，25 passed），但根因不在代码：官方只读 API `me_guilds()` 正式/沙箱均返回 0；开放平台后台「我的机器人」显示 `zh2673_分身` **累计进群 0**、累计用户 1；服务范围里群聊/频道 Public 开关本来就开，开发设置确认 WebSocket 模式 + IP 白名单已含出口 IP。**结论：机器人未加入任何群，群里 @ 不会产生事件；下一步是在 QQ 客户端把机器人加进目标群并由群主授权，再做群 @ E2E。** 收到事件后还需按官方 `demo_group_reply_text.py` 补 `post_group_message(..., msg_id=message.id, msg_type=0)` 再发布新版本。回调地址无需填写（WebSocket 长连接模式，Webhook 才需要）。

## 回退点
- 补丁：`.patchbak` / `apply-tool-patches.py --revert`。
- 已发布版本不可变；修复出新版本。
