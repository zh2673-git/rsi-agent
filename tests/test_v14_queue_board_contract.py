# -*- coding: utf-8 -*-
"""V14（I-20261115-03）：插队语义 + 看板筛选/折叠/全量 的回归契约。

只读源码文本断言，不启动 host。三条修复各自都有一个「用户能直接看见症状」，
所以断言都钉在**症状对应的代码路径**上，而不是钉在某一行字面量上。

为什么必须钉死这三条（都是实测踩到的真故障，不是假想）：

1. **Alt+Enter 曾经被改道到 steer**（Q 轮 Phase 3）。steer = 轮次边界软注入，
   **不取消当前任务**，而且成功后直接 return，把硬插队那段整段跳过——用户看到的
   就是「插队键不插队：当前任务继续跑，我的话排在后面」。
   硬插队逻辑其实**早就存在**（Q6，commit f2a683a：cancel + abort + 被打断者标
   interrupted 挂起、等插队条跑完自动回头续跑），只需要把它接回 Alt+Enter。
   故断言：`interruptAndSend` 里**不得再出现 steer 早退**，且必须走
   `markRunningInterrupted` + `/api/chat/cancel` + `abort`。

2. **筛选条曾是纯装饰**：过滤那一步传的是 `sec.filter`（章节配置里的静态值
   "all"），而不是用户点的 `boardFilter`。于是「点未完成 → 按钮变亮 → 列表一条
   没少」。断言：侧栏过滤必须走 `taskVisibleInSection`，弹窗过滤必须走
   `boardFilter`。

3. **弹窗曾被 layout.limit 截断**：侧栏窄、limit=30 合理；弹窗是「摊开细看」
   的宽面，截断在这里只有坏处。用户要求「专门点进看板的标签中，点了之后能显示
   所有任务」。断言：`renderWinTasks` 内不得再有 `shown >= limit` 截断。

另外钉一条**补丁链自身**的约束：既有补丁 G3-SEND-QUEUE 的幂等判据是「整个
syncRunUI 函数体原文逐字在位」，往该函数体里插一行就会让那条补丁永远报
「锚点未命中」（实测踩过）。故断言 G3 的 patch 文本仍完整存在于 q-session.js。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


def section(text: str, start_marker: str, end_marker: str) -> str:
    """取两个标记之间的片段（不含 end_marker）。找不到时抛 AssertionError。"""
    i = text.find(start_marker)
    assert i >= 0, f"找不到起始标记 {start_marker!r}"
    j = text.find(end_marker, i + len(start_marker))
    assert j >= 0, f"找不到结束标记 {end_marker!r}"
    return text[i:j]


def _block_or_inline(pdir: Path, d: dict, key: str) -> str:
    """取 block 文件（长文本免 JSON 转义）或内联字符串。"""
    fk = key + "_file"
    if fk in d:
        return (pdir / str(d[fk])).read_text(encoding="utf-8").replace("\r\n", "\n")
    return str(d.get(key, "")).replace("\r\n", "\n")


def strip_js_comments(text: str) -> str:
    """去掉 JS 行注释与块注释，只留代码。

    为什么需要：断言「这个函数里不得再出现 steer」时，注释里写着
    「V13-Q 把 Alt+Enter 改道到 steer」是**正当的说明文档**，不是代码。
    不剥注释就会把说明当成违规——实测首版断言就是这样误报的。
    字符串字面量里的注释记号极少出现在本仓前端代码里，不做完整词法分析。
    """
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


class V14InterruptContractTest(unittest.TestCase):
    """1. Alt+Enter 必须是硬插队，不能再走 steer 软注入。"""

    def test_interrupt_and_send_has_no_steer_early_return(self):
        q = read("runtime/crates/host/web-dist/vendor/q-session.js")
        body = section(q, "async function interruptAndSend() {", "async function runQueueNow(")
        code = strip_js_comments(body)
        self.assertNotIn('target: "steer"', code,
                         "interruptAndSend 不得再走 steer 软注入（steer 不取消当前任务）")
        self.assertNotIn("/api/queue", code,
                         "interruptAndSend 不得再调 /api/queue（那是软注入通道）")

    def test_interrupt_and_send_takes_the_hard_preempt_path(self):
        q = read("runtime/crates/host/web-dist/vendor/q-session.js")
        body = section(q, "async function interruptAndSend() {", "async function runQueueNow(")
        # 硬插队三件套：标 interrupted（被打断者回头续跑）+ 取消服务端回合 + 断客户端 fetch
        self.assertIn("markRunningInterrupted(session);", body)
        self.assertIn("/api/chat/cancel", body)
        self.assertIn("s.abort?.abort()", body)

    def test_row_level_preempt_and_resume_still_present(self):
        """行内 ⏭ 的硬插队 + drain 的「挂起续跑」分流必须仍在（Q6 语义）。"""
        q = read("runtime/crates/host/web-dist/vendor/q-session.js")
        rq = section(q, "async function runQueueNow(", "function returnQueueToInput(")
        self.assertIn("markRunningInterrupted(session);", rq)
        drain = section(q, "async function drain(", "async function interruptAndSend(")
        self.assertIn("item.pendingResume = true;", drain,
                      "被打断者必须标记 pendingResume 以便插队条跑完后自动回头续跑")
        self.assertIn("MAX_RESUME", q, "续跑上限（防插队↔被插队无界 ping-pong）不得被删")

    def test_composer_has_no_separate_interrupt_button(self):
        """V15（I-20261115-04）：发送旁**不得**再有独立「插队」键。

        用户原话：「不需要单独在发送旁边显示插队按钮，就是有了新任务后它会自动排队，
        然后在排队的哪里有插队的选项发送过去就好了。」

        即插队入口**统一收回到待发队列行内 ⏭**。故断言四处都不再有 #interrupt：
        index.html 按钮、app-core.js 的 interruptBtn 声明、app-events.js 的 onclick
        绑定、style.css 的样式——任一处残留都会让用户看到两个插队入口。
        """
        idx = read("runtime/crates/host/web-dist/index.html")
        self.assertNotIn('id="interrupt"', idx, "composer 不该再有独立「插队」键（插队在队列行内）")
        core = read("runtime/crates/host/web-dist/vendor/app-core.js")
        self.assertNotIn('interruptBtn = $("interrupt")', core, "interruptBtn 声明应一并撤掉")
        ev = read("runtime/crates/host/web-dist/vendor/app-events.js")
        self.assertNotIn("interruptBtn.onclick", ev, "插队键绑定应一并撤掉")
        css = read("runtime/crates/host/web-dist/style.css")
        self.assertNotIn("button#interrupt", css, "插队键样式应一并撤掉")

    def test_row_level_preempt_is_the_only_preempt_entry(self):
        """唯一的插队入口 = 待发队列行内 ⏭ → runQueueNow 硬插队。

        行内 ⏭ 的语义链必须完整：把该条移到执行项之后 → 打断当前 → 被打断者标
        interrupted 挂起 → 插队条跑完 → 被打断者回到队首续跑。
        """
        q = read("runtime/crates/host/web-dist/vendor/q-session.js")
        # 行内按钮确实绑到 runQueueNow
        self.assertIn("exec.onclick = () => { runQueueNow(i); };", q,
                      "队列行内 ⏭ 必须绑到 runQueueNow")
        # 插队条插到执行项之后（draining 时 index 1），而不是顶掉正在跑的那条
        rq = section(q, "async function runQueueNow(", "function returnQueueToInput(")
        self.assertIn("const at = s.draining ? 1 : 0;", rq)
        self.assertIn("s.queue.splice(at, 0, item);", rq)
        # 打断当前：cancel + abort，且标为「插队打断」而非「用户停止」
        self.assertIn("markRunningInterrupted(session);", rq)
        self.assertIn("/api/chat/cancel", rq)
        self.assertIn("s.abort?.abort()", rq)
        # 被打断者挂起续跑
        drain = section(q, "async function drain(", "async function interruptAndSend(")
        self.assertIn("item.pendingResume = true;", drain)
        self.assertIn("item.resumes", drain, "续跑次数必须计数（配合 MAX_RESUME 上限）")

    def test_alt_enter_calls_hard_interrupt(self):
        ev = read("runtime/crates/host/web-dist/vendor/app-events.js")
        self.assertIn("if (e.altKey) interruptAndSend();", ev)


class V14BoardContractTest(unittest.TestCase):
    """2 + 3. 筛选条真的会筛 + 弹窗可折叠且显示全部。"""

    def test_sidebar_filter_uses_user_clicked_filter(self):
        b = read("runtime/crates/host/web-dist/vendor/app-board.js")
        self.assertIn("function filterBar()", b, "筛选条应抽成共用函数")
        self.assertIn("wrap.appendChild(filterBar());", b, "侧栏应使用共用 filterBar()")
        self.assertIn(".filter((t) => taskVisibleInSection(t, sec))", b,
                      "侧栏过滤必须用用户点的 boardFilter（原来用 sec.filter，点了不筛）")
        self.assertIn("function taskVisibleInSection(t, sec)", b)

    def test_board_window_filter_uses_user_clicked_filter(self):
        b = read("runtime/crates/host/web-dist/vendor/app-board.js")
        win = section(b, "function renderWinTasks(", "function renderWinMetrics(")
        self.assertIn('taskVisible(t, boardFilter ?? "all")', win,
                      "弹窗过滤必须用 boardFilter（原来用 sec.filter）")
        self.assertIn('fb.classList.add("bw-filter")', b, "弹窗应挂上状态筛选条")

    def test_board_window_not_truncated_by_limit(self):
        b = read("runtime/crates/host/web-dist/vendor/app-board.js")
        win = section(b, "function renderWinTasks(", "function renderWinMetrics(")
        self.assertNotIn("shown >= limit", win,
                         "弹窗不应受 layout.limit 截断（宽面看全部任务）")
        self.assertNotIn("const limit = Number(sec.limit ?? 30);", win)

    def test_board_window_groups_are_collapsible(self):
        b = read("runtime/crates/host/web-dist/vendor/app-board.js")
        win = section(b, "function renderWinTasks(", "function renderWinMetrics(")
        self.assertIn('folded("win", g, settled)', win, "弹窗组头应可折叠（与侧栏同一套）")
        self.assertIn("setFold(\"win\", g, !shut)", win)
        css = read("runtime/crates/host/web-dist/style.css")
        self.assertIn(".bw-group.shut", css, "弹窗折叠态缺样式")
        self.assertIn(".bw-group .tchev", css)


class V14PatchChainContractTest(unittest.TestCase):
    """补丁链自身的约束：不得破坏既有补丁的幂等判据。"""

    def test_g3_sync_run_ui_patch_text_still_verbatim_present(self):
        """G3-SEND-QUEUE 的判据 = 「整个 syncRunUI 函数体原文逐字在位」。

        往 syncRunUI 里插任何一行都会让那条补丁永远报「锚点未命中」
        （实测：V14 首版把插队键显隐插进 syncRunUI，导致 G3 失效）。
        故 V14 的插队键显隐改放 app-events.js，syncRunUI 保持逐字不变。
        """
        g3 = read("scripts/patches/blocks/g3-send.txt")
        q = read("runtime/crates/host/web-dist/vendor/q-session.js")
        self.assertIn(g3, q, "G3-SEND-QUEUE 的 patch 文本已被破坏（补丁链会报锚点未命中）")

    def test_style_css_keeps_lane_and_fold_styles(self):
        """style.css 既有的车道运行中标记与新增的弹窗折叠样式都要在。

        V14 首版的 CSS 补丁用「文件末尾的 `.lane.busy` 块」当锚点，patch 文本
        又没把它带回去 → 车道标记被整段删掉（`test_lane_contract` 立刻变红）。
        这类「替换型补丁静默删内容」不报错、不崩，只是某个功能悄悄没了，
        所以必须钉死：既有的不能丢，新增的不能少，条数不能多。
        """
        css = read("runtime/crates/host/web-dist/style.css")
        self.assertIn(".lane.busy", css, "车道运行中标记被补丁删掉了")
        self.assertIn("@keyframes lanePulse", css)
        self.assertEqual(css.count(".lane.busy::before"), 1, "车道样式被写成重复块")
        self.assertEqual(css.count("@keyframes lanePulse"), 1)
        self.assertEqual(css.count(".bw-group.shut"), 1, "弹窗折叠样式重复")
        self.assertEqual(css.count("button#interrupt"), 0,
                         "插队键样式应已撤掉（V15：插队入口只在队列行内）")

    def test_v14_css_patch_carries_its_anchor(self):
        """V14 的 CSS 补丁必须**自带**锚点块（替换型补丁的硬要求）。

        补丁语义是 `src.replace(anchor, patch, 1)`：patch 不含 anchor 全文时，
        anchor 里的内容会被删除——这是静默的功能丢失。故要求 V14 的 CSS 补丁
        文本里带着它替换掉的那段 `.lane.busy` / `@keyframes lanePulse`。
        """
        pdir = ROOT / "scripts" / "patches"
        d = json.loads((pdir / "v14-fe-css-win-fold.json").read_text(encoding="utf-8"))
        patch = _block_or_inline(pdir, d, "patch")
        self.assertIn(".lane.busy::before", patch,
                      "CSS 补丁未自带锚点块 → 应用后车道运行中标记会被删掉")
        self.assertIn("@keyframes lanePulse", patch)

    def test_v14_patches_are_well_formed(self):
        """V14 补丁清单：活跃 ∪ 退役（V15 撤掉了三条插队键补丁 → 移入 retired/）。

        退役不等于消失——「这条能力曾存在」的证据要留档，故查并集而不是只看活跃。
        """
        pdir = ROOT / "scripts" / "patches"
        specs = [json.loads(f.read_text(encoding="utf-8"))
                 for f in sorted(pdir.glob("v14-*.json"))]
        retired = [json.loads(f.read_text(encoding="utf-8"))
                   for f in sorted((pdir / "retired").glob("v14-*.retired"))]
        self.assertGreaterEqual(len(specs) + len(retired), 10, "V14 补丁条数偏少，可能漏写")
        ids = [d["id"] for d in specs + retired]
        self.assertEqual(len(ids), len(set(ids)), "V14 补丁 id 必须唯一")
        for d in specs:
            self.assertTrue(d.get("description"), f"{d['id']} 缺 description")
            self.assertTrue((ROOT / d["file"]).is_file(), f"{d['id']} 目标文件不存在")
            for key in ("anchor", "patch", "anchor_file", "patch_file"):
                if key in d and key.endswith("_file"):
                    self.assertTrue((pdir / d[key]).is_file(), f"{d['id']} {key} 缺失")

    def test_v15_patches_are_well_formed(self):
        """V15 补丁：撤掉 composer 独立插队键的四处改动。

        用 `repair` 型（删除语义）而非替换型——锚点就是「要被删掉的那块」，
        删完锚点消失，repair 的幂等判据（锚点不存在 = 已修好）才成立；
        用普通替换型会永远报「锚点未命中」。
        """
        pdir = ROOT / "scripts" / "patches"
        specs = [json.loads(f.read_text(encoding="utf-8"))
                 for f in sorted(pdir.glob("v15-*.json"))]
        self.assertEqual(len(specs), 4, "V15 应有四条（index/core/events/css 各一）")
        ids = [d["id"] for d in specs]
        self.assertEqual(len(ids), len(set(ids)), "V15 补丁 id 必须唯一")
        targets = {d["file"] for d in specs}
        self.assertEqual(len(targets), 4, "V15 四条补丁应打在四个不同文件上")
        for d in specs:
            self.assertTrue(d.get("description"), f"{d['id']} 缺 description")
            self.assertTrue(d.get("repair"), f"{d['id']} 应声明 repair（删除语义）")
            self.assertTrue((ROOT / d["file"]).is_file(), f"{d['id']} 目标文件不存在")
            for key in ("anchor_file", "patch_file"):
                self.assertTrue((pdir / d[key]).is_file(), f"{d['id']} {key} 缺失")


if __name__ == "__main__":
    unittest.main()
