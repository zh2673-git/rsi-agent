"""E 轮契约测试：知识落层判据（I-06）+ 多域上下文（I-07）。

纪律（与前几轮同源）：测契约不测实现细节——断言字段/枚举/顺序/边界这些跨语言同源
的东西。两侧同源常量用「直读另一侧源码」的方式锁（C4 先例）。

本文件只覆盖 **profile v2 域层** 的 CLI 契约；注入侧（profile_ctx.rs）的渲染契约在
Rust 单测里（渲染与 I/O 分离，C 轮结论）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PY = ROOT / "scripts" / "profile.py"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def run_json(*args: str, ws: Path, env_extra: dict | None = None) -> tuple[int, dict]:
    env = dict(os.environ)
    env["WORKSPACE_ROOT"] = str(ws)
    for k in ("RSI_PROFILE_PATH", "RSI_PROFILE_DOMAIN", "MEMORY_DATA_DIR"):
        env.pop(k, None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(
        [sys.executable, str(PROFILE_PY), *args],
        capture_output=True, text=True, cwd=str(ws), env=env, timeout=120,
    )
    try:
        return p.returncode, json.loads(p.stdout)
    except ValueError:
        return p.returncode, {"raw": p.stdout, "err": p.stderr}


class WorkspaceCase(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._td = tempfile.TemporaryDirectory()
        self.ws = Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()

    def prof(self, *args, env_extra=None):
        return run_json(*args, ws=self.ws, env_extra=env_extra)

    def write(self, name: str, data) -> str:
        p = self.ws / name
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return str(p)

    def section(self, sid: str, body: str, kind: str = "user", domain: str | None = None):
        f = self.write(f"{sid}.json", {"id": sid, "kind": kind, "title": sid, "body": body})
        args = ["section-add", "--file", f]
        if domain is not None:
            args += ["--domain", domain]
        return self.prof(*args)

    def profile_file(self) -> dict:
        return json.loads((self.ws / ".rsi" / "profile.json").read_text(encoding="utf-8"))


class DomainLayerTest(WorkspaceCase):
    """I-20261107-07：上下文按「作用范围」分两级，而不是按用户角色切分。"""

    def test_v1_file_still_reads_as_global_only(self):
        """旧文件（v1，无 domains/current_domain）必须照读，不迁移、不丢条目。"""
        (self.ws / ".rsi").mkdir(parents=True, exist_ok=True)
        (self.ws / ".rsi" / "profile.json").write_text(json.dumps({
            "version": 1,
            "sections": [{"id": "lang", "kind": "user", "title": "语言", "body": "中文"}],
            "notes": [{"id": "N-1", "kind": "user", "text": "旧观察"}],
        }), encoding="utf-8")
        code, out = self.prof("show")
        self.assertEqual(code, 0, out)
        p = out["profile"]
        self.assertEqual(len(p["sections"]), 1, "v1 章节必须还在")
        self.assertEqual(p["notes"][0]["text"], "旧观察")
        self.assertEqual(p["current_domain"], "", "v1 文件按全局层读")
        self.assertEqual(p["domains"], {})
        # brief 也不能因为缺字段而报错
        code, out = self.prof("brief")
        self.assertEqual(code, 0, out)
        self.assertIn("中文", out["brief"])

    def test_use_creates_domain_and_is_sticky(self):
        code, out = self.prof("use", "work")
        self.assertEqual(code, 0, out)
        self.assertTrue(out["created"], "首次 use 应报 created")
        self.assertEqual(self.profile_file()["current_domain"], "work", "切域是粘性状态")
        # 再 use 同一域：不重复创建
        code, out = self.prof("use", "work")
        self.assertEqual(code, 0, out)
        self.assertFalse(out["created"])

    def test_use_none_returns_to_global(self):
        self.prof("use", "work")
        code, out = self.prof("use", "none")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["current"], "")
        self.assertEqual(self.profile_file()["current_domain"], "")

    def test_domain_name_shape_is_closed(self):
        # `-lead` 会被 argparse 当选项吞掉（exit 2），同样算拒绝——故只断言非零。
        for bad in ("Work", "生活", "-lead", "a" * 25, "has space"):
            code, out = self.prof("use", bad)
            self.assertNotEqual(code, 0, f"{bad!r} 应被拒")

    def test_sections_land_in_selected_layer(self):
        self.section("lang", "中文回答")
        code, out = self.section("tone", "工作域：正式书面", domain="work")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["domain"], "work")
        data = self.profile_file()
        self.assertEqual([s["id"] for s in data["sections"]], ["lang"], "全局层只有全局章节")
        self.assertEqual([s["id"] for s in data["domains"]["work"]["sections"]], ["tone"])

    def test_env_domain_overrides_sticky_choice(self):
        self.section("tone", "工作域", domain="work")
        self.prof("use", "work")
        code, out = self.prof("brief", env_extra={"RSI_PROFILE_DOMAIN": "life"})
        self.assertEqual(code, 0, out)
        self.assertEqual(out["domain"], "life", "环境变量优先于文件内粘性状态")

    def test_brief_marks_override_and_keeps_global(self):
        self.section("lang", "中文回答")
        self.section("tone", "全局：简短")
        self.prof("use", "work")
        self.section("tone", "域内：正式书面", domain="work")
        code, out = self.prof("brief")
        self.assertEqual(code, 0, out)
        text = out["brief"]
        self.assertIn("中文回答", text, "继承的全局章节仍在")
        self.assertIn("域内：正式书面", text)
        self.assertIn("--- domain:work ---", text, "域段要有分隔标题")
        self.assertIn("(overrides global)", text, "覆盖全局同 id 必须标注")

    def test_domain_rm_requires_force_when_not_empty(self):
        self.section("tone", "域内内容", domain="work")
        code, out = self.prof("domain-rm", "work")
        self.assertEqual(code, 1, "非空域默认不许删")
        self.assertEqual(out["error"]["code"], "NOT_EMPTY")
        code, out = self.prof("domain-rm", "work", "--force")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["dropped"], 1, "要回报丢了多少条")

    def test_domain_rm_resets_current_domain(self):
        self.prof("use", "work")
        code, out = self.prof("domain-rm", "work")
        self.assertEqual(code, 0, out)
        self.assertIn("note", out, "删掉当前域要说明已切回全局")
        self.assertEqual(self.profile_file()["current_domain"], "")

    def test_domain_limit_is_enforced(self):
        for i in range(8):
            code, out = self.prof("use", f"d{i}")
            self.assertEqual(code, 0, out)
        code, out = self.prof("use", "d8")
        self.assertEqual(code, 1, "域数量有上限")
        self.assertEqual(out["error"]["code"], "LIMIT")

    def test_domains_listing_reports_current(self):
        self.prof("use", "work")
        self.section("tone", "x", domain="life")
        code, out = self.prof("domains")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["current"], "work")
        names = {d["name"]: d for d in out["domains"]}
        self.assertEqual(set(names), {"work", "life"})
        self.assertTrue(names["work"]["current"])
        self.assertFalse(names["life"]["current"])

    def test_note_and_rm_are_layer_scoped(self):
        f = self.write("n.json", {"kind": "model", "text": "全局观察"})
        code, out = self.prof("note", "--file", f)
        self.assertEqual(code, 0, out)
        gid = out["id"]

        code, out = self.section("tone", "x", domain="work")
        self.assertEqual(code, 0, out)
        code, out = self.prof("note", "--file", f, "--domain", "work")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["domain"], "work")

        data = self.profile_file()
        self.assertEqual(len(data["notes"]), 1)
        self.assertEqual(len(data["domains"]["work"]["notes"]), 1)

        # 全局层的 note-rm 不该删掉域内的同名（这里用全局 id 验证作用域隔离）
        code, out = self.prof("note-rm", gid, "--domain", "work")
        self.assertEqual(code, 1, "域层里找不到全局 note id")
        self.assertEqual(out["error"]["code"], "NOT_FOUND")
        code, out = self.prof("note-rm", gid)
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.profile_file()["domains"]["work"]["notes"]), 1,
                         "删全局 note 不得波及域层")

    def test_corrupt_profile_blocks_domain_writes(self):
        (self.ws / ".rsi").mkdir(parents=True, exist_ok=True)
        bad = self.ws / ".rsi" / "profile.json"
        bad.write_text("{not json", encoding="utf-8")
        code, out = self.prof("use", "work")
        self.assertEqual(code, 1, "坏文件拒绝写入（不覆盖用户手改内容）")
        self.assertEqual(bad.read_text(encoding="utf-8"), "{not json")


class CrossLanguageContractTest(unittest.TestCase):
    """两侧同源常量单边改动即失败（C4 先例）。"""

    def test_domain_limits_match_rust(self):
        py = read("scripts/profile.py")
        rs = read("runtime/crates/agent-loop/src/profile_ctx.rs")
        self.assertIn("MAX_DOMAINS = 8", py)
        self.assertIn("MAX_DOMAIN = 24", py)
        self.assertIn("MAX_DOMAIN_BLOCK_CHARS", rs, "Rust 侧要有域块独立上限")
        self.assertIn("const MAX_DOMAIN_NAME: usize = 24;", rs, "域名上限两侧同源")

    def test_domain_keys_match_rust(self):
        """JSON 键名是跨语言契约：写错一边就静默失效。"""
        py = read("scripts/profile.py")
        rs = read("runtime/crates/agent-loop/src/profile_ctx.rs")
        for key in ("current_domain", "domains"):
            self.assertIn(f'"{key}"', py, f"profile.py 应读写 {key}")
            self.assertIn(f'"{key}"', rs, f"profile_ctx.rs 应读 {key}")
        self.assertIn("(overrides global)", rs, "覆盖标注文案在 Rust 侧")
        self.assertIn("(overrides global)", py, "覆盖标注文案两侧一致")

    def test_domain_env_var_same_both_sides(self):
        py = read("scripts/profile.py")
        rs = read("runtime/crates/agent-loop/src/profile_ctx.rs")
        self.assertIn("RSI_PROFILE_DOMAIN", py)
        self.assertIn("RSI_PROFILE_DOMAIN", rs)


class LayerDecisionDocTest(unittest.TestCase):
    """I-20261107-06：知识落层判据必须落成文档，否则下轮还会重问一遍。"""

    DOC = ROOT / "docs" / "self-evolution" / "04-知识落层与多域上下文.md"

    def test_doc_exists_with_decision_table(self):
        self.assertTrue(self.DOC.is_file(), "落层判据要落盘")
        text = self.DOC.read_text(encoding="utf-8")
        for channel in ("内置工具", "技能", "画像", "看板", "账本", "文档", "trace"):
            self.assertIn(channel, text, f"判据表应覆盖 {channel}")

    def test_doc_answers_the_three_questions(self):
        """.I-06 的三个具体问句都要有唯一答案（不能停在「看情况」）。"""
        text = self.DOC.read_text(encoding="utf-8")
        for q in ("记忆加载", "推送至github", "创建skill"):
            self.assertIn(q, text, f"要正面回答「{q}」该放哪层")

    def test_self_extension_path_is_documented(self):
        text = self.DOC.read_text(encoding="utf-8")
        self.assertIn("skills/", text)
        self.assertIn("tools.json", text)


if __name__ == "__main__":
    unittest.main()
