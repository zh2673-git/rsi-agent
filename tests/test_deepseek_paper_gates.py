"""I-13：deepseek-paper 借鉴 Nature 图表规范的契约测试。

为什么这几条值得被测试钉住（而不是只写在文档里）：

1. **G13 必须双向**。只验「坏稿判红」的实现很容易退化成「永远红」，
   只验「好稿判绿」的又容易退化成「永远绿」。两个方向同时钉住才有意义。
2. **G13 与 G14 必须彼此独立**。它们查的是两件事：口径有没有声明 / 图注有没有
   给 n。合成一条就会掩盖「声明了口径但没说几次重复」这个真实缺口。
3. **G13 不能对单点数字误报**。DeepSeek 原文大量出现 `FLOPs per 2K Tokens`、
   `2664K GPU hours` 这类单点量，它们没有误差语义，不该要求统计声明。
   若误报，写作者会为了过门禁给纯数字硬加 `n=`，那是污染。

Nature 依据（2026-11 抓取官方作者指南）：
  - "All error bars and statistics must be defined in the figure legend."
  - "The exact sample size (n) for each experimental group/condition,
     given as a discrete number and unit of measurement"
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINT = ROOT / "skills" / "deepseek-paper" / "tools" / "paper_lint.py"


def gates_for(text: str) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(text)
        p = f.name
    try:
        r = subprocess.run([sys.executable, str(LINT)],
                           input=json.dumps({"args": {"path": p}}),
                           capture_output=True, text=True, encoding="utf-8")
        return {g["id"]: g for g in json.loads(r.stdout)["result"]["gates"]}
    finally:
        Path(p).unlink(missing_ok=True)


BODY = "\n## Results\n\nWe report 71.2 ± 0.4 on GSM8K.\n"


class StatisticsGate(unittest.TestCase):
    """G13：有误差/区间就必须说清它表示什么。"""

    def test_undeclared_error_bar_fails(self):
        g = gates_for("# T\n" + BODY)
        self.assertFalse(g["G13"]["pass"], "有 ± 却无口径声明，G13 必须红")

    def test_declared_error_bar_passes(self):
        g = gates_for("# T\n\nFigure 1: Scores over n = 5 runs. Error bars denote s.d.\n" + BODY)
        self.assertTrue(g["G13"]["pass"], "口径已声明，G13 必须绿: " + g["G13"]["detail"])

    def test_single_point_numbers_do_not_trigger(self):
        """纯单点量（无误差语义）不该逼作者硬加统计声明。"""
        text = "# T\n\n## Costs\n\nTraining used 2664K GPU hours, of which 2.788M H800 GPU hours.\n"
        g = gates_for(text)
        self.assertTrue(g["G13"]["pass"],
                        "单点数字无误差语义，G13 不该误报: " + g["G13"]["detail"])


class FigureCaptionN(unittest.TestCase):
    """G14：图注有误差语义却没给 n → 红。与 G13 相互独立。"""

    def test_caption_with_error_but_no_n_fails(self):
        g = gates_for("# T\n\nFigure 1: Scores. Error bars denote s.d.\n" + BODY)
        self.assertFalse(g["G14"]["pass"], "图注有误差却无 n，G14 必须红")

    def test_caption_with_n_passes(self):
        g = gates_for("# T\n\nFigure 1: Scores, n = 5 independent runs. Error bars denote s.d.\n" + BODY)
        self.assertTrue(g["G14"]["pass"], "图注给了 n，G14 必须绿: " + g["G14"]["detail"])

    def test_g13_and_g14_are_independent(self):
        """声明了口径但没给 n：G13 绿、G14 红——两条门禁查的是两件事。"""
        g = gates_for("# T\n\nFigure 1: Scores. Error bars denote s.d.\n" + BODY)
        self.assertTrue(g["G13"]["pass"], "口径已声明，G13 应绿")
        self.assertFalse(g["G14"]["pass"], "图注缺 n，G14 应红")


class GateCount(unittest.TestCase):
    def test_all_gates_present(self):
        """G1–G14 必须全在：加门禁是这件事的产出，少一条说明被谁删了。"""
        g = gates_for("# T\n\n## A\n\nB\n")
        want = {f"G{i}" for i in range(1, 15)}
        self.assertEqual(want - set(g), set(), f"缺门禁: {sorted(want - set(g))}")


if __name__ == "__main__":
    unittest.main()
