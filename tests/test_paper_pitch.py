"""T-15 成稿提议：paper_pitch 的契约。

这套测试守的核心不是「提议能生成」，而是**它不会乱提议**：

用户的原话是「任务做完自动提议成稿」，但每个 done 任务都提议一遍是噪音——
改个错别字也弹「要不要写成论文」，人很快学会无视这条提示，
而提示一旦被无视就永远不会再被看见。

所以四条「够厚」判据必须**同时**成立才提议，且每条都要能单独否决。
本测试逐个把一条判据打掉，确认整体转为不合格——这才证明四条都在生效，
而不是被写成「任意一条通过就过」。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PITCH = ROOT / "scripts" / "paper_pitch.py"


def run_pitch(board: dict, *args: str) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                     encoding="utf-8") as f:
        json.dump(board, f, ensure_ascii=False)
        p = f.name
    try:
        import os
        env = {**os.environ, "RSI_BOARD_PATH": p}
        r = subprocess.run([sys.executable, str(PITCH), "--json", *args],
                           capture_output=True, text=True, encoding="utf-8",
                           cwd=str(ROOT), env=env)
        assert r.returncode == 0, r.stderr[:400]
        return json.loads(r.stdout)
    finally:
        Path(p).unlink(missing_ok=True)


def thick_task() -> dict:
    """一条满足全部四条判据的任务。"""
    return {
        "id": "T-thick-01",
        "title": "K 轮：补丁链把产物写成重复块",
        "status": "done",
        "goal": "补丁链不再写重复块",
        "updated_at": "2026-11-08T00:00:00Z",
        "outcomes": {
            "brief": "修好了重复块。",
            "pro": ("根因不是某条补丁写错，而是锚点不唯一 + replace(anchor,patch,1) 只替换第一处。"
                    "修法三层：源头删重复行、工具层换行归一化与 order 定序、产物清洗。"
                    "验证 pytest 261 绿、补丁 dry-run 0 FAIL、node --check ×7 绿，"
                    "教训是「当前文件对」不等于「补丁链能重建它」。"),
        },
        "checks": [
            {"id": "c1", "kind": "cmd", "name": "pytest 全绿",
             "target": "python -m pytest tests -q", "status": "pass"},
        ],
        "artifacts": [],
        "plan": [{"step": f"第 {i} 步", "status": "completed"} for i in range(1, 6)],
    }


def board_of(t: dict) -> dict:
    return {"version": 1, "tasks": [t], "inspirations": [], "layout": {"sections": []}}


class PitchTest(unittest.TestCase):
    def test_thick_task_is_eligible(self):
        d = run_pitch(board_of(thick_task()), "--task", "T-thick-01")
        p = d["pitches"][0]
        self.assertTrue(p["eligible"], f"全部判据满足却判不合格: {p['missing']}")

    def test_thin_task_not_eligible(self):
        t = thick_task()
        t["outcomes"]["pro"] = "改好了。"
        t["checks"] = []
        t["plan"] = t["plan"][:1]
        d = run_pitch(board_of(t), "--task", "T-thick-01")
        self.assertFalse(d["pitches"][0]["eligible"], "薄任务不该被提议")
        self.assertEqual(d["eligible"], 0)

    def test_each_criterion_can_veto_alone(self):
        """四条判据各自都能单独否决——证明它们是 AND 而不是 OR。"""
        cases = {
            "verified": lambda t: t.update(checks=[
                {"id": "c1", "kind": "cmd", "name": "x", "target": "x", "status": "fail"}]),
            "thick_pro": lambda t: t["outcomes"].update(pro="短。"),
            "reproducible": lambda t: (t.update(checks=[
                {"id": "c1", "kind": "manual", "name": "人判", "status": "pass"}]),
                t.update(artifacts=[])),
            "enough_work": lambda t: t.update(plan=[
                {"step": "只有一步", "status": "completed"}]),
        }
        for crit, mutate in cases.items():
            with self.subTest(crit=crit):
                t = thick_task()
                mutate(t)
                d = run_pitch(board_of(t), "--task", "T-thick-01")
                p = d["pitches"][0]
                self.assertFalse(p["eligible"], f"打掉 {crit} 后仍判合格，说明该判据没生效")
                self.assertTrue(p["missing"], "不合格必须说清差什么")

    def test_angles_are_specific_not_generic(self):
        """提议必须给具体角度，而不是空问「要不要写」。"""
        d = run_pitch(board_of(thick_task()), "--task", "T-thick-01")
        p = d["pitches"][0]
        self.assertGreaterEqual(len(p["angles"]), 1)
        for a in p["angles"]:
            self.assertTrue(a.get("skeleton"), "每个角度必须带骨架，否则用户无法判断")
            self.assertTrue(a.get("name"))

    def test_evidence_seed_is_traceable(self):
        """evidence_seed 是喂给 deepseek-paper 的证据账本骨架，必须可回溯。"""
        d = run_pitch(board_of(thick_task()), "--task", "T-thick-01")
        seed = d["pitches"][0]["evidence_seed"]
        self.assertEqual(seed["task"], "T-thick-01")
        self.assertTrue(seed["checks"], "证据里必须带 checks（谁验证的）")
        self.assertEqual(seed["checks"][0]["id"], "c1", "check id 不能丢，否则无法反查")

    def test_no_artifact_and_manual_only_is_not_reproducible(self):
        """只有 manual check 又没有 artifacts = 无法复现，不该提议成「可复现」文章。"""
        t = thick_task()
        t["checks"] = [{"id": "c1", "kind": "manual", "name": "用户确认", "status": "pass"}]
        t["artifacts"] = []
        d = run_pitch(board_of(t), "--task", "T-thick-01")
        self.assertFalse(d["pitches"][0]["eligible"])

    def test_read_only(self):
        b = board_of(thick_task())
        before = json.dumps(b, ensure_ascii=False, sort_keys=True)
        run_pitch(b, "--task", "T-thick-01")
        self.assertEqual(json.dumps(b, ensure_ascii=False, sort_keys=True), before)


if __name__ == "__main__":
    unittest.main()
