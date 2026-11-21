"""网关监管入口：保存配置后自动拉起/重载/停止各平台网关。

用法（仓库根目录）：
    python im-gateway/supervise.py start     # 静默启动监管（幂等，已在跑则跳过）
    python im-gateway/supervise.py stop      # 请求监管优雅退出，连带停止各平台网关
    python im-gateway/supervise.py status    # 查看监管与各平台网关状态
    python im-gateway/supervise.py           # 前台常驻（等同 start 但不分离）
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from im_gateway.supervisor import (  # noqa: E402
    _LOG, _PIDFILE, _STATUS, _STOP,
    supervise, _pid_alive,
)

if os.name == "nt":
    _FLAGS = 0x00000008 | 0x00000200 | 0x08000000   # DETACHED | NEW_GROUP | NO_WINDOW
else:
    _FLAGS = 0


def _running_pid() -> int | None:
    try:
        pid = int(_PIDFILE.read_text(encoding="utf-8").strip())
        return pid if _pid_alive(pid) else None
    except (OSError, ValueError):
        return None


def start_detached() -> None:
    if _running_pid() is not None:
        print("[sup] already running (pid %d)" % _running_pid())
        return
    _STOP.unlink(missing_ok=True)
    fh = _LOG.open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            [sys.executable, str(HERE / "supervise.py"), "run"],
            cwd=str(HERE), creationflags=_FLAGS,
            stdout=fh, stderr=subprocess.STDOUT,
        )
    finally:
        fh.close()
    print("[sup] started")


def stop_supervisor() -> None:
    pid = _running_pid()
    if pid is None:
        print("[sup] not running")
        return
    try:
        _STOP.write_text("1", encoding="utf-8")
    except OSError as exc:
        print("[sup] stop request failed:", exc)
        return
    for _ in range(20):  # 最多等 10s
        if not _pid_alive(pid):
            print("[sup] stopped")
            return
        time.sleep(0.5)
    print("[sup] did not stop within 10s (pid %d)" % pid)


def show_status() -> None:
    pid = _running_pid()
    print("[sup] supervisor:", "running pid %d" % pid if pid else "not running")
    try:
        print(_STATUS.read_text(encoding="utf-8"))
    except OSError:
        print("{}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "start":
        start_detached()
    elif cmd == "stop":
        stop_supervisor()
    elif cmd == "status":
        show_status()
    elif cmd == "run":
        try:
            asyncio.run(supervise())
        except KeyboardInterrupt:
            pass
    else:
        print("usage: supervise.py [start|stop|status|run]")
        sys.exit(2)


if __name__ == "__main__":
    main()
