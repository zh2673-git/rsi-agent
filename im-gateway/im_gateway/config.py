"""配置读取：环境变量优先，其次 config.local.json。凭据绝不写日志。"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_LOCAL = Path(__file__).resolve().parent.parent / "config.local.json"
# host config.json 路径：只从固定的 workspace 根 config.json 读取（不信任外部 env 覆盖，
# 防止把 secret 指向任意文件）。测试可在进程内替换本模块 _HOST。
_HOST = Path(__file__).resolve().parents[2] / "config.json"
_SECRET_SUFFIXES = ("client_secret", "token", "api_key", "password")


def _load_local() -> dict[str, Any]:
    if not _LOCAL.exists():
        return {}
    with _LOCAL.open("r", encoding="utf-8") as f:
        return json.load(f)


def _load_host_im() -> dict[str, Any]:
    """读取 host config.json 的 external_channels.im 段（面板保存的凭据来源）。"""
    if not _HOST.exists():
        return {}
    try:
        with _HOST.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    ec = data.get("external_channels")
    if not isinstance(ec, dict):
        return {}
    im = ec.get("im")
    return im if isinstance(im, dict) else {}


def _pick(env: str, sources: tuple[dict[str, Any], ...], key: str, default: str = "") -> str:
    """环境变量 > host config > local 配置 > 默认值。

    host config 的密码字段回显是 `{key_set,key_tail}` 对象而非明文；这里遇到
    对象形式（无真实值）时跳过，避免把掩码对象当成 secret 字符串。
    """
    v = os.environ.get(env)
    if v:
        return str(v)
    for src in sources:
        raw = src.get(key)
        if raw is None:
            continue
        if isinstance(raw, dict):
            continue  # 脱敏视图，不含真实值
        if isinstance(raw, bool):
            return "true" if raw else "false"
        s = str(raw)
        if s:
            return s
    return default


@dataclass
class GatewayConfig:
    host_base: str = "http://127.0.0.1:8710"
    # 平台开关：启用哪些 adapter
    enable_dingtalk: bool = False
    enable_qq: bool = False
    # 钉钉 Stream 凭据
    dingtalk_client_id: str = ""
    dingtalk_client_secret: str = ""
    # QQ 官方机器人凭据
    qq_appid: str = ""
    qq_token: str = ""
    # 白名单：允许触发的 user_id 集合（空 = 不限制；建议生产必须配置）
    allow_users: set[str] = field(default_factory=set)
    # 允许触发的群/会话标识（空 = 不限制）
    allow_chats: set[str] = field(default_factory=set)
    # 单条回复最大字符数
    max_reply_chars: int = 4000
    # agent 单轮最长等待秒数
    chat_timeout_secs: float = 300.0

    @classmethod
    def load(cls) -> "GatewayConfig":
        local = _load_local()
        host_im = _load_host_im()
        # 优先级：env > host config(external_channels.im) > local > default
        sources = (host_im, local)

        def _csv(env: str, key: str) -> set[str]:
            raw = _pick(env, sources, key, "")
            return {x.strip() for x in raw.split(",") if x.strip()}

        return cls(
            host_base=_pick("RSI_HOST_BASE", sources, "host_base", "http://127.0.0.1:8710"),
            enable_dingtalk=str(_pick("GW_ENABLE_DINGTALK", sources, "enable_dingtalk", "false")).lower() in ("1", "true", "yes"),
            enable_qq=str(_pick("GW_ENABLE_QQ", sources, "enable_qq", "false")).lower() in ("1", "true", "yes"),
            dingtalk_client_id=_pick("DINGTALK_CLIENT_ID", sources, "dingtalk_client_id"),
            dingtalk_client_secret=_pick("DINGTALK_CLIENT_SECRET", sources, "dingtalk_client_secret"),
            qq_appid=_pick("QQ_APPID", sources, "qq_appid"),
            qq_token=_pick("QQ_TOKEN", sources, "qq_token"),
            allow_users=_csv("GW_ALLOW_USERS", "allow_users"),
            allow_chats=_csv("GW_ALLOW_CHATS", "allow_chats"),
            max_reply_chars=int(_pick("GW_MAX_REPLY_CHARS", sources, "max_reply_chars", "4000")),
            chat_timeout_secs=float(_pick("GW_CHAT_TIMEOUT", sources, "chat_timeout_secs", "300")),
        )

    def redacted(self) -> dict[str, Any]:
        """日志/诊断用的脱敏视图：只显示是否配置，不显示值。"""
        return {
            "host_base": self.host_base,
            "enable_dingtalk": self.enable_dingtalk,
            "enable_qq": self.enable_qq,
            "dingtalk_cred_set": bool(self.dingtalk_client_id and self.dingtalk_client_secret),
            "qq_cred_set": bool(self.qq_appid and self.qq_token),
            "allow_users": len(self.allow_users),
            "allow_chats": len(self.allow_chats),
        }
