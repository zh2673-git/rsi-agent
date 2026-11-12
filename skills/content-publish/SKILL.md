---
name: content-publish
description: 内容分发实操规范：把一份稿件分发到小红书/B站/抖音/视频号/公众号，含首次登录扫码怎么把二维码交到用户手里、干跑与真发的分界、凭证与登录态边界、失败逐平台归因。Invoke when 用户要把内容发到社交平台、问分发怎么配置、扫码/登录态失效、或 publish.py 报不可用。
origin: user
---

# 内容分发（实操）

本仓库的分发是**三层分工**，先认清各层职责再动手，否则会改错地方：

| 层 | 在哪 | 职责 | 谁改 |
|---|---|---|---|
| 配置 | UI「设置 → 内容分发」→ `config/publish.json` | 开关哪个平台、公众号凭证 | 用户点，别让用户填 JSON |
| 执行 | `scripts/publish.py` → 转调 `sau` / 微信官方 API | 稿件 → 适配器 → 逐平台并发 | 本仓库 |
| 平台本身 | `tools/sau/.venv`（social-auto-upload，MIT） | 驱动浏览器完成各平台上传 | 上游，不要 fork |

**agent 不要自己拼 `sau` 命令发内容**——走 `publish.py`，它带干跑、脱敏、逐平台归因。只有排障时才直接调 `sau`。

## 1. 先看就绪状态，不要猜

```bash
python scripts/publish.py status
```

每行给 `ready` + `reason`。四种 `reason` 对应四种动作：

| reason | 真实原因 | 动作 |
|---|---|---|
| 未找到 sau 命令 | `tools/sau/.venv/Scripts/sau.exe` 不在 | 按本文 §5 安装；装好后 host 无需重启即认（已探测固定位置） |
| 缺 AppID/AppSecret | 公众号凭证没填 | 让用户去 UI 填，**不要在对话里索要 AppSecret** |
| 账号未登录 / invalid | 登录态失效 | 走 §3 扫码，让**用户本人**扫 |
| 平台不支持 X | 内容形态与平台不符 | 换形态或换平台，别硬试 |

## 2. 干跑是默认，真发要显式

```bash
python scripts/publish.py send --draft d.json                 # 干跑：只打印将要执行的命令/请求
python scripts/publish.py send --draft d.json --apply         # 真发
```

**没有用户明确说「发」，就不要加 `--apply`。** 干跑会输出每个平台将要执行的 `cmd`，
先把这份计划给用户确认——这一份比任何口头承诺都能暴露问题（标题太长、缺封面、平台不对）。

稿件形状（`Draft`）：

```json
{"title": "标题", "kind": "video|note|article", "video": "a.mp4", "images": ["1.png"], "body": "正文", "tags": ["t1"]}
```

- `video` → 抖音/快手/小红书/B站/视频号
- `note`（图文）→ 抖音/快手/小红书
- `article` → 只有公众号（`sau` 的文章要 `--content-file`，本引擎不收该形态）

## 3. 首次登录：扫码这一步必须由用户完成

平台登录态由 `sau <platform> login --account <别名>` 自己维护，本仓库**从不读取、不存储、不打印 cookie**。

```bash
sau xiaohongshu login --account creator
sau xiaohongshu check --account creator     # 返回 ok / invalid
```

`--account` 是用户自己的别名，一账号一文件，可多账号并存。默认取 `config/publish.json` 的 `defaults.account`。

### 二维码要「展示」给用户，不是「报路径」

`conf.py` 里 `LOCAL_CHROME_HEADLESS = True`，登录时**没有可见浏览器窗口**——二维码会落成本地图片（通常是项目根下的 `qrcode.png`）。上游文档对此有明确要求，也是实际最容易踩的坑：

> 不要只把图片路径发给用户；这类二维码本身就是给用户扫码的，应优先直接展示图片。

所以：**把二维码图片给用户看（能内联就内联），路径只作补充**。只说「二维码在 xxx.png」等于没给。

三个平台有额外脾气：

- **B站**：不建议非交互环境代跑登录，让用户在自己的终端执行；二维码显示不全就提示打开 `qrcode.png`。
- **抖音**：触发短信二次验证时，程序先读项目根 `verify_code.txt`；交互式终端会直接提示输入。agent 场景写 `verify_code.txt` 提供验证码，验证后程序自动删除。**验证码由用户提供，不要自己编。**
- **视频号/小红书**：风控频繁，登录态容易过期；`check` 返回 invalid 就重新 login，不要反复重试 upload。

### 绝不触碰的边界

- 不索取、不保存用户平台密码；扫码是唯一入口。
- 不去抓/复用 cookie 文件做「免登录」。
- **公众号绝不用浏览器自动化**：后台强校验 + 风控，走野路子等于让用户拿封号换便利。只能用官方 API（§4）。

## 4. 公众号：只建草稿是默认，这是设计不是缺陷

走官方接口两步：`cgi-bin/draft/add` → `cgi-bin/freepublish/submit`。

`auto_publish=false` 是缺省——公众号发布**不可撤回**，草稿箱是安全落点，用户能在后台预览排版再点发布。要一步到位必须显式勾选。

硬约束（官方规定，不是我们的选择）：`title` ≤32 字、`author` ≤16 字、`digest` ≤120 字、`content` <2 万字符且 <1MB、正文图片 URL 必须来自微信「图文消息内图片」接口、封面 `thumb_media_id` 必须是永久 MediaID。

**已知未实现**（会静默降级，别承诺）：正文本地图片、封面 MediaID、定时发布。

## 5. 安装 / 排障 sau

安装在 `tools/sau`（工作区内，随仓库演进）：

```bash
cd tools/sau
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe -e .      # 国内必须走镜像，见下
.venv/Scripts/sau.exe --help
```

两个国内必踩的坑：

1. **pypi.org 直连超时** → 设镜像：`UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/`
2. **patchright 下载 chromium 失败**（国内 CDN 缺 `chromium-1208`，npmmirror 只到 1179）
   → **不要死磕下载**。`conf.py` 设 `LOCAL_CHROME_PATH` 指向系统 Chrome 即可：
   ```
   LOCAL_CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
   ```

`run.cmd` 会把 `tools/sau/.venv/Scripts` 注入 host 进程 PATH，所以 UI 与 `publish.py` 同时生效；
host 的 `sau_on_path()` 还会探测 `tools/sau` 固定位置，装好不必重启。

## 6. 失败怎么归因

`fan_out` **逐平台独立**，一路失败不影响其余，每条结果都带 `platform`。用户要的是「哪些发成功了」，不是「第一个错误」——所以**按平台列结果，不要只报第一条异常**。

超时（默认较长，浏览器上传慢）返回 `超时，上传可能仍在后台进行`：**先让用户去平台查有没有发出去，再决定重发**，不要盲目重试造成重复发布。
错误信息已经过 `redact()`（覆盖 secret/token/password/cookie/key），可直接转述给用户。

## 7. 这个技能为什么存在（形态判断）

分发**不该做成 skill 工具**：一次上传要几十秒到几分钟、可能要用户扫码，塞进对话工具调用会超时且拿不到人的互动。它也不该只做成 UI 按钮——UI 表达不了「这台机器装没装好、缺什么、下一步照做什么」。

正确形状就是现在这样：**配置在 UI、执行在 CLI、agent 靠本技能知道怎么调**。技能是给 agent 的说明书，不是执行体。

## 验收标准

一次分发动作合格，当且仅当：

1. **先看状态后动手**：动笔前跑过 `python scripts/publish.py status`，并对每行 `reason` 给出了对应动作（安装 / 让用户填凭证 / 扫码 / 换平台）。没跑 status 就直接 send 即不合格。
2. **干跑先于真发**：未获用户明确「发」指令时只用干跑；干跑输出的逐平台 `cmd` 计划已呈现给用户。`--apply` 只在用户明说后出现。
3. **二维码是展示不是路径**：需要登录时把二维码图片直接给用户看（内联或可打开的图片），不能只说「在 xxx.png」。
4. **按平台列结果**：结果逐平台列出（`platform` + 成功/失败/超时），不是只报第一条异常。超时按「先让用户去平台查，再决定重发」处理，不盲目重试。
5. **零凭证落盘**：全程未读取/存储/打印 cookie，未索取平台密码或 AppSecret，未把任何密钥写入文件或提交信息。

反例（一律判不合格）：自己拼 `sau` 命令绕过 `publish.py`；在对话里索要 AppSecret；公众号走浏览器自动化；把「超时」当失败直接重发导致重复发布。
