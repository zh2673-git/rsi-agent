"""QQ 发图能力测试：图片标记解析 + 富媒体链路触发。"""
import asyncio
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from im_gateway.adapters import qq  # noqa: E402


def test_extract_images_basic():
    text, paths = qq.extract_images("讲解如下 [img:C:\\a b\\头饰.png] 结束")
    assert paths == ["C:\\a b\\头饰.png"]
    assert text == "讲解如下  结束" or text == "讲解如下 结束"


def test_extract_images_multiple():
    text, paths = qq.extract_images("[img:/tmp/a.png]\n[img:/tmp/b.png]")
    assert paths == ["/tmp/a.png", "/tmp/b.png"]
    assert text == ""


def test_extract_images_none():
    text, paths = qq.extract_images("纯文本回复")
    assert paths == []
    assert text == "纯文本回复"


def test_group_reply_with_images_uses_rich_media(monkeypatch):
    asyncio.set_event_loop(asyncio.new_event_loop())

    class FakeCfg:
        qq_appid = "test-appid"
        qq_token = "test-secret"

    captured = {}
    uploaded = {}

    class FakeApi:
        async def post_group_message(self, **kwargs):
            captured.update(kwargs)

    async def fake_upload(api, **kwargs):
        uploaded.update(kwargs)

    monkeypatch.setattr(qq, "_upload_and_send_images", fake_upload)

    class FakeCore:
        async def handle(self, env, reply):
            await reply(env.chat_id, "图在此 [img:/tmp/a.png]")

    client = qq.build(FakeCfg(), FakeCore())
    client.api = FakeApi()

    msg = types.SimpleNamespace(
        id="msg-123", group_openid="group-abc", content="@bot 发图",
        author=types.SimpleNamespace(member_openid="member-xyz"),
    )
    asyncio.get_event_loop().run_until_complete(client.on_group_at_message_create(msg))

    assert uploaded["group_openid"] == "group-abc"
    assert uploaded["paths"] == ["/tmp/a.png"]
    assert uploaded["msg_id"] == "msg-123"
    # 文本标记已剥离，仅发剩余文本
    assert captured["content"] == "图在此"
    assert captured["msg_type"] == 0
