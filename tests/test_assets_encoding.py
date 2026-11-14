"""I-20261114-05：技能注册表的编码容错。

故障链（实测 2026-11-14）：
  `skills/project-dev/SKILL.md` 尾部混入 19 字节 GBK 脏数据
  → `assets_plugin._scan_skills` 的 `read_text(encoding="utf-8")` 抛 UnicodeDecodeError
    （**不是** OSError，旧代码只捕 OSError）
  → `skills.list` 整条 K500，Web「技能」页与 `GET /api/skills` 全部不可用
  → agent-loop `skills_appendix` 首行 `return String::new()`，把**看板纪律段**
    （以及 @引用说明 / 分解 / 并行 / 三档判据）一起吞掉
  → 用户唯一可见症状：新窗口的会话不把活登记进任务看板，且界面无任何报错。

本文件守两道边界：
  ① **数据**：仓库里每个 SKILL.md / prompt.md 都必须是合法 UTF-8（红住「脏字节进仓库」）；
  ② **降级**：单个技能编码坏 → 只跳过它，其余技能照常返回（红住「一个坏拖垮全部」）。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "runtime" / "plugins" / "assets"
SKILLS = ROOT / "skills"

sys.path.insert(0, str(ASSETS))

import assets_plugin  # noqa: E402

GOOD_SKILL = """---
name: {name}
description: {desc}
---

# {name}

body
"""


class RepoEncodingTest(unittest.TestCase):
    """① 数据侧：脏字节不该进仓库。"""

    def test_all_skill_md_are_utf8(self):
        bad = []
        for p in sorted(SKILLS.glob("*/SKILL.md")):
            try:
                p.read_bytes().decode("utf-8")
            except UnicodeDecodeError as e:
                bad.append(f"{p.relative_to(ROOT)} @byte {e.start}: {e.reason}")
        self.assertEqual(bad, [], f"SKILL.md 非 UTF-8（会让 skills.list 整条失败）: {bad}")

    def test_all_referenced_markdown_are_utf8(self):
        """references/ 下的 md 也会被 read_file / skills.load 读，一并守。"""
        bad = []
        for p in sorted(SKILLS.rglob("*.md")):
            if ".scratch" in p.parts or "outputs" in p.parts:
                continue
            try:
                p.read_bytes().decode("utf-8")
            except UnicodeDecodeError as e:
                bad.append(f"{p.relative_to(ROOT)} @byte {e.start}: {e.reason}")
        self.assertEqual(bad, [], f"技能目录内 md 非 UTF-8: {bad}")


class ScanResilienceTest(unittest.TestCase):
    """② 降级侧：坏一个技能不得让整表失败。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _mk(self, name: str, payload: bytes):
        d = self.root / name
        d.mkdir()
        (d / "SKILL.md").write_bytes(payload)

    def test_scan_skips_non_utf8_skill(self):
        """一个技能尾部落了 GBK 字节 → 只少它，其余照常。"""
        good = GOOD_SKILL.format(name="good-one", desc="ok").encode("utf-8")
        self._mk("good-one", good)
        # 复刻真实损坏形态：正常 UTF-8 正文 + 尾部 GBK 行
        broken = good + "不宣称完成。\n".encode("gbk")
        self._mk("broken-one", broken)

        catalog = assets_plugin._scan_skills(self.root)
        self.assertIn("good-one", catalog, "好技能必须仍在目录里")
        self.assertNotIn("broken-one", catalog, "坏编码技能应被跳过")

    def test_scan_returns_empty_not_raises_when_root_missing(self):
        self.assertEqual(assets_plugin._scan_skills(self.root / "nope"), {})

    def test_scan_prompts_skips_non_utf8_prompt(self):
        self._mk("good-one", GOOD_SKILL.format(name="good-one", desc="ok").encode("utf-8"))
        (self.root / "p-good.md").write_text("# good\n描述\n", encoding="utf-8")
        (self.root / "p-bad.md").write_bytes(b"# bad\n" + "坏".encode("gbk"))

        prompts = assets_plugin._scan_prompts(self.root)
        self.assertIn("good", prompts)
        self.assertNotIn("bad", prompts, "坏编码 prompt 应被跳过而不是整表失败")


class SkillsListOpTest(unittest.TestCase):
    """端到端（插件内）：on_event skills.list 遇坏编码仍返回 ok。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = Path(self.tmp.name) / "data"
        self.data.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_skills_list_ok_with_one_broken_skill(self):
        d = self.data / "good"
        d.mkdir()
        (d / "SKILL.md").write_text(
            GOOD_SKILL.format(name="good", desc="ok"), encoding="utf-8")
        b = self.data / "broken"
        b.mkdir()
        (b / "SKILL.md").write_bytes(
            GOOD_SKILL.format(name="broken", desc="bad").encode("utf-8")
            + "不宣称完成。\n".encode("gbk"))

        plugin = assets_plugin.AssetsPlugin()
        plugin.init({"skills_dir": str(self.data)})
        plugin._skills_root = self.data          # init 读 env，这里直接钉住
        plugin._prompts_root = self.data

        resp = plugin.on_event({"payload": {"op": "skills.list"}})
        self.assertTrue(resp.get("ok"), f"skills.list 不得因单个技能坏而失败: {resp}")
        names = [s["name"] for s in resp["skills"]]
        self.assertEqual(names, ["good"])


if __name__ == "__main__":
    unittest.main()
