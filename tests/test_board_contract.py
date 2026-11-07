# -*- coding: utf-8 -*-
"""B 轮（单会话形态 + 任务看板 / 灵感看板）的轻量契约回归。

只读源码文本断言 + 纯函数级 CLI 测试，不启动 host；覆盖「补丁幂等 + 关键不变量」，
防止后续升级运行时快照时把本轮的 UI/提示词/数据契约整体冲掉而毫无报警。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PDIR = ROOT / "scripts" / "patches"
BOARD_PY = ROOT / "scripts" / "board.py"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def board_json(*args: str, ws: Path) -> tuple[int, dict]:
    """在指定工作区跑 board.py，返回 (exit_code, 解析后的输出)。"""
    env = dict(os.environ)
    env["WORKSPACE_ROOT"] = str(ws)
    env.pop("RSI_BOARD_PATH", None)
    r = subprocess.run(
        [sys.executable, str(BOARD_PY), *args],
        capture_output=True, text=True, encoding="utf-8", env=env,
    )
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise AssertionError(f"board.py 输出不是 JSON: stdout={r.stdout!r} stderr={r.stderr!r}")
    return r.returncode, out


class PatchSetTest(unittest.TestCase):
    def test_b_round_patches_well_formed(self):
        ids = []
        for f in sorted(PDIR.glob("*.json")):
            d = json.loads(f.read_text(encoding="utf-8"))
            ids.append(d["id"])
            self.assertTrue(d.get("description"), f"{f.name} 缺 description")
            if d.get("create"):
                self.assertTrue((PDIR / d["content_file"]).is_file(), f"{f.name} content_file 缺失")
                self.assertTrue(d.get("create_marker"), f"{f.name} 缺 create_marker")
            else:
                self.assertTrue((ROOT / d["file"]).is_file(), f"{f.name} 目标不存在: {d['file']}")
                for key in ("anchor_file", "patch_file"):
                    if key in d:
                        self.assertTrue((PDIR / d[key]).is_file(), f"{f.name} {key} 缺失")
                self.assertTrue("anchor" in d or "anchor_file" in d, f"{f.name} 既无 anchor 也无 anchor_file")
                self.assertTrue("patch" in d or "patch_file" in d, f"{f.name} 既无 patch 也无 patch_file")
        self.assertEqual(len(ids), len(set(ids)), "补丁 id 必须全局唯一")

    def test_b_round_patches_present(self):
        """B/FE 两轮补丁在位（被误删时立刻可见）。

        C 轮退役：`B5`（chat.rs 透传）与 `FE1`（index.html 会话列表→看板分区）的区域被
        `C-CTX-CHAT` 与 `FE8-SIDEBAR` 合法改写（B 轮那条塞在 skills_appendix 调用同一行、
        FE1 的整块 sidebar 被布局容器取代），按 P5b/O 轮先例转 `retired/` 留档，终态内容
        由 C 轮补丁承接——退役不等于功能消失，故这里改查 retired 目录。
        """
        ids = {json.loads(f.read_text(encoding="utf-8"))["id"] for f in PDIR.glob("*.json")}
        for pid in ("B1", "B2", "B3", "B4a", "B4b", "B4c", "B6", "B7",
                    "FE2", "FE3", "FE4", "FE5", "FE6"):
            self.assertIn(pid, ids, f"补丁 {pid} 缺失")
        retired = {f.name for f in (PDIR / "retired").glob("*.retired")}
        for fname in ("b5-chat-want-plan.json.retired", "fe1-index-sidebar.json.retired"):
            self.assertIn(fname, retired, f"退役补丁需留档: {fname}")
        # C 轮新增补丁在位
        for pid in ("C-CTX-MODULE", "C-CTX-MOD", "C-CTX-CHAT", "C-CTX-SKILLS", "C-TESTS",
                    "C1-BOARD-FNS", "C2-LOAD-LAYOUT", "C3-GET-HEAD", "C4-GET-BODY",
                    "C5-LAYOUT-OP", "C6-OP-DOC", "C8-BOARD-TESTS",
                    "C-STYLE", "FE7-BOARD", "FE8-SIDEBAR"):
            self.assertIn(pid, ids, f"C 轮补丁 {pid} 缺失")


class SingleSessionUITest(unittest.TestCase):
    def test_sidebar_has_board_not_sessions(self):
        html = read("runtime/crates/host/web-dist/index.html")
        # 单会话：无会话列表容器、无「新建对话」、无会话小标
        self.assertNotIn('id="sessions"', html, "左栏不得再有会话列表容器")
        self.assertNotIn('id="newchat"', html, "左栏不得再有「新建对话」")
        self.assertNotIn('id="session-tag"', html, "header 不得再显示会话名")
        # C 轮：左栏不再是两个写死分区，而是布局装配容器（章节由 app-board.js 按 layout 装配）
        self.assertIn('id="board-sections"', html, "左栏必须有布局装配容器")
        self.assertLess(html.index('id="board-sections"'), html.index('id="btn-newwin"'),
                        "章节容器必须在底部窗口操作之前")
        # 新窗口入口保留（多实例仍需要）
        self.assertIn('id="btn-newwin"', html)

    def test_board_js_registered_and_contract(self):
        html = read("runtime/crates/host/web-dist/index.html")
        self.assertIn("/vendor/app-board.js", html, "app-board.js 必须被引入")
        js = read("runtime/crates/host/web-dist/vendor/app-board.js")
        # 约束布局：固定组序 + 优先级/时间排序，不提供拖拽
        self.assertIn('const BOARD_ORDER = ["planning", "doing", "verifying", "done", "blocked", "cancelled"]', js)
        self.assertIn("PRIO_RANK", js)
        self.assertNotIn("draggable", js, "看板不得引入自由拖拽（约束排布是前提）")
        # 只读任务 + 可写灵感（权限的界面表达）
        self.assertIn('op: "inspiration.add"', js)
        self.assertIn('op: "inspiration.set"', js)
        self.assertNotIn("task-upsert", js, "UI 不得直接写任务（任务归 agent）")
        # @引用以纯文本注入，不新增事件类型
        self.assertIn("function mentionRef", js)
        self.assertIn("`@${id} `", js)

    def test_core_single_session_keeps_compat_shims(self):
        core = read("runtime/crates/host/web-dist/vendor/app-core.js")
        self.assertIn('const SESSION_ID = "main"', core)
        # 旧调用点仍在 app-events.js 中使用 → 兼容层必须保留这些名字，否则运行期 ReferenceError
        events = read("runtime/crates/host/web-dist/vendor/app-events.js")
        for name in ("touchSession(session)", "autoName(session"):
            self.assertIn(name, events, f"app-events.js 仍调用 {name}")
        for name in ("function touchSession()", "function autoName()", "function renderSessions()"):
            self.assertIn(name, core, f"兼容层缺 {name}（否则发送路径 ReferenceError）")
        # 旧多会话 key 必须清理
        self.assertIn('localStorage.removeItem("ra.sessions#"', core)

    def test_style_has_board_sections(self):
        css = read("runtime/crates/host/web-dist/style.css")
        for marker in (".board-sec", ".tgroup", ".trow", ".tprio.p-P0", ".insp-add",
                       ".dplan .pdot.completed", ".tdetail"):
            self.assertIn(marker, css, f"style.css 缺 {marker}")


class BoardContractTest(unittest.TestCase):
    """CLI 侧数据契约（与 Rust board.rs 同源常量的可执行断言）。"""

    def test_constants_match_rust_side(self):
        py = read("scripts/board.py")
        rs = read("runtime/crates/host/src/web/api/board.rs")
        for status in ("planning", "doing", "verifying", "done", "blocked", "cancelled"):
            self.assertIn(f'"{status}"', py)
            self.assertIn(f'"{status}"', rs)
        for status in ("open", "adopted", "archived"):
            self.assertIn(f'"{status}"', py)
            self.assertIn(f'"{status}"', rs)
        for limit in ("MAX_TASKS = 200", "MAX_INSP = 500", "MAX_INSP_TEXT = 2000"):
            self.assertIn(limit, py)
        for limit in ("MAX_TASKS: usize = 200", "MAX_INSP: usize = 500", "MAX_INSP_TEXT: usize = 2000"):
            self.assertIn(limit, rs)

    def test_workspace_relative_board_path(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            code, out = board_json("stats", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(Path(out["path"]), ws / ".rsi" / "board.json",
                             "看板必须落在工作区内的 .rsi/board.json")

    def test_task_lifecycle_and_progress(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            plan = {"title": "左栏改看板", "goal": "UI 不分会话", "priority": "P1",
                    "plan": [{"step": "契约"}, {"step": "Rust"}, {"step": "前端"}],
                    "resourcing": {"model": "current", "effort": "large",
                                   "skills": ["project-dev"], "tools": ["bash"]},
                    "acceptance": ["GET /api/board 可用", "左栏无会话列表"]}
            pfile = ws / "plan.json"
            pfile.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
            code, out = board_json("task-upsert", "--file", str(pfile), ws=ws)
            self.assertEqual(code, 0, out)
            tid = out["id"]
            self.assertRegex(tid, r"^T-\d{8}-\d{2}$")
            self.assertTrue(out["created"])

            # 进度：3/5 且从 planning 自动转 doing
            code, out = board_json("task-progress", tid, "1/3", "--note", "契约已定", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["progress"], {"done": 1, "total": 3, "note": "契约已定"})
            self.assertEqual(out["status"], "doing", "有进展应自动离开始计划态")

            # 状态迁移 + 人财物读回
            code, out = board_json("task-status", tid, "verifying", ws=ws)
            self.assertEqual(code, 0, out)
            code, out = board_json("show", tid, ws=ws)
            self.assertEqual(code, 0, out)
            t = out["task"]
            self.assertEqual(t["status"], "verifying")
            self.assertEqual(t["resourcing"]["skills"], ["project-dev"])
            self.assertEqual(t["resourcing"]["effort"], "large")
            self.assertEqual(len(t["acceptance"]), 2)
            self.assertEqual(len(t["plan"]), 3)

    def test_status_enum_is_closed(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            pfile = ws / "p.json"
            pfile.write_text(json.dumps({"title": "x"}), encoding="utf-8")
            _, out = board_json("task-upsert", "--file", str(pfile), ws=ws)
            tid = out["id"]
            code, out = board_json("task-status", tid, "weird", ws=ws)
            self.assertEqual(code, 1, "非法状态必须失败")
            self.assertEqual(out["error"]["code"], "BAD_ARG")
            self.assertEqual(out["error"]["field"], "status")
            # 文件未被改写
            code, out = board_json("show", tid, ws=ws)
            self.assertEqual(out["task"]["status"], "planning")

    def test_acceptance_gate_warns_but_does_not_block(self):
        """验收闸是提示级：硬闸会逼模型为「改个错别字」编造验收条目。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            pfile = ws / "p.json"
            pfile.write_text(json.dumps({"title": "无验收的任务"}), encoding="utf-8")
            _, out = board_json("task-upsert", "--file", str(pfile), ws=ws)
            tid = out["id"]
            code, out = board_json("task-status", tid, "done", ws=ws)
            self.assertEqual(code, 0, "空验收不得阻断状态迁移")
            self.assertIn("warning", out)
            self.assertIn("acceptance", out["warning"])

    def test_overlong_and_blank_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            pfile = ws / "p.json"
            pfile.write_text(json.dumps({"title": "  "}), encoding="utf-8")
            code, out = board_json("task-upsert", "--file", str(pfile), ws=ws)
            self.assertEqual(code, 1)
            self.assertEqual(out["error"]["field"], "title")
            code, out = board_json("insp-add", "x" * 2001, ws=ws)
            self.assertEqual(code, 1)
            self.assertEqual(out["error"]["field"], "text")

    def test_inspiration_adopt_links_both_ways(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            _, out = board_json("insp-add", "左栏不该是会话列表", "--tags", "ui,idea", ws=ws)
            iid = out["id"]
            self.assertRegex(iid, r"^I-\d{8}-\d{2}$")
            pfile = ws / "p.json"
            pfile.write_text(json.dumps({"title": "看板改造"}), encoding="utf-8")
            _, out = board_json("task-upsert", "--file", str(pfile), ws=ws)
            tid = out["id"]
            code, out = board_json("insp-adopt", iid, tid, ws=ws)
            self.assertEqual(code, 0, out)
            _, insp = board_json("show", iid, ws=ws)
            self.assertEqual(insp["inspiration"]["status"], "adopted")
            self.assertEqual(insp["inspiration"]["tasks"], [tid])
            _, task = board_json("show", tid, ws=ws)
            self.assertEqual(task["task"]["inspirations"], [iid])

    def test_corrupt_board_is_not_silently_zeroed(self):
        """坏 JSON → 按空板返回 + corrupt 标记，原文件一字不动。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            bad = ws / ".rsi" / "board.json"
            bad.parent.mkdir(parents=True)
            bad.write_text("{oops", encoding="utf-8")
            code, out = board_json("list", ws=ws)
            self.assertEqual(code, 0)
            self.assertTrue(out.get("corrupt"), "坏文件必须显式上报 corrupt")
            self.assertEqual(bad.read_text(encoding="utf-8"), "{oops", "坏文件不得被覆盖")

    def test_cli_and_ui_merge_by_id_not_whole_table(self):
        """两侧都「读-改-写 + 按 id 合并」：先后写不同对象，两者都要在。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            _, out = board_json("insp-add", "先记一条灵感", ws=ws)
            iid = out["id"]
            pfile = ws / "p.json"
            pfile.write_text(json.dumps({"title": "后建的任务"}), encoding="utf-8")
            _, out = board_json("task-upsert", "--file", str(pfile), ws=ws)
            tid = out["id"]
            data = json.loads((ws / ".rsi" / "board.json").read_text(encoding="utf-8"))
            self.assertEqual([i["id"] for i in data["inspirations"]], [iid], "CLI 写任务不得吞掉灵感")
            self.assertEqual([t["id"] for t in data["tasks"]], [tid])
            # Rust 侧同款：模拟「读现有板 + 只追加灵感」后写回
            board = data
            board["inspirations"] = [{
                "id": "I-20990101-01", "text": "UI 侧新增", "tags": [], "status": "open",
                "tasks": [], "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            }] + board["inspirations"]
            (ws / ".rsi" / "board.json").write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
            code, out = board_json("list", ws=ws)
            self.assertEqual(code, 0)
            self.assertEqual(len(out["tasks"]), 1, "UI 写灵感不得吞掉任务")
            self.assertEqual(len(json.loads((ws / ".rsi" / "board.json").read_text(encoding="utf-8"))["inspirations"]), 2)

    def test_refresh_fills_missing_fields_without_deleting(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            p = ws / ".rsi" / "board.json"
            p.parent.mkdir(parents=True)
            p.write_text(json.dumps({"tasks": [{"id": "T-20260101-01"}], "inspirations": []}), encoding="utf-8")
            code, out = board_json("stats", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["tasks"]["total"], 1)
            code, out = board_json("refresh", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertGreater(out["fixed"], 0)
            data = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(len(data["tasks"]), 1, "refresh 不得删条目")
            t = data["tasks"][0]
            for key in ("status", "priority", "plan", "acceptance", "resourcing", "progress"):
                self.assertIn(key, t, f"refresh 应补齐 {key}")


class PromptSectionTest(unittest.TestCase):
    """agent 侧：看板纪律必须进提示词，且通道写死 CLI（不依赖技能工具启用）。"""

    def test_skills_rs_has_task_board_section(self):
        rs = read("runtime/crates/agent-loop/src/skills.rs")
        self.assertIn("fn task_board_section", rs)
        self.assertIn("fn user_wants_task_plan", rs)
        self.assertIn("scripts/board.py", rs, "提示词必须点明 CLI 通道")
        # 人财物四问 + 验收标准
        for marker in ("resourcing.skills", "resourcing.model", "resourcing.tools", "acceptance"):
            self.assertIn(marker, rs, f"任务看板段缺 {marker}")
        # 按需注入：brief 与 full 两档
        self.assertIn("if !full {", rs)
        # 通道写死理由必须写在注释里（防后人「优化」成技能工具）
        self.assertIn("未启用", rs)

    def test_chat_passes_want_task_plan(self):
        chat = read("runtime/crates/agent-loop/src/chat.rs")
        self.assertIn("Self::user_wants_task_plan(&req.user_text)", chat)
        self.assertIn("want_task_plan).await", chat)

    def test_board_injection_requires_cli_presence(self):
        """别的项目工作区没有 board.py → 不得注入这一段（避免污染通用运行时提示词）。"""
        rs = read("runtime/crates/agent-loop/src/skills.rs")
        seg = rs.split("fn task_board_section")[1][:800]
        self.assertIn("board.py", seg)
        self.assertIn("is_file()", seg)
        self.assertIn("return String::new()", seg)


class FrozenSurfaceTest(unittest.TestCase):
    """本轮不碰的面：SSE 事件类型集合、rollback 语义、memory 视图。"""

    def test_sse_event_types_unchanged(self):
        rs = read("runtime/crates/host/src/web/gateway.rs")
        # 看板不得引入 SSE 事件类型（轮询是刻意的选择）
        for banned in ('"board"', '"task"'):
            self.assertNotIn(f'"type": {banned}', rs)

    def test_no_new_dependency(self):
        py = read("scripts/board.py")
        for banned in ("import requests", "import httpx", "import pytz", "import dateutil"):
            self.assertNotIn(banned, py, "board.py 只用标准库")
        # Rust 侧：不新增 crate 依赖（看板自带 civil_from_unix，不引入 chrono）
        manifest = read("runtime/crates/host/Cargo.toml")
        for banned in ("chrono", "time ="):
            self.assertNotIn(banned, manifest, "host 侧不得新增时间库依赖")


if __name__ == "__main__":
    unittest.main()
