"""F 轮契约测试：看板信息架构 + 记忆可见化 + 遗留清账。

纪律（与前几轮同源）：测**契约**不测实现细节。本文件锁三类东西：
1. **跨语言同源常量**（域名形状 / 章节 kind / 域上限）——直读两侧源码比对，
   而不是只测一侧（单侧测试过了，另一侧漂移照样静默坏）；
2. **默认值即设计**（落定组默认收起、记忆页只删不加）——这类"看起来正常"的
   行为最容易在重构时被顺手改掉；
3. **补丁层结构性约束**（尾部追加必须合并、被取代的补丁必须留档）。

不测：DOM 渲染结果的像素级细节（用无头 DOM 桩在 CI 之外验，见 00-PLAN §11 F1）。
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


BOARD_JS = "runtime/crates/host/web-dist/vendor/app-board.js"
SETTINGS_JS = "runtime/crates/host/web-dist/vendor/app-settings.js"
INDEX_HTML = "runtime/crates/host/web-dist/index.html"
STYLE_CSS = "runtime/crates/host/web-dist/style.css"
PROFILE_RS = "runtime/crates/host/src/web/api/profile.rs"
PROFILE_PY = "scripts/profile.py"


class FoldContractTest(unittest.TestCase):
    """F1：落定态默认收起——默认值是设计的一部分，必须被锁住。"""

    def setUp(self):
        self.js = read(BOARD_JS)

    def test_settled_groups_fold_by_default(self):
        # 任务：done / cancelled 传入 dflt=true；活跃组传 false。
        # v13：落定组的默认值不再是裸 settled(g)，而是 settled(g) && !fresh——
        # 「刚做完的那条别折进去」。故断言改成行为级：默认值必须是 settled(g) 参与
        # 计算、且活跃组恒为 false、落定组恒为 true（除非命中 fresh 例外）。
        self.assertIn('const settled = (g) => st === "status" && (g === "done" || g === "cancelled");',
                      self.js, "任务组的『落定态』判据被改动")
        self.assertIn("const shut = folded(sec.id, g, settled(g));", self.js,
                      "任务组未按 settled 决定默认折叠态")
        # v13：收起态必须露出「最新一条」预览——折成一行只剩数字，用户就看不出
        # 自己刚交付的活（这是「任务做完了看板不体现」的直接来源）。
        self.assertIn('row.classList.add("tpreview")', self.js,
                      "折叠组未露出最新一条预览")
        self.assertIn("if (shut) {", self.js, "折叠分支被改动")

    def test_inspiration_layers_fold_by_default(self):
        # 灵感：open 全展，adopted/archived 默认收起
        self.assertIn('const shut = folded(sec.id, st, st !== "open");', self.js,
                      "灵感三层折叠的默认值被改动（open 必须全展）")
        self.assertIn('for (const st of ["open", "adopted", "archived"])', self.js,
                      "灵感分组顺序/层数被改动")

    def test_fold_state_persisted_and_user_wins(self):
        # 用户手动翻转必须记住（localStorage），否则刷新后回到默认 = 白点
        self.assertIn('localStorage.setItem(FOLD_KEY, JSON.stringify(boardFold))', self.js)
        self.assertIn("return k in boardFold ? !!boardFold[k] : !!dflt;", self.js,
                      "folded() 必须在有用户记录时以用户为准")

    def test_collapsed_head_still_shows_count(self):
        # 折叠 ≠ 隐藏：组头必须带条目数
        head = self.js[self.js.index("function tgroupHead"):]
        head = head[: head.index("\n}\n")]
        self.assertIn("${n}", head, "折叠的组头必须显示条目数")


class MemoryPageContractTest(unittest.TestCase):
    """F2：记忆页 = 能看能删不能写——这个不对称是设计，不是遗漏。"""

    def setUp(self):
        self.html = read(INDEX_HTML)
        self.js = read(SETTINGS_JS)
        self.rs = read(PROFILE_RS)

    def test_memory_tab_and_panel_exist(self):
        self.assertIn('data-tab="memory"', self.html)
        self.assertIn('id="tab-memory"', self.html)
        self.assertIn('id="mem-body"', self.html)

    def test_memory_tab_participates_in_switch(self):
        # 页签切换序列必须含 memory，否则点了不动。
        # I-07 加「分发」页后序列变长，故只断言「都在同一条切换数组里」，
        # 不写死整串——写死会让每次加页都假红一次。
        m = re.search(r'for \(const t of \[([^\]]+)\]\)', self.js)
        self.assertIsNotNone(m, "找不到页签切换序列")
        seq = m.group(1)
        for tab in ("llm", "tools", "skills", "memory", "agent", "publish"):
            self.assertIn(f'"{tab}"', seq, f"切换序列缺 {tab}（点了不动）")

    def test_no_add_input_in_memory_page(self):
        """「不能手写新增」的可见证据：记忆页内没有 textarea / 新增输入框。

        切片按**本页自己的**开始标签到下一个页签开始标签，不依赖页签顺序。
        """
        start = self.html.index('id="tab-memory"')
        panel = self.html[start:]
        nxt = panel.index('id="tab-agent"', 1)
        panel = panel[:nxt]
        self.assertNotIn("<textarea", panel, "记忆页不该有可写输入区（新增走观察）")
        self.assertNotIn("＋", panel, "记忆页不该有『＋新增』按钮")

    def test_all_tab_containers_intact(self):
        # F 轮真实缺陷：加记忆页时补丁锚点把 <div id="tab-agent"> 的开标签一起替换掉，
        # 导致 Agent 页容器消失（点页签不会报错，只是内容永远不出现——最难察觉的一类）。
        # I-07 又加了「分发」页，故这里不再写死数量：容器数必须与页签按钮数一致，
        # 「多一个=重复注入，少一个=锚点吞标签」这个判据不变，但不因加页而假红。
        for tab in ("llm", "tools", "skills", "memory", "agent", "publish"):
            self.assertIn(f'id="tab-{tab}"', self.html, f"缺少页签容器 #tab-{tab}")
        buttons = self.html.count('data-tab="')
        containers = self.html.count('<div id="tab-')
        self.assertEqual(containers, buttons,
                         f"页签容器数({containers})应等于页签按钮数({buttons})"
                         "（不相等=重复注入或锚点吞标签）")

    def test_delete_ops_are_whitelisted(self):
        # 后端只放行三种删除，其余一律 400 并给出指引
        self.assertIn('matches!(op, "note-rm" | "section-rm" | "domain-rm")', self.rs)
        self.assertIn("只支持删除操作", self.rs)

    def test_bad_json_refuses_write(self):
        # 坏文件不覆盖（覆盖等于丢结论）
        self.assertIn("拒绝写入（不让删除把坏文件覆盖成空画像）", self.rs)

    def test_domain_shape_matches_python(self):
        # 跨语言同源：Rust 的 valid_domain 与 profile.py 的 DOMAIN_RE 必须等价
        py = read(PROFILE_PY)
        m = re.search(r'DOMAIN_RE\s*=\s*re\.compile\(\s*r?["\']([^"\']+)["\']', py)
        self.assertIsNotNone(m, "profile.py 里找不到 DOMAIN_RE")
        self.assertIn("24", py, "profile.py 域名长度上限应为 24")
        self.assertIn("s.len() <= 24", self.rs, "Rust 侧域名长度上限应为 24")
        # 两侧都只允许小写字母/数字/连字符
        self.assertIn("c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'", self.rs)


class CapabilityOverviewTest(unittest.TestCase):
    """F3：能力总览三列 = 谁做的决定。列标题是判据的界面表达，不该被随手改名。"""

    def setUp(self):
        self.html = read(INDEX_HTML)
        self.js = read(SETTINGS_JS)

    def test_three_columns_exist(self):
        self.assertIn('id="cap-overview"', self.html)
        for label in ("你决定的", "它带的牌", "它记得的事"):
            self.assertIn(label, self.html, f"缺少栏目 {label}")

    def test_rows_jump_to_tabs(self):
        gotos = set(re.findall(r'data-goto="([a-z]+)"', self.html))
        self.assertTrue({"llm", "tools", "skills", "memory", "agent"} <= gotos,
                        f"总览缺跳转目标: {gotos}")

    def test_overview_reuses_cached_config(self):
        # 目录不该为显示值多发一次 /api/config
        self.assertIn("window.__cfgCache = c;", self.js)
        body = self.js[self.js.index("function renderOverview"):]
        body = body[: body.index("\n}\n")]
        self.assertNotIn("await api(", body, "renderOverview 不该发请求（取自缓存）")


class TrendContractTest(unittest.TestCase):
    """F4：趋势是切片不是快照——口径必须写在界面上，避免被当成历史存档。"""

    def setUp(self):
        self.js = read(BOARD_JS)

    def test_trend_function_and_buckets(self):
        self.assertIn("function verdictTrend(tasks, days)", self.js)
        self.assertIn("const days = 7;", self.js, "趋势窗口应为 7 天")

    def test_trend_honest_about_scope(self):
        # 文案必须说清「按最后更新分桶」，否则会被读成「某天有多少件」
        self.assertIn("按任务最后更新时间分桶", self.js)

    def test_trend_uses_existing_fields_only(self):
        # 不新增数据层：只读 updated_at / evaluation.ran_at
        body = self.js[self.js.index("function verdictTrend"):]
        body = body[: body.index("\n}\n")]
        self.assertIn("t.evaluation?.ran_at || t.updated_at", body)
        self.assertNotIn("localStorage", body, "趋势不该自己存快照")


class EnvLockContractTest(unittest.TestCase):
    """F4：改 env 的测试必须持锁——把跑法要求变成代码约束。"""

    def setUp(self):
        self.cfg = read("runtime/crates/host/src/config.rs")
        self.api_cfg = read("runtime/crates/host/src/web/api/config.rs")

    def test_env_lock_defined(self):
        self.assertIn("pub(crate) fn env_lock()", self.cfg)

    def test_all_env_mutating_tests_hold_the_lock(self):
        # 三条已知的 env 测试，各自必须取锁（新增同类测试也要照此）
        for name in ("config_agent_section_applies_to_env",
                     "config_media_section_applies_to_env"):
            body = self.cfg[self.cfg.index(f"fn {name}"):]
            body = body[: body.index("\n    }\n")]
            self.assertIn("env_lock()", body, f"{name} 未取 env_lock")
        body = self.api_cfg[self.api_cfg.index("fn agent_config_applies_to_env_and_validates_numbers"):]
        body = body[: body.index("\n    }\n")]
        self.assertIn("env_lock()", body, "api::config 的 env 测试未取 env_lock")


class PatchStructureTest(unittest.TestCase):
    """F 轮过程教训转成约束：尾部追加不能多条、被取代的补丁要留档。"""

    def test_single_tail_patch_per_file(self):
        # 同一文件的「末尾追加」类补丁若有多条，后一条会截断前一条的幂等判据
        pdir = ROOT / "scripts" / "patches"
        tails = []
        for jf in sorted(pdir.glob("*.json")):
            try:
                d = json.loads(jf.read_text(encoding="utf-8"))
            except Exception:
                continue
            desc = str(d.get("description", ""))
            if "末尾追加" in desc or "末尾一次性追加" in desc:
                tails.append((d["file"], jf.name))
        by_file: dict[str, list[str]] = {}
        for f, name in tails:
            by_file.setdefault(f, []).append(name)
        dup = {f: v for f, v in by_file.items() if len(v) > 1}
        self.assertEqual(dup, {}, f"同一文件有多条尾部追加补丁（会互相截断）: {dup}")

    def test_retired_patches_are_archived_not_deleted(self):
        # 退役 = 移到 retired/ 并留档；直接删会让「这条能力曾存在」的证据消失
        active = {json.loads(p.read_text(encoding="utf-8"))["id"]
                  for p in (ROOT / "scripts" / "patches").glob("*.json")
                  if p.suffix == ".json" and p.read_text(encoding="utf-8").strip().startswith("{")}
        retired_dir = ROOT / "scripts" / "patches" / "retired"
        retired = set()
        for p in retired_dir.glob("*.retired"):
            try:
                retired.add(json.loads(p.read_text(encoding="utf-8"))["id"])
            except Exception:
                continue
        overlap = active & retired
        self.assertEqual(overlap, set(), f"同一补丁既活跃又退役: {overlap}")


if __name__ == "__main__":
    unittest.main()
