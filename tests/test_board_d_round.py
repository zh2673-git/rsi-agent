"""D 轮契约测试：可编辑/删除、看板弹窗、习惯画像、任务↔对话、分解委派。

纪律（与前几轮同源）：**测契约不测实现细节**——断言「字段/枚举/顺序/边界」这些
跨语言同源的东西，不断言「函数里第几行写了什么」。两侧同源常量的锁用「直读另一侧
源码」的方式（C4 先例），这样任一侧单方面改动会当场失败。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_PY = ROOT / "scripts" / "board.py"
PROFILE_PY = ROOT / "scripts" / "profile.py"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def run_json(script: Path, *args: str, ws: Path) -> tuple[int, dict]:
    env = dict(os.environ)
    env["WORKSPACE_ROOT"] = str(ws)
    for k in ("RSI_BOARD_PATH", "RSI_PROFILE_PATH", "MEMORY_DATA_DIR"):
        env.pop(k, None)
    p = subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True, text=True, cwd=str(ws), env=env, timeout=120,
    )
    try:
        out = json.loads(p.stdout)
    except ValueError:
        out = {"raw": p.stdout, "err": p.stderr}
    return p.returncode, out


class WorkspaceCase(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._td = tempfile.TemporaryDirectory()
        self.ws = Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()

    def board(self, *args):
        return run_json(BOARD_PY, *args, ws=self.ws)

    def profile(self, *args):
        return run_json(PROFILE_PY, *args, ws=self.ws)

    def add_task(self, **kw) -> str:
        raw = {"title": kw.pop("title", "测试任务"), "status": "planning"}
        raw.update(kw)
        p = self.ws / "task.json"
        p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        code, out = self.board("task-upsert", "--file", str(p))
        self.assertEqual(code, 0, out)
        return out["id"]

    def board_file(self) -> dict:
        return json.loads((self.ws / ".rsi" / "board.json").read_text(encoding="utf-8"))

    def seed_inspiration(self, text: str, *, status: str = "open",
                         tasks: list[str] | None = None, tags: list[str] | None = None) -> str:
        """像 UI 那样直接写 board.json 造灵感（G 轮起 agent 没有这条写通道）。"""
        p = self.ws / ".rsi" / "board.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        board = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {
            "version": 1, "tasks": [], "inspirations": [],
        }
        items = board.setdefault("inspirations", [])
        iid = f"I-20261108-{len(items) + 1:02d}"
        items.insert(0, {
            "id": iid, "text": text, "tags": tags or [], "status": status,
            "tasks": tasks or [], "created_at": "2026-11-08T00:00:00Z",
            "updated_at": "2026-11-08T00:00:00Z",
        })
        p.write_text(json.dumps(board, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        return iid

    # 旧名兼容：本类内测试曾用 seed(...)
    seed = seed_inspiration


class InspEditDeleteTest(WorkspaceCase):
    """灵感可改可删（I-20261107-02）——G 轮起这条能力**只属于用户界面**。

    原实现把「改/删灵感」挂在 agent 的 CLI 上，与 I-20261108-04「灵感是用户记录碎片
    想法的地方……agent 不能编辑，用户可以编辑」直接冲突。故本轮把写通道整体移到 UI：
    host `/api/board` 的 `inspiration.edit` / `.rm` 保留（唯一调用方是界面），
    `board.py` 的 `insp-edit` / `insp-rm` / `insp-add` / `insp-set` / `insp-adopt` 全部移除。

    测试因此改测**新契约本身**，而不是已经不该存在的那条通道：
      1. agent 侧无灵感写命令（CLI 直接拒绝该子命令）；
      2. UI 侧契约仍在（host 源码里两个 op 的校验原样保留，含 adopted 需 force）；
      3. 灵感数据仍可被 agent **读**（引用装载 / show），这是它的合法权限。
    """

    def test_agent_has_no_inspiration_write_commands(self):
        """agent 侧五个写命令必须全部不存在：灵感是用户的主权。"""
        for cmd in ("insp-add", "insp-set", "insp-adopt", "insp-edit", "insp-rm"):
            code, _ = self.board(cmd, "x", "y")
            self.assertEqual(code, 2, f"{cmd} 应被 argparse 拒绝（exit 2），实际 {code}")

    def test_ui_keeps_edit_and_rm_ops_with_adopted_guard(self):
        """UI 渠道的写能力原样保留——移走的是 agent 的手，不是用户的手。"""
        src = read("runtime/crates/host/src/web/api/board.rs")
        self.assertIn('"inspiration.edit"', src)
        self.assertIn('"inspiration.rm"', src)
        # adopted 默认拒绝 + 显式 force 才删：与旧 CLI 同语义
        self.assertIn("force", src)
        # 已采纳保护：Rust 侧用 K409 + 文案「已被任务采纳」，没有 ADOPTED 这个码
        self.assertIn('Some("adopted")', src)

    def test_agent_can_still_read_inspirations(self):
        """读是 agent 的合法权限：show 能取到，引用能落到上下文块。"""
        iid = self.seed("左栏不该是会话列表")
        code, out = self.board("show", iid)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["inspiration"]["text"], "左栏不该是会话列表")
        code, out = self.board("resolve", f"@{iid} 做掉它")
        self.assertEqual(code, 0, out)
        self.assertIn("左栏不该是会话列表", json.dumps(out, ensure_ascii=False))

    def test_board_file_inspiration_survives_agent_task_writes(self):
        """agent 写任务不得吞掉用户的灵感（并行写的前置条件）。"""
        iid = self.seed("先记一条灵感")
        tid = self.add_task(title="后建的任务")
        data = self.board_file()
        self.assertEqual([i["id"] for i in data["inspirations"]], [iid])
        self.assertIn(tid, [t["id"] for t in data["tasks"]])


class TaskDeleteTest(WorkspaceCase):
    """任务删除要保引用完整性：子任务摘 parent，灵感引用清空。"""

    def test_task_rm_detaches_children_and_unlinks_inspirations(self):
        parent = self.add_task(title="父任务")
        child = self.add_task(title="子任务", parent=parent)
        iid = self.seed_inspiration("来源灵感", tasks=[parent])

        code, out = self.board("task-rm", parent)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["detached"], [child], "子任务应被摘掉 parent 而不是跟着删")
        self.assertEqual(out["unlinked"], [iid])
        data = self.board_file()
        self.assertEqual([t["id"] for t in data["tasks"]], [child], "子任务必须还在")
        self.assertEqual(data["tasks"][0]["parent"], "")
        self.assertEqual(data["inspirations"][0]["tasks"], [])

    def test_task_rm_warns_on_open_task_and_accepts_force(self):
        tid = self.add_task(status="doing")
        code, out = self.board("task-rm", tid)
        self.assertEqual(code, 0, out)
        self.assertIn("warning", out, "删未完结任务应提示（不阻断）")
        code, out = self.board("task-rm", "T-20260101-99")
        self.assertEqual(code, 1)
        self.assertEqual(out["error"]["code"], "NOT_FOUND")

    def test_task_rm_not_found_after_delete(self):
        tid = self.add_task()
        self.board("task-rm", tid)
        self.assertEqual(self.board_file()["tasks"], [])


class DecomposeTest(WorkspaceCase):
    """I-20261107-01：plan 每步要有 owner（谁干），任务可挂 parent（被拆自谁）。"""

    def test_plan_owner_defaults_to_self_and_enum_is_closed(self):
        tid = self.add_task(plan=[{"step": "读代码"}, {"step": "调研", "owner": "subagent"}])
        _, out = self.board("show", tid)
        plan = out["task"]["plan"]
        self.assertEqual(plan[0]["owner"], "self", "不写 owner 缺省 self（不写 ≠ 委派）")
        self.assertEqual(plan[1]["owner"], "subagent")

        p = self.ws / "bad.json"
        p.write_text(json.dumps({"id": tid, "plan": [{"step": "x", "owner": "teammate"}]}), encoding="utf-8")
        code, out = self.board("task-upsert", "--file", str(p))
        self.assertEqual(code, 1)
        self.assertEqual(out["error"]["field"], "plan[0].owner", "非法 owner 要点到具体下标")

    def test_owner_enum_matches_rust_side(self):
        py = read("scripts/board.py")
        rs_hint = read("runtime/crates/agent-loop/src/board_ctx.rs")
        for owner in ("self", "subagent", "skill"):
            self.assertIn(f'"{owner}"', py, f"board.py 的 PLAN_OWNERS 应含 {owner}")
            self.assertIn(f'owner: \\"{owner}\\"', rs_hint, f"提示词应写明 owner={owner} 的判据")

    def test_parent_shape_and_self_reference(self):
        tid = self.add_task()
        p = self.ws / "bad.json"
        p.write_text(json.dumps({"title": "x", "parent": "not-a-task-id"}), encoding="utf-8")
        code, out = self.board("task-upsert", "--file", str(p))
        self.assertEqual(code, 1)
        self.assertEqual(out["error"]["field"], "parent")

        p.write_text(json.dumps({"id": tid, "parent": tid}), encoding="utf-8")
        code, out = self.board("task-upsert", "--file", str(p))
        self.assertEqual(code, 1, "parent 不能指向自己")

    def test_refresh_backfills_owner_and_parent(self):
        # 手改坏/旧版板子：plan 步没有 owner、任务没有 parent
        (self.ws / ".rsi").mkdir(parents=True, exist_ok=True)
        (self.ws / ".rsi" / "board.json").write_text(json.dumps({
            "tasks": [{"id": "T-20260101-01", "title": "旧任务", "plan": [{"step": "a"}]}],
            "inspirations": [],
        }), encoding="utf-8")
        code, out = self.board("refresh")
        self.assertEqual(code, 0, out)
        t = self.board_file()["tasks"][0]
        self.assertEqual(t["plan"][0]["owner"], "self")
        self.assertEqual(t["parent"], "")


class ProfileTest(WorkspaceCase):
    """I-20261107-04：习惯画像留存在 .rsi/profile.json（agent 主动写，系统每轮读）。"""

    def test_section_upsert_and_order_is_pinned(self):
        for sid, kind, body in (("env-x", "env", "bash 单行限制"),
                                ("user-lang", "user", "中文回答")):
            p = self.ws / "s.json"
            p.write_text(json.dumps({"id": sid, "kind": kind, "title": sid, "body": body}), encoding="utf-8")
            code, out = self.profile("section-add", "--file", str(p))
            self.assertEqual(code, 0, out)
        data = json.loads((self.ws / ".rsi" / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual([s["kind"] for s in data["sections"]], ["user", "env"],
                         "章节顺序由 kind 钉死（user → model → workflow → env）")

    def test_section_overwrites_same_id_not_duplicates(self):
        p = self.ws / "s.json"
        for body in ("v1", "v2"):
            p.write_text(json.dumps({"id": "u", "kind": "user", "body": body}), encoding="utf-8")
            self.assertEqual(self.profile("section-add", "--file", str(p))[0], 0)
        data = json.loads((self.ws / ".rsi" / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(len(data["sections"]), 1, "同 id 是覆盖不是追加")
        self.assertEqual(data["sections"][0]["body"], "v2")

    def test_note_drops_oldest_past_limit(self):
        p = self.ws / "n.json"
        p.write_text(json.dumps({"kind": "model", "text": "第一条", "tags": ["a"]}), encoding="utf-8")
        code, out = self.profile("note", "--file", str(p))
        self.assertEqual(code, 0, out)
        self.assertTrue(out["id"].startswith("N-"), out)
        self.assertIn("N-", out["id"])

    def test_brief_is_empty_for_empty_profile_and_bounded(self):
        code, out = self.profile("brief")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["brief"], "", "空画像的 brief 必须是空串（不注入空壳标题）")
        p = self.ws / "s.json"
        p.write_text(json.dumps({"id": "u", "kind": "user", "body": "x" * 1000}), encoding="utf-8")
        self.profile("section-add", "--file", str(p))
        code, out = self.profile("brief", "--limit", "50")
        self.assertEqual(code, 0, out)
        self.assertLessEqual(len(out["brief"]), 51)

    def test_bad_kind_and_id_shape_rejected(self):
        p = self.ws / "s.json"
        p.write_text(json.dumps({"id": "BadId", "kind": "user", "body": "x"}), encoding="utf-8")
        self.assertEqual(self.profile("section-add", "--file", str(p))[0], 1, "id 形状须小写")
        p.write_text(json.dumps({"id": "ok", "kind": "mood", "body": "x"}), encoding="utf-8")
        self.assertEqual(self.profile("section-add", "--file", str(p))[0], 1, "kind 封闭")

    def test_corrupt_profile_is_not_overwritten(self):
        (self.ws / ".rsi").mkdir(parents=True, exist_ok=True)
        bad = self.ws / ".rsi" / "profile.json"
        bad.write_text("{not json", encoding="utf-8")
        code, out = self.profile("show")
        self.assertEqual(code, 0)
        self.assertTrue(out.get("corrupt"), "坏文件要显式回报，不静默当空")
        p = self.ws / "s.json"
        p.write_text(json.dumps({"id": "u", "kind": "user", "body": "x"}), encoding="utf-8")
        code, out = self.profile("section-add", "--file", str(p))
        self.assertEqual(code, 1, "坏文件拒绝写入（不覆盖用户手改内容）")
        self.assertEqual(bad.read_text(encoding="utf-8"), "{not json", "原文件必须原样保留")


class BoardLinkTest(WorkspaceCase):
    """I-20261107-05：任务 ↔ 对话轮次由 trace 的 user.refs 字段反查。"""

    def write_trace(self, events: list[dict]) -> None:
        d = self.ws / "runtime" / "plugins" / "memory" / "data" / "traces"
        d.mkdir(parents=True, exist_ok=True)
        (d / "main.jsonl").write_text(
            "\n".join(json.dumps(e, ensure_ascii=False) for e in events) + "\n", encoding="utf-8")

    def test_link_finds_turns_by_refs_field(self):
        tid = self.add_task(title="被引用过")
        self.write_trace([
            {"type": "user", "text": "无关的一轮"},
            {"type": "user", "text": f"@{tid} 看看这件", "refs": [tid]},
            {"type": "assistant", "text": "好"},
            {"type": "user", "text": "再问一次", "refs": [tid]},
        ])
        code, out = self.board("link", tid)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["total"], 2)
        # user_index 是「第几条 user 事件」的 0 基下标（与前端回滚定位同口径）
        self.assertEqual([t["user_index"] for t in out["turns"]], [1, 2])

    def test_link_without_trace_or_refs_is_empty_with_hint(self):
        tid = self.add_task()
        code, out = self.board("link", tid)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["turns"], [])
        self.assertIn("note", out, "没关联时要给出怎么建立关联的提示")

    def test_link_unknown_id_rejected(self):
        code, out = self.board("link", "T-20260101-99")
        self.assertEqual(code, 1)
        self.assertEqual(out["error"]["code"], "NOT_FOUND")


class FrontEndContractTest(unittest.TestCase):
    """前端契约：按钮/函数/文案在位，且不引入与约束相悖的东西。"""

    def test_board_win_skeleton_and_wiring(self):
        html = read("runtime/crates/host/web-dist/index.html")
        for marker in ('id="board-win"', 'id="bw-tabs"', 'id="bw-root"', 'id="bw-close"',
                       'id="btn-board"', 'id="board-win-foot"'):
            self.assertIn(marker, html, f"index.html 缺 {marker}")
        js = read("runtime/crates/host/web-dist/vendor/app-board.js")
        for fn in ("function openBoardWin", "function closeBoardWin", "function renderBoardWin",
                   "function winTaskCard", "function initBoardWin"):
            self.assertIn(fn, js, f"app-board.js 缺 {fn}")
        # 弹窗与侧栏必须同源（同一份 layout），不得自建第二套章节清单
        self.assertIn("boardSections()", js)
        self.assertNotIn("BOSS_SECTIONS", js)

    def test_scripts_not_double_loaded(self):
        """五个模块曾被引入两次 → 顶层 const/let 重复声明 = 整个前端白屏。"""
        html = read("runtime/crates/host/web-dist/index.html")
        for name in ("q-session.js", "app-core.js", "app-stream.js", "app-files.js",
                     "app-settings.js", "app-events.js", "app-board.js"):
            self.assertEqual(html.count(f'/vendor/{name}"'), 1, f"{name} 被引入多次")

    def test_queue_rows_have_edit_and_copy(self):
        js = read("runtime/crates/host/web-dist/vendor/q-session.js")
        self.assertIn("function startQueueEdit", js)
        self.assertIn("function copyQueueItem", js)
        self.assertIn("qedit", js)
        self.assertIn("qcp", js)
        # 执行中那条不能编辑（改了本地串不改服务端事实）
        self.assertIn("edit.disabled = running", js)

    def test_rollback_keeps_draft(self):
        js = read("runtime/crates/host/web-dist/vendor/app-events.js")
        self.assertIn("stashDraftForRollback()", js)
        self.assertIn("restoreDraftAfterRollback()", js)
        qs = read("runtime/crates/host/web-dist/vendor/q-session.js")
        self.assertIn("if (d.text && !input.value.trim())", qs,
                      "回滚后输入框已有新内容时不得覆盖（否则吞掉用户刚打的字）")

    def test_style_has_board_win(self):
        css = read("runtime/crates/host/web-dist/style.css")
        for marker in (".board-win", ".bw-panel", ".bw-card", ".bw-tabs", ".bw-owner",
                       ".insp-edit", ".insp-confirm"):
            self.assertIn(marker, css, f"style.css 缺 {marker}")

    def test_profile_js_and_rust_agree_on_kinds(self):
        py = read("scripts/profile.py")
        rs = read("runtime/crates/agent-loop/src/profile_ctx.rs")
        for kind in ("user", "model", "workflow", "env"):
            self.assertIn(f'"{kind}"', py)
            self.assertIn(f'"{kind}"', rs)
        # 上限同源（不要求数值逐个核对，但注入块必须有界）
        self.assertIn("MAX_BLOCK_CHARS", rs)


if __name__ == "__main__":
    unittest.main()
