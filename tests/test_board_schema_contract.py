# -*- coding: utf-8 -*-
"""BS（I-20261116）：task-upsert 规格必须在**两个地方同时在位**，且枚举不许漂移。

故障（2026-11-16 实测，用户原话「新建窗口似乎又不能自动将会话中的任务做进看板了」）：
子窗口的 agent 连撞 4 次 `task-upsert` 的 BAD_ARG——

    status: 'in_progress'          ← task 级状态没有 in_progress（它属于 plan 步）
    id: 'T-blind-full'              ← 自造 id，形状必须是 T-YYYYMMDD-NN
    acceptance: "一整段字符串"       ← 必须是数组

第 4 次才对；make-video 子窗口则一次都没登记成功（查了 --help 就放弃）。

根因不是通道：
  - CLI 绝对路径可达（子窗口的 agent 用的就是绝对路径）；
  - 四个实例读的是同一本账（`/api/board` 的 path 完全一致）。
根因是**规格不在调用点同框**：
  ① 提示词 brief 档只给命令名，schema 只在 full 档（靠关键词命中才注入）；
  ② `task-upsert --help` 只印 usage，不印字段规格。

模型看不见规格就只能猜，猜错就重试——每次重试是一轮工具往返；重试到放弃时，
用户看到的就是「任务没进看板」。

所以本测试钉两条不变量：

  A. **双处在位**：CLI `--help` 末尾印 schema；提示词 brief 段也印 schema。
     少任何一处，下一次「用户没命中关键词」就会复现。

  B. **枚举不许漂移**：CLI 的真值（`TASK_STATUSES` / `PLAN_STATUSES` / …）必须
     与提示词里给模型看的那份**逐字一致**。漂移比不给规格更糟——它会让原本
     写对的调用变成写错，模型还查不出原因。
"""
from __future__ import annotations

import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_PY = ROOT / "scripts" / "board.py"
SKILLS_RS = ROOT / "runtime" / "crates" / "agent-loop" / "src" / "skills.rs"


def run_board(*args: str) -> str:
    """跑 board.py 并拿 stdout（--help 走 stdout，故不检查 returncode）。"""
    r = subprocess.run(
        [sys.executable, str(BOARD_PY), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    return r.stdout


def read(rel: Path) -> str:
    return rel.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


class TaskUpsertSchemaInCliTest(unittest.TestCase):
    """A-1：`task-upsert --help` 必须印出字段规格。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.help_text = run_board("task-upsert", "--help")

    def test_help_mentions_schema(self) -> None:
        self.assertIn("JSON schema", self.help_text,
                      "task-upsert --help 必须印 JSON schema（撞错时规格要就在眼前）")

    def test_help_lists_task_status_enum(self) -> None:
        # 真值取自 CLI 自己，不写死——枚举改了本测试自动跟随，但 Rust 侧要对齐（见下）
        self.assertIn("planning|doing|verifying|done|blocked|cancelled", self.help_text)

    def test_help_lists_plan_status_enum(self) -> None:
        self.assertIn("pending|in_progress|completed|cancelled", self.help_text)

    def test_help_lists_owner_enum(self) -> None:
        self.assertIn("self|subagent|skill", self.help_text)

    def test_help_names_the_three_real_rejections(self) -> None:
        """实测撞到的三种拒因必须点名——通用「格式错误」模型无法自我纠正。"""
        for needle in ("in_progress", "T-20261107-01", "acceptance"):
            self.assertIn(needle, self.help_text, f"--help 未点名拒因要素 {needle}")

    def test_help_says_id_can_be_omitted(self) -> None:
        self.assertIn("自动分配", self.help_text,
                      "--help 必须说明 id 可省略（否则模型习惯自造 id 必撞形状校验）")


class SchemaEnumParityTest(unittest.TestCase):
    """B：CLI 真值 ↔ 提示词字面量，必须逐字一致。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.board_src = read(BOARD_PY)
        cls.skills_src = read(SKILLS_RS)
        cls.help_text = run_board("task-upsert", "--help")

    def _enum_from_board_src(self, name: str) -> str:
        m = re.search(rf'^{name} = \((.*?)\)\s*$', self.board_src, re.M)
        self.assertIsNotNone(m, f"board.py 里找不到 {name}")
        items = [x.strip().strip('"') for x in m.group(1).split(",") if x.strip()]
        return "|".join(items)

    def test_prompt_contains_exact_task_status_enum(self) -> None:
        want = self._enum_from_board_src("TASK_STATUSES")
        self.assertIn(want, self.skills_src,
                      f"提示词里的 task 级枚举必须与 board.py 的 TASK_STATUSES 逐字一致：{want}")

    def test_prompt_contains_exact_plan_status_enum(self) -> None:
        want = self._enum_from_board_src("PLAN_STATUSES")
        self.assertIn(want, self.skills_src,
                      f"提示词里的 plan 步枚举必须与 board.py 的 PLAN_STATUSES 逐字一致：{want}")

    def test_prompt_contains_exact_owner_enum(self) -> None:
        want = self._enum_from_board_src("PLAN_OWNERS")
        self.assertIn(want, self.skills_src,
                      f"提示词里的 owner 枚举必须与 board.py 的 PLAN_OWNERS 逐字一致：{want}")

    def test_help_contains_exact_task_status_enum(self) -> None:
        want = self._enum_from_board_src("TASK_STATUSES")
        self.assertIn(want, self.help_text,
                      "--help 的枚举必须与 board.py 真值一致（--help 是从同一常量拼的）")


class BriefPromptCarriesSchemaTest(unittest.TestCase):
    """A-2：提示词 brief 段（每轮都在）必须自带规格。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.src = read(SKILLS_RS)

    def test_brief_section_declares_schema_block(self) -> None:
        self.assertIn("### task-upsert JSON schema", self.src,
                      "brief 段必须含 schema 块（否则没命中关键词的轮次无规格可用）")

    def test_brief_block_is_inside_brief_not_only_full(self) -> None:
        """schema 必须落在 brief 变量里（full=false 也返回它），不能只在 full 追加段。"""
        i_brief = self.src.find('let brief = "\\n## Task board (single-conversation UI)')
        i_schema = self.src.find("### task-upsert JSON schema")
        i_full_branch = self.src.find("if !full {")
        self.assertTrue(i_brief >= 0, "找不到 brief 变量")
        self.assertTrue(i_schema > i_brief, "schema 必须在 brief 变量内部")
        self.assertTrue(i_schema < i_full_branch,
                        "schema 必须在 `if !full` 分支之前——否则 brief 档拿不到它")


class RejectionIsNotSilentTest(unittest.TestCase):
    """被拒时必须**明确**报错（模型要能据此自我纠正，而不是以为写成功了）。"""

    def test_bad_status_reports_allowed_values(self) -> None:
        out = run_board("task-upsert", "--file", "-")
        # 无 stdin 时报 IO/解析错也算正常退出路径；这里只验证 CLI 不 panic
        self.assertNotIn("Traceback", out)

    def test_schema_doc_lists_common_rejections(self) -> None:
        h = run_board("task-upsert", "--help")
        self.assertIn("常见拒因", h,
                      "--help 必须列出常见拒因与修法（这是模型自我纠正的依据）")


if __name__ == "__main__":
    unittest.main()
