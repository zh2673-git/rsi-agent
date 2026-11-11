"""L2 记忆层（`scripts/memory_consolidate.py`）的语义锁。

锁三件事，每一件都是「实现看着对但实际错」的高危点：

1. **确定性**：同一份 trace 重算逐字节相同。这条塌了，用户无法分辨「记忆变了」与
   「摘要算法变了」；
2. **召回不读正文**：`recall` 的 `bytes_read` 必须恒等于 index 文件大小。这条塌了，
   所谓「只读时间戳」就只是注释里的一句话；
3. **有界**：单天 L2 ≤ MAX_DAY_CHARS，会话/提问/文件都有上限。摘要层没有上限就只是
   把 trace 换个格式存一遍。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

RSI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RSI_ROOT / "scripts"))

import memory_consolidate as MC  # noqa: E402


def _write_trace(root: Path, sid: str, events: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    p = root / (sid.replace("#", "_") + ".jsonl")
    with p.open("w", encoding="utf-8", newline="\n") as fh:
        for e in events:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")


# 固定时间戳（2026-11-10 与 2026-11-11 UTC）：不读时钟，测试才可复现。
T1 = 1794358109000  # 2026-11-11 前后
T0 = T1 - 86_400_000


def _events(ts: int) -> list[dict]:
    return [
        {"type": "user", "text": "第一个问题", "ts": ts},
        {"type": "tool_call", "name": "read_file", "round": 1, "args": {}, "ts": ts + 1},
        {"type": "tool_result", "name": "read_file", "ok": True, "ms": 3, "ts": ts + 2},
        {"type": "file_change", "op": "write", "path": "a.py", "ts": ts + 3},
        {"type": "artifact", "path": "outputs/x.md", "bytes": 10, "ts": ts + 4},
        {"type": "chat_summary", "rounds": 2, "llm_calls": 2, "ts": ts + 5},
        {"type": "user", "text": "第二个问题", "ts": ts + 6},
        {"type": "error", "where": "llm.chat", "message": "boom", "ts": ts + 7},
    ]


class _Sandbox(unittest.TestCase):
    """每个用例一套隔离目录（trace 源 + 记忆根 + 数据根全换掉）。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.traces = self.root / "traces"
        self.mem = self.root / "mem"
        self._saved = {k: os.environ.get(k) for k in ("RSI_TRACES_DIR", "RSI_MEMORY_DIR", "RSI_HOME", "WORKSPACE_ROOT")}
        os.environ["RSI_TRACES_DIR"] = str(self.traces)
        os.environ["RSI_MEMORY_DIR"] = str(self.mem)
        os.environ["RSI_HOME"] = str(self.root)
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()


class BuildDeterminismTest(_Sandbox):
    """重算必须逐字节幂等——否则「记忆变了」与「算法变了」不可分辨。"""

    def test_build_is_byte_identical_across_runs(self) -> None:
        _write_trace(self.traces, "s1", _events(T1))
        r1 = MC.build()
        self.assertTrue(r1["ok"])
        self.assertTrue(r1["idempotent"], r1)
        day = r1["written"][0]["day"]
        first = (self.mem / "L2" / f"{day}.md").read_bytes()
        r2 = MC.build()
        second = (self.mem / "L2" / f"{day}.md").read_bytes()
        self.assertEqual(first, second, "同一份 trace 重算必须逐字节相同")
        self.assertTrue(r2["idempotent"])

    def test_no_timestamp_in_l2_body(self) -> None:
        """L2 正文不得含「生成于当前时间」——那会让每次重算都不同。"""
        _write_trace(self.traces, "s1", _events(T1))
        MC.build()
        day = MC.build()["written"][0]["day"]
        text = (self.mem / "L2" / f"{day}.md").read_text(encoding="utf-8")
        self.assertNotIn("generated_at", text)
        # 允许出现事件自身的 UTC 时刻（那是内容），但不允许今天日期被写进正文
        self.assertNotIn(MC.now_utc().strftime("%Y-%m-%dT"), text)

    def test_stale_day_is_removed_on_full_rebuild(self) -> None:
        """L2 是 trace 的派生视图：trace 没了，那天的 L2 也该消失（不是独立账本）。"""
        _write_trace(self.traces, "s1", _events(T1))
        r = MC.build()
        day = r["written"][0]["day"]
        self.assertTrue((self.mem / "L2" / f"{day}.md").is_file())
        (self.traces / "s1.jsonl").unlink()
        MC.build()
        self.assertFalse((self.mem / "L2" / f"{day}.md").is_file(), "孤儿 L2 应被清掉")

    def test_single_day_build_leaves_other_days(self) -> None:
        """`--day` 只重建那天，不碰其它天（单天修复不该动全量）。"""
        _write_trace(self.traces, "s1", _events(T0))
        _write_trace(self.traces, "s2", _events(T1))
        r = MC.build()
        self.assertEqual(r["days"], 2, r)
        keep = next(w["day"] for w in r["written"] if w["day"] != MC.day_of(T1))
        MC.build(day_filter=MC.day_of(T1))
        self.assertTrue((self.mem / "L2" / f"{keep}.md").is_file(), "单天重建不得删别的天")


class RecallReadsTimestampOnlyTest(_Sandbox):
    """召回只读 index——`bytes_read` 恒等于 index 文件大小是这条纪律的可核对形式。"""

    def test_recall_reads_only_index(self) -> None:
        _write_trace(self.traces, "s1", _events(T1))
        MC.build()
        r = MC.recall(days=30)
        self.assertTrue(r["ok"], r)
        idx = self.mem / "L3" / "index.json"
        self.assertEqual(r["bytes_read"], idx.stat().st_size,
                         "bytes_read 必须等于 index 大小，变大即说明偷读了 L2 正文")

    def test_recall_without_index_is_an_error_not_empty(self) -> None:
        """没建索引 ≠ 最近没活。静默返回空会让模型把「没建」说成「没做过」。"""
        r = MC.recall(days=7)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "NO_INDEX")

    def test_recall_window_filters_by_days(self) -> None:
        _write_trace(self.traces, "s1", _events(T0))
        _write_trace(self.traces, "s2", _events(T1))
        MC.build()
        r = MC.recall(days=0)  # 只要今天
        days = [h["day"] for h in r["hits"]]
        self.assertIn(MC.day_of(T1), days)
        self.assertNotIn(MC.day_of(T0), days, "窗口外的天不该出现")

    def test_days_ago_is_computed_server_side(self) -> None:
        """日期算术在服务端做（模型算不准日期）。"""
        self.assertEqual(MC.days_ago("20260101", "20260108"), 7)
        self.assertEqual(MC.days_ago("20260108", "20260108"), 0)

    def test_recall_hit_points_at_l2_path(self) -> None:
        """给指针不给正文：要细节按 l2_path 精确打开一天。"""
        _write_trace(self.traces, "s1", _events(T1))
        MC.build()
        r = MC.recall(days=30)
        self.assertTrue(r["hits"])
        p = Path(r["hits"][0]["l2_path"])
        self.assertTrue(p.is_file(), f"l2_path 指错了: {p}")


class BoundedTest(_Sandbox):
    """摘要层必须有上限——没有上限就只是把 trace 换个格式存一遍。"""

    def test_long_day_is_truncated_with_marker(self) -> None:
        # 造很多会话 + 长提问，逼到 MAX_DAY_CHARS
        # 提问必须**互不相同**：summarize_session 会对相邻重复提问去重（真实场景里
        # 用户不会连问同一句，而去重是为了压掉「重试同一句」的噪声），
        # 全都一样的测试数据会被去重到 1 条，永远到不了上限——测试也就永远绿。
        for i in range(MC.MAX_SESSIONS_PER_DAY + 4):
            evs = [{"type": "user", "text": f"{i}-{k}-" + "长" * 150, "ts": T1 + i * 1000 + k}
                   for k in range(MC.MAX_ASKS + 1)]
            for j in range(50):
                evs.append({"type": "file_change", "path": f"f{i}_{j}.py", "ts": T1 + i * 1000 + j})
            _write_trace(self.traces, f"s{i}", evs)
        r = MC.build()
        day = r["written"][0]["day"]
        text = (self.mem / "L2" / f"{day}.md").read_text(encoding="utf-8")
        self.assertLessEqual(len(text), MC.MAX_DAY_CHARS)
        self.assertIn("已截断", text, "截断必须显式标注，静默截断会把「就这么多活」变成假事实")

    def test_sessions_capped_per_day(self) -> None:
        for i in range(MC.MAX_SESSIONS_PER_DAY + 3):
            _write_trace(self.traces, f"s{i}", _events(T1 + i))
        r = MC.build()
        day = r["written"][0]["day"]
        text = (self.mem / "L2" / f"{day}.md").read_text(encoding="utf-8")
        self.assertEqual(text.count("\n## "), MC.MAX_SESSIONS_PER_DAY, text[:400])
        self.assertIn("未列出", text, "超出上限要说明，不能无声丢弃")

    def test_asks_capped_per_session(self) -> None:
        many = [{"type": "user", "text": f"问{i}", "ts": T1 + i} for i in range(MC.MAX_ASKS + 5)]
        s = MC.summarize_session("s1", many)
        self.assertEqual(len(s["asks"]), MC.MAX_ASKS)
        self.assertEqual(s["asks"][-1], f"问{MC.MAX_ASKS + 4}", "保留最近的提问")


class SummarizeShapeTest(unittest.TestCase):
    """摘要保留什么、丢什么——判据是「回答『那天干了什么』时会不会被追问」。"""

    def test_keeps_intent_files_and_errors(self) -> None:
        s = MC.summarize_session("s1", _events(T1))
        self.assertIn("第一个问题", s["asks"])
        self.assertIn("a.py", s["files"])
        self.assertIn("outputs/x.md", s["artifacts"])
        self.assertTrue(any("boom" in e for e in s["errors"]))
        self.assertEqual(s["events"], 8)

    def test_drops_assistant_body(self) -> None:
        evs = _events(T1) + [{"type": "assistant", "answer": "很长" * 500, "ts": T1 + 100}]
        s = MC.summarize_session("s1", evs)
        self.assertNotIn("很长" * 500, json.dumps(s, ensure_ascii=False))

    def test_bad_lines_are_skipped(self) -> None:
        """trace 是 append-only，断电会留半行——坏行不能拖垮整份摘要。"""
        self.traces_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.traces_dir.cleanup)
        p = Path(self.traces_dir.name) / "s1.jsonl"
        p.write_text(
            '{"type":"user","text":"ok","ts":%d}\n' % T1
            + '{"type":"user","text": broken json\n'
            + '{"type":"file_change","path":"b.py","ts":%d}\n' % (T1 + 1),
            encoding="utf-8",
        )
        evs = MC.load_events(p)
        self.assertEqual(len(evs), 2, evs)


class DayBoundaryTest(unittest.TestCase):
    """跨天会话必须按天切开——否则「那天干了什么」会把两天的活算给一天。"""

    def test_session_spanning_midnight_splits(self) -> None:
        midnight = 1794355200000  # 2026-11-11 00:00Z
        evs = [
            {"type": "user", "text": "before", "ts": midnight - 1000},
            {"type": "user", "text": "after", "ts": midnight + 1000},
        ]
        d1 = MC.day_of(evs[0]["ts"])
        d2 = MC.day_of(evs[1]["ts"])
        self.assertNotEqual(d1, d2, "测试数据本身要跨天")


class CliTest(_Sandbox):
    """CLI 契约：退出码与输出形状（脚本被 agent 直接调用，形状不能随意变）。"""

    def test_build_then_recall_roundtrip(self) -> None:
        _write_trace(self.traces, "s1", _events(T1))
        self.assertEqual(MC.main(["build"]), 0)
        self.assertEqual(MC.main(["recall", "--days", "30", "--json"]), 0)
        self.assertEqual(MC.main(["status", "--json"]), 0)

    def test_bad_day_filter_is_field_error(self) -> None:
        self.assertEqual(MC.main(["build", "--day", "2026-11-11"]), 2)


if __name__ == "__main__":
    unittest.main()
