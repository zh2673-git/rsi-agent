"""QQ 官方机器人适配器：botpy 频道/群 @ 消息触发。"""
from __future__ import annotations

from ..config import GatewayConfig
from ..core import GatewayCore
from ..envelope import from_qq


def build(cfg: GatewayConfig, core: GatewayCore) -> object:
    """构造并返回 botpy 客户端（未 run）。凭据缺失时抛 ValueError。

    处理频道 @（on_at_message_create）与群 @（on_group_at_message_create）。
    私信 on_direct_message_create 未纳入（见 README）。
    """
    import botpy  # 延迟导入：无凭据也能 import 本模块

    if not (cfg.qq_appid and cfg.qq_token):
        raise ValueError("QQ 凭据未配置：QQ_APPID / QQ_TOKEN")

    # public_guild_messages：频道公域消息；public_messages：群/C2C 公域消息
    intents = botpy.Intents(public_guild_messages=True, public_messages=True)

    class Client(botpy.Client):
        async def on_at_message_create(self, message) -> None:
            env = from_qq(message)
            print(f"[qq] 频道@ msg={env.msg_id} chat={env.chat_id} user={env.user_id} text={env.text[:40]!r}", flush=True)

            async def reply(chat_id: str, answer: str) -> None:
                await self.api.post_message(channel_id=message.channel_id, content=answer)

            await core.handle(env, reply)

        async def on_group_at_message_create(self, message) -> None:
            env = from_qq(message)
            print(f"[qq] 群@ msg={env.msg_id} chat={env.chat_id} user={env.user_id} text={env.text[:40]!r}", flush=True)

            async def reply(chat_id: str, answer: str) -> None:
                # 群消息必须用 post_group_message + group_openid 回复
                await self.api.post_group_message(group_openid=message.group_openid, content=answer)

            await core.handle(env, reply)

        async def on_error(self, event_method: str, *args, **kwargs) -> None:
            # botpy 默认 on_error 吞异常；打印出来便于排障（不泄漏凭据）
            print(f"[qq] 事件处理异常 event={event_method} args={args!r}", flush=True)
            await super().on_error(event_method, *args, **kwargs)

    return Client(intents=intents)


def run(cfg: GatewayConfig, core: GatewayCore) -> None:
    """阻塞运行 QQ 机器人（client.run）。"""
    client = build(cfg, core)
    client.run(appid=cfg.qq_appid, secret=cfg.qq_token)
