# 内容分发：调研结论与实现说明（I-20261108-07）

> 需求原文：「就像集成 LLM 模块一样，能否研究集成内容输出分发的模块，比如一键分发小红书、
> B站、公众号等，研究一下 GitHub 上的现成项目，然后在 rsi-agent 项目中可视化的集成进来，
> 用户可以选择分发哪些平台，并且能可视化的做好配置然后生效。」

## 一、调研结论

### 1. 有现成项目，而且质量很高

[`dreammis/social-auto-upload`](https://github.com/dreammis/social-auto-upload)：**16.3k stars，MIT**，343 commits。

它同时提供两样我们要的东西：

| 形态 | 说明 | 对本项目的意义 |
|---|---|---|
| 统一 CLI `sau` | `sau <platform> upload-video\|upload-note\|upload-article --account <别名> ...` | 我们**转调**它，不重造轮子 |
| Agent Skill | 仓库自带 `skills/` 目录，已支持 Codex / Claude Code 消费 | 说明它的接口形状天然适合 agent |

覆盖 18 个平台。与需求点名的三处对照：

| 需求点名 | 本项目支持 | 路线 |
|---|---|---|
| 小红书 | ✅ 视频 + 图文 | 浏览器自动化（sau） |
| B站 | ✅ 视频（自动准备 biliup） | 浏览器自动化（sau） |
| 公众号 | ❌ **不支持** | 需走微信官方 API（见下） |
| 视频号 | ✅ 视频 | 浏览器自动化（sau） |

### 2. 公众号是唯一的缺口，且**不能**用浏览器自动化补

微信公众平台有正式的**服务端接口**，两步：

```
POST https://api.weixin.qq.com/cgi-bin/draft/add?access_token=...
  → {"media_id": "..."}                     # 进草稿箱
POST https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=...
  → {"publish_id": "..."}                   # 正式发布
```

取 token：`GET /cgi-bin/token?grant_type=client_credential&appid=&secret=`。

关键约束（来自官方文档，不是我们的选择）：

- `title` ≤ **32 字**、`author` ≤ 16 字、`digest` ≤ 120 字；
- `content` 支持 HTML，但**必 < 2 万字符、< 1MB**，JS 会被剥离；
- 正文图片 URL **必须**来自「上传图文消息内的图片获取URL」接口，外部图片 URL 会被过滤；
- `thumb_media_id`（封面）必须是**永久** MediaID。

**为什么不用浏览器自动化**：公众号后台登录强校验（扫码 + 频繁风控），社区没有可用入口。
走野路子等于让用户拿账号封禁风险换便利——这条不做。

### 3. 由此确定的双路线架构

不是「一个统一接口抽象所有平台」，而是**两个基类**：

- `SauAdapter` → 转调 `sau` CLI。平台改版的维护成本留在上游，我们只承受 CLI 参数级变化。
- `WeChatAdapter` → 官方 API。凭证自己管，请求自己发。

这个分叉是**真实存在**的：一边靠本地登录态 cookie，一边靠 AppID/AppSecret。
硬抽象成一个接口会写出一堆 `if platform == "wechat"`，不如在类型层面分开。

## 二、实现

### 文件

| 文件 | 职责 |
|---|---|
| `scripts/publish.py` | 分发引擎：稿件 → 适配器 → 并发分发；CLI `send`/`status`/`set` |
| `runtime/crates/host/src/web/api/publish.rs` | `/api/publish/config` 读写 + 就绪判定（外挂补丁新建） |
| `runtime/crates/host/web-dist/index.html` | 设置面板新增「分发」页签 |
| `runtime/crates/host/web-dist/vendor/app-settings.js` | 面板渲染 + 保存逻辑 |
| `config/publish.json` | 凭证落点（**与 config.json 分开**，见下） |

### 三个设计决策及理由

**① 凭证独立文件 `config/publish.json`**

不放 `config.json` 有三个直接好处：可单独设文件权限、可单独不进备份、agent 读主配置时不会顺带带出公众号密钥。

**② 一键分发 = 逐平台独立，一路失败不影响其余**

`fan_out` 按平台循环，每条结果都带 `platform`。用户要的是「哪些发成功了」，不是「第一个错误」。这是「一键分发」和「一个脚本」的区别。

**③ 公众号默认只建草稿，不直接发布**

`auto_publish=false` 是缺省。公众号发布**不可撤回**，而草稿箱是安全落点——用户能在后台预览排版再点发布。要一步到位必须显式勾选。

### 安全边界

- **凭证脱敏**：`redact()` 覆盖 `secret/token/password/cookie/key`，连错误信息也过一遍（平台返回体常带回显 token）。
- **GET 不回明文**：`/api/publish/config` 只回 `secret_set:true/false`，前端据此显示「已设置，留空不修改」。
- **空 secret = 不修改**：POST 传空串不会擦掉已存凭证（与 llm key 同一约定）。
- **默认干跑**：`publish.py send` 不带 `--apply` 只打印将要执行什么。
- **不代管登录态**：cookie 由 `sau <platform> login` 自己维护，本引擎从不读取、不存储、不打印。

## 三、可视化配置怎么用

设置面板 → **分发** 页签：

- 每个平台一行：开关 + 就绪状态（就绪 / 不可用 + **原因**）
- 不可用原因写成能照做的下一步：未装 `sau` 会给安装指引，缺 AppSecret 会指到公众平台哪个菜单
- 公众号额外有：AppID / AppSecret / 作者名 / 直接发布勾选框
- 切到这个页签时**重新探测**一次（用户可能刚在终端装好 sau / 登录完）

## 四、还没做的（边界清楚，不是遗漏）

1. **正文图片上传**：微信要求图片先经「上传图文消息内图片」接口换成内部 URL。当前实现只处理纯文本 + 排版标签，正文带本地图片会被微信过滤。
2. **封面 MediaID**：`thumb_media_id` 需先调素材上传接口。当前未传，公众号图文消息可能要求补。
3. **定时发布**：`sau` 支持 `--schedule`，引擎未暴露该参数。
4. **多账号并发**：`sau` 支持按 account 并发，引擎目前串行。
5. **发布历史**：没有记录「哪篇发到哪些平台、结果如何」。理想落点是看板 artifacts。

这五项都是**增量**，不影响主流程可用。

## 五、验证

| 项 | 结果 |
|---|---|
| `pytest tests/` | **227 passed**（含 `test_publish_i07.py` 11 项） |
| `cargo test --workspace` | **118 passed**（host 40 / agent-loop 38 / react_mocks 40） |
| 补丁链幂等 | 全部 OK，0 FAIL / 0 DRY |
| 活体 e2e（隔离端口 8791） | 5 组断言通过：路由注册、就绪判定、**secret 不泄漏**、空值不覆盖、落盘位置正确 |

活体验证最要紧的一条：写入 `S3CRET_MUST_NOT_LEAK_123` 后，POST/GET 响应与 `config.json` 里都**查不到**该串，只在 `config/publish.json` 落盘。
