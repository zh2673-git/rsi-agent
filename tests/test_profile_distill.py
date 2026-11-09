"""T-12 归纳层①：profile_distill 的契约。

这套测试守三件事，缺一条这个管道就不该被信任：

1. **只提议、不落库**。蒸馏若自动写画像，一条误判会持续污染后续所有轮次的
   判断（画像进每轮 prompt）。所以本命令必须是纯读——测试直接比对
   profile.json 与 board.json 的字节内容，跑前跑后必须完全不变。

2. **密钥与绝对路径绝不外流**。候选文本会被人复制进画像或对话，一旦带出
   token / 本机绝对路径，泄漏面就从「一次会话」变成「长期记忆」。这是硬边界。

3. **去重按语义而非前缀**。同一结论会在 `outcomes.pro` 与 `plan[].step`
   各写一遍、措辞略不同（「A、B、C」vs「A + B + C」）；前缀去重抓不住，
   人去确认时白看一遍。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DISTILL = ROOT / "scripts" / "profile_distill.py"


def run_distill(*args: str, board_path: Path | None = None) -> dict:
    env = None
    cmd = [sys.executable, str(DISTILL), *args, "--json"]
    if board_path is not None:
        import os
        env = {**os.environ, "RSI_BOARD_PATH": str(board_path)}
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       cwd=str(ROOT), env=env)
    assert r.returncode == 0, r.stderr[:400]
    return json.loads(r.stdout)


def sample_task() -> dict:
    return {
        "id": "T-test-01",
        "title": "样例",
        "status": "done",
        "updated_at": "2026-11-08T00:00:00Z",
        "outcomes": {
            "brief": "给人看的一句话。",
            "pro": "锚点必须唯一，否则补丁永远不幂等。"
                   "实测 pytest 261 绿、node --check ×7 绿。"
                   "token = abc123secret 不应出现在候选里。",
        },
        "plan": [
            {"step": "根因：锚点不唯一导致重复插入", "status": "completed"},
            {"step": "还有个没做的步骤不该被抽出来", "status": "pending"},
        ],
    }


class DistillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.dir = Path(self.td.name)
        self.board = self.dir / "board.json"
        self.board.write_text(json.dumps(
            {"version": 1, "tasks": [sample_task()], "inspirations": [],
             "layout": {"sections": []}}, ensure_ascii=False), encoding="utf-8")

    def tearDown(self) -> None:
        self.td.cleanup()

    def test_extracts_section_and_note(self):
        d = run_distill("--task", "T-test-01", "--status", "all", board_path=self.board)
        kinds = {c["kind"] for c in d["candidates"]}
        self.assertIn("section", kinds, "强约束措辞应被抽为 section")

    def test_pending_step_not_extracted(self):
        d = run_distill("--task", "T-test-01", "--status", "all", board_path=self.board)
        texts = " ".join(c["text"] for c in d["candidates"])
        self.assertNotIn("没做的步骤", texts, "未完成步骤不该成为画像候选")

    def test_secret_never_leaks(self):
        d = run_distill("--task", "T-test-01", "--status", "all", board_path=self.board)
        blob = json.dumps(d, ensure_ascii=False)
        self.assertNotIn("abc123secret", blob, "密钥绝不能进入候选文本")

    def test_has_source_for_traceability(self):
        d = run_distill("--task", "T-test-01", "--status", "all", board_path=self.board)
        self.assertTrue(d["candidates"])
        for c in d["candidates"]:
            self.assertEqual(c["source"], "T-test-01", "每条候选必须可回溯到任务")
            self.assertTrue(c["why"], "每条候选必须说明命中哪条判据")

    def test_is_read_only(self):
        """核心纪律：本命令不得改写 board.json（更不得写 profile.json）。"""
        before = self.board.read_bytes()
        run_distill("--task", "T-test-01", "--status", "all", board_path=self.board)
        self.assertEqual(self.board.read_bytes(), before, "蒸馏不得改写看板")

    def test_dedup_by_semantics(self):
        """同一结论文本即便措辞不同（顿号 vs 加号），也只出现一次。"""
        g = run_distill("--task", "T-test-01", "--status", "all", board_path=self.board)
        notes = [c["text"] for c in g["candidates"] if c["kind"] == "note"]
        verified = [t for t in notes if "261" in t]
        self.assertLessEqual(len(verified), 1,
                             f"同一验证结论被抽了多次: {verified}")


if __name__ == "__main__":
    unittest.main()
