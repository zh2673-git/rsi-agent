"""T-16 归纳层②：board_cluster 的契约。

守三件事：

1. **不造第二套真相**。分类必须从既有字段（inspirations / 标题轮次标记 /
   supersedes / depends_on）**现算**，绝不写回 board.json。一旦写回，
   cluster 字段与真实字段就会不同步——这正是 board.rs 与 board.py
   必须同源校验要防的那类漂移。

2. **不用低可靠信号**。`resourcing.skills` 看起来能分组，但实测
   `project-dev` 出现在 13/20 个任务里，用它分组会全塌成一组。这条必须有
   测试钉住：**加入一个带 project-dev 的任务，不得改变分组数**。

3. **每个任务恰好出现在一个组里**。漏一个 = 流水账漏条目；
   重复出现 = 读者以为有两件事（本项目真实踩过：三元表达式副作用写法
   把同一任务同时塞进按轮次组与未归类组）。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLUSTER = ROOT / "scripts" / "board_cluster.py"


def run_cluster(board: dict, *args: str) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                     encoding="utf-8") as f:
        json.dump(board, f, ensure_ascii=False)
        p = f.name
    try:
        import os
        env = {**os.environ, "RSI_BOARD_PATH": p}
        r = subprocess.run([sys.executable, str(CLUSTER), "--json", *args],
                           capture_output=True, text=True, encoding="utf-8",
                           cwd=str(ROOT), env=env)
        assert r.returncode == 0, r.stderr[:400]
        return json.loads(r.stdout)
    finally:
        Path(p).unlink(missing_ok=True)


def task(tid: str, title: str, *, insp=None, skills=None, status="done", **kw) -> dict:
    t = {
        "id": tid, "title": title, "status": status,
        "updated_at": "2026-11-08T00:00:00Z",
        "inspirations": insp or [],
        "resourcing": {"skills": skills or []},
        "outcomes": {"brief": f"{tid} 的一句话结论"},
    }
    t.update(kw)
    return t


def board_of(*tasks: dict) -> dict:
    return {"version": 1, "tasks": list(tasks), "inspirations": [],
            "layout": {"sections": []}}


class ClusterTest(unittest.TestCase):
    def test_each_task_in_exactly_one_group(self):
        b = board_of(
            task("T-1", "K 轮：甲", insp=["I-1"]),
            task("T-2", "H 轮：乙"),          # 无灵感，有轮次
            task("T-3", "丙"),                # 无灵感无轮次
        )
        d = run_cluster(b)
        seen: list[str] = []
        for g in d["groups"]:
            seen.extend(g["tasks"])
        self.assertEqual(sorted(seen), ["T-1", "T-2", "T-3"],
                         f"任务必须恰好出现一次，实际: {seen}")
        self.assertEqual(len(seen), len(set(seen)), f"有任务被重复计入: {seen}")

    def test_inspiration_is_primary_key(self):
        """同一灵感派生的任务归一组，即便轮次不同。"""
        b = board_of(
            task("T-1", "K 轮：甲", insp=["I-9"]),
            task("T-2", "L 轮：乙", insp=["I-9"]),
        )
        d = run_cluster(b)
        groups = [g for g in d["groups"] if g["kind"] == "inspiration"]
        self.assertEqual(len(groups), 1, "同灵感应归一组")
        self.assertEqual(sorted(groups[0]["tasks"]), ["T-1", "T-2"])
        self.assertEqual(groups[0]["label"], "I-9")

    def test_round_tag_kept_when_also_has_inspiration(self):
        """挂了灵感的任务也要保留轮次信息——否则读者丢了迭代脉络。"""
        d = run_cluster(board_of(task("T-1", "K 轮：甲", insp=["I-1"])))
        self.assertEqual(d["groups"][0]["rounds"], ["K"])

    def test_low_signal_skill_does_not_split(self):
        """核心：resourcing.skills 是低可靠信号，加它不得改变分组数。"""
        base = board_of(task("T-1", "甲", insp=["I-1"]), task("T-2", "乙", insp=["I-2"]))
        with_skills = board_of(
            task("T-1", "甲", insp=["I-1"], skills=["project-dev", "tdd"]),
            task("T-2", "乙", insp=["I-2"], skills=["project-dev", "tdd"]),
        )
        a = run_cluster(base)
        b = run_cluster(with_skills)
        self.assertEqual(len(a["groups"]), len(b["groups"]),
                         "skills 不该参与分组（它太泛，会把所有任务塌成一组）")

    def test_lineage_edges_surface(self):
        b = board_of(
            task("T-1", "甲", supersedes=["T-0"]),
            task("T-2", "乙", depends_on=["T-1"]),
            task("T-0", "旧"),
        )
        d = run_cluster(b)
        pairs = {(e["from"], e["rel"], e["to"]) for e in d["edges"]}
        self.assertIn(("T-1", "supersedes", "T-0"), pairs)
        self.assertIn(("T-2", "depends_on", "T-1"), pairs)

    def test_unknown_lineage_target_dropped(self):
        """指向不存在的任务时不出边——不猜、不产生悬空引用。"""
        d = run_cluster(board_of(task("T-1", "甲", supersedes=["T-ghost"])))
        self.assertEqual(d["edges"], [])

    def test_read_only(self):
        b = board_of(task("T-1", "甲", insp=["I-1"]))
        before = json.dumps(b, ensure_ascii=False, sort_keys=True)
        run_cluster(b)
        self.assertEqual(json.dumps(b, ensure_ascii=False, sort_keys=True), before)

    def test_status_filter(self):
        b = board_of(task("T-1", "甲", status="done"), task("T-2", "乙", status="doing"))
        d = run_cluster(b, "--status", "done")
        self.assertEqual(d["tasks_scanned"], 1)


if __name__ == "__main__":
    unittest.main()
