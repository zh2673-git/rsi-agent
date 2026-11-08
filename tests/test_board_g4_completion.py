"""I-20261108-06 补齐（G4a-Rust 锁 / G4b 并行判据）的可机跑断言。

为什么单列一个文件：G 轮那批测试（`test_board_g_round.py`）只覆盖了 Python 侧锁，
`board.rs` 无锁这件事从未被测过——正是这个缺口让「I-06 已完成」的错误结论活了下来。
本文件的纪律是**读源码验契约**：跨语言同源的东西（锁文件名、判据文本）直读另一侧，
任一侧单方面改动会当场失败。

不测实现细节（不 grep `create_new`、不 grep 函数名），只测三件对外为真的事：
  1. Rust 侧与 Python 侧用的是**同一把**锁文件（否则两把锁等于没锁）；
  2. 取锁发生在 **load 之前**（先 load 后取锁 = 拿旧快照覆盖别人，锁白加）；
  3. 并行判据真的进了 system prompt（不是只写在判定文档里）。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


BOARD_RS = "runtime/crates/host/src/web/api/board.rs"
BOARD_PY = "scripts/board.py"
BOARD_CTX_RS = "runtime/crates/agent-loop/src/board_ctx.rs"
SKILLS_RS = "runtime/crates/agent-loop/src/skills.rs"


class G4aRustLockTest(unittest.TestCase):
    """跨进程写锁：Rust 侧必须与 Python 侧取同一把锁，且锁在 load 之前。"""

    def test_lock_file_name_matches_python(self):
        """两侧必须是同一个 `board.lock`：两把不同的锁等于没有锁。"""
        rs = read(BOARD_RS)
        py = read(BOARD_PY)
        self.assertIn('"board.lock"', rs, "board.rs 必须在 board.json 同目录取 board.lock")
        self.assertIn('"board.lock"', py, "board.py 侧锁名")
        # 两侧都从 board 路径派生，等价于「同一目录同一文件」
        self.assertIn("with_file_name(\"board.lock\")", rs)
        self.assertIn('board_path().parent / "board.lock"', py)

    def test_lock_is_acquired_before_load_in_post(self):
        """post_board 必须先取锁再 load——顺序反了锁就白加（拿旧快照覆盖别人）。

        这是本次修补的核心不变量，也是最容易被后来者改错的一处：`load_board()`
        变成第一句时，测试必须变红。
        """
        rs = read(BOARD_RS)
        # 只看 post_board 函数体，避免 get_board 里的 load_board 干扰
        m = re.search(r"pub\(crate\) async fn post_board.*?\n}\n", rs, re.S)
        self.assertIsNotNone(m, "找不到 post_board")
        body = m.group(0)
        lock_at = body.find("BoardLock::acquire()")
        load_at = body.find("load_board()")
        self.assertGreater(lock_at, -1, "post_board 必须取锁")
        self.assertGreater(load_at, -1, "post_board 必须读板")
        self.assertLess(lock_at, load_at, "锁必须在 load_board 之前拿")

    def test_lock_failure_is_explicit_not_silent(self):
        """拿不到锁要明确失败（409），不能静默降级成无锁写。"""
        rs = read(BOARD_RS)
        m = re.search(r"pub\(crate\) async fn post_board.*?\n}\n", rs, re.S)
        body = m.group(0)
        # 取锁的 Err 分支必须返回响应而非继续执行
        self.assertRegex(
            body,
            r"BoardLock::acquire\(\)\.await\s*\{[^}]*Err\([^)]*\)\s*=>",
            "取锁失败必须有 Err 分支",
        )
        self.assertIn('"K409"', body, "锁冲突复用 409（与坏板拒绝写入同族）")

    def test_stale_lock_is_reclaimed(self):
        """崩溃留下的残锁不能永久堵死：超龄即回收。"""
        rs = read(BOARD_RS)
        self.assertIn("LOCK_STALE", rs)
        self.assertIn("remove_file", rs, "残锁必须能被删掉")

    def test_lock_released_on_drop(self):
        """早退/panic 展开路径也要释放锁，否则一次异常就锁死看板。"""
        rs = read(BOARD_RS)
        self.assertRegex(rs, r"impl Drop for BoardLock", "必须用 Drop 释放锁")
        drop_body = re.search(r"impl Drop for BoardLock \{.*?\n}", rs, re.S).group(0)
        self.assertIn("remove_file", drop_body)

    def test_doc_no_longer_claims_atomic_is_mutual_exclusion(self):
        """模块文档不得再写「原子替换 → 并发写不吞条目」这个错误结论。

        这正是当初漏掉 Rust 锁的思想根源：把原子性当成了互斥性。留一条断言，
        防止后人把那句话加回去。
        """
        rs = read(BOARD_RS)
        # 只看模块文档头（`//!` 段）：锁实现的注释里会**引用**那句错话用来解释
        # 「为什么当初写错了」，引用不是主张，不能一并判红。
        header = "\n".join(l for l in rs.splitlines()[:20] if l.startswith("//!"))
        self.assertNotIn("因此并发写不会互相吞条目", header)
        self.assertIn("原子替换只保证不掉半截文件", header, "要写清正确结论，不只是删错话")


class G4bParallelCriterionTest(unittest.TestCase):
    """并行判据必须进 system prompt——这是 I-06 的正身，也是当初唯一没做的部分。"""

    def test_parallel_hint_exists_and_is_mounted(self):
        ctx = read(BOARD_CTX_RS)
        skills = read(SKILLS_RS)
        self.assertIn("fn parallel_hint()", ctx, "board_ctx.rs 必须有 parallel_hint")
        self.assertIn("board_ctx::parallel_hint()", skills, "必须真挂进 system prompt")

    def test_criterion_covers_both_directions(self):
        """判据必须同时给「可以并行」和「必须串行」两类信号，否则等于没判据。"""
        ctx = read(BOARD_CTX_RS)
        m = re.search(r"pub\(super\) fn parallel_hint\(\) -> String \{.*?\n}\n", ctx, re.S)
        self.assertIsNotNone(m, "找不到 parallel_hint 函数体")
        body = m.group(0)
        low = body.lower()
        # 可以并行：不同文件 / 无先后依赖
        self.assertIn("different files", low)
        self.assertIn("no ordering", low)
        # 必须串行：同一文件 / 同一 build 目录 / 有依赖
        self.assertIn("the same file", low)
        self.assertIn("one step's input is another step's output", low)

    def test_unsure_defaults_to_serial(self):
        """「拿不准就串行」必须明写：并行猜错的代价是不确定的，串行只花时间。"""
        ctx = read(BOARD_CTX_RS)
        self.assertIn("When unsure, go serial", ctx)

    def test_user_only_sees_merged_result(self):
        """并行是 agent 的事：用户只看一条合并结果，不该看到 N 份子报告。"""
        ctx = read(BOARD_CTX_RS)
        m = re.search(r"pub\(super\) fn parallel_hint\(\) -> String \{.*?\n}\n", ctx, re.S)
        low = m.group(0).lower()
        self.assertIn("one merged answer", low)
        self.assertIn("merge the sub-results", low)

    def test_board_write_flagged_as_serial(self):
        """看板写虽已加锁，判据里仍应劝串行（重试比排队更贵）。"""
        ctx = read(BOARD_CTX_RS)
        self.assertIn("both steps write the board", ctx)


class InspOpsNoDuplicateTest(unittest.TestCase):
    """顺手修掉的既有缺陷：两个 op 分支整段重复，后者是死代码。"""

    def test_no_duplicate_op_arms(self):
        rs = read(BOARD_RS)
        for op in ("inspiration.edit", "inspiration.rm"):
            n = rs.count(f'"{op}" =>')
            self.assertEqual(n, 1, f"{op} 的 match 分支必须只有一处（重复会让后者变死代码）")


class PromptOverrideIsTotalTest(unittest.TestCase):
    """`AGENT_SYSTEM_PROMPT` 文档承诺「整体覆盖」，实现必须真的整体。

    这条不只是语义洁癖：三段附录的内容取决于**本机状态**（画像里有几条观察、
    手上在办几个任务）。若覆盖态仍拼接，按预算精确断言的用例就随本机文件内容
    变红/变绿——红的原因还看不出与画像有关。实测踩过这个坑，故留断言。
    """

    def test_override_blanks_all_three_appendices(self):
        rs = read("runtime/crates/agent-loop/src/chat.rs")
        m = re.search(r"let override_on = cfg\.system_prompt_override\.is_some\(\);.*?;", rs, re.S)
        self.assertIsNotNone(m, "找不到 override 判定")
        block = m.group(0)
        # 三样都必须被置空：技能附录 / 看板上下文 / 习惯画像
        self.assertIn("String::new()", block)
        self.assertIn("skills_appendix", block)
        self.assertIn("board_ctx", block)
        self.assertIn("profile_ctx", block)

    def test_appendices_still_injected_without_override(self):
        """不能在「覆盖态置空」时把非覆盖态也一起关掉——那是把功能删了。"""
        rs = read("runtime/crates/agent-loop/src/chat.rs")
        m = re.search(r"let override_on = cfg\.system_prompt_override\.is_some\(\);.*?\);", rs, re.S)
        else_branch = m.group(0).split("} else {")[1]
        self.assertIn("skills_appendix", else_branch, "非覆盖态必须照旧注入技能附录")
        self.assertIn("board_ctx", else_branch)
        self.assertIn("profile_ctx", else_branch)



if __name__ == "__main__":
    unittest.main()
