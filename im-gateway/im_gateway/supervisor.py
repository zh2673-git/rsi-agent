"""配置驱动的网关监管进程。

职责：监视 config.json（经 GatewayConfig.load 读取），按 external_channels.im 的
启用开关与凭据，自动拉起 / 重载 / 停止各平台的网关子进程。保存设置面板即触发重连，
无需手动敲命令。agent core 零改动：监管进程与网关均在 im-gateway/ 内。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .config import GatewayConfig

_HERE = Path(__file__).resolve().parent.parent   # im-gateway/
_RUN = _HERE / "run.py"
_LOG = _HERE / "gateway.log"
_STATUS = _HERE / "gateway-status.json"
_PIDFILE = _HERE / ".supervisor.pid"
_STOP = _HERE / ".stop-request"
_POLL_SECS = 2.0
_RESTART_SECS = 30.0

if os.name == "nt":
    _FLAGS = 0x00000008 | 0x00000200 | 0x08000000   # DETACHED | NEW_GROUP | NO_WINDOW
else:
    _FLAGS = 0


def _log(msg: str) -> None:
    line = time.strftime("[%H:%M:%S] ") + msg + "\n"
    try:
        with _LOG.open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    print("[sup] " + msg, flush=True)


def _sig(cfg: GatewayConfig, platform: str) -> str:
    """相关配置指纹（含密钥，仅内部比较，不写日志）。"""
    common = [cfg.host_base, str(cfg.max_reply_chars), str(cfg.chat_timeout_secs),
              ",".join(sorted(cfg.allow_users)), ",".join(sorted(cfg.allow_chats))]
    if platform == "qq":
        raw = "|".join([cfg.qq_appid, cfg.qq_token] + common)
    else:
        raw = "|".join([cfg.dingtalk_client_id, cfg.dingtalk_client_secret] + common)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def desired_platforms(cfg: GatewayConfig) -> dict[str, str]:
    """当前应运行的平台 -> 配置指纹。仅启用且凭据齐全才纳入。"""
    out: dict[str, str] = {}
    if cfg.enable_qq and cfg.qq_appid and cfg.qq_token:
        out["qq"] = _sig(cfg, "qq")
    if cfg.enable_dingtalk and cfg.dingtalk_client_id and cfg.dingtalk_client_secret:
        out["dingtalk"] = _sig(cfg, "dingtalk")
    return out


class Supervisor:
    """按配置对账子进程。spawner 可注入以便测试。"""

    def __init__(self, spawner=None, poll_secs: float = _POLL_SECS) -> None:
        self._spawn = spawner or self._default_spawn
        self.poll_secs = poll_secs
        self.children: dict[str, dict] = {}

    def _default_spawn(self, platform: str):
        fh = _LOG.open("a", encoding="utf-8")
        try:
            return subprocess.Popen(
                [sys.executable, str(_RUN), "--platform", platform],
                cwd=str(_HERE), creationflags=_FLAGS,
                stdout=fh, stderr=subprocess.STDOUT,
            )
        finally:
            fh.close()

    def _stop(self, platform: str) -> None:
        entry = self.children.pop(platform, None)
        if not entry:
            return
        proc = entry["proc"]
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                proc.kill()

    def _start(self, platform: str, sig: str) -> None:
        proc = self._spawn(platform)
        self.children[platform] = {"proc": proc, "sig": sig, "started": time.monotonic()}
        _log(f"启动 {platform} 网关（配置 {sig}）")

    def reconcile(self, cfg: GatewayConfig) -> None:
        desired = desired_platforms(cfg)
        for platform in list(self.children):
            entry = self.children[platform]
            proc = entry["proc"]
            if platform not in desired:
                self._stop(platform)
                _log(f"停止 {platform}（已关闭或凭据清空）")
                continue
            if entry["sig"] != desired[platform]:
                self._stop(platform)
                self._start(platform, desired[platform])
                _log(f"重载 {platform}（配置变化）")
                continue
            if proc.poll() is not None and time.monotonic() - entry["started"] >= _RESTART_SECS:
                code = proc.returncode
                self._stop(platform)
                self._start(platform, desired[platform])
                _log(f"重连 {platform}（上次退出 code={code}）")
        for platform, sig in desired.items():
            if platform not in self.children:
                self._start(platform, sig)
        self._write_status(desired)

    def _write_status(self, desired: dict[str, str]) -> None:
        status = {}
        for platform, entry in self.children.items():
            proc = entry["proc"]
            status[platform] = {
                "desired_sig": desired.get(platform),
                "running": proc.poll() is None,
                "pid": getattr(proc, "pid", None),
                "returncode": proc.returncode,
            }
        try:
            _STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def stop_all(self) -> None:
        for platform in list(self.children):
            self._stop(platform)


def _pid_alive(pid: int) -> bool:
    try:
        if os.name == "nt":
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid
            )
            if not handle:
                return False
            code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(handle)
            return bool(ok) and code.value == 259  # STILL_ACTIVE
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def _claim_single_instance() -> bool:
    """pidfile 单实例：已有一个存活监管在跑则返回 False。"""
    try:
        if _PIDFILE.exists():
            old = int(_PIDFILE.read_text(encoding="utf-8").strip())
            if _pid_alive(old):
                return False
    except (OSError, ValueError):
        pass
    try:
        _PIDFILE.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass
    return True


async def supervise(poll_secs: float = _POLL_SECS) -> None:
    if not _claim_single_instance():
        _log("已有监管进程在运行，退出")
        return
    sup = Supervisor(poll_secs=poll_secs)
    _log(f"网关监管启动（轮询 {poll_secs}s）")
    try:
        while True:
            if _STOP.exists():
                try:
                    _STOP.unlink()
                except OSError:
                    pass
                break
            try:
                sup.reconcile(GatewayConfig.load())
            except Exception as exc:  # noqa: BLE001
                _log(f"配置读取失败：{type(exc).__name__}")
            await asyncio.sleep(poll_secs)
    finally:
        sup.stop_all()
        try:
            _PIDFILE.unlink(missing_ok=True)
        except OSError:
            pass
        _log("网关监管停止")
