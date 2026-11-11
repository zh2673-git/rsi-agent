"""MCP 工具的按需装载声明（G 轮）——语义锁。

tools_plugin.py 的 list 契约对 MCP 工具附 `deferred: True`（完整 JSON Schema 不进
agent-loop 的下发清单，模型调 load_tools 报名后才下发）；技能工具**不附**（装载即
期待可见）。这两条是配对的：只测一侧的话，把两边都标成 deferred 或都不标，测试仍绿。

为什么用源码断言而不是起进程：`_init_mcp()` 需要真连一台 MCP server（stdio 子进程），
在本机 CI 上不可用；而这里要锁的是**声明策略**（哪个池标 deferred），不是 MCP 协议本身
（协议由 tools/mcp.py 覆盖）。策略写在 list 分支的字典里，源码即契约。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "runtime" / "plugins" / "tools" / "tools_plugin.py"


class McpDeferredDeclarationTest(unittest.TestCase):
    """MCP 池标 deferred、技能池不标——两侧都要锁。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.src = PLUGIN.read_text(encoding="utf-8")

    def _mcp_list_block(self) -> str:
        """MCP 工具在 list 分支里的字典字面量（`for name, e in _MCP_TOOLS.items():` 之后）。"""
        start = self.src.find("for name, e in _MCP_TOOLS.items():")
        self.assertGreater(start, 0, "tools_plugin.py 里找不到 MCP 的 list 分支")
        end = self.src.find("return {" , start)
        self.assertGreater(end, start, "找不到 MCP list 分支的收尾")
        return self.src[start:end]

    def test_mcp_tools_declared_deferred(self) -> None:
        block = self._mcp_list_block()
        self.assertIn('"deferred": True', block, f"MCP 工具必须标 deferred: {block}")

    def test_mcp_keeps_parameters_for_config_view(self) -> None:
        # 配置视图（all=true）仍要 schema，否则设置面板显示不出参数表单；
        # deferred 是给 agent-loop 的分流标记，不改变 list 契约本身。
        block = self._mcp_list_block()
        self.assertIn('"parameters": e["parameters"]', block, block)

    def test_skill_tools_not_deferred(self) -> None:
        """技能工具不得标 deferred：数量少（1-3 件）且刚 load_skill 就期待可见，
        藏起来会让「装了却看不见」这个老坑复活。"""
        start = self.src.find("def _skill_tools(")
        end = self.src.find("def _call_skill_tool(", start)
        self.assertGreater(start, 0)
        self.assertGreater(end, start)
        block = self.src[start:end]
        self.assertNotIn("deferred", block, f"技能工具池不该出现 deferred: {block}")

    def test_deferred_only_in_mcp_section(self) -> None:
        """`deferred` 只允许出现在 MCP list 分支——别处出现即视为策略被改宽。"""
        hits = [m.start() for m in re.finditer(r'"deferred"', self.src)]
        self.assertEqual(len(hits), 1, f"deferred 应恰好出现 1 处（MCP list），实得 {len(hits)}")
        mcp_start = self.src.find("for name, e in _MCP_TOOLS.items():")
        self.assertGreater(hits[0], mcp_start, "deferred 出现在 MCP list 分支之外")


if __name__ == "__main__":
    unittest.main()
