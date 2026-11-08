"""H 轮：静态页结构契约。

用户报「记忆和 agent 模块都是一样的，没什么其他内容」，真因不是数据、不是后端：
F 轮的 F3-MEM 补丁锚点吞掉了 `#tab-skills` 的收尾 `</div>`，于是 `#tab-memory` 与
`#tab-agent` 被嵌进默认 `hidden` 的 `#tab-skills` 里——页签切换逻辑把 `hidden` 正确设了，
但两个子面板的可见性被祖先的 `hidden` 吃掉，永远看不到内容。

这类缺陷 pytest / cargo / 补丁层**全绿**（补丁层只验「锚点命中」，不验「产物是合法
DOM」），只有真打开浏览器才暴露。故在此立契约：静态页必须结构自洽。

测的是结构不测文案——文案会改，结构不该坏。
"""
from __future__ import annotations

import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "runtime" / "crates" / "host" / "web-dist" / "index.html"

VOID = {"br", "hr", "img", "input", "meta", "link", "source", "area", "col",
        "embed", "param", "track", "wbr"}

TABS = ("tab-llm", "tab-tools", "tab-skills", "tab-memory", "tab-agent")


class _Struct(HTMLParser):
    """记录 id 计数、各页签的祖先 id/class 链、标签配对情况。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: Counter[str] = Counter()
        self.chains: dict[str, list[str]] = {}
        self.stack: list[tuple[str, str | None, str | None]] = []
        self.implicit_close: list[str] = []
        self.extra_close: list[str] = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        i = d.get("id")
        if i:
            self.ids[i] += 1
            if i in TABS:
                self.chains[i] = [x[1] or x[2] or x[0] for x in self.stack]
        if tag in VOID:
            return
        self.stack.append((tag, i, d.get("class")))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for k in range(len(self.stack) - 1, -1, -1):
            if self.stack[k][0] == tag:
                if k != len(self.stack) - 1:
                    self.implicit_close.append(
                        f"</{tag}> 隐式关闭了 " + ", ".join(
                            f"<{x[0]}{'#' + x[1] if x[1] else ''}>"
                            for x in self.stack[k + 1:])
                    )
                del self.stack[k:]
                return
        self.extra_close.append(f"多余的 </{tag}>")


def parse() -> _Struct:
    p = _Struct()
    p.feed(INDEX.read_text(encoding="utf-8"))
    return p


class StaticStructure(unittest.TestCase):
    """静态页要么结构自洽，要么这里红——不靠人去点浏览器发现。"""

    def test_no_duplicate_id(self):
        """id 重复会让 $() 取到错误节点：顶栏 conn/status 曾整组重复。"""
        dups = {k: v for k, v in parse().ids.items() if v > 1}
        self.assertEqual(dups, {}, f"存在重复 id（getElementById 只取第一个）: {dups}")

    def test_tags_balanced(self):
        """标签必须成对：隐式关闭 = 作者少写了闭合，是嵌入错误的前兆。"""
        p = parse()
        self.assertEqual(p.extra_close, [], "有多余的闭合标签")
        self.assertEqual(p.implicit_close, [], "有标签未显式闭合（被祖先隐式关闭）")
        self.assertEqual(p.stack, [], "有标签到文件末尾仍未闭合")

    def test_tabs_are_siblings(self):
        """五个设置页签必须是同一层兄弟。

        这是 H 轮那个 bug 的定点回归：任一面板嵌进另一个 hidden 面板，
        点该页签就永远看不到内容——而 hidden 标志位本身是对的，查 JS 查不出来。
        """
        p = parse()
        missing = [t for t in TABS if t not in p.chains]
        self.assertEqual(missing, [], f"页签缺失: {missing}")
        parents = {t: tuple(p.chains[t]) for t in TABS}
        distinct = set(parents.values())
        self.assertEqual(
            len(distinct), 1,
            "页签不在同一父节点下（嵌套会让 hidden 祖先吃掉子面板可见性）: "
            + repr(parents),
        )
        # 进一步：父链里不能出现另一个页签 id
        for name, chain in parents.items():
            others = [c for c in chain if c in TABS and c != name]
            self.assertEqual(others, [], f"{name} 被嵌在 {others} 内部")

    def test_body_wrapper_not_nested(self):
        """设置抽屉的 .body 容器只应出现一次（曾重复嵌套一层）。"""
        src = INDEX.read_text(encoding="utf-8")
        self.assertEqual(
            src.count('<div class="body">'), 1,
            '设置抽屉里 <div class="body"> 应恰有 1 个（重复嵌套会打乱高度/滚动）',
        )

    def test_every_tab_has_toggle_route(self):
        """切换逻辑列出的页签集合必须与实际 DOM 里的页签集合一致。

        防「加了面板忘了接切换」与「删了面板留下死引用」两种漂移。
        """
        p = parse()
        js = (ROOT / "runtime" / "crates" / "host" / "web-dist"
              / "vendor" / "app-settings.js").read_text(encoding="utf-8")
        listed = [t for t in TABS if f'"{t.replace("tab-", "")}"' in js]
        self.assertEqual(sorted(listed), sorted(TABS),
                         f"切换逻辑与实际页签不一致：DOM={sorted(p.chains)} JS={sorted(listed)}")


if __name__ == "__main__":
    unittest.main()
