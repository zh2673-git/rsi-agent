"""秘书工具（scripts/secretary.py）的判据测试。

为什么这些值得钉住，而不是只看「跑得出东西」：

1. **「做了没有」有两种相反的错法**。把有证据的 done 当成没做完 → 用户白催一遍；
   把自述的 done 当成做完了 → 用户以为交付了其实没有。两个方向都要布断言，
   只测一个方向的实现会退化成「永远缺证据」或「永远齐备」。
2. **派活是 join，不是推理**。技能库里没有的能力必须报 missing，而不是派给一个
   听起来合理的名字。这条一旦退化，秘书就会自信地把活派给不存在的部门。
3. **只读是秘书这个角色的定义**。若秘书能写，「告诉我没做」会滑向「顺手帮我做掉」，
   用户失去只问不做的入口。用 mtime 全量比对来锁，比「代码里没写 save()」更硬——
   后者挡不住以后有人加一个。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))


def _board(tasks: list[dict], insps: list[dict]) -> dict:
    return {"version": 1, "tasks": tasks, "inspirations": insps}


class SecretaryCriteriaTest(unittest.TestCase):
    """构造一块「什么毛病都有」的板，逐条验判据。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.td = Path(tempfile.mkdtemp(prefix="sec-test-"))
        board = _board(
            [
                # 自述完成：无 checks、无产物 → 必须进「拿不出证据」
                {"id": "T-20260101-01", "title": "自述完成", "status": "done"},
                # 有证据完成：checks + verdict=pass → 不得被误列
                {"id": "T-20260101-02", "title": "有证据完成", "status": "done",
                 "checks": [{"id": "c1", "kind": "cmd", "status": "pass"}],
                 "evaluation": {"verdict": "pass"}},
                # 靠产物也算有证据（不要求一定有 checks）
                {"id": "T-20260101-06", "title": "有产物完成", "status": "done",
                 "artifacts": ["outputs/x.md"]},
                # 需要不存在的技能 → missing
                {"id": "T-20260101-03", "title": "需要不存在的技能", "status": "doing",
                 "resourcing": {"skills": ["不存在的技能"]}},
                # 没写技能 → unassigned
                {"id": "T-20260101-04", "title": "没指派", "status": "doing"},
                # 技能都在库里 → covered
                {"id": "T-20260101-05", "title": "可派", "status": "doing",
                 "resourcing": {"skills": ["tdd"]},
                 "inspirations": ["I-20260101-03"]},
            ],
            [
                {"id": "I-20260101-01", "text": "孤儿采纳", "status": "adopted"},
                {"id": "I-20260101-02", "text": "没人认领", "status": "open"},
                {"id": "I-20260101-03", "text": "被引用", "status": "open"},
                {"id": "I-20260101-04", "text": "已归档", "status": "archived"},
            ],
        )
        (cls.td / "board.json").write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
        cls._env = {k: os.environ.get(k) for k in ("RSI_BOARD_PATH", "RSI_HOME", "WORKSPACE_ROOT")}
        os.environ["RSI_BOARD_PATH"] = str(cls.td / "board.json")
        os.environ["RSI_HOME"] = str(cls.td)
        os.environ.pop("WORKSPACE_ROOT", None)
        import secretary
        cls.mod = secretary
        cls.d = secretary.build(limit=50)

    @classmethod
    def tearDownClass(cls) -> None:
        for k, v in cls._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        import shutil
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_claimed_done_without_proof_is_listed(self) -> None:
        ids = {t["id"] for t in self.d["claimed_done_without_proof"]}
        self.assertIn("T-20260101-01", ids, "自述完成（无 checks 无产物）必须被列出")

    def test_done_with_proof_not_flagged(self) -> None:
        ids = {t["id"] for t in self.d["claimed_done_without_proof"]}
        self.assertNotIn("T-20260101-02", ids, "checks=pass 的 done 不得被误列为缺证据")
        self.assertNotIn("T-20260101-06", ids, "有产物的 done 也不得被误列")

    def test_assign_three_outcomes(self) -> None:
        av = self.d["assign"]
        self.assertIn("T-20260101-05", {a["task"]["id"] for a in av["covered"]})
        self.assertIn("T-20260101-03", {m["task"]["id"] for m in av["missing"]})
        self.assertIn("T-20260101-04", {t["id"] for t in av["unassigned"]})
        # missing 必须点名缺的是哪个技能——只说「缺技能」用户无法行动
        miss = {m["task"]["id"]: m["missing"] for m in av["missing"]}
        self.assertEqual(miss["T-20260101-03"], ["不存在的技能"])

    def test_orphan_inspiration_by_task_side(self) -> None:
        orphan = {i["id"] for i in self.d["orphan_inspirations"]}
        self.assertIn("I-20260101-02", orphan, "open 且无人引用 = 没人认领")
        # 以任务侧引用为准：status 还是 open 但已有任务引用它 → 不算孤儿
        self.assertNotIn("I-20260101-03", orphan, "被任务引用过的灵感不算没人认领")
        self.assertNotIn("I-20260101-04", orphan, "归档灵感不进孤儿列表")

    def test_adopted_without_task_is_flagged(self) -> None:
        dang = {i["id"] for i in self.d["adopted_without_task"]}
        self.assertIn("I-20260101-01", dang, "自称 adopted 却无任务引用（任务可能被删）必须报出")

    def test_read_only(self) -> None:
        """只读边界：跑一遍 build 前后，板文件与目录的 mtime 全量不变。"""
        before = {p: p.stat().st_mtime_ns for p in self.td.rglob("*") if p.is_file()}
        self.mod.build(limit=10)
        after = {p: p.stat().st_mtime_ns for p in self.td.rglob("*") if p.is_file()}
        self.assertEqual(before, after, "秘书工具不得写任何文件（只读是角色的定义）")

    def test_render_has_all_sections(self) -> None:
        txt = self.mod.render(self.d)
        for key in ("全局快照", "在做的事", "拿不出证据", "没人认领", "能交给谁"):
            self.assertIn(key, txt, f"人读视图缺分区: {key}")

    def test_corrupt_board_degrades_not_crashes(self) -> None:
        """坏 JSON 必须降级（报 corrupt + 空板），不能抛异常——秘书不能因看板坏了就拒绝回答。"""
        bad = Path(tempfile.mkdtemp(prefix="sec-bad-"))
        (bad / "board.json").write_text("{not json", encoding="utf-8")
        old = os.environ.get("RSI_BOARD_PATH")
        os.environ["RSI_BOARD_PATH"] = str(bad / "board.json")
        try:
            d = self.mod.build()
            self.assertTrue(d["corrupt"], "坏 JSON 必须标 corrupt")
            self.assertIn("读不出来", self.mod.render(d))
        finally:
            if old is None:
                os.environ.pop("RSI_BOARD_PATH", None)
            else:
                os.environ["RSI_BOARD_PATH"] = old
            import shutil
            shutil.rmtree(bad, ignore_errors=True)

    def test_skills_without_skill_json_are_still_in_catalog(self) -> None:
        """技能「在不在库里」看目录里有没有 SKILL.md，不看有没有 skill.json。

        这是实测踩到的真 bug：初版只扫 `skills/*/skill.json`，于是 rsi-board /
        git-ops / trace-analysis 这些只有 SKILL.md 的技能被判「不在库里」，
        秘书会告诉用户「这件事缺 rsi-board，得先造技能」——而它就在那儿。
        一条 join 错判的代价是用户去造一个已经存在的技能，所以必须钉住。
        """
        cat = self.mod.skill_catalog()
        self.assertIn("rsi-board", cat,
                      "只有 SKILL.md 的技能也必须在册（否则派活会误报缺技能）")
        self.assertIn("tdd", cat)
        # frontmatter 的 description 要能读到，否则「谁能干什么」只剩名字
        self.assertTrue(cat["rsi-board"]["description"],
                        "从 SKILL.md frontmatter 必须取到 description")

    def test_unassigned_and_missing_distinguish_absent_skill(self) -> None:
        """missing 只报**真的**不在库里的技能名，不把在册技能误报为缺。"""
        missing_names = {n for m in self.d["assign"]["missing"] for n in m["missing"]}
        self.assertIn("不存在的技能", missing_names)
        self.assertNotIn("tdd", missing_names, "在册技能不得出现在 missing 里")

    def test_board_anchors_code_root_not_workspace(self) -> None:
        """「所有工作区视角」的物理前提：账本跟着代码根走（RSI_HOME），不跟着工作区。

        这是秘书这个角色能不能成立的根本：若每个工作区各有一块板，秘书每次只能看到
        自己那个窗口的活，「我手上这些事现在什么情况」这个问题永远答不全。
        与 host board.rs::data_root、board.py::data_root 三处必须同源——这里只钉住
        Python 侧，另两处各有自己的用例。
        """
        code = Path(tempfile.mkdtemp(prefix="sec-code-"))
        proj = Path(tempfile.mkdtemp(prefix="sec-proj-"))
        saved = {k: os.environ.get(k) for k in ("RSI_HOME", "WORKSPACE_ROOT", "RSI_BOARD_PATH")}
        try:
            os.environ.pop("RSI_BOARD_PATH", None)
            os.environ["RSI_HOME"] = str(code)
            os.environ["WORKSPACE_ROOT"] = str(proj)
            p = self.mod.B.board_path()
            self.assertEqual(p.parent.parent, code,
                             f"RSI_HOME 在场时账本必须锚代码根，实际 {p}")
            self.assertFalse(str(p).startswith(str(proj)),
                             "账本不得落在工作区（否则每个窗口各有一块板）")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            import shutil
            shutil.rmtree(code, ignore_errors=True)
            shutil.rmtree(proj, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
