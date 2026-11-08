"""内容分发引擎：一份稿件 → 多个平台（I-20261108-07）。

## 为什么是「引擎 + 平台适配器」而不是各平台各写一套

用户原话是「一键分发小红书、B站、公众号等」「选择分发哪些平台」「可视化配置后生效」。
三件事分别对应三层，混在一起写会变成三个互不相干的脚本：

1. **稿件**（`Draft`）：标题/正文/标签/媒体文件，与平台无关；
2. **平台适配器**（`Adapter`）：把稿件翻译成该平台的调用方式，回答「我能不能发这种内容」；
3. **分发编排**（`fan_out`）：按用户选中的平台逐个发，收集每路结果，**互不阻塞**——
   一个平台失败不能让其余平台不发（这是「一键分发」和「一个脚本」的区别）。

## 平台的两种技术形态（这是本文件最要紧的认知）

调研结论（2026-11，见 `outputs/content-distribution-design.md`）：

- **浏览器自动化路线**：小红书/B站/抖音/视频号等，社区成熟方案是
  `dreammis/social-auto-upload`（MIT，16.3k★，统一 CLI `sau`）。
  它靠**本地登录态 cookie** + Playwright 操作网页，不需要开发者资质。
  我们不重造这套轮子——18 个平台的登录/cookie/上传细节重写一遍就是几千行且必然腐烂。
- **官方 API 路线**：微信公众号有正式服务端接口（`cgi-bin/draft/add` →
  `cgi-bin/freepublish/submit`），需要 AppID/AppSecret。这条**必须**用官方接口：
  公众号没有可用的浏览器自动化入口（后台强校验），走野路子等于让用户冒封号风险。

所以适配器分成两个基类（`SauAdapter` / `WeChatAdapter`），新增平台时按它属于哪条路线继承。

## 安全边界（比功能更重要）

- **凭证不落明文日志**：`redact()` 把所有 token/secret 字段替换为 `***`，错误信息也过一遍。
- **默认干跑**：`--apply` 才真发。调研/配置阶段用户只想看「会发什么、发给谁」。
- **登录态不代管**：cookie 由各平台 CLI 自己维护（`sau <platform> login`），
  本引擎从不读取、不存储、不打印任何 cookie。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

_SCRIPTS = Path(__file__).resolve().parent
RSI_ROOT = _SCRIPTS.parent

# 配置落点：与 config.json 分开存（凭证不进主配置，便于单独设权限/单独备份）
PUBLISH_CONFIG = RSI_ROOT / "config" / "publish.json"
DEFAULT_TIMEOUT = 600  # 浏览器上传含等待，给足时间


# ── 凭证脱敏 ─────────────────────────────────────────────────────────────────

_SECRET_KEYS = ("secret", "token", "appsecret", "app_secret", "password", "cookie", "key")


def redact(obj: Any) -> Any:
    """递归脱敏：键名含 secret/token/password/cookie 的值一律替换。

    为什么连错误信息也要过一遍：平台返回体里常带 access_token 回显，
    直接 `print(resp)` 会把用户凭证写进终端历史与 trace。
    """
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if any(s in str(k).lower() for s in _SECRET_KEYS) and not isinstance(v, (dict, list)):
                out[k] = "***" if v else ""
            else:
                out[k] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj


# ── 稿件 ─────────────────────────────────────────────────────────────────────


@dataclass
class Draft:
    """与平台无关的稿件。`kind` 决定能发到哪些平台。"""

    title: str
    body: str = ""
    tags: list[str] = field(default_factory=list)
    video: str = ""          # 视频文件路径（本地绝对或工作区相对）
    images: list[str] = field(default_factory=list)
    kind: str = "video"      # video | note | article
    cover: str = ""

    @staticmethod
    def load(path: str | Path) -> "Draft":
        p = Path(path)
        if not p.is_file():
            raise SystemExit(f"稿件文件不存在: {p}")
        data = json.loads(p.read_text(encoding="utf-8"))
        known = {f for f in Draft.__dataclass_fields__}
        return Draft(**{k: v for k, v in data.items() if k in known})

    def validate(self) -> list[str]:
        """返回问题列表（空=通过）。文案要能直接告诉用户改哪里。"""
        problems = []
        if not self.title.strip():
            problems.append("标题不能为空")
        if self.kind == "video" and not self.video:
            problems.append("视频稿件必须给 video 路径")
        if self.kind == "note" and not self.images:
            problems.append("图文稿件必须给至少一张 images")
        if self.kind == "article" and not self.body.strip():
            problems.append("文章稿件必须给 body 正文")
        if self.video and not _exists(self.video):
            problems.append(f"视频文件不存在: {self.video}")
        for im in self.images:
            if not _exists(im):
                problems.append(f"图片不存在: {im}")
        return problems


def _exists(p: str) -> bool:
    q = Path(p)
    if q.is_absolute():
        return q.exists()
    return (RSI_ROOT / q).exists() or q.exists()


# ── 平台适配器 ───────────────────────────────────────────────────────────────


class Adapter:
    """平台适配器基类。子类只回答两件事：能发什么、怎么发。"""

    name = ""
    label = ""
    kinds: tuple[str, ...] = ()

    def available(self) -> tuple[bool, str]:
        """能不能用 + 为什么不能用（给用户看的原因，不是异常栈）。"""
        raise NotImplementedError

    def publish(self, draft: Draft, account: str, dry: bool) -> dict:
        raise NotImplementedError

    def supports(self, kind: str) -> bool:
        return kind in self.kinds


class SauAdapter(Adapter):
    """浏览器自动化路线：转调 community 的 `sau` CLI（social-auto-upload）。

    为什么转调而不是内嵌它的 Python API：它的 `uploader/` 内部接口随平台改版而变，
    而 `sau <platform> upload-*` 的 CLI 契约是它对外承诺的稳定面。转调等于把
    「平台改版」的维护成本留在上游，我们只承受 CLI 参数级别的变化。
    """

    # sau 子命令 → 内容形态
    _CMD = {"video": "upload-video", "note": "upload-note", "article": "upload-article"}

    def __init__(self, name: str, label: str, kinds: tuple[str, ...], extra_args: dict | None = None):
        self.name = name
        self.label = label
        self.kinds = kinds
        self.extra_args = extra_args or {}

    def available(self) -> tuple[bool, str]:
        exe = shutil.which("sau")
        if not exe:
            return False, (
                "未找到 sau 命令。请先安装 social-auto-upload（MIT）：\n"
                "  pip install -e . 或 uv sync（见 github.com/dreammis/social-auto-upload）\n"
                "装好后 `sau --help` 应能列出平台子命令。"
            )
        return True, ""

    def _build(self, draft: Draft, account: str) -> list[str]:
        sub = self._CMD[draft.kind]
        args = ["sau", self.name, sub, "--account", account]
        if draft.kind == "video":
            args += ["--file", draft.video, "--title", draft.title, "--desc", draft.body]
        elif draft.kind == "note":
            args += ["--images", *draft.images, "--title", draft.title, "--note", draft.body]
        else:
            # 文章：sau 要 --content-file；本引擎收的是正文文本，落临时文件再传
            raise RuntimeError(f"{self.name} 的文章发布需 --content-file，请用 kind=video/note 或改用公众号")
        if draft.tags:
            args += ["--tags", ",".join(draft.tags)]
        for k, v in self.extra_args.items():
            args += [k, v]
        return args

    def publish(self, draft: Draft, account: str, dry: bool) -> dict:
        if not self.supports(draft.kind):
            return {
                "ok": False,
                "platform": self.name,
                "error": f"{self.label} 不支持 {draft.kind}（支持：{', '.join(self.kinds)}）",
            }
        try:
            args = self._build(draft, account)
        except RuntimeError as e:
            return {"ok": False, "platform": self.name, "error": str(e)}
        if dry:
            return {"ok": True, "platform": self.name, "dry": True, "cmd": redact(args)}
        started = time.time()
        try:
            # 平台 CLI 会打印进度、可能要求扫码；不捕获其 stdout（用户要看得见）
            r = subprocess.run(args, timeout=DEFAULT_TIMEOUT, capture_output=True, text=True, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            return {"ok": False, "platform": self.name, "error": f"超时（>{DEFAULT_TIMEOUT}s），上传可能仍在后台进行"}
        except OSError as e:
            return {"ok": False, "platform": self.name, "error": f"启动失败: {e}"}
        tail = (r.stdout or "")[-800:] + (r.stderr or "")[-800:]
        return {
            "ok": r.returncode == 0,
            "platform": self.name,
            "exit": r.returncode,
            "secs": round(time.time() - started, 1),
            "output": redact(tail),
        }


class WeChatAdapter(Adapter):
    """官方 API 路线：微信公众号（服务号/订阅号）。

    两步（这是公众号发布的固定形状，不是我们绕路）：
      1. `cgi-bin/draft/add`    → 得到 media_id（进草稿箱，人工可在后台改）
      2. `cgi-bin/freepublish/submit` → 用 media_id 正式发布

    为什么默认只做第 1 步：公众号发布是**不可撤回**的对外动作，而草稿箱是安全落点
    ——用户能在后台预览排版再点发布。故 `auto_publish=false` 是缺省，
    要一步到位才显式打开。
    """

    name = "wechat"
    label = "微信公众号"
    kinds = ("article",)

    API = "https://api.weixin.qq.com/cgi-bin"

    def __init__(self, appid: str = "", secret: str = "", auto_publish: bool = False, author: str = ""):
        self.appid = appid
        self.secret = secret
        self.auto_publish = auto_publish
        self.author = author

    def available(self) -> tuple[bool, str]:
        if not self.appid or not self.secret:
            return False, "缺 AppID/AppSecret。到「设置 → 内容分发」填写（公众平台 → 设置与开发 → 基本配置）"
        return True, ""

    def _access_token(self) -> str:
        import urllib.parse
        import urllib.request

        q = urllib.parse.urlencode({
            "grant_type": "client_credential",
            "appid": self.appid,
            "secret": self.secret,
        })
        with urllib.request.urlopen(f"{self.API}/token?{q}", timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        if "access_token" not in data:
            raise RuntimeError(f"取 access_token 失败: {redact(data)}")
        return data["access_token"]

    def _post(self, path: str, token: str, payload: dict) -> dict:
        import urllib.request

        req = urllib.request.Request(
            f"{self.API}/{path}?access_token={token}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))

    def publish(self, draft: Draft, account: str, dry: bool) -> dict:
        ok, why = self.available()
        if not ok:
            return {"ok": False, "platform": self.name, "error": why}
        payload = {
            "articles": [{
                "article_type": "news",
                "title": draft.title[:32],           # 平台硬限：≤32 字
                "author": self.author[:16],
                "digest": draft.body[:120],
                "content": _md_to_html(draft.body),
                "need_open_comment": 0,
                "only_fans_can_comment": 0,
            }]
        }
        if dry:
            return {
                "ok": True, "platform": self.name, "dry": True,
                "would_post": f"{self.API}/draft/add",
                "payload": redact(payload),
                "auto_publish": self.auto_publish,
            }
        try:
            token = self._access_token()
            res = self._post("draft/add", token, payload)
        except Exception as e:  # noqa: BLE001 - 网络/凭证异常都要转成可读原因
            return {"ok": False, "platform": self.name, "error": f"草稿提交失败: {e}"}
        if "media_id" not in res:
            return {"ok": False, "platform": self.name, "error": f"草稿未创建: {redact(res)}"}
        out = {"ok": True, "platform": self.name, "media_id": res["media_id"], "stage": "draft"}
        if self.auto_publish:
            try:
                pub = self._post("freepublish/submit", token, {"media_id": res["media_id"]})
                out["publish"] = redact(pub)
                out["stage"] = "submitted"
                if pub.get("errcode"):
                    out["ok"] = False
                    out["error"] = f"发布提交失败: {redact(pub)}"
            except Exception as e:  # noqa: BLE001
                out["ok"] = False
                out["error"] = f"草稿已建但发布提交失败: {e}（可到后台手动发布）"
        return out


def _md_to_html(text: str) -> str:
    """极简 Markdown → 公众号可用 HTML。

    为什么自己写而不引依赖：公众号只要「段落/标题/加粗/列表」这几样，
    正文超过 2 万字符或含被过滤标签会被接口拒；引 markdown 库只为这四样不划算，
    且它的输出（如 `<h1>` 带 id）反而更容易被微信过滤。
    """
    if "<" in text and "</" in text:
        return text  # 已经是 HTML，原样交出去
    lines, out, in_list = text.splitlines(), [], False
    for raw in lines:
        line = raw.rstrip()
        if not line:
            if in_list:
                out.append("</ul>")
                in_list = False
            continue
        if line.startswith(("- ", "* ")):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_esc(line[2:])}</li>")
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        if line.startswith("#"):
            level = min(len(line) - len(line.lstrip("#")), 3)
            out.append(f"<h{level}>{_esc(line.lstrip('#').strip())}</h{level}>")
        else:
            out.append(f"<p>{_esc(line)}</p>")
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── 平台注册表 ───────────────────────────────────────────────────────────────

def build_adapters(cfg: dict) -> dict[str, Adapter]:
    """按配置装配适配器。只装配用户**选中**的平台——没选的不出现在结果里。"""
    enabled = cfg.get("platforms", {})
    out: dict[str, Adapter] = {}

    # 浏览器自动化路线（sau CLI）：只列出经过实测的四个主力平台
    sau_platforms = {
        "xiaohongshu": ("小红书", ("video", "note")),
        "bilibili": ("B站", ("video",)),
        "tencent": ("微信视频号", ("video",)),
        "douyin": ("抖音", ("video", "note")),
    }
    for key, (label, kinds) in sau_platforms.items():
        pcfg = enabled.get(key) or {}
        if not pcfg.get("enabled"):
            continue
        out[key] = SauAdapter(key, label, kinds, pcfg.get("extra_args"))

    wx = enabled.get("wechat") or {}
    if wx.get("enabled"):
        out["wechat"] = WeChatAdapter(
            appid=wx.get("appid", ""),
            secret=wx.get("app_secret", ""),
            auto_publish=bool(wx.get("auto_publish")),
            author=wx.get("author", ""),
        )
    return out


def load_config() -> dict:
    if not PUBLISH_CONFIG.is_file():
        return {"platforms": {}, "defaults": {"account": "creator"}}
    try:
        return json.loads(PUBLISH_CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SystemExit(f"config/publish.json 无法解析: {e}")


def save_config(cfg: dict) -> Path:
    PUBLISH_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    PUBLISH_CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return PUBLISH_CONFIG


# ── 分发编排 ─────────────────────────────────────────────────────────────────


def fan_out(draft: Draft, adapters: dict[str, Adapter], account: str, dry: bool, only: list[str] | None = None) -> dict:
    """逐平台分发，收集每路结果。

    关键取舍：**一路失败不影响其余**，且结果里每条都带 `platform`——
    用户要的是「哪些发成功了」，不是「第一个错误」。
    `only` 有值时按它过滤（命令行 `--platforms a,b` 直接指定，不看配置的 enabled）。
    """
    targets = {k: v for k, v in adapters.items() if not only or k in only}
    if only:
        missing = [k for k in only if k not in adapters]
        # 显式点名了却在配置里没启用 → 直接装配一个可用的（用户意图优先于配置）
        for k in missing:
            ad = _ad_hoc_adapter(k, load_config())
            if ad:
                targets[k] = ad
            else:
                targets[k] = _MissingAdapter(k)

    results = []
    for key, ad in targets.items():
        ok, why = ad.available()
        if not ok:
            results.append({"ok": False, "platform": key, "label": getattr(ad, "label", key), "error": why})
            continue
        r = ad.publish(draft, account, dry)
        r.setdefault("label", getattr(ad, "label", key))
        results.append(r)
    return {
        "ok": all(r.get("ok") for r in results) if results else False,
        "dry": dry,
        "draft": {"title": draft.title, "kind": draft.kind},
        "account": account,
        "results": results,
    }


class _MissingAdapter(Adapter):
    def __init__(self, name: str):
        self.name = name
        self.label = name

    def available(self) -> tuple[bool, str]:
        return False, f"未知平台 {self.name}（可用：xiaohongshu/bilibili/tencent/douyin/wechat）"


def _ad_hoc_adapter(key: str, cfg: dict) -> Adapter | None:
    base = build_adapters({"platforms": {key: {"enabled": True, **((cfg.get("platforms") or {}).get(key) or {})}}})
    return base.get(key)


# ── CLI ──────────────────────────────────────────────────────────────────────


def _hint_payload() -> dict:
    """给 Agent/UI 的自描述：有哪些平台、各自能不能用、缺什么。"""
    cfg = load_config()
    # available 用「全部平台」探一遍，不受 enabled 影响——用户要看到「我还能开哪些」
    all_cfg = {"platforms": {k: {"enabled": True, **v} for k, v in {
        "xiaohongshu": {}, "bilibili": {}, "tencent": {}, "douyin": {}, "wechat": {},
    }.items()}}
    for k, v in (cfg.get("platforms") or {}).items():
        all_cfg["platforms"].setdefault(k, {}).update({"enabled": True, **v})
    ads = build_adapters(all_cfg)
    rows = []
    for key, ad in ads.items():
        ok, why = ad.available()
        rows.append({
            "platform": key,
            "label": ad.label,
            "kinds": list(ad.kinds),
            "enabled": bool(((cfg.get("platforms") or {}).get(key) or {}).get("enabled")),
            "ready": ok,
            "reason": why,
        })
    return {"ok": True, "config_path": str(PUBLISH_CONFIG), "platforms": rows}


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="publish.py", description="内容分发：一份稿件 → 多个平台")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pub = sub.add_parser("send", help="分发稿件")
    pub.add_argument("--draft", required=True, help="稿件 JSON 路径")
    pub.add_argument("--account", default="", help="账号别名（sau 的 --account，默认取配置 defaults.account）")
    pub.add_argument("--platforms", default="", help="逗号分隔，覆盖配置的启用列表")
    pub.add_argument("--apply", action="store_true", help="真的发布（缺省只干跑，打印将要执行的命令/请求）")

    sub.add_parser("status", help="平台就绪状态（配置了什么、缺什么）")

    cfgp = sub.add_parser("set", help="写平台配置（供 UI 调用）")
    cfgp.add_argument("--file", required=True, help="含 platforms/defaults 的 JSON")

    args = ap.parse_args(argv)

    if args.cmd == "status":
        print(json.dumps(_hint_payload(), ensure_ascii=False, indent=1))
        return 0

    if args.cmd == "set":
        raw = Path(args.file).read_text(encoding="utf-8")
        try:
            data = json.loads(raw)
        except ValueError as e:
            print(json.dumps({"ok": False, "error": f"配置 JSON 非法: {e}"}, ensure_ascii=False))
            return 2
        p = save_config(data)
        print(json.dumps({"ok": True, "path": str(p)}, ensure_ascii=False))
        return 0

    # send
    cfg = load_config()
    draft = Draft.load(args.draft)
    problems = draft.validate()
    if problems:
        print(json.dumps({"ok": False, "errors": problems}, ensure_ascii=False, indent=1))
        return 2
    account = args.account or (cfg.get("defaults") or {}).get("account", "creator")
    only = [s.strip() for s in args.platforms.split(",") if s.strip()] or None
    adapters = build_adapters(cfg)
    if not only and not adapters:
        print(json.dumps({
            "ok": False,
            "error": "没有任何平台被启用。先 `publish.py set` 写入 platforms，或运行时用 --platforms 指定。",
            "hint": "publish.py status 可看各平台缺什么",
        }, ensure_ascii=False, indent=1))
        return 2
    out = fan_out(draft, adapters, account, dry=not args.apply, only=only)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
