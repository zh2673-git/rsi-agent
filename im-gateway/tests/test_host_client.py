"""host_client 的 SSE 事件筛选：真实重放形状下不得把历史 assistant 当当前回复。"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from im_gateway.host_client import HostClient  # noqa: E402


class _Resp:
    def __init__(self, lines):
        self._lines = lines

    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _StreamCM:
    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return _Resp(self._lines)

    async def __aexit__(self, *a):
        return None


class _Client:
    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    def stream(self, method, url):
        return _StreamCM(self._lines)


def _frame(evt):
    return [f"data: {json.dumps(evt, ensure_ascii=False)}", ""]


def test_stream_answer_ignores_replayed_assistant(monkeypatch):
    lines = []
    lines += _frame({"type": "user", "text": "上一轮问题", "cursor": 2})
    lines += _frame({"type": "assistant", "answer": "上一轮答案", "sid": "old", "cursor": 3})
    lines += _frame({"type": "stream_delta", "text": "正在", "cursor": 4})
    lines += _frame({"type": "assistant", "answer": "本轮答案", "sid": "new", "cursor": 5})

    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **kw: _Client(lines))
    client = HostClient("http://x")
    assert asyncio.run(client.stream_answer("s", gate=3)) == "本轮答案"


def test_stream_answer_without_cursor_never_accepts_when_gate_set(monkeypatch):
    lines = _frame({"type": "assistant", "answer": "老答案无 cursor"})
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **kw: _Client(lines))
    client = HostClient("http://x")
    assert asyncio.run(client.stream_answer("s", gate=1)) == ""


def test_stream_answer_accepts_when_no_gate(monkeypatch):
    lines = _frame({"type": "assistant", "answer": "唯一答案", "cursor": 1})
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **kw: _Client(lines))
    client = HostClient("http://x")
    assert asyncio.run(client.stream_answer("s")) == "唯一答案"


def test_chat_uses_replayed_cursor_as_gate(monkeypatch):
    # replay 历史只到 cursor=3；本轮答案 cursor=8 在阶段2 连接才出现。
    history = []
    history += _frame({"type": "user", "text": "上一轮问题", "cursor": 2})
    history += _frame({"type": "assistant", "answer": "上一轮答案", "cursor": 3})
    answer = _frame({"type": "assistant", "answer": "本轮答案", "cursor": 8})

    submitted = {}
    calls = {"n": 0}

    def fake_client(*a, **kw):
        calls["n"] += 1
        return _Client(history if calls["n"] == 1 else history + answer)

    monkeypatch.setattr("httpx.AsyncClient", fake_client)

    async def fake_submit(self, session_id, message):
        submitted["ok"] = True
        return True

    monkeypatch.setattr(HostClient, "submit", fake_submit)

    client = HostClient("http://x")
    assert asyncio.run(client.chat("s", "本轮问题")) == "本轮答案"
    assert submitted["ok"] is True


def test_chat_gate_is_last_replay_cursor_not_first_assistant(monkeypatch):
    """多轮历史：gate 必须取到最后一条事件 cursor，否则旧 assistant 被当新回复。"""
    # 模拟 3 轮历史；每轮 user/assistant/chat_summary，cursor 连续到 9。
    lines = []
    for i, (kind, ans) in enumerate(
        [
            ("user", "问题1"),
            ("assistant", "答案1"),
            ("chat_summary", ""),
            ("user", "问题2"),
            ("assistant", "答案2"),
            ("chat_summary", ""),
            ("user", "问题3"),
            ("assistant", "答案3"),
            ("chat_summary", ""),
        ],
        start=1,
    ):
        lines += _frame({"type": kind, "answer": ans, "text": ans, "cursor": i})

    submitted = {}
    calls = {"n": 0}

    # 阶段1 replay 只返回历史(c<=9)，阶段2 返回历史 + 新答案(cursor=10)。
    def fake_client(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _Client(lines)
        return _Client(lines + _frame({"type": "assistant", "answer": "真正的本轮答案", "cursor": 10}))

    monkeypatch.setattr("httpx.AsyncClient", fake_client)

    async def fake_submit(self, session_id, message):
        submitted["ok"] = True
        return True

    monkeypatch.setattr(HostClient, "submit", fake_submit)

    client = HostClient("http://x")
    assert asyncio.run(client.chat("s", "本轮问题")) == "真正的本轮答案"
    assert submitted["ok"] is True
