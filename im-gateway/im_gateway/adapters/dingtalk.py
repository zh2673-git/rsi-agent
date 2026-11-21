"""钉钉 Stream 模式适配器：官方 SDK 长连接收消息 + reply_text 回复。"""
from __future__ import annotations

import asyncio

from ..config import GatewayConfig
from ..core import GatewayCore
from ..envelope import from_dingtalk


def build(cfg: GatewayConfig, core: GatewayCore) -> object:
    """构造并返回钉钉 Stream 客户端（未 start）。凭据缺失时抛 ValueError。"""
    import dingtalk_stream  # 延迟导入：无凭据也能 import 本模块
    from dingtalk_stream import AckMessage

    if not (cfg.dingtalk_client_id and cfg.dingtalk_client_secret):
        raise ValueError("钉钉凭据未配置：DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET")

    credential = dingtalk_stream.Credential(cfg.dingtalk_client_id, cfg.dingtalk_client_secret)
    client = dingtalk_stream.DingTalkStreamClient(credential)

    class Handler(dingtalk_stream.ChatbotHandler):
        async def process(self, callback: dingtalk_stream.CallbackMessage) -> None:
            incoming = dingtalk_stream.ChatbotMessage.from_dict(callback.data)
            text = (incoming.text.content or "").strip() if incoming.text else ""
            env = from_dingtalk(callback.data, getattr(incoming, "msg_id", "") or "", text)

            async def reply(chat_id: str, answer: str) -> None:
                # reply_text 是同步方法，放到线程池避免阻塞事件循环；签名 (text, incoming_message)
                await asyncio.to_thread(self.reply_text, answer, incoming_message)

            await core.handle(env, reply)
            return AckMessage.STATUS_OK, "OK"

    client.register_callback_handler(dingtalk_stream.chatbot.ChatbotMessage.TOPIC, Handler())
    return client


def run(cfg: GatewayConfig, core: GatewayCore) -> None:
    """阻塞运行钉钉 Stream 客户端（start_forever）。"""
    client = build(cfg, core)
    client.start_forever()
