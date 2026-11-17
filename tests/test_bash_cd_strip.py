"""P1-D：bash 前导 `cd` 剥离的回归（cwd 已是工作区根，前导 cd 是冗余）。

实测依据：今日 bash 调用 7711 次中 7196 次（93%）以 `cd` 开头——提示词与工具描述
都已明令禁止，靠模型服从不可靠，故在执行层静默剥掉。

契约：
- 剥前导 cd（带引号 / 不带引号 / `/d` / `&&` / `&`），最多两层；
- **不动**命令中间的 cd（那是在切子目录，语义上确实需要）；
- 剥完为空时保持原样（不静默执行空命令）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

RSI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RSI_ROOT / "runtime" / "plugins" / "tools"))

import tools.bash as bash_mod  # noqa: E402


class StripLeadingCdTest(unittest.TestCase):
    def test_quoted_with_drive_and_and(self):
        self.assertEqual(bash_mod._strip_leading_cd('cd /d "D:\\repo" && cargo test'), "cargo test")

    def test_unquoted_path(self):
        self.assertEqual(bash_mod._strip_leading_cd("cd D:\\repo && cargo test"), "cargo test")

    def test_single_ampersand_separator(self):
        self.assertEqual(bash_mod._strip_leading_cd('cd "D:\\repo" & cargo test'), "cargo test")

    def test_two_levels(self):
        self.assertEqual(bash_mod._strip_leading_cd('cd /d "D:\\a" && cd /d "D:\\b" && ls'), "ls")

    def test_no_cd_untouched(self):
        self.assertEqual(bash_mod._strip_leading_cd("cargo test"), "cargo test")

    def test_middle_cd_untouched(self):
        cmd = "cargo test && cd sub && ls"
        self.assertEqual(bash_mod._strip_leading_cd(cmd), cmd)

    def test_only_cd_kept_safe(self):
        # 剥完为空 → 保持原样，不静默执行空命令
        raw = 'cd /d "D:\\repo"'
        self.assertEqual(bash_mod._strip_leading_cd(raw), raw)


if __name__ == "__main__":
    unittest.main()
