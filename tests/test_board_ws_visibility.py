# -*- coding: utf-8 -*-
"""v13：看板的「工作区归属可见性」契约。

## 这一轮在修什么

用户原话：「在本工作区发的任务，当然要显示在本工作区？这是很顺其自然的道理。
当然它也可以在全部中看到。具体可以在全部中分类编号，比如一眼可以看到哪个工作区的
任务？而且各各工作区有任务应该是自动显示的，不是要用户提醒才显示，这样才对。」

拆成三条可验收的要求：
1. **归属可见**：每条任务行都带工作区徽章；本工作区的高亮。
2. **可分类编号**：`group_by=workspace` 是合法分组维度，本工作区排最前。
3. **不靠提醒**：折叠的落定组不能只剩一个数字——要露出最新一条（带徽章）。

## 为什么断言写成这样

前两条能靠源码断言钉住（字符串在不在）。第三条的本质是**渲染行为**，
源码断言只能证明「有这段代码」，所以另有一份真浏览器验收（`.scratch/uicheck.py`
与 `vischeck.py`，本轮用它抓出两个真 bug）。这里钉「代码路径存在且默认值正确」，
浏览器侧验「用户真能看到」——只有前者会漏布局问题，只有后者无法进 CI。
"""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

APP_BOARD = "runtime/crates/host/web-dist/vendor/app-board.js"
STYLE_CSS = "runtime/crates/host/web-dist/style.css"
BOARD_PY = "scripts/board.py"
BOARD_RS = "runtime/crates/host/src/web/api/board.rs"
BOARD_CTX = "runtime/crates/agent-loop/src/board_ctx.rs"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def body_of(js: str, header: str) -> str:
    """截取一个函数体（到第一个顶格 `}` 为止）。"""
    seg = js[js.index(header):]
    return seg[: seg.index("\n}")]


class WorkspaceGroupByTest(unittest.TestCase):
    """`workspace` 必须是两端同源的分组维度——只改一侧会让前端白屏。"""

    def test_whitelist_contains_workspace_in_both_languages(self):
        py = read(BOARD_PY)
        rs = read(BOARD_RS)
        self.assertRegex(py, r'GROUP_BYS\s*=\s*\([^)]*"workspace"',
                         "board.py 的 GROUP_BYS 缺 workspace")
        self.assertRegex(rs, r'const GROUP_BYS: &\[&str\]\s*=\s*&\[[^\]]*"workspace"',
                         "board.rs 的 GROUP_BYS 缺 workspace")

    def test_frontend_groups_by_workspace(self):
        js = read(APP_BOARD)
        self.assertIn('groupBy === "workspace"', js, "前端缺按工作区分组的分支")
        seg = js[js.index('groupBy === "workspace"'):]
        seg = seg[: seg.index("\n  }")]
        self.assertIn("boardMine()", seg, "分组排序必须让本工作区优先")

    def test_unknown_workspace_is_not_invented(self):
        """空标签 = 归属未知，不许编一个「未知」印出来（会被读成「丢失」）。"""
        js = read(APP_BOARD)
        self.assertIn("function wsTagOf", js)
        seg = body_of(js, "function wsTagOf")
        self.assertIn('?? ""', seg, "空标签必须退化为空串而不是占位文案")
        self.assertNotIn("未知", seg, "不得为无归属条目编造标签")


class WorkspaceVisibilityTest(unittest.TestCase):
    """任务行/组头必须让归属可见。"""

    def test_row_chip_rendered_and_highlighted(self):
        js = read(APP_BOARD)
        self.assertIn('class="tws', js, "任务行缺工作区徽章")
        self.assertIn(chr(34)+" mine"+chr(34), js, "徽章缺「本工作区」高亮态")
        css = read(STYLE_CSS)
        self.assertIn(".tws.mine", css, "高亮态缺样式（类名有了但看不见等于没做）")

    def test_chip_hidden_in_mine_scope(self):
        """「本项目」档下每条都一样，再印徽章只是噪声。"""
        js = read(APP_BOARD)
        seg = js[js.index("const wsChip"):]
        seg = seg[: seg.index("row.innerHTML")]
        self.assertIn('boardScope !== "mine"', seg,
                      "本项目档应隐藏徽章（否则挤占标题宽度且全是重复信息）")

    def test_group_head_shows_distribution(self):
        js = read(APP_BOARD)
        self.assertIn("function wsDist", js, "缺组头工作区分布函数")
        self.assertIn("tgroupHead(sec.id, g, label, arr.length, shut, wsDist(arr))", js,
                      "组头未接线工作区分布")
        self.assertIn(".tdist", read(STYLE_CSS), "分布缺样式")

    def test_collapsed_group_shows_latest_preview(self):
        """折叠组只剩「完成 30」一个数字，用户就不知道自己刚做完的那条在里面。"""
        js = read(APP_BOARD)
        self.assertIn('row.classList.add("tpreview")', js, "折叠组未露出最新一条")
        self.assertIn(".trow.tpreview", read(STYLE_CSS), "预览行缺样式")
        i = js.index('row.classList.add("tpreview")')
        self.assertIn("updated_at", js[max(0, i - 600):i],
                      "预览必须按更新时间挑最新一条")


class SortPrecedenceTest(unittest.TestCase):
    """同组内本工作区排最前——否则「完成」组里自己的活还埋在 28 条里。"""

    def test_sort_rows_prefers_mine(self):
        js = read(APP_BOARD)
        seg = body_of(js, "function sortRows")
        self.assertIn("mineRank", seg, "sortRows 缺本工作区优先")
        self.assertLess(seg.index("mineRank(a)"), seg.index("PRIO_RANK[a.priority]"),
                        "归属必须是主序（在优先级之前比较）")


class CheckCwdTest(unittest.TestCase):
    """`cmd` 检查必须剥掉 `\\\\?\\` 长路径前缀再交给 shell。

    实测事故：本机 `WORKSPACE_ROOT` 是 `\\\\?\\D:\\ZH\\vibe code\\WF\\1109`，
    `subprocess.run(shell=True, cwd=...)` 把它交给 cmd.exe 后，cmd 不认 UNC 工作目录、
    静默退到 `C:\\Windows` 执行——命令在错的目录里跑，于是
    `python: can't open file 'C:\\Windows\\.scratch\\verify.py'`，或干脆给个假 exit=0。
    更糟的是它还会**挂住**：看板 eval 曾因此卡 45s+ 并被外部超时杀掉，留下残锁。
    """

    def test_strips_long_path_prefix_before_shell(self):
        py = read(BOARD_PY)
        seg = py[py.index('if kind == "cmd":'):]
        seg = seg[: seg.index("timeout=to")]
        self.assertIn("startswith", seg, "未处理 Windows 长路径前缀")
        self.assertIn("\\\\?\\", seg, "未识别 \\\\\\\\?\\\\ 前缀")
        self.assertIn("cwd=cwd", seg, "剥完前缀必须真的传给 subprocess")


class RegisterDisciplineTest(unittest.TestCase):
    """「不是要用户提醒才显示」的另一半：提示词必须要求动手前登记。"""

    def test_prompt_demands_register_before_edit(self):
        rs = read(BOARD_CTX)
        self.assertIn("Registering is part of doing the work", rs,
                      "提示词缺「登记是干活的一部分」")
        self.assertIn("Register BEFORE the first substantive edit", rs,
                      "提示词未要求动手前登记（做完才补 = 用户看不到过程）")
        self.assertIn("Do not wait to be asked", rs,
                      "提示词未明说「不要等用户提醒」")


if __name__ == "__main__":
    unittest.main()
