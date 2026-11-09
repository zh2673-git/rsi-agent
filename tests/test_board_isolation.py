# -*- coding: utf-8 -*-
"""测试隔离与「布局被测试写坏」的回归。

实测事故（两次，同一个根因）：
1. 一次全量跑往真实账本塞了 34 条 `tmp*` 垃圾任务（任务号占到 T-20261109-44）。
2. 更隐蔽的一次：`test_layout_written_by_cli_is_visible_to_host_and_persists`
   用 `{"sections": [{"id": "tasks", "kind": "tasks", "title": "我的任务"}]}`
   写布局，落进了代码根那本真账 —— 于是用户的**灵感看板整段消失**。
   灵感数据 26 条一条没丢，只是 layout.sections 里没有 inspirations 段了。

根因是 `board.py::data_root()` 的判定顺序 `RSI_HOME` -> `WORKSPACE_ROOT`：
用例设了 `WORKSPACE_ROOT=<tempdir>`，但 agent 进程环境里带着 `RSI_HOME=<代码根>`，
于是每一次写都命中真账。`tests/conftest.py` 在会话开始就摘掉这两个变量。

这里钉死三件事：
- conftest 必须真的摘掉 `RSI_HOME` / `RSI_BOARD_PATH`（摘一半等于没摘）；
- 每个会写账的测试模块，用的临时工作区不得是代码根；
- 兜底布局必须同时含任务段和灵感段 —— 缺灵感段的默认值本身就是个 bug。
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BOARD_PY = "scripts/board.py"
BOARD_RS = "runtime/crates/host/src/web/api/board.rs"
APP_BOARD = "runtime/crates/host/web-dist/vendor/app-board.js"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class ConftestIsolationTest(unittest.TestCase):
    """conftest 是唯一的隔离闸：它坏了，全量跑就会写坏用户真账。"""

    def test_conftest_pops_rsi_home(self):
        src = read("tests/conftest.py")
        self.assertIn('"RSI_HOME"', src,
                      "conftest 没摘 RSI_HOME —— data_root() 会优先命中它，测试写进真账")
        self.assertIn('"RSI_BOARD_PATH"', src,
                      "conftest 没摘 RSI_BOARD_PATH —— 显式指向的账本照样被测试写")
        self.assertIn("os.environ.pop", src,
                      "conftest 必须真的 pop 掉，不能只是断言")

    def test_conftest_runs_before_any_test_module(self):
        # conftest.py 在 rootdir/tests 下即自动加载；若被挪走或改名，隔离静默失效。
        self.assertTrue((ROOT / "tests" / "conftest.py").is_file(),
                        "tests/conftest.py 不存在 —— 测试隔离整体失效")
        ini = read("pytest.ini")
        self.assertIn("testpaths = tests", ini,
                      "pytest 未锁定 tests/，conftest 可能不在加载路径上")


class DefaultLayoutKeepsInspirationsTest(unittest.TestCase):
    """兜底布局缺灵感段 = 用户灵感看板凭空消失（本次事故的形态）。"""

    def test_python_default_layout_has_both_kinds(self):
        src = read(BOARD_PY)
        seg = src[src.index("DEFAULT_LAYOUT = {"):]
        seg = seg[: seg.index("\n}")]
        self.assertIn('"kind": "tasks"', seg, "兜底布局缺任务段")
        self.assertIn('"kind": "inspirations"', seg, "兜底布局缺灵感段")

    def test_rust_default_layout_has_both_kinds(self):
        src = read(BOARD_RS)
        seg = src[src.index("fn default_layout() -> Value {"):]
        seg = seg[: seg.index("\n}")]
        self.assertIn('"kind": "tasks"', seg, "兜底布局缺任务段")
        self.assertIn('"kind": "inspirations"', seg, "兜底布局缺灵感段")

    def test_frontend_fallback_has_both_kinds(self):
        src = read(APP_BOARD)
        seg = src[src.index("const DEFAULT_SECTIONS = ["):]
        seg = seg[: seg.index("\n];")]
        self.assertIn('kind: "tasks"', seg, "前端兜底缺任务段")
        self.assertIn('kind: "inspirations"', seg, "前端兜底缺灵感段")

    def test_live_board_layout_still_has_inspirations(self):
        """真账本若只剩任务段，说明又被某次跑写坏了 —— 直接红，别等用户发现。"""
        path = Path(os.environ.get("RSI_HOME") or ROOT) / ".rsi" / "board.json"
        if not path.is_file():
            self.skipTest("本机没有真账本（CI/干净检出）")
        board = json.loads(path.read_text(encoding="utf-8"))
        kinds = [s.get("kind") for s in (board.get("layout") or {}).get("sections") or []]
        if not kinds:
            self.skipTest("账本未写自定义布局，走兜底（兜底已单测）")
        self.assertIn("inspirations", kinds,
                      f"真账本的布局丢了灵感段（当前 {kinds}）—— 灵感看板会整段消失")
        self.assertIn("tasks", kinds,
                      f"真账本的布局丢了任务段（当前 {kinds}）")


if __name__ == "__main__":
    unittest.main()
