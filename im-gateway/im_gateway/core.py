"""核心编排：Envelope → 白名单/幂等 → host 调用 → 回复文本。"""
from __future__ import annotations

from typing import Awaitable, Callable

from .config import GatewayConfig
from .envelope import Envelope
from .host_client import HostClient
from .session import SessionManager, safe_session_key
from .session_meta import record as record_session_meta

# 回复回调：platform chat_id, 回复文本
ReplyFn = Callable[[str, str], Awaitable[None]]


class GatewayCore:
    def __init__(self, config: GatewayConfig, host: HostClient | None = None) -> None:
        self.config = config
        self.host = host or HostClient(config.host_base, config.chat_timeout_secs)
        self.sessions = SessionManager()

    def allowed(self, env: Envelope) -> bool:
        """白名单校验：配置了才限制；聊天/用户任一白名单命中即可放行。"""
        if self.config.allow_users and env.user_id not in self.config.allow_users:
            return False
        if self.config.allow_chats and env.chat_id not in self.config.allow_chats:
            return False
        return True

    def _clip(self, text: str) -> str:
        limit = self.config.max_reply_chars
        if len(text) <= limit:
            return text
        return text[: limit - 24] + "\n…（回复过长已截断）"

    async def handle(self, env: Envelope, reply: ReplyFn) -> None:
        """处理一条入站消息，回复通过 reply(chat_id, text) 发回平台。"""
        if not env.text.strip():
            return
        if not self.allowed(env):
            return
        if self.sessions.is_duplicate(env):
            return

        key = safe_session_key(env.platform, env.chat_id, env.user_id)
        chat_id = env.chat_id
        # 记录会话可读元数据供电脑端侧栏展示；失败不影响消息处理主流程。
        try:
            record_session_meta(env)
        except Exception:  # noqa: BLE001 展示增强，永不阻塞入站
            pass

        async def task() -> str:
            try:
                answer = await self.host.chat(key, env.text)
                text = self._clip(answer) if answer else "（agent 未返回文本）"
            except Exception as exc:  # noqa: BLE001 网关层兜底，不泄漏堆栈/凭据
                text = f"抱歉，处理失败：{type(exc).__name__}"
            await reply(chat_id, text)
            return text

        await self.sessions.run(key, task)
