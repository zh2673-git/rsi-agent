# -*- coding: utf-8 -*-
"""Q 轮（前端交互 / 记忆 / 显式队列）的轻量契约回归。

只读源码文本断言，不启动 host；覆盖「补丁幂等 + 关键不变量」，防止后续升级
快照时把 Q 轮改动整体冲掉而毫无报警。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QDIR = ROOT / "scripts" / "patches" / "q-round"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class QRoundContractTest(unittest.TestCase):
    def test_patch_set_is_well_formed_and_idempotent_markers(self):
        files = sorted(QDIR.glob("*.json"))
        self.assertGreaterEqual(len(files), 30)
        ids = []
        for f in files:
            d = json.loads(f.read_text(encoding="utf-8"))
            ids.append(d["id"])
            self.assertTrue(d.get("description"))
            if d.get("create"):
                self.assertTrue((QDIR / d["content_file"]).is_file(), f"{f.name} content_file 缺失")
                self.assertTrue(d.get("create_marker"), f"{f.name} 缺 create_marker")
            else:
                self.assertTrue((ROOT / d["file"]).is_file(), f"{f.name} 目标文件不存在: {d['file']}")
                for key in ("anchor", "patch", "anchor_file", "patch_file"):
                    if key in d and key.endswith("_file"):
                        self.assertTrue((QDIR / d[key]).is_file(), f"{f.name} {key} 缺失")
        self.assertEqual(len(ids), len(set(ids)), "补丁 id 必须唯一")

    def test_frontend_per_session_and_precise_cursor(self):
        core = read("runtime/crates/host/web-dist/vendor/q-session.js")
        for marker in ("const runState = new Map()", "sessionCache", "preciseCursor", "postChatDirect", "interruptAndSend"):
            self.assertIn(marker, core, f"q-session.js 缺 {marker}")
        events = read("runtime/crates/host/web-dist/vendor/app-events.js")
        self.assertIn("typeof ev.cursor === \"number\"", events)
        self.assertIn("connect(undefined, true)", read("runtime/crates/host/web-dist/vendor/app-core.js"))
        gw = read("runtime/crates/host/src/web/gateway.rs")
        self.assertIn("\"cursor\"", gw)
        # 精确游标必须是字段而非新事件类型
        self.assertNotIn("\"type\": \"cursor\"", gw)

    def test_memory_sidecar_keeps_original_view(self):
        m = read("runtime/plugins/memory/memory_plugin.ts")
        for marker in ("appendSessionEvents", "session.index", "memory.recall", "pruneSessionCache",
                       "kind: \"compaction\"", "loadIfAbsent", "persist(sessionId, msgs)"):
            self.assertIn(marker, m, f"memory_plugin.ts 缺 {marker}")
        # 旧视图仍是 sessions/<safe>.json：get / summarize / rollback 语义不换
        self.assertIn("case \"summarize\":", m)
        self.assertIn("case \"rollback\":", m)
        self.assertIn("destroy(): void {", m)

    def test_server_queue_preserves_k409_and_wire_contract(self):
        q = read("runtime/crates/agent-loop/src/queue.rs")
        for marker in ("MAX_ITEMS_PER_SESSION", "take_steers", "try_spawn", "leftover_steers_to_followup", "destroy()"):
            self.assertIn(marker, q, f"queue.rs 缺 {marker}")
        lib = read("runtime/crates/agent-loop/src/lib.rs")
        for op in ("queue/enqueue", "queue/status", "queue/remove", "queue/interrupt"):
            self.assertIn(f"\"{op}\"", lib)
        chat = read("runtime/crates/agent-loop/src/chat.rs")
        self.assertIn("K409", chat)  # 裸并发裁决保留
        self.assertIn("queue::mark_active", chat)
        self.assertIn("queue::take_steers", chat)
        # steer 不写 user trace 事件，不污染回滚计数
        self.assertNotIn("\"type\": \"user\"", chat.split("queue::take_steers")[1][:1200])
        web = read("runtime/crates/host/src/web/mod.rs")
        for route in ("/api/chat/status", "/api/queue", "/api/queue/remove", "/api/chat/cancel", "/api/chat"):
            self.assertIn(route, web)
        self.assertIn("404,", web)  # 未知路由仍 404（e2e 契约）

    def test_recall_skill_hard_budget(self):
        s = read("skills/memory-recall/SKILL.md")
        self.assertIn("origin: user", s)
        self.assertIn("≤5 条", s)
        self.assertIn("≤25KB", s)
        self.assertIn("不返回全文", s)


if __name__ == "__main__":
    unittest.main()
