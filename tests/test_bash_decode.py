"""N3 解码三态回归（独立于工具契约套件；python -m unittest discover -s tests -v 可收）。

用例锚定 `_decode_output` 的行为契约：
- 纯 ASCII / UTF-8 中文：原样解码（消除 GBK 乱码的主诉求）；
- 非法字节：`\\xNN` 转义保留（零信息丢失，模型可反推原始编码）；
- 混合流：合法 UTF-8 段正常解码、非法字节逐个转义；
- 旧 locale 路径回归：GBK 双字节落入 \\xNN（不假装解码成功）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

RSI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RSI_ROOT / "runtime" / "plugins" / "tools"))

import tools.bash as bash_mod  # noqa: E402


class DecodeOutputTest(unittest.TestCase):
    def test_ascii_passthrough(self):
        self.assertEqual(bash_mod._decode_output(b"hello world"), "hello world")

    def test_utf8_chinese(self):
        raw = "目录: D:\\test\n名称: 中文.txt".encode("utf-8")
        self.assertEqual(bash_mod._decode_output(raw), "目录: D:\\test\n名称: 中文.txt")

    def test_invalid_bytes_escaped(self):
        # \xff\xfe 是 BOM/非法 UTF-8 头，必须以 \xNN 转义出现，而不是 U+FFFD 或异常
        out = bash_mod._decode_output(b"ok\xff\xfeend")
        self.assertEqual(out, "ok\\xff\\xfeend")

    def test_truncated_tail_terminates(self):
        # 尾部不完整多字节序列：必须转义收敛而不是死循环（首版回归）
        self.assertEqual(bash_mod._decode_output(b"end\xe4\xb8"), "end\\xe4\\xb8")

    def test_mixed_stream(self):
        raw = b"prefix-" + "中文".encode("utf-8") + b"-\xc4\xe3-tail"
        out = bash_mod._decode_output(raw)
        self.assertIn("中文", out)          # 合法 UTF-8 段正常
        self.assertIn("\\xc4\\xe3", out)    # GBK 双字节原样转义可见

    def test_gbk_bytes_not_faked(self):
        # "你" 的 GBK 编码 \xc4\xe3 恰是合法 UTF-8 序列 U+0123（罕见重合，诚实边界）
        out = bash_mod._decode_output("你".encode("gbk"))
        self.assertNotEqual(out, "你")      # 不允许假装解出 GBK
        self.assertIsInstance(out, str)


if __name__ == "__main__":
    unittest.main()
