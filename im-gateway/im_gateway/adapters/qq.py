"""QQ 官方机器人适配器：botpy 频道/群 @ 消息触发。

回复支持可选图片：agent answer 中形如 ``[img:/path/to/a.png]`` 的标记会被
解析为富媒体消息（msg_type=7），经「图中转 URL → 上传 file_info → 富媒体」
链路发出；标记本身从文本中剥离。没有标记时行为与旧版完全一致（纯文本）。

图中转说明：QQ v2 富媒体上传接口只接受**公网 URL**（服务端下载），不接收本地
字节；本项目机器无法直连境外图床，实测 paste.rs 可用（POST 原始字节返回 URL）。
"""
from __future__ import annotations

import re
from pathlib import Path

from ..config import GatewayConfig
from ..core import GatewayCore
from ..envelope import from_qq

# [img:C:\path\a.png] / [img:/tmp/a.png]，路径内允许空格与中文，不含 ']'
_IMG_MARK = re.compile(r"\[img:([^\]]+)\]")
# 图中转服务：POST 原始字节 -> 文本响应含公网 URL
_IMAGE_HOST = "https://paste.rs"


def extract_images(text: str) -> tuple[str, list[str]]:
    """从文本中剥离 ``[img:路径]`` 标记，返回 (纯文本, 图片路径列表)。"""
    paths = [m.group(1).strip() for m in _IMG_MARK.finditer(text or "")]
    paths = [p for p in paths if p]
    clean = _IMG_MARK.sub("", text or "").strip()
    return clean, paths


def _upload_image_host(data: bytes) -> str:
    """把图片字节传到图中转服务，返回公网 URL。同步，调用方放 to_thread。"""
    import httpx
    resp = httpx.post(
        _IMAGE_HOST, content=data, timeout=60,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    resp.raise_for_status()
    url = resp.text.strip()
    if not url.startswith("http"):
        raise RuntimeError(f"图中转返回非 URL: {url[:80]}")
    return url


async def _upload_and_send_images(api, *, group_openid: str | None, channel_id: str | None,
                                  openid: str | None, paths: list[str], msg_id: str | None) -> None:
    """把本地图片以 QQ 富媒体消息发出。

    链路：本地图 -> 图中转 URL -> POST /v2/groups|users/{id}/files (file_type=1)
    -> file_info -> post_group_message/post_c2c_message (msg_type=7)。
    频道（channel_id）走 post_message 的 file_image 本地字节，无需中转。
    复用 botpy client 自身的 http session/鉴权（api.api._http / api.http）。
    """
    import asyncio

    sent = 0
    for raw in paths:
        p = Path(raw)
        if not p.is_file():
            print(f"[qq] 图片不存在，跳过: {raw}", flush=True)
            continue
        try:
            if group_openid or openid:
                url = await asyncio.to_thread(_upload_image_host, p.read_bytes())
                if group_openid:
                    media = await api.post_group_file(group_openid=group_openid, file_type=1, url=url)
                else:
                    media = await api.post_c2c_file(openid=openid, file_type=1, url=url)
                file_info = (media or {}).get("file_info") if isinstance(media, dict) else None
                if not file_info:
                    print(f"[qq] 上传图片未返回 file_info: {raw} -> {media!r}", flush=True)
                    continue
                kwargs = dict(msg_type=7, media={"file_info": file_info})
                if msg_id:
                    # 同一 msg_id 文本+多图需不同 msg_seq，否则官方判重复发送失败
                    kwargs.update(msg_id=msg_id, msg_seq=sent + 2)
                if group_openid:
                    await api.post_group_message(group_openid=group_openid, **kwargs)
                else:
                    await api.post_c2c_message(openid=openid, **kwargs)
            else:
                # 频道：post_message 支持 file_image 直接传本地字节
                await api.post_message(channel_id=channel_id, file_image=str(p))
            sent += 1
        except Exception as exc:  # noqa: BLE001 单张失败不影响其它图片
            print(f"[qq] 发图失败 {p.name}: {type(exc).__name__}: {exc}", flush=True)
    print(f"[qq] 富媒体发送完成: {sent}/{len(paths)}", flush=True)


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
                text, images = extract_images(answer)
                if images:
                    await _upload_and_send_images(
                        self.api, channel_id=message.channel_id, group_openid=None,
                        openid=None, paths=images, msg_id=message.id,
                    )
                await self.api.post_message(channel_id=message.channel_id, content=text)

            await core.handle(env, reply)

        async def on_group_at_message_create(self, message) -> None:
            env = from_qq(message)
            print(f"[qq] 群@ msg={env.msg_id} chat={env.chat_id} user={env.user_id} text={env.text[:40]!r}", flush=True)

            async def reply(chat_id: str, answer: str) -> None:
                # 群消息必须用 post_group_message + group_openid 回复；
                # msg_id 关联被回复的 @ 消息、msg_type=0 文本，均为官方 demo 要求。
                text, images = extract_images(answer)
                if images:
                    await _upload_and_send_images(
                        self.api, group_openid=message.group_openid, channel_id=None,
                        openid=None, paths=images, msg_id=message.id,
                    )
                if text:
                    await self.api.post_group_message(
                        group_openid=message.group_openid,
                        msg_type=0,
                        msg_id=message.id,
                        content=text,
                    )

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
