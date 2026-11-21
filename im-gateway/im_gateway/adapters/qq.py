"""QQ 官方机器人适配器：botpy 频道/群 @ 消息触发。"""
from __future__ import annotations

from ..config import GatewayConfig
from ..core import GatewayCore
from ..envelope import from_qq


def build(cfg: GatewayConfig, core: GatewayCore) -> object:
    """构造并返回 botpy 客户端（未 run）。凭据缺失时抛 ValueError。

    M0 只处理频道/群 @ 消息：on_at_message_create。
    私信 on_direct_message_create 未纳入（见 README）。
    """
    import botpy  # 延迟导入：无凭据也能 import 本模块

    if not (cfg.qq_appid and cfg.qq_token):
        raise ValueError("QQ 凭据未配置：QQ_APPID / QQ_TOKEN")

    intents = botpy.Intents(public_guild_messages=True)

    class Client(botpy.Client):
        async def on_at_message_create(self, message: "botpy.message.Message") -> None:
            env = from_qq(message)

            async def reply(chat_id: str, answer: str) -> None:
                # 用 Channel ID 主动发消息；message.reply 依赖 message 对象，这里统一接口
                await self.api.post_message(channel_id=message.channel_id, content=answer)

            await core.handle(env, reply)

    return Client(intents=intents)


def run(cfg: GatewayConfig, core: GatewayCore) -> None:
    """阻塞运行 QQ 机器人（client.run）。"""
    client = build(cfg, core)
    client.run(appid=cfg.qq_appid, secret=cfg.qq_token)
