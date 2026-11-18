"""git-ops 只读查询契约（反探针铁律的机器化）。

背景（实测）：一次 tag+release 的会话里 151 次工具调用，其中 52 次是
`python -c "subprocess.run(['git',...])"` 包装——唯一理由是 git 默认
`core.quotepath=true` 会把中文文件名转义成 `\\350\\275\\254`，模型读不出。
包装层于是成了固定税，且每次只查一个视角（status 一次、diff 一次、log 一次）。

本测试锁三件事：

  1. 每个 COMMANDS 项都必须带 `-c core.quotepath=false`（漏一个就退回八进制地狱）；
  2. `state` 真的一次拿全四个视角（status/diff_stat/log/ahead），且中文路径原样输出；
  3. 白名单里没有任何写操作（commit / push / add / tag / reset …），
     写操作必须留在 bash 里人工可见 —— 这是「只读工具」的边界。

断言用临时 git 仓库，不碰真实工作区状态（真实仓库的 dirty 清单每天都在变）。
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills" / "git-ops"
sys.path.insert(0, str(SKILL))

import repo_query  # noqa: E402

GIT_AVAILABLE = shutil.which("git") is not None

# 只读语义：子命令动词必须在白名单里，且不得出现写操作实参。
# `git tag`（无参数）是列举、`git tag <name>` 是创建——同一个动词两种语义，
# 所以动词之外还要验实参个数，否则 `tags` 子命令会把写通道带进来。
READ_VERBS = {"status", "diff", "log", "branch", "remote", "tag", "rev-parse", "show"}
WRITE_VERBS = {"add", "commit", "push", "reset", "checkout", "merge", "rebase",
               "rm", "mv", "stash", "clone", "fetch", "pull", "clean", "restore"}


class QuotepathPrefixTest(unittest.TestCase):
    """每一条命令都关掉路径转义——单点遗漏会让那一条子命令退回八进制输出。"""

    def test_every_command_disables_quotepath(self) -> None:
        for sub, argv in repo_query.COMMANDS.items():
            self.assertEqual(
                argv[:3], ["git", "-c", "core.quotepath=false"],
                f"子命令 {sub} 未关闭 core.quotepath，中文路径会被转义: {argv}",
            )

    def test_git_prefix_is_shared_constant(self) -> None:
        """GIT 前缀是唯一来源：子命令里不得各自手写 'git'。"""
        for sub, argv in repo_query.COMMANDS.items():
            self.assertEqual(argv[: len(repo_query.GIT)], repo_query.GIT,
                             f"{sub} 没有复用 GIT 前缀（手写 'git' 会漏掉 -c 参数）")


class ReadOnlyBoundaryTest(unittest.TestCase):
    """写操作永不出现在白名单里：这是工具的定位，也是审计面。"""

    def _verb(self, argv: list[str]) -> tuple[str, list[str]]:
        """跳过 GIT 前缀（含 -c key=value 对）后取动词与其后实参。"""
        i = len(repo_query.GIT)
        return argv[i], argv[i + 1:]

    def test_no_write_verbs(self) -> None:
        for sub, argv in repo_query.COMMANDS.items():
            verb, rest = self._verb(argv)
            self.assertNotIn(verb, WRITE_VERBS,
                             f"子命令 {sub} 用了写动词 {verb}，只读工具不得有写通道")
            self.assertIn(verb, READ_VERBS, f"子命令 {sub} 的动词 {verb} 不在只读白名单里")
            stray = [a for a in rest if a in WRITE_VERBS]
            self.assertEqual(stray, [], f"子命令 {sub} 的实参里含写操作 {stray}")

    def test_tag_sub_never_creates_a_tag(self) -> None:
        """`git tag` 不带参数才是列举；一旦带上名字就是创建——形状必须钉死。"""
        verb, rest = self._verb(repo_query.COMMANDS["tags"])
        self.assertEqual(verb, "tag")
        # 只允许 --sort=... 这类选项，不允许任何位置实参（= 要创建的 tag 名）
        positionals = [a for a in rest if not a.startswith("-")]
        self.assertEqual(positionals, [], f"tags 子命令带了位置实参，会创建 tag: {positionals}")

    def test_unknown_sub_reports_error(self) -> None:
        """未知子命令必须报错带可选列表，而不是静默跑 status。"""
        with self.assertRaises(ValueError) as ctx:
            repo_query.query("nope")
        self.assertIn("nope", str(ctx.exception))


@unittest.skipUnless(GIT_AVAILABLE, "本机无 git，跳过端到端断言")
class EndToEndTest(unittest.TestCase):
    """在临时仓库里跑真 git：验证「中文路径原样 + state 四视角合一」。"""

    def setUp(self) -> None:
        self.td = tempfile.mkdtemp()
        self.root = Path(self.td)
        self._git("init", "-q")
        self._git("config", "user.email", "t@example.com")
        self._git("config", "user.name", "t")
        (self.root / "base.txt").write_text("a\n", encoding="utf-8")
        self._git("add", "base.txt")
        self._git("commit", "-q", "-m", "init")
        self._orig_root = repo_query.ROOT
        repo_query.ROOT = self.root

    def tearDown(self) -> None:
        repo_query.ROOT = self._orig_root
        shutil.rmtree(self.td, ignore_errors=True)

    def _git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=str(self.root), check=True,
                       capture_output=True, timeout=30)

    def test_state_returns_all_four_views(self) -> None:
        (self.root / "改动.txt").write_text("x\n", encoding="utf-8")
        out = repo_query.query("state")
        for key in ("branch_line", "dirty", "clean", "diff_stat", "log", "ahead", "upstream"):
            self.assertIn(key, out, f"state 缺视角 {key}：{json.dumps(out, ensure_ascii=False)}")
        self.assertFalse(out["clean"])
        self.assertIn("改动.txt", "\n".join(out["dirty"]),
                      f"state.dirty 未列出未跟踪文件: {out['dirty']}")

    def test_chinese_path_is_not_octal_escaped(self) -> None:
        """核心回归：转义串 `\\350\\275\\254` 不得出现，中文原名必须原样返回。"""
        (self.root / "改动.txt").write_text("x\n", encoding="utf-8")
        out = repo_query.query("status")
        joined = "\n".join(out["dirty"])
        self.assertIn("改动.txt", joined, f"中文路径被转义或丢失: {joined}")
        self.assertNotIn("\\35", joined, f"输出里出现八进制转义（quotepath 未生效）: {joined}")

    def test_ahead_lists_unpushed_commits(self) -> None:
        """无上游时 ahead 回空列表而不是抛错（gh/GitHub 首次推送前就是这个状态）。"""
        out = repo_query.query("ahead")
        self.assertEqual(out["output"], "", "无上游时 ahead 应为空")
        # 有上游时：造一个 bare remote 再验证能列出提交
        bare = self.root / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True,
                       capture_output=True, timeout=30)
        self._git("remote", "add", "origin", str(bare))
        self._git("push", "-q", "-u", "origin", "HEAD:refs/heads/main")
        (self.root / "second.txt").write_text("b\n", encoding="utf-8")
        self._git("add", "second.txt")
        self._git("commit", "-q", "-m", "second")
        out = repo_query.query("state")
        self.assertEqual(len(out["ahead"]), 1, f"应恰有 1 笔未推送提交: {out['ahead']}")
        self.assertIn("second", out["ahead"][0])

    def test_tags_sorted_version_desc(self) -> None:
        for v in ("v0.0.9", "v0.0.10", "v0.0.2"):
            self._git("tag", v)
        out = repo_query.query("tags")
        self.assertEqual(out["list"][:3], ["v0.0.10", "v0.0.9", "v0.0.2"],
                         f"tag 未按版本序倒排（字符串排序会把 v0.0.9 排到 v0.0.10 前面）: {out['list']}")


class CliProtocolTest(unittest.TestCase):
    """CLI 与工具执行器都必须回单个 JSON 对象（模型据此解析）。"""

    def test_cli_emits_json_with_ok(self) -> None:
        proc = subprocess.run([sys.executable, str(SKILL / "repo_query.py"), "tags"],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("sub"), "tags")

    def test_executor_reads_query_from_stdin(self) -> None:
        proc = subprocess.run([sys.executable, str(SKILL / "exec_query.py")],
                              input=json.dumps({"args": {"query": "tags"}}),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60, cwd=str(SKILL))
        payload = json.loads(proc.stdout)
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("sub"), "tags")

    def test_executor_defaults_to_state(self) -> None:
        """缺省子命令必须是 state（一次查全），不是 status——省掉一轮「再查 diff」。"""
        proc = subprocess.run([sys.executable, str(SKILL / "exec_query.py")],
                              input=json.dumps({"args": {}}),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60, cwd=str(SKILL))
        payload = json.loads(proc.stdout)
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("sub"), "state")

    def test_tools_json_declares_all_subs(self) -> None:
        """tools.json 的描述必须把全部子命令报给模型，否则模型会用「猜的」名字。"""
        spec = json.loads(io.open(SKILL / "tools.json", encoding="utf-8").read())
        self.assertEqual(len(spec), 1)
        desc = spec[0]["description"]
        for sub in repo_query.COMMANDS:
            self.assertIn(sub, desc, f"tools.json 未声明子命令 {sub}")


if __name__ == "__main__":
    unittest.main()
