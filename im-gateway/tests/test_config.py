from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from im_gateway import config as cfg_mod  # noqa: E402


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """把 host/local 配置重定向到临时文件，并清空相关环境变量。"""
    host = tmp_path / "config.json"
    local = tmp_path / "config.local.json"
    monkeypatch.setattr(cfg_mod, "_HOST", host)
    monkeypatch.setattr(cfg_mod, "_LOCAL", local)
    for k in ("RSI_HOST_CONFIG", "RSI_HOST_BASE", "GW_ENABLE_DINGTALK", "GW_ENABLE_QQ",
              "DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "QQ_APPID", "QQ_TOKEN",
              "GW_ALLOW_USERS", "GW_ALLOW_CHATS", "GW_MAX_REPLY_CHARS", "GW_CHAT_TIMEOUT"):
        monkeypatch.delenv(k, raising=False)
    return host, local


def _write(path: Path, data: dict):
    path.write_text(json.dumps(data), encoding="utf-8")


def test_precedence_env_host_local_default(isolated):
    host, local = isolated
    _write(host, {"external_channels": {"im": {
        "enable_dingtalk": True,
        "dingtalk_client_id": "from-host-id",
        "dingtalk_client_secret": "host-secret",
        "host_base": "http://host:8710",
        "max_reply_chars": 2000,
    }}})
    _write(local, {
        "dingtalk_client_id": "from-local-id",
        "dingtalk_client_secret": "local-secret",
        "host_base": "http://local:8710",
        "enable_qq": True,
        "max_reply_chars": 3000,
    })

    c = cfg_mod.GatewayConfig.load()
    assert c.host_base == "http://host:8710"           # host > local
    assert c.dingtalk_client_id == "from-host-id"       # host > local
    assert c.dingtalk_client_secret == "host-secret"    # host > local
    assert c.enable_dingtalk is True                    # host bool
    assert c.enable_qq is True                          # local only
    assert c.max_reply_chars == 2000                    # host > local

    os.environ["DINGTALK_CLIENT_ID"] = "from-env-id"
    os.environ["RSI_HOST_BASE"] = "http://env:8710"
    c2 = cfg_mod.GatewayConfig.load()
    assert c2.dingtalk_client_id == "from-env-id"       # env > host
    assert c2.host_base == "http://env:8710"            # env > host
    assert c2.dingtalk_client_secret == "host-secret"   # host fallback


def test_masked_secret_not_used(isolated):
    host, _ = isolated
    _write(host, {"external_channels": {"im": {
        "dingtalk_client_secret": {"key_set": True, "key_tail": "abcd"},
        "qq_token": {"key_set": False},
    }}})
    c = cfg_mod.GatewayConfig.load()
    assert c.dingtalk_client_secret == ""  # 掩码对象不能当明文
    assert c.qq_token == ""


def test_missing_and_bad_host_config(isolated):
    host, local = isolated
    _write(local, {"host_base": "http://local-only:8710"})
    c = cfg_mod.GatewayConfig.load()
    assert c.host_base == "http://local-only:8710"
    host.write_text("{bad json", encoding="utf-8")
    c2 = cfg_mod.GatewayConfig.load()
    assert c2.host_base == "http://local-only:8710"
