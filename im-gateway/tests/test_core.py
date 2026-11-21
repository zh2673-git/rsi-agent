"""core 主链路测试：白名单/幂等/mock host/回复截断。"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from im_gateway import core as core_mod  # noqa: E402
from im_gateway.config import GatewayConfig  # noqa: E402
from im_gateway.core import GatewayCore  # noqa: E402
from im_gateway.envelope import Envelope  # noqa: E402


@pytest.fixture(autouse=True)
def _no_real_meta(monkeypatch):
    """core.handle 写会话元数据到展示文件；测试不应污染真实 im-gateway/data。"""
    monkeypatch.setattr(core_mod, "record_session_meta", lambda env: "test-sid")


class FakeHost:
    def __init__(self, answer: str = "agent-reply", raise_exc: bool = False):
        self.answer = answer
        self.raise_exc = raise_exc
        self.calls = []

    async def chat(self, session_id, message):
        self.calls.append((session_id, message))
        if self.raise_exc:
            raise RuntimeError("boom")
        return self.answer


def _env(msg="m1", user="u1", chat="c1", text="hello"):
    return Envelope(platform="dingtalk", msg_id=msg, chat_id=chat, user_id=user, text=text)


def _run(core, env):
    replies = []

    async def reply(chat_id, text):
        replies.append((chat_id, text))

    asyncio.run(core.handle(env, reply))
    return replies


def test_whitelist_user_blocks():
    cfg = GatewayConfig(allow_users={"ok-user"})
    host = FakeHost()
    core = GatewayCore(cfg, host)
    assert _run(core, _env(user="bad")) == []
    assert host.calls == []


def test_whitelist_chat_blocks():
    cfg = GatewayConfig(allow_chats={"ok-chat"})
    host = FakeHost()
    core = GatewayCore(cfg, host)
    assert _run(core, _env(chat="bad")) == []
    assert host.calls == []


def test_happy_path():
    cfg = GatewayConfig(max_reply_chars=4000)
    host = FakeHost("final-answer")
    core = GatewayCore(cfg, host)
    replies = _run(core, _env())
    assert len(replies) == 1
    chat_id, text = replies[0]
    assert chat_id == "c1"
    assert text == "final-answer"
    assert host.calls[0][1] == "hello"


def test_dedup_prevents_second_call():
    host = FakeHost()
    core = GatewayCore(GatewayConfig(), host)
    assert len(_run(core, _env(msg="dup"))) == 1
    assert len(_run(core, _env(msg="dup"))) == 0
    assert len(host.calls) == 1


def test_reply_clipped():
    host = FakeHost("x" * 100)
    core = GatewayCore(GatewayConfig(max_reply_chars=30), host)
    replies = _run(core, _env())
    assert len(replies[0][1]) <= 30
    assert "截断" in replies[0][1]


def test_host_error_replies_generic():
    host = FakeHost(raise_exc=True)
    core = GatewayCore(GatewayConfig(), host)
    replies = _run(core, _env())
    assert replies[0][1].startswith("抱歉，处理失败")
