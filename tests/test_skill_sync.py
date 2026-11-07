"""技能部署副本一致性（scripts/sync_skills.py）自测。

背景：skills/<name>/ 是运行时加载的部署副本（SKILLS_DIR → 本仓 skills/），
部分技能另有兄弟源仓库。两者无同步机制时曾长期静默一致（纯属巧合），
源仓库一旦前进，部署副本就会无声落后。本测试锁定三件事：

  1. 当前仓库状态无漂移（守住现状）；
  2. 检查器在"内容被改""多出文件""缺少文件"三种情况下都能报 E_DRIFT；
  3. 比较对 CRLF/LF 与 BOM 不敏感（否则 Windows checkout 会永远漂移）。

断言用临时目录，不碰真实技能目录。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import sync_skills  # noqa: E402


def write(root: Path, rel: str, text: str, newline: str = "\n", bom: bool = False) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    data = text.replace("\n", newline).encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    p.write_bytes(data)
    return p


class NormalisationTest(unittest.TestCase):
    def test_crlf_and_bom_are_equivalent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            a = write(d / "a", "x.md", "alpha\nbeta\n")
            b = write(d / "b", "x.md", "alpha\nbeta\n", newline="\r\n", bom=True)
            self.assertEqual(sync_skills._norm(a), sync_skills._norm(b))

    def test_real_content_change_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            a = write(d / "a", "x.md", "alpha\n")
            b = write(d / "b", "x.md", "alpha changed\n")
            self.assertNotEqual(sync_skills._norm(a), sync_skills._norm(b))


class DiffTest(unittest.TestCase):
    def _pair(self, td: str) -> tuple[Path, Path]:
        d = Path(td)
        return d / "src", d / "dst"

    def test_identical_trees_pass(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            src, dst = self._pair(td)
            for root in (src, dst):
                write(root, "SKILL.md", "# s\n")
                write(root, "tools/x.json", "{}\n")
                write(root, "tools.json", "[]\n")
            r = sync_skills.diff_skill("t", src, dst)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["code"], "OK")
            self.assertEqual(r["files_src"], 3)

    def test_content_drift_detected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            src, dst = self._pair(td)
            write(src, "SKILL.md", "# new\n")
            write(dst, "SKILL.md", "# old\n")
            r = sync_skills.diff_skill("t", src, dst)
            self.assertFalse(r["ok"])
            self.assertEqual(r["code"], "E_DRIFT")
            self.assertIn("SKILL.md", r["content_differs"])

    def test_missing_in_deploy_detected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            src, dst = self._pair(td)
            write(src, "SKILL.md", "# s\n")
            write(src, "references/extra.md", "x\n")
            write(dst, "SKILL.md", "# s\n")
            r = sync_skills.diff_skill("t", src, dst)
            self.assertFalse(r["ok"])
            self.assertIn("references/extra.md", r["only_in_source"])

    def test_extra_in_deploy_detected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            src, dst = self._pair(td)
            write(src, "SKILL.md", "# s\n")
            write(dst, "SKILL.md", "# s\n")
            write(dst, "local_probe.txt", "x\n")
            r = sync_skills.diff_skill("t", src, dst)
            self.assertFalse(r["ok"])
            self.assertIn("local_probe.txt", r["only_in_dest"])

    def test_repo_assets_are_not_deployed(self) -> None:
        """docs/、LICENSE、README.md 属源仓库自用，不算漂移。"""
        with tempfile.TemporaryDirectory() as td:
            src, dst = self._pair(td)
            write(src, "SKILL.md", "# s\n")
            write(dst, "SKILL.md", "# s\n")
            write(src, "LICENSE", "MIT\n")
            write(src, "README.md", "repo readme\n")
            write(src, "docs/case/01.md", "case\n")
            r = sync_skills.diff_skill("t", src, dst)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["only_in_source"], [])

    def test_missing_source_reports_code(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            src, dst = self._pair(td)
            write(dst, "SKILL.md", "# s\n")
            r = sync_skills.diff_skill("t", src, dst)
            self.assertFalse(r["ok"])
            self.assertEqual(r["code"], "E_SOURCE_MISSING")


class SyncApplyTest(unittest.TestCase):
    def test_copies_changed_and_keeps_unrelated(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            src, dst = d / "src", d / "dst"
            write(src, "SKILL.md", "# canonical\n")
            write(src, "new/file.md", "fresh\n")
            write(dst, "SKILL.md", "# stale\n")
            write(dst, "keep.txt", "local\n")

            res = sync_skills.apply_sync("t", src, dst, prune=False)
            self.assertTrue(res["ok"])
            self.assertEqual(sorted(res["written"]), ["SKILL.md", "new/file.md"])
            # 未 --prune 时不删本地文件
            self.assertTrue((dst / "keep.txt").is_file())
            self.assertEqual((dst / "SKILL.md").read_text(encoding="utf-8"), "# canonical\n")

    def test_prune_removes_extras(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            src, dst = d / "src", d / "dst"
            write(src, "SKILL.md", "# s\n")
            write(dst, "SKILL.md", "# s\n")
            write(dst, "junk.txt", "x\n")

            res = sync_skills.apply_sync("t", src, dst, prune=True)
            self.assertIn("junk.txt", res["pruned"])
            self.assertFalse((dst / "junk.txt").exists())


class LiveRepoTest(unittest.TestCase):
    """守住当前仓库现状：已登记的源仓库不得漂移。"""

    def test_registered_skills_have_no_drift(self) -> None:
        missing = []
        for name, rel in sync_skills.SOURCE_MAP.items():
            src = (sync_skills.TOOL_ROOT / rel).resolve()
            dst = (sync_skills.SKILLS_DIR / name).resolve()
            if not src.is_dir():
                # 源仓库未 checkout（如单仓克隆）：跳过而非失败
                continue
            r = sync_skills.diff_skill(name, src, dst)
            if not r["ok"]:
                missing.append(r)
        self.assertEqual(missing, [], f"部署副本与源仓库漂移: {missing}")


if __name__ == "__main__":
    unittest.main()
