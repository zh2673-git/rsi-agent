# -*- coding: utf-8 -*-
"""C 轮（评价体系 / @引用装载 / 跨任务聚合 / 受约束的插件化看板）的契约回归。

只读源码文本断言 + 纯函数级 CLI 测试，不启动 host；覆盖四块能力与两条不变量：
  - 评价体系：checks 执行器（cmd/file/grep/manual）、verdict 判定、失败退回 doing、done 前的证据闸；
  - @引用装载：resolve 一次给全上下文，缺失引用显式上报；
  - 跨任务聚合：digest 按技能/状态收敛，brief 只给最小信息面；
  - 布局：layout 白名单封闭 + 顺序钉死（乱序配置改变不了结构）；
  - 不变量：无新增第三方依赖、UI 仍不写任务、SSE 事件类型未增。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_PY = ROOT / "scripts" / "board.py"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def board_json(*args: str, ws: Path) -> tuple[int, dict]:
    env = dict(os.environ)
    env["WORKSPACE_ROOT"] = str(ws)
    env.pop("RSI_BOARD_PATH", None)
    r = subprocess.run(
        [sys.executable, str(BOARD_PY), *args],
        capture_output=True, text=True, encoding="utf-8", env=env,
    )
    try:
        return r.returncode, json.loads(r.stdout)
    except ValueError:
        raise AssertionError(f"board.py 输出不是 JSON: stdout={r.stdout!r} stderr={r.stderr!r}")


def make_task(ws: Path, **kw) -> str:
    payload = {"title": "任务", **kw}
    p = ws / "t.json"
    p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    code, out = board_json("task-upsert", "--file", str(p), ws=ws)
    assert code == 0, out
    return out["id"]


def seed_inspiration(ws: Path, text: str, *, tags: list[str] | None = None) -> str:
    """直接写 board.json 造灵感（G 轮起 agent 侧无灵感写命令）。"""
    p = ws / ".rsi" / "board.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    board = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {
        "version": 1, "tasks": [], "inspirations": [],
    }
    items = board.setdefault("inspirations", [])
    iid = f"I-20261108-{len(items) + 1:02d}"
    items.insert(0, {
        "id": iid, "text": text, "tags": tags or [], "status": "open", "tasks": [],
        "created_at": "2026-11-08T00:00:00Z", "updated_at": "2026-11-08T00:00:00Z",
    })
    p.write_text(json.dumps(board, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return iid


class EvaluationTest(unittest.TestCase):
    """C1：checks = 机跑的证明（acceptance 是人读的标准）。"""

    def test_eval_runs_all_four_kinds_and_records_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            (ws / "artifact.txt").write_text("hello", encoding="utf-8")
            tid = make_task(ws, checks=[
                {"id": "c1", "kind": "file", "name": "产物存在", "target": "artifact.txt"},
                {"id": "c2", "kind": "cmd", "name": "退出 0", "target": "python -c \"print(1)\""},
                {"id": "c3", "kind": "grep", "name": "文本命中", "target": "hello", "scope": "."},
                {"id": "c4", "kind": "manual", "name": "人判"},
            ])
            code, out = board_json("eval", tid, ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["verdict"], "pass")
            self.assertEqual((out["pass"], out["fail"], out["skip"]), (3, 0, 1))

            _, shown = board_json("show", tid, ws=ws)
            checks = {c["id"]: c for c in shown["task"]["checks"]}
            self.assertEqual(checks["c1"]["evidence"]["exists"], True)
            self.assertEqual(checks["c2"]["evidence"]["exit_code"], 0)
            self.assertGreaterEqual(checks["c3"]["evidence"]["hits"], 1, "grep 命中数应 ≥1")
            # manual 永远 skip：agent 不能给自己判过
            self.assertEqual(checks["c4"]["status"], "skip")
            for c in checks.values():
                self.assertIn("last_run", c, "每条检查必须留运行时间")
                self.assertIn("evidence", c, "每条检查必须留证据")

    def test_failed_check_downgrades_done_back_to_doing(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = make_task(ws, acceptance=["x"], checks=[
                {"id": "c1", "kind": "cmd", "name": "会失败", "target": "python -c \"import sys;sys.exit(3)\""},
            ])
            board_json("task-status", tid, "done", ws=ws)
            code, out = board_json("eval", tid, ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["verdict"], "fail")
            self.assertEqual(out["failed"], ["c1"])
            self.assertEqual(out["status"], "doing", "验收挂了不得停在 done（假完成必须退回执行）")

    def test_done_without_passing_eval_warns(self):
        """有 checks 却没跑（verdict=none）就 done → 提示级告警（自证不是证据）。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = make_task(ws, acceptance=["x"], checks=[
                {"id": "c1", "kind": "file", "name": "产物", "target": "nope.txt"},
            ])
            code, out = board_json("task-status", tid, "done", ws=ws)
            self.assertEqual(code, 0)
            self.assertIn("warning", out)
            self.assertIn("eval", out["warning"])
            # 跑过一次（即使失败）后，verdict 变成 fail，告警文案换成「全 PASS 再收尾」同一类
            board_json("eval", tid, ws=ws)
            code, out = board_json("task-status", tid, "done", ws=ws)
            self.assertIn("evaluation.verdict=fail", out.get("warning", ""), out)

    def test_eval_without_checks_is_explicit_error(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = make_task(ws, acceptance=["人判就够了"])
            code, out = board_json("eval", tid, ws=ws)
            self.assertEqual(code, 1)
            self.assertEqual(out["error"]["code"], "NO_CHECKS")
            self.assertEqual(out["error"]["field"], "checks")

    def test_only_runs_selected_checks_and_keeps_others(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = make_task(ws, checks=[
                {"id": "c1", "kind": "cmd", "name": "先跑这个", "target": "python -c \"pass\""},
                {"id": "c2", "kind": "cmd", "name": "这个先不跑", "target": "python -c \"raise SystemExit(0)\""},
            ])
            _, out = board_json("eval", tid, "--only", "c1", ws=ws)
            self.assertEqual(out["verdict"], "pass")
            self.assertEqual(out["pass"], 1)
            _, shown = board_json("show", tid, ws=ws)
            statuses = {c["id"]: c["status"] for c in shown["task"]["checks"]}
            self.assertEqual(statuses["c1"], "pass")
            self.assertEqual(statuses["c2"], "pending", "未被选中的检查不得被改写")

    def test_check_add_appends_without_rewriting_task(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = make_task(ws, goal="保留这个目标", checks=[
                {"id": "c1", "kind": "file", "name": "a", "target": "a.txt"},
            ])
            p = ws / "c.json"
            p.write_text(json.dumps({"id": "c2", "kind": "manual", "name": "人判"}), encoding="utf-8")
            code, out = board_json("check-add", tid, "--file", str(p), ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["checks"], 2)
            _, shown = board_json("show", tid, ws=ws)
            self.assertEqual(shown["task"]["goal"], "保留这个目标", "check-add 不得清空既有字段")

    def test_check_validation_rejects_bad_input(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            p = ws / "t.json"
            p.write_text(json.dumps({"title": "x", "checks": [{"id": "c1", "kind": "nope",
                                                               "target": "x"}]}), encoding="utf-8")
            code, out = board_json("task-upsert", "--file", str(p), ws=ws)
            self.assertEqual(code, 1)
            self.assertTrue(out["error"]["field"].startswith("checks"), out)
            p.write_text(json.dumps({"title": "x", "checks": [
                {"id": "c1", "kind": "cmd", "target": "x", "timeout_secs": 9999}]}), encoding="utf-8")
            code, out = board_json("task-upsert", "--file", str(p), ws=ws)
            self.assertEqual(code, 1, "timeout_secs 超界必须拒绝")


class ReferenceResolveTest(unittest.TestCase):
    """C2：@引用装载——一次给全，缺失显式上报，不改板。"""

    def test_resolve_returns_both_kinds_and_missing(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = make_task(ws, goal="目标句", plan=[{"step": "一步"}], acceptance=["能跑"],
                            resourcing={"skills": ["project-dev"]})
            iid = seed_inspiration(ws, "看板要有约束", tags=["ui"])
            before = (ws / ".rsi" / "board.json").read_text(encoding="utf-8")
            code, out = board_json("resolve", f"接着做 @{tid} 和 @{iid}，另外 @T-20990101-01", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["count"], 2)
            kinds = [r["type"] for r in out["refs"]]
            self.assertEqual(kinds, ["task", "inspiration"], "任务是账、灵感是料：任务在前")
            task = out["refs"][0]
            for key in ("goal", "plan", "acceptance", "resourcing", "progress", "artifacts"):
                self.assertIn(key, task, f"引用块缺 {key}")
            self.assertEqual(out["refs"][1]["tags"], ["ui"])
            self.assertEqual(out["missing"], ["T-20990101-01"])
            self.assertEqual((ws / ".rsi" / "board.json").read_text(encoding="utf-8"), before,
                             "resolve 是只读解析，不得改板")

    def test_resolve_without_refs_is_noop(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            code, out = board_json("resolve", "没有引用的一句话", ws=ws)
            self.assertEqual(code, 0)
            self.assertEqual(out["count"], 0)
            self.assertIn("note", out)


class DigestTest(unittest.TestCase):
    """C3：跨任务聚合——同类任务的归纳面，粒度由调用方控制。"""

    def test_digest_filters_and_aggregates(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            a = make_task(ws, title="写技能", resourcing={"skills": ["creat-skill"]},
                          acceptance=["有案例"], artifacts=["outputs/a.md"])
            b = make_task(ws, title="改看板", resourcing={"skills": ["project-dev"]})
            board_json("task-status", b, "done", ws=ws)
            _, out = board_json("digest", ws=ws)
            self.assertEqual(out["total"], 2)
            by_skill = {s["skill"]: s for s in out["by_skill"]}
            self.assertEqual(by_skill["creat-skill"]["open"], 1)
            self.assertEqual(by_skill["project-dev"]["done"], 1)
            # 完整档带 goal/acceptance/artifacts；brief 只给最小面
            full = next(t for t in out["tasks"] if t["id"] == a)
            self.assertIn("artifacts", full)
            _, brief = board_json("digest", "--brief", ws=ws)
            self.assertNotIn("artifacts", brief["tasks"][0])
            self.assertIn("verdict", brief["tasks"][0])
            # 按技能过滤
            _, only = board_json("digest", "--skill", "creat-skill", ws=ws)
            self.assertEqual([t["id"] for t in only["tasks"]], [a])


class LayoutTest(unittest.TestCase):
    """C4：受约束的插件化——枚举封闭 + 顺序钉死。"""

    def _wc(self, ws: Path, layout: dict) -> tuple[int, dict]:
        p = ws / "layout.json"
        p.write_text(json.dumps(layout, ensure_ascii=False), encoding="utf-8")
        return board_json("layout", "--file", str(p), ws=ws)

    def test_layout_defaults_to_tasks_then_inspirations(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            code, out = board_json("layout", ws=ws)
            self.assertEqual(code, 0)
            kinds = [s["kind"] for s in out["layout"]["sections"]]
            self.assertEqual(kinds, ["tasks", "inspirations"])

    def test_layout_order_is_pinned_by_kind(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            code, out = self._wc(ws, {"sections": [
                {"id": "insp", "kind": "inspirations", "title": "灵感"},
                {"id": "m", "kind": "metrics", "metrics": ["verdict", "acceptance"]},
                {"id": "t", "kind": "tasks", "group_by": "skill", "filter": "open", "limit": 5},
            ]})
            self.assertEqual(code, 0, out)
            kinds = [s["kind"] for s in out["layout"]["sections"]]
            self.assertEqual(kinds, ["tasks", "metrics", "inspirations"], "配置乱序不得改变结构")
            t = out["layout"]["sections"][0]
            self.assertEqual((t["group_by"], t["filter"], t["limit"]), ("skill", "open", 5))
            self.assertEqual(out["layout"]["sections"][1]["metrics"], ["verdict", "acceptance"])

    def test_layout_rejects_unknown_kind_duplicate_id_and_overlong(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            for bad, field in (
                ({"sections": [{"id": "x", "kind": "chart"}]}, "sections"),
                ({"sections": [{"id": "a", "kind": "tasks"}, {"id": "a", "kind": "tasks"}]}, "sections"),
                ({"sections": []}, "layout.sections"),
                ({"sections": [{"id": "x", "kind": "metrics", "metrics": ["nope"]}]}, "metrics"),
                ({"sections": [{"id": "x", "kind": "tasks", "limit": 0}]}, "sections"),
            ):
                code, out = self._wc(ws, bad)
                self.assertEqual(code, 1, f"应拒绝: {bad}")
                got = out["error"]["field"]
                self.assertTrue(got == field or got.startswith(field + "["),
                                f"{bad} → field={got}（期望 {field} 或其下具体项）")

    def test_layout_written_by_cli_is_visible_to_host_and_persists(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            self._wc(ws, {"sections": [{"id": "tasks", "kind": "tasks", "title": "我的任务"}]})
            data = json.loads((ws / ".rsi" / "board.json").read_text(encoding="utf-8"))
            self.assertEqual(data["layout"]["sections"][0]["title"], "我的任务")
            # 再读回来仍是同一份（不被兜底覆盖）
            _, out = board_json("layout", ws=ws)
            self.assertEqual(out["layout"]["sections"][0]["title"], "我的任务")

    def test_refresh_fills_checks_and_evaluation(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            p = ws / ".rsi" / "board.json"
            p.parent.mkdir(parents=True)
            p.write_text(json.dumps({"tasks": [{"id": "T-20260101-01"}], "inspirations": []}),
                         encoding="utf-8")
            code, out = board_json("refresh", ws=ws)
            self.assertEqual(code, 0, out)
            t = json.loads(p.read_text(encoding="utf-8"))["tasks"][0]
            self.assertEqual(t["checks"], [])
            self.assertEqual(t["evaluation"]["verdict"], "none")


class CrossLayerContractTest(unittest.TestCase):
    """跨语言同源 + 不变量（改一侧忘另一侧的检测点）。"""

    def test_layout_whitelist_present_in_both_sides(self):
        py = read("scripts/board.py")
        rs = read("runtime/crates/host/src/web/api/board.rs")
        for kind in ("tasks", "inspirations", "metrics"):
            self.assertIn(f'"{kind}"', py)
            self.assertIn(f'"{kind}"', rs)
        for item in ("by_status", "by_skill", "verdict", "acceptance"):
            self.assertIn(f'"{item}"', py)
            self.assertIn(f'"{item}"', rs)

    def test_host_board_keeps_layout_and_offers_layout_set(self):
        rs = read("runtime/crates/host/src/web/api/board.rs")
        self.assertIn("fn normalize_layout", rs)
        self.assertIn("fn default_layout", rs)
        self.assertIn('"layout.set"', rs, "POST 必须支持写布局")
        self.assertIn('board["layout"] = lay.clone()', rs, "load_board 必须带出 layout")
        self.assertIn("by_verdict", rs)

    def test_agent_loop_loads_refs_before_prompt(self):
        chat = read("runtime/crates/agent-loop/src/chat.rs")
        self.assertIn("board_ctx::refs_context", chat)
        self.assertIn("board_ctx", read("runtime/crates/agent-loop/src/lib.rs"))
        ctx = read("runtime/crates/agent-loop/src/board_ctx.rs")
        self.assertIn("fn extract_refs", ctx)
        self.assertIn("fn refs_context", ctx)
        self.assertIn("fn board_ops_hint", ctx)
        # 只读纪律：不得有写盘调用
        for banned in ("fs::write", "fs::rename", "OpenOptions"):
            self.assertNotIn(banned, ctx, "看板上下文装载只能是只读")

    def test_ui_still_read_only_on_tasks_and_no_new_event_types(self):
        js = read("runtime/crates/host/web-dist/vendor/app-board.js")
        self.assertNotIn("task-upsert", js, "UI 不得直接写任务（任务归 agent）")
        self.assertIn('op: "inspiration.add"', js)
        self.assertNotIn("draggable", js, "看板不得引入自由拖拽")
        self.assertIn("KIND_ORDER", js)
        self.assertEqual(js.count("KIND_ORDER"), js.count("KIND_ORDER"), "占位：常量必须在位")
        # 顺序钉死：渲染前按 KIND_ORDER 排序
        self.assertIn("KIND_ORDER.indexOf", js)
        gw = read("runtime/crates/host/src/web/gateway.rs")
        for banned in ('"type": "board"', '"type": "task"'):
            self.assertNotIn(banned, gw, "不得新增 SSE 事件类型")

    def test_no_new_dependency(self):
        py = read("scripts/board.py")
        for banned in ("import requests", "import httpx", "import pytz", "import dateutil"):
            self.assertNotIn(banned, py, "board.py 只用标准库")
        # checks 的 grep 用纯 Python 扫描，不依赖 PATH 里的 findstr/grep
        self.assertIn("def _run_check", py)
        self.assertNotIn("subprocess.run([\"findstr\"", py)


if __name__ == "__main__":
    unittest.main()
