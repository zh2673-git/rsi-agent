# -*- coding: utf-8 -*-
"""run_tests —— tdd 技能配套工具：固定探测并运行工作区测试套件。

协议（tools 插件命令通道）：stdin 收 {"args":{...}}，stdout 回
{"ok":true,"result":...} | {"ok":false,"error":{"code","message"}}。

安全约束：
- 只运行固定探测出的测试命令（cargo test / python -m unittest / python -m pytest / npm test），
  不接受任意命令；extra 仅作为测试框架的附加 argv 拼接（list 形式不经 shell，无注入面）；
- 测试固定在 WORKSPACE_ROOT 运行（未设置时报错拒绝，不回落任意目录）；
- 有上界等待：timeout_secs（默认/上限 900）到点杀**进程树**并如实回 timeout=true
  （不留后台孤儿进程——时空闭环）。

探测口径（profile_reason 可审计）：
- cargo：有 Cargo.toml；
- pytest：有 pytest.ini / pyproject.toml / setup.py / setup.cfg；
- unittest：无 pytest 清单、但 tests/ 下有 test_*.py —— 与 rsi-agent 的约定命令
  `python -m unittest discover -s tests` 一致（避免 pytest 跨目录收集同名测试文件时假红）；
- npm：package.json 带 "test" 脚本。

判定：工具执行成功即 ok:true；测试是否通过看 result.passed（exit_code == 0 且未超时）。
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

TAIL = 8000            # stdout/stderr 尾部保留字符数（报错信息多在尾部）
DEFAULT_TIMEOUT = 900  # 与 skills/tdd/tools.json 的 exec.timeout_secs 对齐
MAX_TIMEOUT = 900
PROFILES = ("cargo", "pytest", "unittest", "npm")


def _resp(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _tail(s: str) -> str:
    return s[-TAIL:] if len(s) > TAIL else s


def _err(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def _has_pytest_manifest(ws: Path) -> bool:
    return any(
        (ws / name).is_file() for name in ("pytest.ini", "pyproject.toml", "setup.py", "setup.cfg")
    )


def _has_unittest_tests(ws: Path) -> bool:
    """tests/ 下存在 test_*.py（unittest discover 的约定布局）。"""
    tests_dir = ws / "tests"
    if not tests_dir.is_dir():
        return False
    try:
        return any(p.is_file() and p.name.startswith("test_") and p.suffix == ".py"
                   for p in tests_dir.iterdir())
    except OSError:
        return False


def _detect(ws: Path, profile: str | None) -> tuple[list[str], str, str] | None:
    """按 cargo > pytest > unittest > npm 探测；profile 指定时只看对应清单。

    返回 (cmd, profile, reason)；None = 未探测到。
    """
    want = [profile] if profile else list(PROFILES)
    for p in want:
        if p == "cargo" and (ws / "Cargo.toml").is_file():
            return ["cargo", "test"], p, "工作区有 Cargo.toml"
        if p == "pytest" and _has_pytest_manifest(ws):
            return [sys.executable, "-m", "pytest"], p, "工作区有 pytest 清单文件"
        if p == "unittest" and _has_unittest_tests(ws):
            return (
                [sys.executable, "-m", "unittest", "discover", "-s", "tests"],
                p,
                "tests/ 下有 test_*.py 且无 pytest 清单（rsi-agent 约定口径）",
            )
        if p == "npm" and (ws / "package.json").is_file():
            pkg = (ws / "package.json").read_text(encoding="utf-8", errors="replace")
            if '"test"' in pkg:
                return ["npm.cmd" if os.name == "nt" else "npm", "test"], p, 'package.json 含 "test" 脚本'
    return None


def _kill_tree(proc: subprocess.Popen) -> None:
    """杀进程树：Windows 用 taskkill /T（否则 pytest/cargo 孙进程会残留），其余平台用进程组。"""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=10,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        try:
            proc.kill()
        except OSError:
            pass


def run(args: dict) -> dict:
    """执行一次测试运行，返回契约 dict（纯函数：不做 stdin/stdout）。"""
    ws_raw = os.environ.get("WORKSPACE_ROOT", "").strip()
    if not ws_raw:
        return _err("NO_WORKSPACE", "WORKSPACE_ROOT 未设置，拒绝运行")
    ws = Path(ws_raw).resolve()

    profile = args.get("profile")
    if profile is not None and profile not in PROFILES:
        return _err("BAD_PROFILE", f"profile 只支持 {'/'.join(PROFILES)}，收到: {profile!r}")

    extra = args.get("extra") or []
    if not isinstance(extra, list) or not all(isinstance(x, str) for x in extra):
        return _err("BAD_EXTRA", "extra 必须是字符串数组")
    if len(extra) > 16 or any(len(x) > 200 for x in extra):
        return _err("BAD_EXTRA", "extra 最多 16 项且每项 ≤200 字符")

    timeout = args.get("timeout_secs", DEFAULT_TIMEOUT)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        return _err("BAD_TIMEOUT", "timeout_secs 必须是正数（秒）")
    timeout = min(float(timeout), float(MAX_TIMEOUT))

    found = _detect(ws, profile)
    if found is None:
        return _err(
            "NO_PROFILE",
            "未探测到测试命令（需 Cargo.toml / pytest 清单 / tests/test_*.py / package.json 带 test 脚本）",
        )
    cmd, prof, reason = found
    cmd = cmd + [x for x in extra if x.strip()]

    t0 = time.perf_counter()
    popen_kw: dict = {
        "cwd": str(ws),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if os.name != "nt":
        popen_kw["start_new_session"] = True  # 进程组，便于超时整组回收
    proc = subprocess.Popen(cmd, **popen_kw)
    try:
        out, err = proc.communicate(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            out, err = "", ""
        timed_out = True
    dt = time.perf_counter() - t0

    return {
        "ok": True,
        "result": {
            "profile": prof,
            "profile_reason": reason,
            "cmd": cmd,
            "exit_code": proc.returncode,
            "passed": (proc.returncode == 0) and not timed_out,
            "timeout": timed_out,
            "timeout_secs": timeout,
            "duration_secs": round(dt, 1),
            "stdout_tail": _tail(out or ""),
            "stderr_tail": _tail(err or ""),
        },
    }


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        args = req.get("args") or {}
        if not isinstance(args, dict):
            _resp(_err("BAD_ARGS", "args 必须是对象"))
            return 0
        _resp(run(args))
    except Exception as exc:  # noqa: BLE001 - 任何异常都按协议回错误而非崩溃
        _resp(_err("TOOL_ERROR", f"{type(exc).__name__}: {exc}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
