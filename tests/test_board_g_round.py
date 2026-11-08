"""G 轮（I-20261108-04/05/06）：灵感主权 + 发送键一致 + 并行前置。

三条用户原话对应的可机跑断言：
  1. 灵感是用户的（agent 只读、用户记录不被打断）
  2. 运行中点发送与 Enter 同效
  3. 并行之前，看板写必须不丢更新

纪律同前几轮：测契约不测实现细节；跨语言同源的东西直读另一侧源码比对
（这样任一侧单方面改动会当场失败）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_PY = ROOT / "scripts" / "board.py"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def board(*args: str, ws: Path) -> tuple[int, dict]:
    env = dict(os.environ)
    env["WORKSPACE_ROOT"] = str(ws)
    env.pop("RSI_BOARD_PATH", None)
    r = subprocess.run(
        [sys.executable, str(BOARD_PY), *args],
        capture_output=True, text=True, encoding="utf-8", env=env, timeout=120,
    )
    try:
        return r.returncode, json.loads(r.stdout)
    except ValueError:
        return r.returncode, {"raw": r.stdout, "err": r.stderr}


def add_task(ws: Path, **kw) -> str:
    p = ws / "t.json"
    p.write_text(json.dumps({"title": "任务", **kw}, ensure_ascii=False), encoding="utf-8")
    code, out = board("task-upsert", "--file", str(p), ws=ws)
    assert code == 0, out
    return out["id"]


class G1InspirationSovereigntyTest(unittest.TestCase):
    """I-20261108-04 第 1 条：agent 不能编辑灵感，用户可以。"""

    def test_no_write_commands_in_cli(self):
        """五个写命令必须从 agent 侧彻底消失（argparse 直接拒绝 → exit 2）。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            for cmd in ("insp-add", "insp-set", "insp-adopt", "insp-edit", "insp-rm"):
                code, out = board(cmd, "I-1", "x", ws=ws)
                self.assertEqual(code, 2, f"{cmd} 仍存在：{out}")

    def test_help_has_no_inspiration_write(self):
        """--help 里也不该再出现写命令（文档与实现同源）。"""
        r = subprocess.run([sys.executable, str(BOARD_PY), "--help"],
                           capture_output=True, text=True, encoding="utf-8")
        for cmd in ("insp-add", "insp-set", "insp-adopt", "insp-edit", "insp-rm"):
            self.assertNotIn(cmd, r.stdout, f"--help 仍列出 {cmd}")

    def test_agent_reads_but_never_writes(self):
        """读权限保留；写权限没有——任务侧记关联，灵感对象一字不动。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            p = ws / ".rsi" / "board.json"
            p.parent.mkdir(parents=True)
            p.write_text(json.dumps({
                "version": 1, "tasks": [], "inspirations": [{
                    "id": "I-20261108-01", "text": "用户原话", "tags": ["ui"],
                    "status": "open", "tasks": [],
                    "created_at": "2026-11-08T00:00:00Z", "updated_at": "2026-11-08T00:00:00Z",
                }],
            }, ensure_ascii=False), encoding="utf-8")
            before = p.read_text(encoding="utf-8")

            # 可读
            code, out = board("show", "I-20261108-01", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["inspiration"]["text"], "用户原话")

            # 写任务（记关联）后，灵感对象必须原封不动
            tid = add_task(ws, title="采纳它", inspirations=["I-20261108-01"])
            after = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(after["inspirations"][0]["text"], "用户原话")
            self.assertEqual(after["inspirations"][0]["status"], "open", "agent 不得改灵感状态")
            self.assertEqual(after["inspirations"][0]["tasks"], [], "agent 不得反向写灵感")
            self.assertEqual(after["tasks"][0]["inspirations"], ["I-20261108-01"],
                             "采纳关联应记在任务一侧")
            self.assertNotEqual(before, json.dumps(after, ensure_ascii=False, indent=1) + "\n",
                                "写任务当然会改文件（这条只为防止断言写反）")

    def test_prompt_tells_agent_inspirations_are_users(self):
        """提示词必须明说：灵感归用户，agent 只读、不总结。"""
        src = read("runtime/crates/agent-loop/src/skills.rs")
        self.assertIn("Inspirations are the user own words", src)
        self.assertIn("insp-adopt is gone", src)
        # 旧指令「become work via insp-adopt」不得再出现（那是一条已不存在的能力）
        self.assertNotIn("+ `insp-adopt <I-ID> <T-ID>`", src)


class G2DraftSurvivesPollTest(unittest.TestCase):
    """I-20261108-04 第 2 条：记灵感时不能被刷新打断。"""

    def test_refresh_snapshots_draft_and_focus(self):
        src = read("runtime/crates/host/web-dist/vendor/app-board.js")
        self.assertIn("inspDrafts", src, "重绘前必须摘草稿")
        self.assertIn("inspFocus", src, "重绘前必须摘焦点")
        # 顺序契约：先摘快照，再清空。写反就等于没做。
        # 用「行内容」定位而不是裸子串——注释里也提到过 root.innerHTML，裸找会命中注释。
        lines = src.split("\n")
        i_snap = next(n for n, l in enumerate(lines) if "inspDrafts.set(" in l)
        i_clear = next(n for n, l in enumerate(lines)
                       if l.strip() == 'root.innerHTML = "";' and n > i_snap - 40)
        self.assertLess(i_snap, i_clear, "必须先摘快照再清空 root")
        # 焦点也要在清空之前摘
        i_focus = next(n for n, l in enumerate(lines) if "inspFocus = active" in l)
        self.assertLess(i_focus, i_clear, "必须先摘焦点再清空 root")

    def test_input_restores_draft(self):
        src = read("runtime/crates/host/web-dist/vendor/app-board.js")
        self.assertIn("inspDrafts.get(sec.id)", src, "新输入框必须回填草稿")


class G3SendButtonConsistencyTest(unittest.TestCase):
    """I-20261108-05：运行中点发送与 Enter 同效，不再 disabled。"""

    def test_send_not_disabled_while_running(self):
        src = read("runtime/crates/host/web-dist/vendor/q-session.js")
        self.assertIn("sendBtn.disabled = false", src)
        self.assertNotIn("sendBtn.disabled = s.running", src,
                         "运行中禁用发送键就是那个 bug 本身")

    def test_send_and_enter_share_one_path(self):
        """按钮与 Enter 必须走同一个 send()（两条路径分叉才会出现「键盘能发鼠标不能」）。"""
        ev = read("runtime/crates/host/web-dist/vendor/app-events.js")
        self.assertIn("sendBtn.onclick = () => send()", ev)
        self.assertIn("else send();", ev)


class G4BoardLockTest(unittest.TestCase):
    """I-20261108-06 并行前置：看板读→改→写必须互斥，否则并行直接丢更新。"""

    def test_write_commands_hold_lock(self):
        src = read("scripts/board.py")
        self.assertIn("board.lock", src)
        self.assertIn("READ_ONLY_CMDS", src)
        # 锁必须加在 main（集中一处），而不是分散在每个 cmd_* 里——漏一个就是偶发丢更新
        self.assertIn("ctx = nullcontext() if ns.cmd in READ_ONLY_CMDS else locked()", src)

    def test_concurrent_writes_do_not_lose_entries(self):
        """8 个并发 task-upsert：条目数必须一条不少（无锁时后写者会覆盖前者的新条目）。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            env = dict(os.environ)
            env["WORKSPACE_ROOT"] = str(ws)
            env.pop("RSI_BOARD_PATH", None)
            procs = []
            for i in range(8):
                p = ws / f"t{i}.json"
                p.write_text(json.dumps({"title": f"并发任务{i}"}, ensure_ascii=False),
                             encoding="utf-8")
                procs.append(subprocess.Popen(
                    [sys.executable, str(BOARD_PY), "task-upsert", "--file", str(p)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                ))
            for pr in procs:
                pr.communicate(timeout=120)
            data = json.loads((ws / ".rsi" / "board.json").read_text(encoding="utf-8"))
            self.assertEqual(len(data["tasks"]), 8,
                             f"并发写丢了条目：只剩 {len(data['tasks'])} 条")

    def test_stale_lock_is_reclaimed(self):
        """崩溃留下的残锁不能永久堵死看板：超龄即回收。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            lock = ws / ".rsi" / "board.lock"
            lock.parent.mkdir(parents=True)
            lock.write_text("dead 0", encoding="utf-8")
            old = time.time() - 3600          # 一小时前，远超 stale 阈值
            os.utime(lock, (old, old))
            tid = add_task(ws, title="残锁也写得进去")
            self.assertTrue(tid)
            self.assertFalse(lock.exists(), "写完必须释放锁")

    def test_read_only_commands_do_not_take_lock(self):
        """读不互斥：list 在锁被占用时也必须能跑（否则轮询会互相排队）。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            lock = ws / ".rsi" / "board.lock"
            lock.parent.mkdir(parents=True)
            lock.write_text("held", encoding="utf-8")   # 新鲜锁：不会被当残锁
            code, out = board("list", ws=ws)
            self.assertEqual(code, 0, out)


class ParallelContractTest(unittest.TestCase):
    """I-20261108-06：并行能力的真实边界（写下来防止下次重复踩）。"""

    def test_board_writes_are_the_only_shared_resource(self):
        """并行前置已就位：跨进程锁 + 原子替换。"""
        src = read("scripts/board.py")
        self.assertIn("os.replace", src, "原子替换：崩溃不留半截 JSON")

    def test_session_gate_is_still_per_session(self):
        """同会话第二路 chat 仍被 K409 拒——**这是有意的**，不是遗留缺陷。

        拆它会连带重构取消标志 / turn_starts / 流式 sid / 回滚定位；
        做错的表现是「点停止停错任务」「回滚删错对话」。故本轮明确保留，
        并把可并行的部分交给子代理（同一回合内 join_all 并发）。
        """
        src = read("runtime/crates/agent-loop/src/chat.rs")
        self.assertIn("K409", src)
        self.assertIn("gate.try_lock()", src)

    def test_tool_wave_runs_in_parallel(self):
        """一个回合内的工具波次本来就是并发的（这是「agent 自行并行」的技术底座）。"""
        src = read("runtime/crates/agent-loop/src/chat.rs")
        self.assertIn("futures::future::join_all(execs)", src)

import io

class G5TwoLineOutcomeTest(unittest.TestCase):
    """I-20261108-04 第 3 条：任务完成后两条线——专业结论 + 通俗结论。"""

    def test_outcomes_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = add_task(ws, title="做一件事",
                           outcomes={"brief": "做完了，你可以直接用", "pro": "改了 3 个文件，pytest 全绿"})
            code, out = board("show", tid, ws=ws)
            self.assertEqual(code, 0, out)
            self.assertEqual(out["task"]["outcomes"]["brief"], "做完了，你可以直接用")
            self.assertEqual(out["task"]["outcomes"]["pro"], "改了 3 个文件，pytest 全绿")

    def test_short_form_fields_accepted(self):
        """顶层 brief/pro 也接受（少写一层嵌套，降低模型写错的概率）。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            p = ws / "t.json"
            p.write_text(json.dumps({"title": "x", "brief": "一句话", "pro": "专业版"},
                                    ensure_ascii=False), encoding="utf-8")
            code, out = board("task-upsert", "--file", str(p), ws=ws)
            self.assertEqual(code, 0, out)
            _, got = board("show", out["id"], ws=ws)
            self.assertEqual(got["task"]["outcomes"]["brief"], "一句话")
            self.assertEqual(got["task"]["outcomes"]["pro"], "专业版")

    def test_done_without_outcome_warns(self):
        """done 却说不清结果 → 提示（不阻断，但这正是用户抱怨的那件事）。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = add_task(ws, title="悄悄完成的任务")
            code, out = board("task-status", tid, "done", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertIn("warning", out)
            self.assertIn("outcomes", out["warning"])

    def test_done_with_outcome_silent(self):
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            tid = add_task(ws, title="有结论的任务", outcomes={"brief": "成了"})
            code, out = board("task-status", tid, "done", ws=ws)
            self.assertEqual(code, 0, out)
            self.assertNotIn(
                "outcomes", out.get("warning", ""),
                f"已写结论不该再催：{out.get('warning')}",
            )

    def test_refresh_backfills_outcomes(self):
        """旧板子没有 outcomes 字段：refresh 补齐，不炸、不删条目。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            p = ws / ".rsi" / "board.json"
            p.parent.mkdir(parents=True)
            p.write_text(json.dumps({
                "version": 1, "inspirations": [],
                "tasks": [{"id": "T-20261108-01", "title": "老任务", "status": "done",
                           "priority": "P1"}],
            }, ensure_ascii=False), encoding="utf-8")
            code, out = board("refresh", ws=ws)
            self.assertEqual(code, 0, out)
            data = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(data["tasks"][0]["outcomes"], {"brief": "", "pro": ""})
            self.assertEqual(len(data["tasks"]), 1, "refresh 不得删条目")

    def test_digest_carries_outcome(self):
        """同类归纳必须回答「上次结果如何」，不只「做过」。"""
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td)
            add_task(ws, title="同类任务", status="done",
                     resourcing={"skills": ["tdd"]},
                     outcomes={"brief": "给人看的结论", "pro": "给 agent 的结论"})
            code, out = board("digest", "--skill", "tdd", ws=ws)
            self.assertEqual(code, 0, out)
            blob = json.dumps(out, ensure_ascii=False)
            self.assertIn("给人看的结论", blob)
            self.assertIn("给 agent 的结论", blob)

    def test_ui_renders_outcome_block(self):
        js = read("runtime/crates/host/web-dist/vendor/app-board.js")
        self.assertIn("outcomeBlock", js)
        self.assertIn("obrief", js, "给人看的结论要单独一个样式点")
        self.assertIn("opro", js, "专业结论默认折叠")
        # 顺序：结论必须在「目标」之前（先结果后过程）
        goal_marker = '(t.goal ? `<div class="dsec"><b>目标</b>'
        self.assertLess(js.index("outcomeBlock +"), js.index(goal_marker))

    def test_prompt_section_requires_both_lines(self):
        src = read("runtime/crates/agent-loop/src/skills.rs")
        self.assertIn("outcomes", src, "提示词要教 agent 写两条线")
