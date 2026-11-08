"""灵感「永远是待议」根因的回归断言（J 轮）。

## 这个 bug 的形状

用户问：「为什么灵感中待议的还是有 7 个。」查下去发现是**三层叠加**：

1. **G1 删光了 agent 的灵感写通道**（`insp-add/set/adopt/edit/rm`），采纳关联改记在
   任务一侧的 `task.inspirations`——这个设计是对的（一个事实只存一处）。
2. **但 UI 的分组只读 `inspiration.status`**，而 `adopted` 这个值从此**再没有任何
   通道能写进去**（agent 不许写、UI 只有「归档」按钮）。于是状态机里有一个
   **不可达状态**：枚举里有 `adopted`，却没有任何代码路径能到达它。
3. 结果：任务全做完了，左边灵感还挂在「待议」，而且会**永远**挂着。

## 为什么测试是这么写的

三条断言分别钉住三层，任何一层重新断掉都会被抓住：

- `adopted` 必须能被**推导**出来（从任务侧），否则宁可让它从枚举里消失——
  留着一个不可达的状态是最坏情况：界面上看着有这条路，其实没有。
- **归档优先于推导**：用户归档了就是不想再看，不能被某个任务的引用重新拉回列表。
- 源码里**不许**再出现指向已删除命令的指引（`insp-adopt` 等）。SKILL.md 曾长期
  教 agent 跑一个不存在的命令——这类「文档教人走死路」的缺陷没有编译器能发现。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

APP_BOARD = "runtime/crates/host/web-dist/vendor/app-board.js"
BOARD_PY = "scripts/board.py"
SKILL_MD = "skills/rsi-board/SKILL.md"

# G1 删掉的五个写命令。它们不该再出现在「教 agent 怎么用」的文档里。
GONE_CMDS = ("insp-add", "insp-set", "insp-adopt", "insp-edit", "insp-rm")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class InspDerivedStateTest(unittest.TestCase):
    """灵感显示状态必须从任务侧推导——否则 `adopted` 是不可达状态。"""

    def test_derive_fn_exists_and_reads_task_side(self):
        """推导函数存在，且数据来源是 tasks 的 inspirations（不是灵感自己的 status）。"""
        js = read(APP_BOARD)
        self.assertIn("function deriveInspState", js, "缺推导函数")
        start = js.index("function deriveInspState")
        body = js[start : start + 900]
        self.assertIn("tasks", body, "推导必须读任务侧")
        self.assertIn("inspirations", body, "推导必须读 task.inspirations")
        self.assertIn('status: "adopted"', body, "有任务引用即视为已采纳")

    def test_render_uses_derived_state(self):
        """渲染入口必须走推导——只加函数不接线，bug 照旧。"""
        js = read(APP_BOARD)
        start = js.index("function renderInspSection")
        head = js[start : start + 600]
        self.assertIn("deriveInspState(", head, "renderInspSection 必须调用推导函数")

    def test_archived_wins_over_derived(self):
        """归档是用户的显式动作，优先级高于推导——归档了就是不想再看。"""
        js = read(APP_BOARD)
        start = js.index("function deriveInspState")
        body = js[start : start + 900]
        arch = body.index('"archived"')
        adopt = body.index('status: "adopted"')
        self.assertLess(arch, adopt, "archived 分支必须在 adopted 推导之前（提前返回）")

    def test_adopted_state_is_reachable(self):
        """`adopted` 在 UI 侧必须有来源：要么能写，要么能推导。"""
        js = read(APP_BOARD)
        self.assertIn('status: "adopted"', js, "adopted 必须在 UI 侧可达（推导）")


class NoDeadCommandGuidanceTest(unittest.TestCase):
    """文档不能再教 agent 跑已删除的命令——这类死路没有编译器能发现。"""

    def test_skill_md_has_no_removed_insp_commands(self):
        md = read(SKILL_MD)
        for cmd in GONE_CMDS:
            # 允许出现在「明确指出它已删除」的否定语境里，禁止出现在命令清单中。
            for m in re.finditer(re.escape(cmd), md):
                ctx = md[max(0, m.start() - 60) : m.end() + 40]
                self.assertTrue(
                    ("没有" in ctx) or ("已删" in ctx) or ("gone" in ctx.lower())
                    or ("不是去找不存在" in ctx),
                    f"SKILL.md 仍在命令语境里提到已删除的 {cmd}：…{ctx}…",
                )

    def test_board_py_has_no_insp_write_commands(self):
        """CLI 侧确实没有灵感写命令（G1 的实质），否则文档改了口、代码没改。"""
        py = read(BOARD_PY)
        for cmd in GONE_CMDS:
            self.assertNotIn(
                f'"{cmd}"', py, f"board.py 不应再注册 {cmd}（灵感写权限归用户）"
            )

    def test_task_inspiration_field_still_exists(self):
        """采纳关联的落点还在：task-append --inspiration（推导的唯一数据源）。"""
        py = read(BOARD_PY)
        self.assertIn("--inspiration", py, "task-append 必须能写 inspirations")
        self.assertIn('task["inspirations"]', py, "任务的 inspirations 字段是推导真源")


if __name__ == "__main__":
    unittest.main()
