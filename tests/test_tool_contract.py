"""工具层契约用例（RSI 的 E2 证据来源：确定性、可回归、无外部依赖）。

覆盖本轮审计发现的 D1/D2/D3/D4 与「声明 vs 行为」防漂移：
- bash `_shell_cwd()`：扩展长度前缀归一、fail-closed、UNC 形态；
- files `_guard_write()`：核心写保护 v7 前缀闸（v6 布尔遗留不解禁、前缀放行、永不豁免压过授权）；
- run_tests：超时有上界 + 进程树回收、契约错误码、rsi-agent 形态探测为 unittest；
- 工具名口径：准入闸与运行时插件闸同口径（防三方漂移）；
- tools.json 声明与执行体常量一致（timeout_secs ↔ MAX_TIMEOUT）。

运行：python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

RSI_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = RSI_ROOT / "scripts"
PLUGIN_TOOLS = RSI_ROOT / "runtime" / "plugins" / "tools"
RUN_TESTS = RSI_ROOT / "skills" / "tdd" / "run_tests.py"

sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(PLUGIN_TOOLS))

import conformance_gate  # noqa: E402

import tools.bash as bash_mod  # noqa: E402
import tools.files as files_mod  # noqa: E402
from tools import ToolError  # noqa: E402

sys.path.insert(0, str(RUN_TESTS.parent))
import run_tests  # noqa: E402


class ShellCwdTest(unittest.TestCase):
    """D1：带扩展长度前缀的 WORKSPACE_ROOT 会让 cmd.exe 静默改在 C:/Windows 执行（exit=0）。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _with_ws(self, value: str):
        return patch.dict(os.environ, {"WORKSPACE_ROOT": value})

    def test_strips_extended_length_prefix(self) -> None:
        ext = "\\\\?\\" + str(self.root)
        with self._with_ws(ext):
            self.assertEqual(bash_mod._shell_cwd(), str(self.root))

    def test_strips_unc_extended_form(self) -> None:
        with patch.object(bash_mod.os.path, "isdir", return_value=True):
            with self._with_ws("\\\\?\\UNC\\srv\\share\\dir"):
                self.assertEqual(bash_mod._shell_cwd(), "\\\\srv\\share\\dir")

    def test_fail_closed_when_workspace_missing(self) -> None:
        with self._with_ws("\\\\?\\" + str(self.root / "nope")):
            with self.assertRaises(ToolError) as ctx:
                bash_mod._shell_cwd()
        self.assertEqual(ctx.exception.code, "BAD_WORKSPACE")

    def test_plain_workspace_unchanged(self) -> None:
        with self._with_ws(str(self.root)):
            self.assertEqual(bash_mod._shell_cwd(), str(self.root))


class CoreWriteGateTest(unittest.TestCase):
    """A：核心写保护 v7 前缀闸——语义锁（同步 react-agent 时，这些断言就是第 5 处适配的验收）。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._ws = patch.dict(os.environ, {"WORKSPACE_ROOT": str(self.root)})
        self._ws.start()
        self.addCleanup(self._ws.stop)
        self.addCleanup(self.tmp.cleanup)
        os.environ.pop("ALLOW_CORE_WRITE", None)
        self.addCleanup(os.environ.pop, "ALLOW_CORE_WRITE", None)

    def _guard(self, rel: str) -> None:
        files_mod._guard_write(self.root / rel, rel)

    def test_default_denies_core_fail_closed(self) -> None:
        with self.assertRaises(ToolError) as ctx:
            self._guard("runtime/crates/agent-loop/src/lib.rs")
        self.assertEqual(ctx.exception.code, "CORE_PROTECTED")

    def test_v6_boolean_one_no_longer_unlocks(self) -> None:
        """布尔 "1" 是 v6 遗留：不再等价全解禁，一律按未授权处理。"""
        with patch.dict(os.environ, {"ALLOW_CORE_WRITE": "1"}):
            with self.assertRaises(ToolError) as ctx:
                self._guard("runtime/plugins/tools/tools/bash.py")
        self.assertEqual(ctx.exception.code, "CORE_PROTECTED")

    def test_prefix_grant_allows_matched_tree_only(self) -> None:
        grant = patch.dict(os.environ, {"ALLOW_CORE_WRITE": "runtime/crates/agent-loop"})
        with grant:
            self._guard("runtime/crates/agent-loop/src/scratch.rs")
            with self.assertRaises(ToolError):
                self._guard("runtime/crates/host/src/config.rs")

    def test_never_allow_overrides_prefix_grant(self) -> None:
        """config.json / plugins/memory 永不豁免：即使被显式列入授权前缀也拒绝。"""
        grant = patch.dict(
            os.environ,
            {"ALLOW_CORE_WRITE": "config.json,plugins/memory,runtime/plugins/tools/tools"},
        )
        with grant:
            for rel in ("config.json", "plugins/memory/store.json"):
                with self.assertRaises(ToolError) as ctx:
                    self._guard(rel)
                self.assertIn("永不豁免", str(ctx.exception))
            self._guard("runtime/plugins/tools/tools/bash.py")

    def test_zero_and_empty_still_denies(self) -> None:
        for value in ("0", "", None):
            env = {} if value is None else {"ALLOW_CORE_WRITE": value}
            with patch.dict(os.environ, env, clear=False):
                os.environ.pop("ALLOW_CORE_WRITE", None)
                if value is not None:
                    os.environ["ALLOW_CORE_WRITE"] = value
                with self.assertRaises(ToolError):
                    self._guard("runtime/crates/host/src/main.rs")

    def test_skills_root_exempt_without_any_grant(self) -> None:
        """自扩展主通道（skills/）在零授权下依旧放行——闸收紧不伤合法途径。"""
        self._guard("skills/my-skill/SKILL.md")


class RunTestsContractTest(unittest.TestCase):
    """D2/D3：验证工具必须有上界、报真话、口径可审计。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _env(self):
        return patch.dict(os.environ, {"WORKSPACE_ROOT": str(self.root)})

    def _make_unittest_project(self) -> None:
        tests = self.root / "tests"
        tests.mkdir(parents=True, exist_ok=True)
        (tests / "test_sample.py").write_text(
            "import unittest\n\nclass S(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
            encoding="utf-8",
        )

    def test_no_workspace_is_refused(self) -> None:
        with patch.dict(os.environ, {"WORKSPACE_ROOT": ""}):
            out = run_tests.run({})
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["code"], "NO_WORKSPACE")

    def test_bad_profile_and_bad_extra(self) -> None:
        with self._env():
            self.assertEqual(run_tests.run({"profile": "maven"})["error"]["code"], "BAD_PROFILE")
            self.assertEqual(run_tests.run({"extra": ["x" * 201]})["error"]["code"], "BAD_EXTRA")
            self.assertEqual(run_tests.run({"timeout_secs": 0})["error"]["code"], "BAD_TIMEOUT")

    def test_no_profile_reported_not_guessed(self) -> None:
        with self._env():
            out = run_tests.run({})
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["code"], "NO_PROFILE")

    def test_unittest_profile_for_rsi_layout(self) -> None:
        """tests/ 有 test_*.py 且无 pytest 清单 → unittest discover（项目约定命令）。"""
        self._make_unittest_project()
        with self._env():
            out = run_tests.run({})
        self.assertTrue(out["ok"], out)
        res = out["result"]
        self.assertEqual(res["profile"], "unittest")
        self.assertEqual(res["cmd"][1:], ["-m", "unittest", "discover", "-s", "tests"])
        self.assertTrue(res["passed"], res)
        self.assertIn("rsi-agent", res["profile_reason"])

    def test_pytest_manifest_takes_precedence(self) -> None:
        self._make_unittest_project()
        (self.root / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
        with self._env():
            out = run_tests.run({})
        self.assertEqual(out["result"]["profile"], "pytest")

    def test_timeout_is_bounded_and_reported(self) -> None:
        """挂死套件必须在 timeout_secs 内返回，并如实报 timeout=true / passed=false。"""
        tests = self.root / "tests"
        tests.mkdir(parents=True, exist_ok=True)
        (tests / "test_hang.py").write_text(
            "import time, unittest\n\nclass H(unittest.TestCase):\n"
            "    def test_hang(self):\n        time.sleep(20)\n",
            encoding="utf-8",
        )
        t0 = time.perf_counter()
        with self._env():
            out = run_tests.run({"timeout_secs": 2})
        elapsed = time.perf_counter() - t0
        self.assertTrue(out["ok"], out)
        res = out["result"]
        self.assertTrue(res["timeout"])
        self.assertFalse(res["passed"])
        self.assertEqual(res["timeout_secs"], 2.0)
        self.assertLess(elapsed, 15, "超时未在上界内返回")

    def test_timeout_capped_by_max(self) -> None:
        self._make_unittest_project()
        with self._env():
            out = run_tests.run({"timeout_secs": 10_000})
        self.assertEqual(out["result"]["timeout_secs"], float(run_tests.MAX_TIMEOUT))


class ToolNameConformanceTest(unittest.TestCase):
    """D4：准入闸与运行时插件闸必须同口径，否则闸的权威性不成立。"""

    def _plugin_re(self) -> str:
        src = (PLUGIN_TOOLS / "tools_plugin.py").read_text(encoding="utf-8")
        m = re.search(r'_SKILL_TOOL_NAME_RE\s*=\s*re\.compile\(r"([^"]+)"\)', src)
        self.assertIsNotNone(m, "tools_plugin.py 里找不到 _SKILL_TOOL_NAME_RE")
        return m.group(1)

    def test_same_name_pattern_as_plugin(self) -> None:
        plugin = self._plugin_re()
        # 插件用 fullmatch，闸用 match：闸已用 ^...$ 锚定，二者等价
        self.assertEqual(conformance_gate.NAME_RE.pattern, "^" + plugin + "$")

    def test_gate_and_plugin_agree_on_samples(self) -> None:
        plugin = re.compile(self._plugin_re())
        samples = ["run_tests", "run-tests", "RunTests", "bad name", "9lives", "x" * 65]
        for s in samples:
            gate_ok = bool(conformance_gate.NAME_RE.match(s))
            plugin_ok = bool(plugin.fullmatch(s))
            self.assertEqual(gate_ok, plugin_ok, f"口径不一致: {s!r}")

    def test_reserved_names_rejected(self) -> None:
        self.assertIn("read_file", conformance_gate.RESERVED_NAMES)
        self.assertIn("load_skill", conformance_gate.RESERVED_NAMES)

    def test_tdd_tools_pass_gate(self) -> None:
        skill = RSI_ROOT / "skills" / "tdd"
        errors, warnings, count, _ = conformance_gate._static_checks(skill)
        self.assertEqual(errors, [], errors)
        self.assertEqual(count, 1)
        self.assertFalse([w for w in warnings if w["code"].startswith("E_")])


class DeclarationDriftTest(unittest.TestCase):
    """声明 vs 行为防漂移：tools.json 的 timeout_secs 必须等于执行体上界。"""

    def test_tools_json_timeout_matches_executor(self) -> None:
        decl = json.loads((RSI_ROOT / "skills" / "tdd" / "tools.json").read_text(encoding="utf-8"))
        self.assertEqual(len(decl), 1)
        declared = decl[0]["exec"]["timeout_secs"]
        self.assertEqual(declared, run_tests.MAX_TIMEOUT)
        self.assertEqual(declared, run_tests.DEFAULT_TIMEOUT)

    def test_tools_json_declares_new_params(self) -> None:
        decl = json.loads((RSI_ROOT / "skills" / "tdd" / "tools.json").read_text(encoding="utf-8"))
        props = decl[0]["parameters"]["properties"]
        self.assertIn("timeout_secs", props)
        self.assertIn("unittest", props["profile"]["enum"])

    def test_executor_runs_as_subprocess_protocol(self) -> None:
        """端到端：stdin {"args":{...}} → stdout 单行契约 JSON（命令通道协议不变）。"""
        proc = subprocess.run(
            [sys.executable, str(RUN_TESTS)],
            input=json.dumps({"args": {"profile": "maven"}}),
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=dict(os.environ, WORKSPACE_ROOT=str(RSI_ROOT)),
        )
        payload = json.loads(proc.stdout.strip())
        self.assertIn("ok", payload)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "BAD_PROFILE")


class ExternalPatchTest(unittest.TestCase):
    """v8 外挂补丁语义锁：scripts/patches/*.json 的加载、容错与执行语义。"""

    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "apply_tool_patches", SCRIPTS / "apply-tool-patches.py"
        )
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)

    def test_load_external_picks_up_json(self):
        """真实外挂文件被加载为合法补丁描述（v9：dict 形态，含 create 分支）。"""
        with patch.object(self.mod, "ROOT", RSI_ROOT):
            ext = self.mod._load_external()
        self.assertTrue(ext, "scripts/patches/ 下应有外挂补丁")
        for item in ext:
            self.assertTrue(str(item["id"]))
            self.assertTrue(str(item["desc"]))
            self.assertTrue(str(item["path"]))
            if item["create"]:
                self.assertTrue(item["content"], f"{item['id']} create 补丁必须有内容")
            else:
                self.assertTrue(str(item["anchor"]), f"{item['id']} 锚点不能为空")
                self.assertTrue(str(item["patch"]), f"{item['id']} 补丁体不能为空")

    def test_corrupt_external_skipped_not_fatal(self):
        """单个外挂 JSON 损坏 → 跳过并提示，不拖垮补丁流程。"""
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            fake_root = Path(td)
            (fake_root / "scripts" / "patches").mkdir(parents=True)
            (fake_root / "scripts" / "patches" / "bad.json").write_text("{oops", encoding="utf-8")
            with patch.object(self.mod, "ROOT", fake_root):
                self.assertEqual(self.mod._load_external(), [])
            # 内置清单不受影响（P5b/P4a/P4b 已退役：2026-11-03/04，计数 11→8）
            self.assertEqual(len(self.mod.PATCHES), 8)

    def test_external_create_patch_writes_new_file(self):
        """v9 create 补丁：整文件新建、幂等、--revert 只删「补丁创建且未被演进」的文件。"""
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            fake_root = Path(td)
            pdir = fake_root / "scripts" / "patches"
            (pdir / "blocks").mkdir(parents=True)
            (pdir / "blocks" / "new.txt").write_text("// created by patch\n", encoding="utf-8")
            (pdir / "c1.json").write_text(json.dumps({
                "id": "C1", "description": "新建模块", "file": "src/new_mod.rs",
                "create": True, "content_file": "blocks/new.txt",
            }), encoding="utf-8")
            target = fake_root / "src" / "new_mod.rs"
            with patch.object(self.mod, "ROOT", fake_root):
                self.assertEqual(self.mod.apply(dry=False), 0)
                self.assertEqual(target.read_text(encoding="utf-8"), "// created by patch\n")
                # 幂等：内容一致 → 跳过，不报错
                self.assertEqual(self.mod.apply(dry=False), 0)
                self.assertEqual(target.read_text(encoding="utf-8"), "// created by patch\n")
                # 用户演进后 revert：内容不一致 → 保留，不误删
                target.write_text("// created by patch\nextra();\n", encoding="utf-8")
                self.mod.revert()
                self.assertTrue(target.exists(), "被演进的新建文件不应被 revert 删除")
                target.write_text("// created by patch\n", encoding="utf-8")
                self.mod.revert()
                self.assertFalse(target.exists(), "未演进的补丁新建文件应被 revert 删除")

    def test_external_patch_applies_and_reverts(self):
        """外挂补丁走与内置一致的 apply/--revert 语义（锚点替换 + 备份还原）。"""
        import shutil
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            fake_root = Path(td)
            target = fake_root / "target.txt"
            anchor = "hello world"
            patch_text = "hello patched"
            target.write_text("say " + anchor + " now", encoding="utf-8")
            (fake_root / "scripts" / "patches").mkdir(parents=True)
            (fake_root / "scripts" / "patches" / "t1.json").write_text(json.dumps({
                "id": "T1", "description": "临时验证", "file": "target.txt",
                "anchor": anchor, "patch": patch_text,
            }), encoding="utf-8")
            with patch.object(self.mod, "ROOT", fake_root):
                rc_apply = self.mod.apply(dry=False)
                self.assertEqual(rc_apply, 0)
                self.assertIn(patch_text, target.read_text(encoding="utf-8"))
                # 幂等：再跑一遍不重复替换
                self.assertEqual(self.mod.apply(dry=False), 0)
                self.assertEqual(target.read_text(encoding="utf-8").count(patch_text), 1)
                # 回滚：--revert 还原到最初态
                self.assertEqual(self.mod.revert(), 0)
                self.assertEqual(target.read_text(encoding="utf-8"), "say hello world now")
                self.assertFalse((fake_root / "target.txt.patchbak").exists())
            shutil.rmtree(td, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
