"""QQ 适配器结构测试：确认群 @ 链路已注册（不需要真连 QQ）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def test_qq_adapter_registers_group_callback_and_intent():
    import asyncio
    import botpy
    from im_gateway.adapters import qq

    # botpy Client 构造时调 asyncio.get_event_loop()，测试里先备一个
    asyncio.set_event_loop(asyncio.new_event_loop())

    class FakeCore:
        pass

    class FakeCfg:
        qq_appid = "test-appid"
        qq_token = "test-secret"

    client = qq.build(FakeCfg(), FakeCore())

    # 群 @ 回调必须存在
    assert hasattr(client, "on_group_at_message_create")
    assert hasattr(client, "on_at_message_create")
    # botpy 把 intents 存成 int（群公域 bit 1<<25）
    assert int(client.intents) & (1 << 25), "public_messages intent 未开启"


def test_qq_group_reply_uses_msg_id_and_msg_type():
    import asyncio
    import types
    from im_gateway.adapters import qq

    asyncio.set_event_loop(asyncio.new_event_loop())

    class FakeCfg:
        qq_appid = "test-appid"
        qq_token = "test-secret"

    captured = {}

    class FakeApi:
        async def post_group_message(self, **kwargs):
            captured.update(kwargs)

    class FakeCore:
        async def handle(self, env, reply):
            await reply(env.chat_id, "answer")

    client = qq.build(FakeCfg(), FakeCore())
    client.api = FakeApi()

    msg = types.SimpleNamespace(
        id="msg-123",
        group_openid="group-abc",
        content="@bot hi",
        author=types.SimpleNamespace(member_openid="member-xyz"),
    )
    asyncio.get_event_loop().run_until_complete(client.on_group_at_message_create(msg))

    assert captured == {
        "group_openid": "group-abc",
        "msg_type": 0,
        "msg_id": "msg-123",
        "content": "answer",
    }

