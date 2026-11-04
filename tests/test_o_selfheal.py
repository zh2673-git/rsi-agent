"""O 轮自愈回归（独立套件；python -m unittest discover -s tests -v 可收）。

锚定第三轮（O1/O2）的行为契约——「硬拒绝」改「就地自愈」的语义边界：
- optional_int：越界 clamp 到最近合法端点 + params_adjusted 审计清单；范围内值不动；
- grep：本调用窗口内的 clamp 以「参数已自动修正」提示透出；dispatch 每调用清窗口；
- edit_file：白空间归一（全角空格/行首尾/连续空白）**唯一**命中 → mode=whitespace
  就地替换；多处命中不猜（维持 EDIT_NO_MATCH 语义）。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

RSI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RSI_ROOT / "runtime" / "plugins" / "tools"))

import tools  # noqa: E402
from tools import files as files_mod  # noqa: E402
from tools import grep as grep_mod  # noqa: E402


class OptionalIntClampTest(unittest.TestCase):
    def setUp(self):
        tools._PARAMS_ADJUSTED.clear()

    def test_over_high_clamps(self):
        self.assertEqual(tools.optional_int({}, "k", 0, 0, 10), 0)
        self.assertEqual(tools.optional_int({"k": 25}, "k", 0, 0, 10), 10)
        self.assertEqual(len(tools._PARAMS_ADJUSTED), 1)

    def test_below_low_clamps(self):
        self.assertEqual(tools.optional_int({"k": -3}, "k", 0, 0, 10), 0)
        self.assertEqual(len(tools._PARAMS_ADJUSTED), 1)

    def test_in_range_untouched(self):
        self.assertEqual(tools.optional_int({"k": 7}, "k", 0, 0, 10), 7)
        self.assertEqual(tools._PARAMS_ADJUSTED, [])

    def test_request_recorded(self):
        tools._PARAMS_ADJUSTED.clear()
        tools.optional_int({"k": 99}, "k", 0, 0, 10)
        rec = tools._PARAMS_ADJUSTED[-1]
        self.assertEqual(rec["requested"], 99)
        self.assertEqual(rec["clamped_to"], 10)


class GrepClampHintTest(unittest.TestCase):
    def setUp(self):
        tools._PARAMS_ADJUSTED.clear()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "a.py").write_text("hello world\n", encoding="utf-8")
        self.root = str(root)
        self._saved_ws = os.environ.get("WORKSPACE_ROOT")
        os.environ["WORKSPACE_ROOT"] = self.root  # _guard 契约：搜索根必须在工作区内

    def tearDown(self):
        tools._PARAMS_ADJUSTED.clear()
        if self._saved_ws is None:
            os.environ.pop("WORKSPACE_ROOT", None)
        else:
            os.environ["WORKSPACE_ROOT"] = self._saved_ws
        self.tmp.cleanup()

    def test_no_hint_when_in_range(self):
        out = grep_mod.TOOLS["grep"]["run"]({"pattern": "hello", "path": self.root})
        self.assertNotIn("参数已自动修正", out)

    def test_hint_when_clamped(self):
        out = grep_mod.TOOLS["grep"]["run"](
            {"pattern": "hello", "path": self.root, "context_after": 30}
        )
        self.assertIn("参数已自动修正", out)
        self.assertIn("context_after 30→10", out)


class EditWhitespaceHealTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Path(self.tmp.name) / "f.txt"
        self._saved_ws = os.environ.get("WORKSPACE_ROOT")
        os.environ["WORKSPACE_ROOT"] = self.tmp.name  # _guard_write 契约：写入目标须在工作区内

    def tearDown(self):
        if self._saved_ws is None:
            os.environ.pop("WORKSPACE_ROOT", None)
        else:
            os.environ["WORKSPACE_ROOT"] = self._saved_ws
        self.tmp.cleanup()

    def _edit(self, old, new):
        return files_mod.TOOLS["edit_file"]["run"](
            {"path": str(self.p), "old_string": old, "new_string": new}
        )

    def test_whitespace_diff_healed(self):
        self.p.write_text("def  f():\n    pass\n", encoding="utf-8")  # 双半角空格
        r = self._edit("def f():", "def g():")  # 单空格提交（空白形态不一致）
        self.assertEqual(r["match_mode"], "whitespace")
        self.assertIn("def g():", self.p.read_text(encoding="utf-8"))
        self.assertIn("    pass", self.p.read_text(encoding="utf-8"))

    def test_ambiguous_not_guessed(self):
        self.p.write_text("x  1\nx  2\nz\nx  1\nx  2\n", encoding="utf-8")
        with self.assertRaises(files_mod.ToolError) as cm:
            self._edit("x 1\nx 2", "y")  # 白空间归一后命中两个窗口 → 不猜
        self.assertEqual(cm.exception.code, "EDIT_NO_MATCH")

    def test_exact_edit_unaffected(self):
        self.p.write_text("alpha\nbeta\n", encoding="utf-8")
        r = self._edit("alpha", "ALPHA")
        self.assertEqual(r["match_mode"], "exact")
        self.assertEqual(self.p.read_text(encoding="utf-8"), "ALPHA\nbeta\n")


if __name__ == "__main__":
    unittest.main()
