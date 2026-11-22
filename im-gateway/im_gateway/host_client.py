"""Host 客户端：POST /api/chat 提交 + SSE /api/events 接收本轮 assistant.answer。

契约（已从源码核实）：
- POST /api/chat body {"session_id","message"} -> {"ok": bool}（不含回复）
- GET /api/events?session=&after= 是 SSE 长连接；assistant 事件 .answer 为最终文本
- SSE 每帧由 host 注入 cursor（trace 精确游标）；复用会话时历史 assistant 会先被重放。

关键 correctness：每次 chat 先读取 SSE 已重放的最大 cursor 作为 gate，再提交用户消息；
只接受 cursor > gate 的 assistant 帧。这样同会话第二轮不会把第一轮的历史答案当作当前回复。
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import httpx


class HostClient:
    def __init__(self, base: str, timeout_secs: float = 300.0) -> None:
        self.base = base.rstrip("/")
        self.timeout_secs = timeout_secs
        # K409（同会话旧任务未释放）退避重试参数：默认 5 次、起始 1s（1/2/4/8/8 ≈ 23s）
        self._k409_retries = 5
        self._k409_backoff = 1.0

    async def submit(self, session_id: str, message: str) -> bool:
        """提交用户消息。返回 host 是否接受。

        注意：host 的 POST /api/chat 是「阻塞到 agent 整轮收敛」才返回，
        长任务（多轮工具调用）可能耗时数分钟。这里必须用 chat_timeout_secs
        作为读超时，不能用固定短超时，否则长任务会在提交阶段被 ReadTimeout
        打断，被 core 兜底成「处理失败」（agent 其实仍在后台继续跑完）。

        K409（同会话已有进行中的 chat）不直接判失败：网关重启会丢掉本侧会话锁，
        而 host 侧旧任务可能仍在跑；此时立即报 RuntimeError 会让用户看到
        「处理失败」。改为有限退避重试，等旧任务释放并发闸后再提交本条消息。
        """
        deadline = asyncio.get_running_loop().time() + self.timeout_secs
        attempt = 0
        while True:
            async with httpx.AsyncClient(timeout=self.timeout_secs) as client:
                resp = await client.post(
                    f"{self.base}/api/chat",
                    json={"session_id": session_id, "message": message},
                )
                resp.raise_for_status()
                data = resp.json()
            if data.get("ok"):
                return True
            err = data.get("error") if isinstance(data.get("error"), dict) else {}
            if err.get("code") != "K409" or attempt >= self._k409_retries:
                return False
            attempt += 1
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return False
            delay = min(self._k409_backoff * (2 ** (attempt - 1)), 8.0, remaining)
            print(
                f"[gw] submit K409，旧任务未释放会话闸，{delay:.1f}s 后重试 "
                f"session={session_id} attempt={attempt}/{self._k409_retries}",
                flush=True,
            )
            await asyncio.sleep(delay)

    async def _iter_events(self, session_id: str, after: int = 0) -> AsyncIterator[dict]:
        url = f"{self.base}/api/events?session={session_id}&after={after}"
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("event:"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    try:
                        evt = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(evt, dict):
                        yield evt

    @staticmethod
    def _is_assistant(evt: dict) -> bool:
        kind = evt.get("type") or evt.get("kind") or ""
        return kind == "assistant" or bool(evt.get("answer"))

    @staticmethod
    def _cursor(evt: dict) -> int | None:
        v = evt.get("cursor")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        return int(v)

    async def stream_answer(
        self,
        session_id: str,
        after: int = 0,
        *,
        gate: int | None = None,
    ) -> str:
        """订阅 SSE，等待本轮 assistant 事件返回 .answer 文本。

        gate 若提供：只接受 cursor > gate 的 assistant 帧；无 cursor 的历史帧拒绝。
        """
        deadline = asyncio.get_running_loop().time() + self.timeout_secs
        async for evt in self._iter_events(session_id, after):
            if asyncio.get_running_loop().time() > deadline:
                raise TimeoutError("等待 agent 回复超时")
            if not self._is_assistant(evt):
                continue
            if gate is not None:
                cursor = self._cursor(evt)
                if cursor is None or cursor <= gate:
                    continue
            answer = evt.get("answer")
            if isinstance(answer, str) and answer:
                return answer
        return ""

    async def chat(self, session_id: str, message: str, after: int = 0) -> str:
        """提交 + 等回复的组合入口。

        复用会话时 GET /api/events 会从 after=0 重放历史 assistant。若提交后才订阅，
        第一帧 old answer 会被误当本轮回复。这里先建立 SSE 连接、消费已重放事件，
        取最大 cursor 作为 gate，再提交；之后只接受 cursor > gate 的 assistant。

        取舍：重放历史很多时需读完已有历史才提交（trace 一般几十到几百条，毫秒级）。
        """
        deadline = asyncio.get_running_loop().time() + self.timeout_secs
        # 重放是批量推送：历史事件一次性刷出，刷完后 host 进入 300ms 轮询且无帧。
        # 连续 idle 无帧即认为重放已 catch up。不能用「读到 assistant 就停」，
        # 多轮历史是 user/assistant/chat_summary 交替，第一条 assistant 只是第一轮，
        # 提前停会把后续历史 assistant 当成新回复返回（stale answer）。
        replay_idle = 0.6

        # 阶段1：独立连接消费历史重放，取最大 cursor 作为 gate。
        # 持续读到连续 idle 无新帧（历史已全部重放）才提交；无历史会话等 idle 即提交。
        # 用独立 gen 且显式 aclose，避免与 submit 后新连接共用导致 StreamClosed。
        gate = 0
        replay = self._iter_events(session_id, after)
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(
                        anext(replay),
                        timeout=min(replay_idle, max(0.1, deadline - asyncio.get_running_loop().time())),
                    )
                except (StopAsyncIteration, asyncio.TimeoutError):
                    break
                if asyncio.get_running_loop().time() > deadline:
                    raise TimeoutError("等待 SSE 就绪超时")
                cur = self._cursor(evt)
                if cur is not None:
                    gate = max(gate, cur)
        finally:
            await replay.aclose()

        ok = await self.submit(session_id, message)
        if not ok:
            raise RuntimeError("host 拒绝消息")

        # host POST /api/chat 阻塞到 agent 收敛才返回：submit 期间答案已写入 trace，
        # 且 submit 自身可能耗尽初始 deadline。这里为「读答案」重起一个独立窗口，
        # 避免长任务刚提交完就被判定为等待回复超时。
        deadline = asyncio.get_running_loop().time() + self.timeout_secs
        # 阶段2：新连接从 gate 之后读本轮 assistant（cursor > gate）。
        return await self._wait_answer(session_id, gate, deadline)

    async def _wait_answer(self, session_id: str, gate: int, deadline: float) -> str:
        """新 SSE 连接，只接受 cursor > gate 的 assistant 作为本轮回复。"""
        loop = asyncio.get_running_loop()
        ask = self._iter_events(session_id, gate)
        try:
            async for evt in ask:
                if loop.time() > deadline:
                    raise TimeoutError("等待 agent 回复超时")
                if not self._is_assistant(evt):
                    continue
                cursor = self._cursor(evt)
                if cursor is None or cursor <= gate:
                    continue
                answer = evt.get("answer")
                if isinstance(answer, str) and answer:
                    return answer
        finally:
            await ask.aclose()
        return ""

