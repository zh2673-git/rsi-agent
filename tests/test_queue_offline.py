"""断线不吞待发队列的回归断言（K 轮）。

## 这个 bug 的形状

用户原话：「你自己关掉现有 agent 进程后，自己没有重启。然后在断线的情况下，如果我手动
点回复之后，排队的指令就都消失了。」

排查结论：队列本身在**前端内存**（`runState`，`q-session.js`），host 重启不会清空它。
真正吞掉它的是 `drain` 的结局分流：

- `postChatDirect` 的 `catch` 分支把所有异常一律 `return "error"`，
- `drain` 见到非 `aborted` 的结局就 `splice` 出队（语义是「这条跑完了」）。

断线时 `fetch` 会被**立即拒绝**（连接层失败，请求根本没送到服务端），于是每一条待发项
都被「跑完了」——`while (s.queue.length)` 一轮把整个队列清空，`finally` 再把 `running`
置回 false，界面显示空闲。用户看到的就是「排队的指令全没了」。

关键区别：**请求没送到 ≠ 执行完了**。前者必须留着条目，后者才该出队。

## 为什么测试是这么写的

- 断言 `postChatDirect` 的连接层失败返回 `offline` 而不是 `error`——这是根因点；
- 断言 `drain` 见到 `offline` 就 `break`（不是 `continue`，更不是出队）——循环必须停，
  否则会拿同一条无限重试；
- 断言 `item.offline` 被标上且能被 `renderQueue` 看见——用户能确认「它还在」才是修复的
  一半，静默保留和静默丢弃一样让人不安；
- 断言「服务端明确回错」（非 ok 的 v）仍然出队——不能为了不吞队列，把真正的执行失败
  也留成死循环。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
Q_SESSION = "runtime/crates/host/web-dist/vendor/q-session.js"
STYLE_CSS = "runtime/crates/host/web-dist/style.css"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def body(src: str, signature: str) -> str:
    """取 `signature` 起始的函数体（按大括号配对），找不到返回空串。"""
    i = src.find(signature)
    if i < 0:
        return ""
    j = src.find("{", i)
    if j < 0:
        return ""
    depth = 0
    for k in range(j, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                return src[j : k + 1]
    return ""


class OfflineKeepsQueueTest(unittest.TestCase):
    """连接层失败必须保留队列条目。"""

    def setUp(self) -> None:
        self.src = read(Q_SESSION)

    def test_post_chat_direct_returns_offline_on_connection_failure(self) -> None:
        """fetch reject（断线）→ offline，不能是 error（error 会被 drain 当跑完出队）。"""
        fn = body(self.src, "async function postChatDirect(")
        self.assertTrue(fn, "postChatDirect 未找到")
        catch_at = fn.find("catch (e)")
        self.assertGreater(catch_at, 0, "postChatDirect 应有 catch 分支")
        tail = fn[catch_at:]
        self.assertIn(
            'return "offline"',
            tail,
            "连接层失败必须返回 offline：返回 error 会让 drain 把没送到的指令当跑完出队",
        )
        # AbortError 仍走 aborted（用户主动停/插队），不能混进 offline
        abort_at = tail.find('e?.name === "AbortError"')
        self.assertGreater(abort_at, 0, "AbortError 分支应保留")
        self.assertIn('return "aborted"', tail[abort_at:], "abort 语义不能被 offline 覆盖")

    def test_retry_exhausted_is_offline_not_error(self) -> None:
        """K409 重试窗口耗尽 → 同样拿不到服务端结论，按 offline 保留。"""
        fn = body(self.src, "async function postChatDirect(")
        self.assertNotIn(
            'return "error";\n}',
            fn.replace("\r", ""),
            "重试耗尽不能返回 error（那会把条目当执行失败出队）",
        )

    def test_drain_breaks_on_offline(self) -> None:
        """drain 见到 offline 必须 break，且不能走到出队。"""
        fn = body(self.src, "async function drain(")
        self.assertTrue(fn, "drain 未找到")
        # 从 while 开始看：offline 分支要在 splice 出队之前
        while_at = fn.find("while (s.queue.length)")
        self.assertGreater(while_at, 0, "drain 应有串行 while 循环")
        loop = fn[while_at:]
        off_at = loop.find('outcome === "offline"')
        splice_at = loop.find("s.queue.splice(at, 1)")
        self.assertGreater(off_at, 0, "drain 必须识别 offline 结局")
        self.assertGreater(splice_at, 0, "出队语句应仍存在（正常完成要出队）")
        self.assertLess(
            off_at,
            splice_at,
            "offline 判断必须在出队之前——否则没送到的条目照样被删掉",
        )
        offline_block = loop[off_at:splice_at]
        self.assertIn("break", offline_block, "offline 必须 break 停下循环（不能 continue 空转）")

    def test_drain_outlines_offline_item(self) -> None:
        """被断线拦住的那条要打上 item.offline，让用户看得见它没丢。"""
        fn = body(self.src, "async function drain(")
        self.assertIn("item.offline = true", fn, "drain 应给断线条目打 offline 标记")
        self.assertIn("item.offline = false", fn, "再次尝试前应清掉旧标记")

    def test_render_queue_shows_offline_tag(self) -> None:
        """renderQueue 必须渲染「待重发」——静默保留和静默丢弃一样让人不安。"""
        fn = body(self.src, "function renderQueue(")
        self.assertTrue(fn, "renderQueue 未找到")
        self.assertIn("item.offline", fn, "renderQueue 应渲染 offline 行")
        self.assertIn("待重发", fn, "行内文案应说明这条在等重发")

    def test_offline_style_exists(self) -> None:
        """样式：待重发行要有可辨识的边框（与「待续跑」区分）。"""
        css = read(STYLE_CSS)
        self.assertRegex(
            css,
            r"\.qitem\.offline\b",
            "style.css 应有 .qitem.offline 样式",
        )


class ServiceErrorStillDequeuesTest(unittest.TestCase):
    """反向约束：真正的服务端失败仍要出队，别把修复做成死循环。"""

    def test_non_ok_response_returns_error(self) -> None:
        fn = body(read(Q_SESSION), "async function postChatDirect(")
        self.assertIn(
            'return v.ok ? "ok" : "error"',
            fn,
            "服务端明确回非 ok 时仍应返回 error（执行过 → 出队），不能一律 offline",
        )


if __name__ == "__main__":
    unittest.main()
