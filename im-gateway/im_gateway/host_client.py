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

    async def submit(self, session_id: str, message: str) -> bool:
        """提交用户消息。返回 host 是否接受。"""
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{self.base}/api/chat",
                json={"session_id": session_id, "message": message},
            )
            resp.raise_for_status()
            data = resp.json()
            return bool(data.get("ok"))

    async def _iter_events(self, session_id: str, after: int = 0) -> AsyncIterator[dict]:
        url = f"{self.base}/api/events?session={session_id}&after={after}"
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", url) as resp:
                await resp.raise_for_status()
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
        gen = self._iter_events(session_id, after)

        gate = 0
        async for evt in gen:
            if asyncio.get_running_loop().time() > deadline:
                await gen.aclose()
                raise TimeoutError("等待 SSE 就绪超时")
            cur = self._cursor(evt)
            if cur is not None:
                gate = max(gate, cur)
            # SSE 是持续长连接；读到「空批」后 host 才进入实时阶段，但帧本身无显式标记。
            # 稳妥做法：读到第一条 assistant 后即认为历史重放已覆盖（历史最后一条就是
            # assistant），再往后提交；若会话无历史则等首个非 assistant 帧或超时。
            if self._is_assistant(evt):
                break

        ok = await self.submit(session_id, message)
        if not ok:
            await gen.aclose()
            raise RuntimeError("host 拒绝消息")

        return await self._consume_after_gate(gen, gate, deadline)

    async def _consume_after_gate(
        self,
        gen: AsyncIterator[dict],
        gate: int,
        deadline: float,
    ) -> str:
        """继续迭代已有 SSE 生成器，只接受 cursor > gate 的 assistant。"""
        loop = asyncio.get_running_loop()
        async for evt in gen:
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
        return ""
