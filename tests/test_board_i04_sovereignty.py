"""I-20261108-04 三条诉求的回归断言（G 轮 / G3 补齐）。

## 用户原话

> 1. 灵感是用户记录碎片想法的地方。不需要呈现 agent 对灵感的总结。agent 运行的时候
>    在需要的情况下只是读取灵感，agent 不能编辑，用户可以编辑。
> 2. 灵感在 agent 工作的时候，用户记录的时候会被刷新，这样是不对的，这样会影响用户
>    记录灵感。
> 3. 对于用户来说，任务完成后其实应该是两条线。一条是确认任务是否专业的、按照计划、
>    需求完成了。另一条是需要把任务的结果通俗化的呈现出来，这才是看板的终极意义。

## 为什么测的是源码而不是 DOM

前端没有 DOM 测试环境（无 jsdom 依赖），而这三条诉求的病灶都落在**源码结构**上：
写通道是否存在、重绘前是否摘了快照、`done` 是否要求 conclusions。用字符串断言钉住
结构，比引入整套 DOM 栈便宜，且能精确指出「哪一句话被谁改回去了」。

局限要说清：这些断言只能证明**代码里留着这段逻辑**，不能证明它在浏览器里跑得对。
运行时行为靠人工冒烟（记录在任务 T-20261108-04 的结论里）。
"""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

APP_BOARD = "runtime/crates/host/web-dist/vendor/app-board.js"
BOARD_PY = "scripts/board.py"
BOARD_RS = "runtime/crates/host/src/web/api/board.rs"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class InspIsUserSovereignTest(unittest.TestCase):
    """第 1 条：灵感归用户，agent 只读；且不呈现 agent 写的小结。"""

    def test_agent_cli_has_no_inspiration_write_op(self):
        """agent 的写通道（board.py）不得出现任何 inspiration.* 写 op。"""
        py = read(BOARD_PY)
        # 允许出现的是「读」与「在任务上记 inspirations 关联」，不允许增删改灵感本体。
        for op in ("inspiration.add", "inspiration.set", "inspiration.edit",
                   "inspiration.rm", "inspiration.adopt"):
            self.assertNotIn(op, py, f"board.py 不应能 {op}（灵感主权归用户）")

    def test_write_ops_only_served_to_the_ui(self):
        """写 op 只在 host 的 UI 接口里，且注释写明唯一调用方是用户界面。"""
        py = read(BOARD_PY)
        self.assertIn("只走 UI", py, "board.py 顶部应写明灵感写权限归属")

    def test_no_agent_summary_rendered_on_inspiration(self):
        """灵感区不得渲染任何「agent 总结/摘要」字段——只显示用户原文。"""
        js = read(APP_BOARD)
        start = js.index("function inspRow")
        body = js[start : start + 1200]
        self.assertIn("it.text", body, "灵感行必须显示原文")
        for forbidden in ("it.summary", "it.gist", "agentNote", "it.synopsis"):
            self.assertNotIn(forbidden, js, f"灵感不应渲染 {forbidden}（那是 agent 的转述）")


def refresh_sections_body() -> str:
    """截取 refreshSections 整个函数体——固定字符窗口会随注释增长而切偏。"""
    js = read(APP_BOARD)
    start = js.index("function refreshSections")
    end = js.index("async function refreshBoard", start)
    return js[start:end]


class SafeDuringPollRefreshTest(unittest.TestCase):
    """第 2 条：agent 跑着的时候用户能安心记录，轮询重绘不许打断输入。"""

    def test_refresh_snapshots_drafts_before_wipe(self):
        body = refresh_sections_body()
        # 带分号的才是真语句——注释里也出现过同样的字眼（不带分号），会误判位置。
        wipe = body.index('root.innerHTML = "";')
        self.assertIn("inspDrafts.set", body[:wipe], "必须在清空 DOM 之前摘草稿")

    def test_drafts_are_put_back_on_rerender(self):
        """摘了还要还：回填发生在 renderInspSection 建输入框时，不在 refreshSections。"""
        js = read(APP_BOARD)
        start = js.index("function renderInspSection")
        body = js[start : js.index("function inspRow", start)]
        self.assertIn("inspDrafts.get", body, "重建输入框时必须把草稿读回去")

    def test_inline_edit_skips_this_refresh(self):
        """G3：行内编辑进行中 → 本轮重绘直接返回，不销毁输入框与它的监听。"""
        body = refresh_sections_body()
        guard = body.index('classList.contains("insp-edit")')
        wipe = body.index('root.innerHTML = "";')
        self.assertLess(guard, wipe, "编辑保护必须在清空 DOM 之前生效")

    def test_focus_is_restored_after_rebuild(self):
        """G4：inspFocus 必须被读取（G2 只写不读，光标位置丢了）。"""
        body = refresh_sections_body()
        self.assertIn("setSelectionRange(inspFocus.start", body, "还原要带选区")
        read_at = body.index("if (inspFocus)")
        wipe = body.index('root.innerHTML = "";')
        self.assertGreater(read_at, wipe, "焦点还原必须在重建之后")

    def test_edit_guard_has_a_way_back(self):
        """跳过重绘不能变成永久不刷新：编辑结束必须有 refreshBoard 把状态补上。"""
        js = read(APP_BOARD)
        start = js.index("async function editInspiration")
        body = js[start : start + 1600]
        self.assertIn("await refreshBoard()", body,
                      "编辑收尾必须补一次刷新，否则编辑期间的更新被永久吞掉")


class DoneOwesTwoLinesTest(unittest.TestCase):
    """第 3 条：完成 = 专业验收线 + 通俗结果线，两条都要有。"""

    def test_done_without_outcomes_warns(self):
        """done 且 outcomes 全空必须给 warning——「完成」不等于「结果是什么」。"""
        py = read(BOARD_PY)
        self.assertIn("def check_acceptance_warning", py)
        start = py.index("def check_acceptance_warning")
        body = py[start : start + 2000]
        self.assertIn('task["status"] == "done"', body, "必须专门判 done")
        self.assertIn("outcomes", body, "必须检查 outcomes 是否为空")
        self.assertIn("warns.append", body, "空 outcomes 必须产生提示")

    def test_outcome_brief_is_plain_language_for_human(self):
        """brief 面向人：一句话说清「现在是什么状态、你还要不要管它」。"""
        py = read(BOARD_PY)
        start = py.index("def check_acceptance_warning")
        body = py[start : start + 2000]
        self.assertIn("给人看", body, "brief 的定位必须写清是给人看的")

    def test_outcome_pro_is_for_agents(self):
        py = read(BOARD_PY)
        start = py.index("def check_acceptance_warning")
        body = py[start : start + 2000]
        self.assertIn("给 agent 看", body, "pro 的定位必须写清是给 agent 归纳用的")

    def test_detail_shows_outcome_before_process(self):
        """详情页顺序：先结果（通俗），再目标/计划/验收（过程）。看完要知道做成了没有。"""
        js = read(APP_BOARD)
        start = js.index("const outs = t.outcomes")
        body = js[start : start + 1600]
        o = body.index("outcomeBlock")
        goal = body.index("t.goal")
        self.assertLess(o, goal, "结果块必须排在「目标」之前")

    def test_done_without_summary_says_so_in_ui(self):
        """UI 侧也不能沉默：done 却没结论时明说，而不是当无事发生。"""
        js = read(APP_BOARD)
        self.assertIn("没有留下结论", js,
                      "done 且无 outcomes 时，详情页要明说「完成了但没有结论」")

    def test_pro_is_collapsed_for_human_reading(self):
        """专业结论折叠起来——人的视线先落在通俗结论上。"""
        js = read(APP_BOARD)
        self.assertIn('class="opro"', js, "pro 必须可折叠（details）")
        self.assertIn("<details class=\"opro\"", js, "pro 用 details 折叠")


if __name__ == "__main__":
    unittest.main()
