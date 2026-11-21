"""session 幂等/串行测试。"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from im_gateway.session import SessionManager, safe_session_key  # noqa: E402
from im_gateway.envelope import Envelope  # noqa: E402


def test_safe_session_key():
    k = safe_session_key("dingtalk", "cid/1", "u-1")
    assert k.startswith("dt-")
    assert len(k) == len("dt-") + 12
    assert "/" not in k
    assert safe_session_key("qq", "c", "u").startswith("qq-")


def _env(msg_id: str, chat: str = "c1", user: str = "u1") -> Envelope:
    return Envelope(platform="dingtalk", msg_id=msg_id, chat_id=chat, user_id=user, text="hi")


def test_dedup():
    sm = SessionManager()
    assert sm.is_duplicate(_env("m1")) is False
    assert sm.is_duplicate(_env("m1")) is True
    assert sm.is_duplicate(_env("m2")) is False


def test_serial_per_session():
    sm = SessionManager()
    order = []

    async def task(tag):
        async def inner():
            order.append(f"{tag}-start")
            await asyncio.sleep(0.01)
            order.append(f"{tag}-end")
            return tag
        return await sm.run("key1", inner)

    async def main():
        await asyncio.gather(task("a"), task("b"))

    asyncio.run(main())
    # 同 key 串行：a-start,a-end,b-start,b-end 或反过来；不会交错
    assert order in (["a-start", "a-end", "b-start", "b-end"],
                     ["b-start", "b-end", "a-start", "a-end"])
