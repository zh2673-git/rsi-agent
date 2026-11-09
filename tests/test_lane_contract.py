"""车道（lane）契约：一个任务一条车道，车道 = session（I-20261108-14）。

**为什么车道必须是 session**：内核 `agent-loop/src/chat.rs` 的同会话闸按 `session_id`
上锁，`try_lock` 失败即 K409，**不排队**。所以「一个 session 里并行跑多个任务」在语义
上做不到；能并行的最小粒度就是 session。于是「一个任务一条车道」实现上等价于
「一个任务一个 session_id」，窗口只是多开几个槽位同时看着它们。

这个文件守四件事（各自都对应一条真实会坏的路径）：

1. **DOM 结构**：`#lanes` 必须在 `#stream` 内、`#feed` 之前。塞进 `#feed` 里会被
   `resetSessionFeed()` 的 `feed.innerHTML=""` 清掉——切一次车道就永远消失。
2. **切换链路真的接上**：`snapshotSessionFeed` 在 FE4 单会话化后是**无人调用的死代码**，
   切走即丢；`switchSession` 必须调用它，否则「切回来还在」是假的。
3. **车道 id 字符集跨语言同源**：JS 侧推导出的 sid 会被 host 当作文件名拼进
   `.stream/{session}.jsonl`，必须过 `agent-loop/src/trace.rs::stream_file_for` 的校验
   （ascii 字母数字 + `-_.`，子会话另加 `#`）。JS 侧若输出中文或空格，trace 就写不出来。
4. **纯函数语义**（需要 node，缺失则跳过）：推导结果合法、不同任务不撞车道、已收口任务
   不占车道、**当前车道永不消失**。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEBDIST = ROOT / "runtime" / "crates" / "host" / "web-dist"
CORE = WEBDIST / "vendor" / "app-core.js"
BOARD = WEBDIST / "vendor" / "app-board.js"
QBASE = WEBDIST / "vendor" / "q-session.js"
INDEX = WEBDIST / "index.html"
STYLE = WEBDIST / "style.css"
TRACE_RS = ROOT / "runtime" / "crates" / "agent-loop" / "src" / "trace.rs"


def _src(p: Path) -> str:
    return p.read_text(encoding="utf-8").replace("\r\n", "\n")


def _extract_fn(src: str, name: str) -> str:
    """按大括号配平截取 `function name(...) {...}` 全文。

    比正则可靠：函数体里含 `{`/`}` 字符串与模板串时，非配平的正则会提前截断，
    截出来的半截 JS 会被 node 报语法错，把真实缺陷掩盖成「测试环境问题」。
    """
    i = src.find(f"function {name}(")
    if i < 0:
        raise AssertionError(f"app-core.js 里找不到 function {name}")
    j = src.find("{", i)
    if j < 0:
        raise AssertionError(f"{name} 缺少函数体")
    depth = 0
    for k in range(j, len(src)):
        ch = src[k]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[i : k + 1]
    raise AssertionError(f"{name} 的大括号不配平")


class LaneStructure(unittest.TestCase):
    """静态结构：不改浏览器就发现不了的错，这层兜住。"""

    def test_lanes_sits_between_stream_and_feed(self):
        html = INDEX.read_text(encoding="utf-8")
        self.assertIn('id="lanes"', html, "缺少车道条容器 #lanes")
        self.assertEqual(html.count('id="lanes"'), 1, "#lanes 只能有一个")
        s = html.find('id="stream"')
        l = html.find('id="lanes"')
        f = html.find('id="feed"')
        self.assertTrue(s < l < f, f"#lanes 必须在 #stream 内、#feed 之前（got stream={s} lanes={l} feed={f}）")

    def test_lanes_hidden_by_default(self):
        """单车道时整条隐藏：单任务使用不该多出一排视觉噪音（车次数在 JS 里定）。"""
        html = INDEX.read_text(encoding="utf-8")
        m = re.search(r'<div id="lanes"[^>]*>', html)
        self.assertIsNotNone(m, "找不到 #lanes 开标签")
        self.assertIn("hidden", m.group(0), "#lanes 必须默认 hidden，由 renderLanes 按车道数放行")

    def test_css_has_lane_rule(self):
        css = _src(STYLE)
        self.assertIn("#lanes {", css, "style.css 缺少 #lanes 布局规则")
        self.assertIn("#lanes[hidden]", css, "hidden 需显式 display:none（flex 会覆盖 hidden 默认值）")
        self.assertIn(".lane.busy", css, "缺少「后台车道运行中」的视觉标记")


class LaneWiring(unittest.TestCase):
    """切换链路与看板联动：断一处就退化成「单会话 + 一排点不动的按钮」。"""

    def test_switch_session_not_empty(self):
        core = _src(CORE)
        self.assertNotIn("function switchSession() {}", core,
                         "switchSession 又变回空函数了——车道条点了不会动")
        self.assertIn("function switchSession(sid)", core, "switchSession 应接收车道 id")

    def test_snapshot_called_on_switch(self):
        """FE4 之后 snapshotSessionFeed 曾是死代码：没人调用 → 切走即丢。"""
        core = _src(CORE)
        self.assertIn("snapshotSessionFeed(session)", core,
                      "switchSession 必须在切走前快照当前车道，否则切回来内容全丢")
        self.assertIn("connect(undefined, true)", core,
                      "切换后必须带 useCache 重连（命中缓存瞬时显示 + 增量追赶）")

    def test_snapshot_fn_used_somewhere(self):
        """防御回归：q-session 定义的快照函数必须真有调用点（不只看 app-core）。"""
        q = _src(QBASE)
        self.assertIn("function snapshotSessionFeed(", q, "q-session.js 应保留快照实现")
        callers = [p for p in (CORE, BOARD) if "snapshotSessionFeed(" in _src(p)]
        self.assertTrue(callers, "snapshotSessionFeed 又成了无人调用的死代码")

    def test_board_refresh_repaints_lanes(self):
        """车道清单跟着看板走：任务由 agent 经 board.py 增删改，前端只跟着重排。"""
        board = _src(BOARD)
        self.assertIn("renderLanes()", board, "refreshBoard 后必须重绘车道条")
        i = board.find("async function refreshBoard")
        j = board.find("function", i + 10)
        seg = board[i : j if j > 0 else len(board)]
        self.assertIn("renderLanes", seg, "重绘必须发生在 refreshBoard 内（boardData 刚赋值之后）")
        self.assertLess(seg.find("boardData ="), seg.find("renderLanes"),
                        "renderLanes 必须在 boardData 赋值之后——laneList() 读的就是它")

    def test_no_task_write_from_ui(self):
        """车道 id 由任务 id 确定性推导，前端因此不需要写板。

        这条守的是既有边界：host `/api/board` 刻意不提供 task 写 op（任务只由 agent 经
        `board.py` 推进）。若哪天有人为了「记住当前车道」去给前端加 task 写面，这里会红。
        """
        host_board = ROOT / "runtime" / "crates" / "host" / "src" / "web" / "api" / "board.rs"
        src = host_board.read_text(encoding="utf-8")
        self.assertNotIn('"task.set"', src, "host /api/board 不应新增 task 写 op")


class LaneIdCharset(unittest.TestCase):
    """车道 id 会变成 trace 文件名，跨语言必须同源。"""

    def test_rust_gate_allows_expected_chars(self):
        rs = TRACE_RS.read_text(encoding="utf-8")
        self.assertIn("is_ascii_alphanumeric()", rs, "trace.rs 的 session 白名单应是 ascii 字母数字")
        for ch in ("'-'", "'_'", "'.'", "'#'"):
            self.assertIn(ch, rs, f"trace.rs 白名单应含 {ch}（否则车道 id 写不出 trace）")

    def test_js_sanitizer_excludes_hash(self):
        """`#` 是子代理会话分隔符（`{parent}#sub-{n}`），绝不可进车道 id：
        进了就会被当成子代理，SSE 按 `{session}#sub-*.jsonl` 前缀 glob 时会串。"""
        core = _src(CORE)
        fn = _extract_fn(core, "laneOfTask")
        self.assertIn("[^a-z0-9._-]", fn,
                      "laneOfTask 的字符集必须与 trace.rs 白名单一致（ascii 字母数字 + -_.）")
        self.assertNotIn("#", fn.replace("`#`", "").replace("#sub", ""),
                         "laneOfTask 的清洗集合里不能放行 #")

    def test_js_sanitizer_bounded(self):
        core = _src(CORE)
        fn = _extract_fn(core, "laneOfTask")
        self.assertIn(".slice(0, 64)", fn, "车道 id 需限长（trace.rs 限 session ≤64 字节）")


@unittest.skipUnless(shutil.which("node"), "需要 node 才能跑行为测试")
class LaneBehavior(unittest.TestCase):
    """纯函数语义（真跑 node）。这些是「看起来对、切起来错」的定点回归。"""

    def _run(self, body: str) -> str:
        core = _src(CORE)
        harness = "\n".join([
            '"use strict";',
            'const SESSION_ID = "main";',
            "let session = SESSION_ID;",
            "const LANE_MAIN = SESSION_ID;",
            "let boardData = null;",
            _extract_fn(core, "laneOfTask"),
            _extract_fn(core, "laneList"),
            "function setSession(s) { session = s; }",
            "function setBoard(b) { boardData = b; }",
            body,
        ])
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(harness)
            path = f.name
        try:
            r = subprocess.run([shutil.which("node"), path], capture_output=True, text=True, timeout=60)
        finally:
            Path(path).unlink(missing_ok=True)
        if r.returncode != 0:
            self.fail(f"node 执行失败: {r.stderr[:800]}")
        return r.stdout.strip()

    def test_charset_is_ascii_safe(self):
        out = self._run(
            'const got = ["T-20261108-14","T 20261108 14","T-20261108-14#sub-1",'
            '"a/b\\\\c","  空格  ","任务","__x.y__"].map(laneOfTask);'
            'console.log(JSON.stringify(got));'
        )
        got = json.loads(out)
        for v in got:
            self.assertRegex(v, r"^[a-z0-9._-]*$", f"推导结果含非法字符，trace 将写不出: {v!r}")
            self.assertNotIn("#", v, f"车道 id 不得含子代理分隔符 #: {v!r}")

    def test_distinct_tasks_distinct_lanes(self):
        out = self._run(
            'console.log(JSON.stringify([laneOfTask("T-1") !== laneOfTask("T-2"),'
            ' laneOfTask("T-1") === laneOfTask("t-1")]));'
        )
        distinct, case_fold = json.loads(out)
        self.assertTrue(distinct, "不同任务 id 必须推导出不同车道（否则两个任务挤在一条车道，K409）")
        self.assertTrue(case_fold, "大小写归一后应是同一条车道（id 不应因大小写分裂）")

    def test_closed_tasks_yield_no_lane(self):
        out = self._run(
            'setBoard({board:{tasks:[{id:"T-A",status:"doing"},{id:"T-B",status:"done"},'
            '{id:"T-C",status:"cancelled"},{id:"main",status:"doing"}]}});'
            'setSession("main");console.log(JSON.stringify(laneList().map(l=>l.sid)));'
        )
        self.assertEqual(json.loads(out), ["main", "t-a"],
                         "清单 = 主车道 + 未收口任务；done/cancelled 与撞主车道的任务都不占车道")

    def test_current_lane_never_vanishes(self):
        """站在一条已收口任务的车道上时，刷新/重绘不能把它抽走。"""
        out = self._run(
            'setBoard({board:{tasks:[{id:"T-B",status:"done"}]}});'
            'setSession("t-b");console.log(JSON.stringify(laneList().map(l=>l.sid)));'
        )
        self.assertIn("t-b", json.loads(out), "当前所在车道必须始终出现在清单里")

    def test_board_absent_only_main_lane(self):
        out = self._run('setBoard(null);setSession("main");console.log(JSON.stringify(laneList().map(l=>l.sid)));')
        self.assertEqual(json.loads(out), ["main"], "看板未加载时只有主车道，不得报错")


if __name__ == "__main__":
    unittest.main()
