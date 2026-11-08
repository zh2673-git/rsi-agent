"""I-20261108-07 内容分发：静态契约 + Python 引擎冒烟。

Rust 侧有单测（`web::api::publish::tests`）覆盖就绪判定，但有两类事只有这里能测：
  1. **跨语言契约**：`publish.py` 与 `publish.rs` 的平台清单/字段名必须同源，
     任一侧单方面改会当场失败（这类漂移在活体上表现为「面板里少一个平台」）；
  2. **引擎的拒绝路径**：稿件不合法、平台未启用、缺凭证时，必须给出可照做的原因
     而不是抛栈。

活体 HTTP 验证（路由真的注册、secret 不回显）在 `tests/` 里以 Rust 单测 +
手工 e2e 覆盖，因为起进程的用例在 CI 上不稳；这里保证「不装 host 也能跑红的契约」。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLISH_PY = ROOT / "scripts" / "publish.py"
PUBLISH_RS = ROOT / "runtime" / "crates" / "host" / "src" / "web" / "api" / "publish.rs"


def run(*args: str) -> tuple[int, dict]:
    r = subprocess.run(
        [sys.executable, str(PUBLISH_PY), *args],
        capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=str(ROOT),
    )
    try:
        return r.returncode, json.loads(r.stdout)
    except ValueError:
        return r.returncode, {"raw": r.stdout, "err": r.stderr}


class PlatformContractTest(unittest.TestCase):
    """两侧平台清单必须同源——漂移的表现是「面板里少一个平台」。"""

    def test_same_platforms_on_both_sides(self):
        py = (ROOT / "scripts" / "publish.py").read_text(encoding="utf-8")
        rs = PUBLISH_RS.read_text(encoding="utf-8")
        for name in ("xiaohongshu", "bilibili", "tencent", "douyin", "wechat"):
            self.assertIn(f'"{name}"', py, f"publish.py 缺平台 {name}")
            self.assertIn(f'"{name}"', rs, f"publish.rs 缺平台 {name}")

    def test_user_named_three_platforms_are_present(self):
        """用户原话点名的三处：小红书、B站、公众号。少一个就是没做到。"""
        py = (ROOT / "scripts" / "publish.py").read_text(encoding="utf-8")
        self.assertIn("小红书", py)
        self.assertIn("B站", py)
        self.assertIn("微信公众号", py)

    def test_wechat_uses_official_api_not_browser(self):
        """公众号必须走官方 draft/add：没有可用的浏览器自动化入口，野路子=封号风险。"""
        py = (ROOT / "scripts" / "publish.py").read_text(encoding="utf-8")
        self.assertIn("cgi-bin", py)
        self.assertIn("draft/add", py)

    def test_browser_route_is_delegated_to_upstream_cli(self):
        """浏览器自动化不重造：转调 sau CLI（上游 MIT 项目），只承受 CLI 参数级变化。"""
        py = (ROOT / "scripts" / "publish.py").read_text(encoding="utf-8")
        self.assertIn('"sau"', py)
        self.assertIn("social-auto-upload", py)


class SecretHygieneTest(unittest.TestCase):
    """凭证不进明文——这是本功能最容易出事的地方。"""

    def test_redact_covers_common_key_names(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import publish

        out = publish.redact({
            "app_secret": "A", "access_token": "B", "password": "C",
            "cookie": "D", "nested": {"appsecret": "E"}, "ok": 1,
        })
        for k in ("app_secret", "access_token", "password", "cookie"):
            self.assertEqual(out[k], "***", f"{k} 必须脱敏")
        self.assertEqual(out["nested"]["appsecret"], "***", "嵌套也要脱敏")
        self.assertEqual(out["ok"], 1, "非敏感字段不该被改")

    def test_rs_never_returns_plaintext_secret(self):
        rs = PUBLISH_RS.read_text(encoding="utf-8")
        # GET 只回 secret_set，不回 app_secret 明文
        self.assertIn("secret_set", rs)
        self.assertNotRegex(rs, r'obj\.insert\(\s*"app_secret"', "GET 不得回明文 secret")


class EngineRejectPathTest(unittest.TestCase):
    """拒绝路径：原因要能照做，不抛栈。"""

    def test_status_lists_every_platform_with_reason(self):
        code, out = run("status")
        self.assertEqual(code, 0, out)
        names = {p["platform"] for p in out["platforms"]}
        for want in ("xiaohongshu", "bilibili", "tencent", "douyin", "wechat"):
            self.assertIn(want, names)
        for p in out["platforms"]:
            if not p["ready"]:
                self.assertTrue(p["reason"].strip(), f"{p['platform']} 不可用却没给原因")

    def test_bad_draft_is_rejected_with_readable_reason(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td) / "bad.json"
            d.write_text(json.dumps({"title": "", "kind": "video"}), encoding="utf-8")
            code, out = run("send", "--draft", str(d), "--platforms", "wechat")
            self.assertNotEqual(code, 0)
            self.assertFalse(out.get("ok"))
            joined = json.dumps(out, ensure_ascii=False)
            self.assertIn("标题", joined, "空标题要说清是标题问题")
            self.assertIn("video", joined, "缺视频要说清缺什么")

    def test_nothing_enabled_is_rejected_not_silently_empty(self):
        """无平台启用时必须明确失败——静默返回空 results 会让用户以为「发过了」。"""
        with tempfile.TemporaryDirectory() as td:
            d = Path(td) / "ok.json"
            d.write_text(json.dumps({"title": "t", "kind": "article", "body": "x"}), encoding="utf-8")
            cfgdir = Path(td) / "config"
            cfgdir.mkdir()
            (cfgdir / "publish.json").write_text(json.dumps({"platforms": {}}), encoding="utf-8")
            # 不指定 --platforms 且配置里没有启用项 → 必须报错
            r = subprocess.run(
                [sys.executable, str(PUBLISH_PY), "send", "--draft", str(d)],
                capture_output=True, text=True, encoding="utf-8", timeout=60, cwd=str(ROOT),
            )
            self.assertNotEqual(r.returncode, 0, r.stdout)
            self.assertIn("没有任何平台被启用", r.stdout)


class DraftShapeTest(unittest.TestCase):
    def test_markdown_to_wechat_html(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import publish

        html = publish._md_to_html("# 标题\n正文\n\n- 一\n- 二\n")
        self.assertIn("<h1>标题</h1>", html)
        self.assertIn("<p>正文</p>", html)
        self.assertIn("<ul>", html)
        self.assertEqual(html.count("<li>"), 2)

    def test_html_passthrough_is_not_double_escaped(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import publish

        src = "<p>已有 HTML</p>"
        self.assertEqual(publish._md_to_html(src), src, "已是 HTML 就原样交出，别再包一层")


class SauDiscoveryTest(unittest.TestCase):
    """sau 定位不能只查 PATH —— PATH 是宿主启动时的快照。

    实际踩过：把 sau 装到 tools/sau 后，运行中的 host 里 `shutil.which("sau")`
    仍是 None，UI 四个浏览器平台一起误报「未找到 sau 命令」，用户以为没装好。
    """

    def _load(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import publish

        return publish

    def test_finds_workspace_install_even_when_path_is_stale(self):
        """PATH 上没有，但 tools/sau 有 → 必须认。"""
        publish = self._load()
        with tempfile.TemporaryDirectory() as td:
            fake_root = Path(td)
            exe = fake_root / "tools" / "sau" / ".venv" / "Scripts" / "sau.exe"
            exe.parent.mkdir(parents=True)
            exe.write_text("x", encoding="utf-8")
            old_root, old_path = publish.RSI_ROOT, os.environ.get("PATH", "")
            publish.RSI_ROOT = fake_root
            os.environ["PATH"] = ""          # 模拟「host 启动后 PATH 里还没有 sau」
            try:
                got = publish.sau_exe()
            finally:
                publish.RSI_ROOT, os.environ["PATH"] = old_root, old_path
            self.assertIsNotNone(got, "只查 PATH 就会漏掉 tools/sau 里的安装")
            self.assertTrue(got.endswith("sau.exe"), got)

    def test_returns_none_when_nothing_installed(self):
        """两处都没有就老实返回 None，让上层给出可照做的原因。"""
        publish = self._load()
        with tempfile.TemporaryDirectory() as td:
            old_root, old_path = publish.RSI_ROOT, os.environ.get("PATH", "")
            publish.RSI_ROOT = Path(td)
            os.environ["PATH"] = ""
            try:
                self.assertIsNone(publish.sau_exe())
            finally:
                publish.RSI_ROOT, os.environ["PATH"] = old_root, old_path

    def test_available_reason_tells_how_to_install(self):
        """未装时的原因必须给可执行的一步，而不是让用户去猜。"""
        publish = self._load()
        with tempfile.TemporaryDirectory() as td:
            old_root, old_path = publish.RSI_ROOT, os.environ.get("PATH", "")
            publish.RSI_ROOT = Path(td)
            os.environ["PATH"] = ""
            try:
                ad = publish.SauAdapter("xiaohongshu", "小红书", ("video",))
                ok, why = ad.available()
            finally:
                publish.RSI_ROOT, os.environ["PATH"] = old_root, old_path
            self.assertFalse(ok)
            self.assertIn("install_sau.py", why, "要说清一条能照做的安装命令")


if __name__ == "__main__":
    unittest.main()
