"""登录渠道按钮：前端渲染口径必须等于 `/api/upstream/providers`（P3 的机器判据）。

P3 的目标是「装了什么插件就有什么按钮」。这条目标有两个独立的失效方式，只测一个
都拦不住：

1. **后端没读到插件清单** → API 少了渠道。由 `GET /api/upstream/providers` 的实现
   保证，不在本文件范围（要跑 CLI，属运行态验收）。
2. **前端没按 API 渲染** → 又退回写死渠道表。症状是 API 有 9 个渠道而界面上还是
   当年那三个按钮，或者把 `usable=false` 的渠道渲染成可点按钮（点了必然报错，
   比没有按钮更糟）。

本文件守的是第 2 类：把「API 清单 → 按钮集合」的映射抽成纯函数
（`scripts/verify-login-buttons.py::expected_buttons`），这里断言它的口径，并
静态断言前端确实在调那个 API、且没有把渠道 id 写死在 HTML 里。

为什么不直接开浏览器：pytest 要能在没有 playwright、没有运行实例的机器上绿。
真浏览器那一步是 `scripts/verify-login-buttons.py` 的职责，看板 c4 会跑它。
"""
from __future__ import annotations

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify-login-buttons.py"
SETTINGS_JS = ROOT / "runtime" / "crates" / "host" / "web-dist" / "vendor" / "app-settings.js"
INDEX_HTML = ROOT / "runtime" / "crates" / "host" / "web-dist" / "index.html"


def _load_module():
    spec = importlib.util.spec_from_file_location("verify_login_buttons", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ExpectedButtons(unittest.TestCase):
    """映射口径：usable → 可点；不可用 → 灰显且文案带「需终端」。"""

    @classmethod
    def setUpClass(cls):
        cls.expected_buttons = staticmethod(_load_module().expected_buttons)

    def test_usable_provider_is_clickable(self):
        got = self.expected_buttons([{"id": "trae-cn", "name": "Trae CN", "usable": True}])
        self.assertEqual(got, [("trae-cn", "登录 Trae CN 账号", False)])

    def test_unusable_provider_is_disabled_with_terminal_hint(self):
        got = self.expected_buttons(
            [{"id": "qwenwork-enterprise", "name": "QwenWork 企业版", "usable": False}]
        )
        self.assertEqual(got, [("qwenwork-enterprise", "登录 QwenWork 企业版 账号（需终端）", True)])

    def test_order_follows_api_order(self):
        """顺序必须跟着 API 走：写死顺序 = 又一次把渠道表钉死在前端。"""
        api = [
            {"id": "b", "name": "B", "usable": True},
            {"id": "a", "name": "A", "usable": True},
        ]
        self.assertEqual([x[0] for x in self.expected_buttons(api)], ["b", "a"])
        self.assertEqual([x[0] for x in self.expected_buttons(list(reversed(api)))], ["a", "b"])

    def test_missing_name_falls_back_to_id(self):
        """插件可能不给 name：此时按钮不能是「登录  账号」（两个空格、指不到渠道）。"""
        got = self.expected_buttons([{"id": "kiro", "usable": True}])
        self.assertEqual(got, [("kiro", "登录 kiro 账号", False)])

    def test_mapping_has_teeth(self):
        """反向用例：把 usable 语义取反，必须能被上面几条抓到。

        没有这一条的话，「映射写反」和「映射写对」在本文件里可能是同一份绿——
        测试自己也要证明它会红。
        """

        def inverted(providers):
            out = []
            for p in providers:
                label = p.get("name") or p.get("id") or ""
                if not p.get("usable"):
                    out.append((p["id"], f"登录 {label} 账号", False))
                else:
                    out.append((p["id"], f"登录 {label} 账号（需终端）", True))
            return out

        api = [{"id": "trae-cn", "name": "Trae CN", "usable": True}]
        self.assertNotEqual(inverted(api), self.expected_buttons(api))


class FrontendContract(unittest.TestCase):
    """前端必须按 API 渲染，而不是自带一张渠道表。"""

    def test_settings_js_fetches_providers_api(self):
        js = SETTINGS_JS.read_text(encoding="utf-8")
        self.assertIn('"/api/upstream/providers"', js,
                      "app-settings.js 没有调 /api/upstream/providers：渠道表又写死了？")

    def test_settings_js_renders_into_login_btn_container(self):
        js = SETTINGS_JS.read_text(encoding="utf-8")
        self.assertIn('$("upstream-login-btns")', js,
                      "app-settings.js 没有往 #upstream-login-btns 渲染按钮")

    def test_settings_js_disables_unusable_provider(self):
        """灰显 + title 是「点了不动的按钮比没有按钮更糟」的落地判据。"""
        js = SETTINGS_JS.read_text(encoding="utf-8")
        self.assertRegex(js, r"b\.disabled\s*=\s*true",
                         "app-settings.js 没有把不可用渠道的按钮禁用")
        self.assertIn("plugin login", js,
                      "灰显按钮缺 title 终端命令：用户看到灰按钮却不知道该怎么办")

    def test_index_html_has_no_hardcoded_login_buttons(self):
        """写死的登录按钮（`upstream-login-qoder` 那一代）不得回流。"""
        html = INDEX_HTML.read_text(encoding="utf-8")
        hardcoded = re.findall(r'id="upstream-login-(?!btns\b)[a-z0-9-]+"', html)
        self.assertEqual(hardcoded, [],
                         f"index.html 又出现写死的登录按钮：{hardcoded}（应只留 #upstream-login-btns）")
        self.assertIn('id="upstream-login-btns"', html,
                      "index.html 缺 #upstream-login-btns 容器")


if __name__ == "__main__":
    unittest.main()
