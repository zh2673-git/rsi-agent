"""X 轮回归：首屏历史重放的两个性能断点，以及回滚预填。

背景（实测，非推测）：
- 后端 trace.read 曾对每条事件读入最多 1MB：单批 800 条 1693ms，全量 14751 条 31s，
  实际读入 14.4GB 只为 14.4MB 的文件。修后单批 31ms / 全量 0.6s。
- 前端过程框的 MutationObserver 曾每回合新建、旧的从不 disconnect，且回调同步读
  scrollHeight（forced reflow）：CPU 采样 65.8s 里 63.5s 落在这个观察者上。
  修后 Task 30.5s → 2.9s，feed 子节点 140 → 311（历史真的渲染完整了）。

这些断言钉的是「不该退回去的形状」，不是实现细节：
- 读事件必须用下一行偏移做上界（否则又变成每条读 1MB）；
- 过程框观察者必须只有一个句柄并断旧接新，且不得再用 subtree+characterData 全量观察。
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class TraceReadPrecisionTest(unittest.TestCase):
    """后端：按行长精确读，别再整块 1MB。"""

    def test_read_event_line_accepts_end_offset(self):
        ts = read("runtime/plugins/memory/memory_plugin.ts")
        self.assertIn("function readEventLine(file: string, off: number, end?: number)",
                      ts, "readEventLine 必须接受下一行偏移，否则只能整块读")
        # 有 end 时必须用它裁掉，不能退化成 cap（=1MB）
        self.assertRegex(ts, r"const len = end !== undefined && end > off \? Math\.min\(end - off, cap\) : cap;",
                         "有 end 偏移时必须按它裁剪读取长度")

    def test_trace_read_passes_next_offset(self):
        ts = read("runtime/plugins/memory/memory_plugin.ts")
        self.assertIn("readEventLine(file, offsets[cursor], offsets[cursor + 1])", ts,
                      "trace.read 循环必须把下一条的起始偏移传进去")

    def test_read_event_line_not_called_without_end_in_loop(self):
        """回归：循环里若出现两参数调用，等于退回「每条读 1MB」。"""
        ts = read("runtime/plugins/memory/memory_plugin.ts")
        bad = re.findall(r"readEventLine\(file, offsets\[cursor\]\)", ts)
        self.assertEqual(bad, [], "trace.read 循环里出现了不带 end 的 readEventLine 调用")


class ProcessFollowObserverTest(unittest.TestCase):
    """前端：过程框跟随不得每回合新建观察者，也不得全量观察子树。"""

    def test_single_observer_handle(self):
        js = read("runtime/crates/host/web-dist/vendor/app-stream.js")
        self.assertIn("let processBoxMo = null;", js,
                      "必须登记唯一观察者句柄，否则每回合攒一个且旧的从不 disconnect")
        self.assertIn("if (processBoxMo) { processBoxMo.disconnect(); processBoxMo = null; }", js,
                      "新建过程框前必须先断开旧观察者")

    def test_observer_scope_is_childlist_only(self):
        js = read("runtime/crates/host/web-dist/vendor/app-stream.js")
        self.assertIn("processBoxMo.observe(processBody, { childList: true });", js,
                      "观察范围应只留 childList；subtree+characterData 会让每个事件都产生 record")
        self.assertNotIn("{ childList: true, subtree: true, characterData: true }", js,
                         "不得退回全量子树观察（实测占 63.5s/65.8s 采样的热点）")

    def test_follow_is_frame_coalesced(self):
        js = read("runtime/crates/host/web-dist/vendor/app-stream.js")
        self.assertIn("function scheduleProcessFollow()", js)
        self.assertIn("if (processFollowQueued) return;", js,
                      "同一帧内的多次跟随请求必须合并，否则每次都 forced reflow")
        self.assertIn("noteProcessGrow();", js,
                      "textContent 变更不产生 childList mutation，必须显式通知才能保持贴底跟随")

    def test_scroll_feed_is_frame_coalesced(self):
        js = read("runtime/crates/host/web-dist/vendor/app-core.js")
        self.assertIn("let feedScrollQueued = false;", js,
                      "scrollFeed 每事件一次 forced reflow（实测 0.42ms/次），须合并到每帧一次")


class RollbackPrefillTest(unittest.TestCase):
    """回滚：把被删掉的那条提问原文放回输入框。"""

    def test_user_bubble_passes_turn(self):
        js = read("runtime/crates/host/web-dist/vendor/app-events.js")
        self.assertIn("rollbackTo(idx, false, _turn)", js,
                      "普通回滚也必须带 ut，否则只有索引、拿不到原文")
        self.assertIn("stashRollbackTarget(resend ? null : ut);", js,
                      "重新生成已把原文发出去，不应再预填（否则像没发）")

    def test_restore_prefers_rolled_back_text(self):
        qs = read("runtime/crates/host/web-dist/vendor/q-session.js")
        self.assertIn("function stashRollbackTarget(turn)", qs)
        self.assertIn("const pick = (target && target.text) ? target : (d && d.text) ? d : null;", qs,
                      "优先级：被回滚的提问原文 > 回滚前未发草稿")
        self.assertIn("!input.value.trim()", qs,
                      "输入框已有内容时不得覆盖")
        self.assertIn("input.setSelectionRange(input.value.length, input.value.length);", qs,
                      "预填后光标应在末尾（目的是改一改再发）")


if __name__ == "__main__":
    unittest.main()
