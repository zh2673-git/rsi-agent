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


def _dup_patch_blocks(specs, read_src):
    """判据本体：哪些补丁的**替换全文**在产物里出现了不止一次。

    抽成纯函数是为了让它能被反向用例直接喂假数据——判据写在测试方法体里时，
    只能证明「当前仓库是干净的」，证明不了「脏了会报」。

    Args:
        specs: `(spec_path, spec_dict, patch_text, anchor_text)` 序列。
        read_src: `target_rel_path -> str | None`，None 表示读不到（跳过）。

    Returns:
        诊断字符串列表，空列表 = 干净。
    """
    bad = []
    for f, d, patch, anchor in specs:
        if _is_repair(d):
            continue
        target = d.get("file")
        if not target:
            continue
        src = read_src(target)
        if src is None:
            continue
        a = _norm(anchor)
        # 太短的补丁（一两行通用代码）没有诊断价值，会全是噪声
        p = _norm(patch)
        if len(p) < 24:
            continue
        # 白名单仍然要查：判据换了，但「这个文件里这段重复是合法的」这条事实没变。
        if a and (target, a.splitlines()[0].strip()) in KNOWN_LEGIT_REPEATS:
            continue
        # CSS 章节末行的合法重复（见 KNOWN_LEGIT_RULE_REPEATS 的说明），
        # 同一份事实在两张表里各查一次：这里按「目标文件+行首」判，上面按选择器判。
        if target.endswith("style.css") and a and any(
            a.strip().startswith(sel + " {") and body in a
            for sel, body in KNOWN_LEGIT_RULE_REPEATS
        ):
            continue
        n = _norm(src).count(p)
        if n > 1:
            bad.append(
                f"{target}: 补丁 {f} 的替换全文在产物里出现 {n} 次"
                f"（应 ≤1）→ 补丁被重复应用\n    {p.splitlines()[0][:70]!r}"
            )
    return bad


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
    """B. 产物：补丁的**替换全文**在目标文件里最多出现一次。

    判据为什么不是「锚点在产物里出现的次数 > 在补丁文本里的次数」（旧写法）：

    `apply-tool-patches.py` 用的是 `src.replace(anchor, patch, 1)`，而 patch 文本
    里本身就含一份 anchor。于是替换完成后，**anchor 在文件里的计数恒等于替换前**——
    这个量对「补丁被应用了几次」完全不敏感。它唯一能触发的情形是「基线里本来就有
    多份 anchor」，那是基线的事实，不是污染。旧写法因此既抓不到真污染（历史上
    style.css 整段 5705 字节被写两遍那次，anchor 计数同样没变），又会稳定误报
    那些「一个片段服务两处」的合法重复——旧表 KNOWN_LEGIT_REPEATS 就是为压这些
    误报而长的，越压越长，说明判据选错了。

    真判据：**patch 全文在产物里出现几次 = 补丁被应用了几次**。>1 就是重复块。

    这条判据自己也有反向用例（见下方 GuardHasTeeth），否则「换判据」和「关告警」
    从测试结果上分不出来。
    """

    def test_target_has_no_duplicate_patch_block(self):
        def _read(target: str):
            tp = ROOT / target
            if not tp.is_file():
                return None
            try:
                return tp.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                return None

        bad = _dup_patch_blocks(
            ((f.name, d, patch, anchor) for f, d, patch, anchor in _iter_specs()),
            _read,
        )
        self.assertEqual(bad, [], "产物被写成重复块（补丁重复插入的残留）:\n" + "\n".join(bad))


class GuardHasTeeth(unittest.TestCase):
    """B'. 判据自身的反向用例——证明它抓得到真污染、且不误报合法重复。

    没有这一组，「把判据改松」与「把告警关掉」在测试结果上是同一件事。
    三条情形对应历史上真实发生过的三类事件：

    1. 补丁应用一次  → 不得报（否则天天误报，人会开始无视它）；
    2. 同一段写两遍  → **必须**报（style.css 5705 字节被写两遍那次）；
    3. 基线本来就有多份 anchor，补丁只应用一次 → 不得报（NW18 的情形：
       两个测试函数各自 `set_var("AGENT_STREAM_DIR", ...)`，是天经地义的重复）。
    """

    PATCH = "let a = 1;\n// 新增的三行说明\nlet b = 2;\nlet c = 3;"
    ANCHOR = "let a = 1;"
    SPEC = {"file": "tgt/x.rs", "patch_file": "blocks/p.txt", "anchor_file": "blocks/a.txt"}

    def _run(self, src: str) -> list[str]:
        return _dup_patch_blocks([("probe.json", self.SPEC, self.PATCH, self.ANCHOR)], lambda _t: src)

    def test_applied_once_is_clean(self) -> None:
        src = "fn f() {\n    let a = 1;\n    // 新增的三行说明\n    let b = 2;\n    let c = 3;\n}\n"
        self.assertEqual(self._run(src), [])

    def test_written_twice_is_caught(self) -> None:
        body = "    let a = 1;\n    // 新增的三行说明\n    let b = 2;\n    let c = 3;\n"
        src = f"fn f() {{\n{body}}}\n\nfn g() {{\n{body}}}\n"
        bad = self._run(src)
        self.assertTrue(bad, "补丁被应用两次必须报出——否则这条守卫是摆设")
        self.assertIn("出现 2 次", bad[0])

    def test_baseline_multi_anchor_is_not_flagged(self) -> None:
        # 旧判据在这里必然误报（anchor 2 处 vs patch 1 份），新判据不该报。
        src = (
            "fn f() {\n    let a = 1;\n    // 新增的三行说明\n    let b = 2;\n    let c = 3;\n}\n\n"
            "fn g() {\n    let a = 1;\n}\n"
        )
        self.assertEqual(self._run(src), [])


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
