"""会话管理：安全 session key、幂等去重、每会话串行队列。"""
from __future__ import annotations

import asyncio
import hashlib
import re
import time
from typing import Awaitable, Callable

from .envelope import Envelope

_SAFE = re.compile(r"[^A-Za-z0-9_.-]")
_DedupValue = tuple[float, str]


def safe_session_key(platform: str, chat_id: str, user_id: str) -> str:
    """只保留安全字符；不稳定部分用 sha256 前 12 位。"""
    prefix = {"dingtalk": "dt", "qq": "qq"}.get(platform, platform[:2] or "im")
    digest = hashlib.sha256(f"{chat_id}::{user_id}".encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


class SessionManager:
    def __init__(self, dedup_ttl_secs: float = 300.0) -> None:
        self._dedup_ttl = dedup_ttl_secs
        self._seen: dict[str, _DedupValue] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_result: dict[str, str] = {}

    def is_duplicate(self, env: Envelope) -> bool:
        key = f"{env.platform}:{env.msg_id}"
        if not env.msg_id:
            return False
        now = time.monotonic()
        old = self._seen.get(key)
        if old and now - old[0] < self._dedup_ttl:
            return True
        # 过期则刷新为「刚处理完」的占位，等待 run() 写真实结果
        self._seen[key] = (now, "")
        return False

    def lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def run(self, key: str, task: Callable[[], Awaitable[str]]) -> str:
        """同一 session 串行执行；返回结果并写入 dedup 缓存以便快速重放。"""
        async with self.lock_for(key):
            result = await task()
        self._last_result[key] = result
        for k, (ts, _) in list(self._seen.items()):
            if k.endswith(key) or key in k:
                self._seen[k] = (ts, result)
        return result

    def last_result(self, key: str) -> str | None:
        return self._last_result.get(key)
