"""Envelope 归一化测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from im_gateway.envelope import from_dingtalk, from_qq  # noqa: E402


def test_from_dingtalk():
    data = {
        "msgId": "m1",
        "conversationId": "cid-1",
        "senderStaffId": "u-1",
        "createAt": 12345,
    }
    env = from_dingtalk(data, "m1", "  hello  ")
    assert env.platform == "dingtalk"
    assert env.msg_id == "m1"
    assert env.chat_id == "cid-1"
    assert env.user_id == "u-1"
    assert env.text == "hello"
    assert env.timestamp_ms == 12345


def test_from_qq():
    class Author:
        id = " user-9 "

    class Msg:
        id = "qq-msg-1"
        channel_id = "chan-7"
        content = "  hi there  "
        author = Author()

    env = from_qq(Msg())
    assert env.platform == "qq"
    assert env.msg_id == "qq-msg-1"
    assert env.chat_id == "chan-7"
    assert env.user_id == "user-9"
    assert env.text == "hi there"


def test_from_qq_group_message():
    """群消息：group_openid / author.member_openid，且对象是 __slots__。"""
    class Author:
        __slots__ = ("member_openid",)
        def __init__(self):
            self.member_openid = " member-u-3 "

    class GroupMsg:
        __slots__ = ("id", "group_openid", "content", "author")
        def __init__(self):
            self.id = "qq-group-msg-1"
            self.group_openid = "grp-42"
            self.content = "  群里的消息  "
            self.author = Author()

    env = from_qq(GroupMsg())
    assert env.platform == "qq"
    assert env.msg_id == "qq-group-msg-1"
    assert env.chat_id == "grp-42"
    assert env.user_id == "member-u-3"
    assert env.text == "群里的消息"
