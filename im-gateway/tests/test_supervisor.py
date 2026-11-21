"""Supervisor.reconcile 行为测试：拉起/重载/停止/崩溃重连，全用假进程。"""
from __future__ import annotations

import time
from types import SimpleNamespace

from im_gateway.config import GatewayConfig
from im_gateway.supervisor import Supervisor


class FakeProc:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self._returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self._returncode

    @property
    def returncode(self):
        return self._returncode

    def terminate(self) -> None:
        self.terminated = True
        self._returncode = 0

    def kill(self) -> None:
        self.killed = True
        self._returncode = -9

    def wait(self, timeout=None) -> None:
        return None


def _qq_cfg(**kw) -> GatewayConfig:
    base = dict(enable_qq=True, qq_appid="appid", qq_token="token")
    base.update(kw)
    return GatewayConfig(**base)


def test_starts_enabled_platform_with_credentials():
    spawned = []
    sup = Supervisor(spawner=lambda p: spawned.append(p) or FakeProc(100 + len(spawned)))
    sup.reconcile(_qq_cfg())
    assert spawned == ["qq"]
    assert sup.children["qq"]["proc"].poll() is None


def test_does_not_start_without_credentials_or_when_disabled():
    spawned = []
    sup = Supervisor(spawner=lambda p: spawned.append(p) or FakeProc(1))
    sup.reconcile(GatewayConfig(enable_qq=True, qq_appid="appid", qq_token=""))
    sup.reconcile(GatewayConfig(enable_qq=False, qq_appid="appid", qq_token="token"))
    assert spawned == []


def test_reloads_on_credential_change():
    procs = []

    def spawn(p):
        pr = FakeProc(100 + len(procs))
        procs.append(pr)
        return pr

    sup = Supervisor(spawner=spawn)
    sup.reconcile(_qq_cfg(qq_token="token-A"))
    first = procs[0]
    sup.reconcile(_qq_cfg(qq_token="token-B"))
    assert first.terminated is True
    assert len(procs) == 2
    assert sup.children["qq"]["proc"] is procs[1]


def test_stops_when_disabled():
    procs = []
    sup = Supervisor(spawner=lambda p: procs.append(FakeProc(1)) or procs[-1])
    sup.reconcile(_qq_cfg())
    sup.reconcile(GatewayConfig(enable_qq=False))
    assert "qq" not in sup.children
    assert procs[0].terminated is True


def test_reconnects_after_stable_exit(monkeypatch):
    procs = []

    def spawn(p):
        pr = FakeProc(100 + len(procs))
        procs.append(pr)
        return pr

    sup = Supervisor(spawner=spawn)
    sup.reconcile(_qq_cfg())
    # 模拟子进程已退出，但刚启动不久：不应立即重连
    procs[0]._returncode = 1
    sup.reconcile(_qq_cfg())
    assert len(procs) == 1
    # 把启动时间推到 30s 前：应重连
    sup.children["qq"]["started"] = time.monotonic() - 31
    sup.reconcile(_qq_cfg())
    assert len(procs) == 2
