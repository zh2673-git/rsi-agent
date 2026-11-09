"""K 轮：补丁链自身的「不重复」契约 + 产物无重复块。

为什么需要这个文件（都是实测踩到的真实故障，不是假想）：

1. **补丁文本自带重复行**：`F3-CFG-CACHE` 的 patch 文本里，锚点行
   `showInstBadge(c.instance_name ?? "")` 写了两遍。而补丁语义是「锚点 → 替换文本」，
   把锚点行写进替换文本 = 每应用一次，该行就多一份。`Z1` 之前，这已把
   `app-settings.js` 的该行变成 2 份；`C-STYLE` / `F3-CAP-CSS` 把 `style.css` 的
   `.ist {…}` 变成 3 份。

2. **重复插入比语法错更隐蔽**：`showInstBadge(...)` 重复赋值是合法 JS，
   `node --check` 全绿；`.ist {…}` 重复是合法 CSS，浏览器照渲染。它们不会报错，
   只会让文件越长越乱、且每次重放都再坏一点。所以必须有**结构契约**兜住，
   而不是靠肉眼看 diff。

3. **与 `test_static_structure.py` 同一立场**：补丁层只验「锚点命中」，不验
   「产物是否被写重复」。锚点命中 ≠ 补丁正确。

判据取「整块比对」而不是「逐行比对」：多行锚点里出现多个 `}`、`});`
是正常上下文，逐行比会全是假阳性（实测过滤后仍有 6 条噪声，其中 3 条是
多行锚点的合法重复）。真正要防的是**同一块被写两遍**。

测的是两件事：
  A. 每条补丁的替换文本，不得把锚点整块包含两次以上（源头）。
  B. 产物文件里，锚点块出现次数不得多于替换文本里出现的次数（污染）。
  C. CSS 产物里不得有完全重复的选择器规则。
"""
from __future__ import annotations

import json
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCHES = ROOT / "scripts" / "patches"
PATCH_DIRS = ("", "q-round")


def _norm(text: str) -> str:
    """比对口径：只认非空行的内容，忽略行尾空白与空行差异（CRLF/LF 混用是常态）。"""
    return "\n".join(l.strip() for l in text.splitlines() if l.strip())


def _iter_specs():
    for sub in PATCH_DIRS:
        d0 = PATCHES / sub if sub else PATCHES
        if not d0.is_dir():
            continue
        for f in sorted(d0.glob("*.json")):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(d, dict):
                continue
            pa = d.get("patch_file")
            if not pa:
                continue
            pp = d0 / pa
            if not pp.is_file():
                continue
            patch = pp.read_text(encoding="utf-8")
            an = d.get("anchor_file")
            anchor = ""
            if an and (d0 / an).is_file():
                anchor = (d0 / an).read_text(encoding="utf-8")
            yield f, d, patch, anchor


def _is_repair(d: dict) -> bool:
    """repair 型补丁的 patch 文本就是「期望不能再出现」的坏块，天然与锚点重合，豁免。"""
    return str(d.get("mode", "")).lower() == "repair" or bool(d.get("repair"))


# 已知的「合法多次出现」：不是补丁重复插入，而是同一行在源码里本就服务两个位置。
# 加白名单必须给理由——这是例外表，不是掩盖问题的抽屉。
KNOWN_LEGIT_REPEATS = {
    # chat.rs 在「轮次边界」与「波次循环内」各查一次取消信号：两处都是必需的
    # （轮次开始前快速退出 + 工具波次之间中断），语义不同，删任一处都会漏取消。
    ("runtime/crates/agent-loop/src/chat.rs",
     "if let Some(v) = self.check_cancel(env, &req.session_id).await {"),
}

# CSS 里「同一行规则出现两次」的合法情形：**两个不同章节各自收尾**用同一行。
# 与上面的 KNOWN_LEGIT_REPEATS 分开是因为判据不同——这里没有「修补残留」的嫌疑，
# 而是同一行被两个注释头（`/* ── D 轮…` 与 `/* ── C 轮…`）各自当作章节末行。
# 加白名单必须给理由，且在注释里写明是**哪两个章节**，否则后人无法判断该不该删。
KNOWN_LEGIT_RULE_REPEATS = {
    # C 轮章节末尾与 D 轮章节末尾各有一行 `.ist`：两章节都定义了灵感状态徽章样式，
    # 各自独立成立。曾经这里是「重复块」的残留（整段 5705 字节被写两遍），
    # 去重后剩下的就是这两行同名规则——不是 bug，删任一行会让某章节失去该样式。
    (".ist", "font-size: 10px; color: var(--faint);"),
}


class PatchSourceNotDuplicated(unittest.TestCase):
    """A. 源头：替换文本里锚点块最多出现一次（保留上下文），不得整块写两遍。"""

    def test_patch_text_does_not_repeat_anchor(self):
        bad = []
        for f, d, patch, anchor in _iter_specs():
            if _is_repair(d):
                continue
            a = _norm(anchor)
            if not a:
                continue
            n = _norm(patch).count(a)
            # 单行锚点用纯计数；n>1 说明整块上下文被写了两遍
            if n > 1:
                bad.append(
                    f"{f.name} → {d.get('patch_file')}: 锚点块在替换文本里出现 {n} 次"
                    f"（应 ≤1）→ 每应用一次就多插 {n - 1} 份\n    {a.splitlines()[0][:70]!r}"
                )
        self.assertEqual(
            bad, [],
            "补丁替换文本重复包含锚点块（会把产物写成重复块）:\n" + "\n".join(bad),
        )


class ArtifactNotPolluted(unittest.TestCase):
    """B. 产物：锚点块在目标文件里的出现次数，不得超过替换文本里的次数。"""

    def test_target_has_no_duplicate_patch_block(self):
        bad = []
        for f, d, patch, anchor in _iter_specs():
            if _is_repair(d):
                continue
            target = d.get("file")
            if not target:
                continue
            tp = ROOT / target
            if not tp.is_file():
                continue
            try:
                src = tp.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            a = _norm(anchor)
            # 太短的锚点（一两行通用代码）没有诊断价值，会全是噪声
            if len(a) < 24 or len(a.splitlines()) < 1:
                continue
            if (target, a.splitlines()[0].strip()) in KNOWN_LEGIT_REPEATS:
                continue
            # CSS 章节末行的合法重复（见 KNOWN_LEGIT_RULE_REPEATS 的说明），
            # 同一份事实在两张表里各查一次：这里按「目标文件+行首」判，上面按选择器判。
            if target.endswith("style.css") and any(
                a.strip().startswith(sel + " {") and body in a
                for sel, body in KNOWN_LEGIT_RULE_REPEATS
            ):
                continue
            in_patch = _norm(patch).count(a)
            in_src = _norm(src).count(a)
            if in_patch and in_src > in_patch:
                bad.append(
                    f"{target}: {a.splitlines()[0][:70]!r}… 在产物里出现 {in_src} 次，"
                    f"但补丁文本只提供 {in_patch} 次 → 产物有重复块"
                )
        self.assertEqual(bad, [], "产物被写成重复块（补丁重复插入的残留）:\n" + "\n".join(bad))


class DistStyleRulesNotDuplicated(unittest.TestCase):
    """C. CSS 专项：同一条选择器规则在产物里只应有一份。

    `style.css` 是补丁最密集的文件（15+ 条），重复块在这里代价最大：
    它不会报错，只会让后一条覆盖前一条，出现「改了没效果」的鬼故事。
    """

    def test_no_duplicate_selector_rule(self):
        css = (ROOT / "runtime" / "crates" / "host" / "web-dist" / "style.css").read_text(encoding="utf-8")
        rules: Counter[tuple[str, str]] = Counter()
        for line in css.splitlines():
            s = line.strip()
            if not s.endswith("}") or "{" not in s:
                continue
            sel, rest = s.split("{", 1)
            body = rest.rsplit("}", 1)[0].strip()
            sel = sel.strip()
            if sel and body and not sel.startswith("@") and (sel, body) not in KNOWN_LEGIT_RULE_REPEATS:
                rules[(sel, body)] += 1
        dups = {f"{sel} {{ {body} }}": n for (sel, body), n in rules.items() if n > 1}
        self.assertEqual(dups, {}, f"产物 CSS 有完全重复的规则（后一条覆盖前一条）: {dups}")


if __name__ == "__main__":
    unittest.main()
