"""统一消息结构：把各平台的入站消息归一化为同一个 Envelope。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Envelope:
    platform: str          # "dingtalk" | "qq"
    msg_id: str            # 平台消息 id，用于幂等去重
    chat_id: str           # 会话/群标识
    user_id: str           # 发送者标识
    text: str              # 纯文本正文
    timestamp_ms: int = 0
    raw: dict[str, Any] = field(default_factory=dict)

    def session_key(self) -> str:
        """由 chat_id + user_id 派生的稳定会话键（在 session.py 里再转安全串）。"""
        return f"{self.chat_id}::{self.user_id}"


def from_dingtalk(data: dict[str, Any], msg_id: str, text: str) -> Envelope:
    """钉钉 ChatbotMessage 归一化。conversationId 定位会话，senderStaffId 定位用户。"""
    return Envelope(
        platform="dingtalk",
        msg_id=msg_id or str(data.get("msgId", "")),
        chat_id=str(data.get("conversationId", "") or data.get("conversation_id", "")),
        user_id=str(data.get("senderStaffId", "") or data.get("senderId", "")).strip(),
        text=text.strip(),
        timestamp_ms=int(data.get("createAt", 0) or 0),
        raw=data,
    )


def from_qq(message: Any) -> Envelope:
    """QQ botpy 消息归一化：频道用 channel_id/author.id，群用 group_openid/author.member_openid。

    botpy 消息对象是 __slots__ 而非 __dict__，故全部按属性读取。
    """
    author = getattr(message, "author", None)
    # 频道消息 author.id；群消息 author.member_openid
    user_id = str(
        getattr(author, "id", None)
        or getattr(author, "member_openid", None)
        or ""
    ).strip()
    # 频道消息 channel_id；群消息 group_openid
    chat_id = str(
        getattr(message, "channel_id", None)
        or getattr(message, "group_openid", None)
        or ""
    ).strip()
    return Envelope(
        platform="qq",
        msg_id=str(getattr(message, "id", "") or ""),
        chat_id=chat_id,
        user_id=user_id,
        text=str(getattr(message, "content", "") or "").strip(),
        raw={},
    )
