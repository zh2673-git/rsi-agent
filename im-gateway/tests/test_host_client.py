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


def test_submit_retries_on_k409_then_accepts(monkeypatch):
    """网关重启竞态：host 返回 K409（旧任务未释放闸）时应退避重试，而非判失败。"""
    posts = {"n": 0}

    class _R:
        def __init__(self, ok, code=None):
            self._d = {"ok": ok}
            if code:
                self._d["error"] = {"code": code, "message": "busy"}

        def raise_for_status(self):
            return None

        def json(self):
            return self._d

    class _C:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            posts["n"] += 1
            # 前两次 K409，第三次接受
            return _R(False, "K409") if posts["n"] < 3 else _R(True)

    monkeypatch.setattr("httpx.AsyncClient", _C)
    client = HostClient("http://x", timeout_secs=30.0)
    client._k409_backoff = 0.01  # 测试加速
    assert asyncio.run(client.submit("s", "msg")) is True
    assert posts["n"] == 3


def test_submit_gives_up_when_non_k409(monkeypatch):
    """非 K409 的 ok=false（如 K400/K500）不重试，直接判失败。"""
    posts = {"n": 0}

    class _R:
        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": False, "error": {"code": "K400", "message": "bad"}}

    class _C:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            posts["n"] += 1
            return _R()

    monkeypatch.setattr("httpx.AsyncClient", _C)
    client = HostClient("http://x", timeout_secs=30.0)
    assert asyncio.run(client.submit("s", "msg")) is False
    assert posts["n"] == 1


def test_submit_timeout_uses_configured_chat_timeout(monkeypatch):
    """submit 必须用 chat_timeout_secs 作为读超时，不能用固定 15s——
    否则长任务在 POST /api/chat 阻塞阶段就被 ReadTimeout 打断。"""
    captured = {}

    class _FakeClient:
        def __init__(self, *a, **kw):
            captured["timeout"] = kw.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            class R:
                def raise_for_status(self):
                    return None

                def json(self):
                    return {"ok": True}

            return R()

    monkeypatch.setattr("httpx.AsyncClient", _FakeClient)
    client = HostClient("http://x", timeout_secs=300.0)
    assert asyncio.run(client.submit("s", "长任务")) is True
    assert captured["timeout"] == 300.0


def test_chat_reset_deadline_after_blocking_submit(monkeypatch):
    """submit 阻塞到 agent 收敛（耗时超过一个 timeout 窗口）后，
    读答案阶段必须重起 deadline，不能刚提交完就假超时。"""
    calls = {"n": 0}

    def fake_client(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _Client([])  # replay 阶段无历史
        # 阶段2：新答案在 gate 之后
        return _Client(_frame({"type": "assistant", "answer": "长任务终于完成", "cursor": 5}))

    monkeypatch.setattr("httpx.AsyncClient", fake_client)

    # submit 模拟长任务：把可控时钟推进到远超初始 deadline（timeout_secs=1）。
    state = {"t": 0.0, "loop": None}

    async def fake_submit(self, session_id, message):
        state["loop"].time = lambda: 1.0 + 10**6  # 初始 deadline=0+1，此处已远超
        return True

    monkeypatch.setattr(HostClient, "submit", fake_submit)

    async def scenario():
        loop = asyncio.get_running_loop()
        orig_time = loop.time
        state["loop"] = loop
        loop.time = lambda: state["t"]
        try:
            # timeout_secs=1：初始 deadline=1；submit 把 loop.time 推到 1e6；
            # 若 chat 未在 submit 后重算 deadline，_wait_answer 第一行即假超时。
            return await HostClient("http://x", timeout_secs=1.0).chat("s", "长任务")
        finally:
            loop.time = orig_time

    assert asyncio.run(scenario()) == "长任务终于完成"


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
