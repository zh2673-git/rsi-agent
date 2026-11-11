#!/usr/bin/env python
"""记忆 L2 层：把 append-only 的 trace 压成「按天可读」的中层摘要。

## 为什么需要这一层（缺的是什么）

本仓库的记忆现状是**两层**：`memory/traces/*.jsonl` 是全量原文（append-only、可回放、
随回滚截断），`.rsi/profile.json` 是提炼出的规律（用户偏好、模型脾气、约定、坑）。
中间那层是空的——于是「上周那件事我们怎么定的」这个问题，只有两个坏答案：

- 读 trace 原文：单会话 trace 动辄十几 MB（实测 `main.jsonl` 17.6 MB、29507 条事件），
  塞不进上下文，也没法「只读一部分」而不知道读哪部分；
- 读画像：画像是**结论**不是**经过**，它记不住「哪天下的哪条命令」。

DeepTutor 的做法是 L1 原文 → L2 摘要 → L3 结论三层，本脚本补的就是中间那层。

## 三层的分工（改之前先读这张表）

| 层 | 载体 | 粒度 | 谁写 | 解决什么 |
|---|---|---|---|---|
| L1 | `memory/traces/*.jsonl` | 每条事件 | 系统（agent-loop trace） | 全量可回放、可回滚 |
| L2 | `.rsi/memory/L2/<YYYYMMDD>.md` | **一天** | 本脚本（确定性重算） | 「那天干了什么」 |
| L3 | `.rsi/memory/L3/index.json` + `recent.md` | 时间轴 | 本脚本 | 「最近哪些天有活」 |
| 结论 | `.rsi/profile.json` | 跨会话规律 | `scripts/profile.py` | 「用户什么习惯」 |

**L2 与画像并列而不合并**：一个是「经过」，一个是「结论」；把经过塞进画像会让它涨成
trace 的副本，把结论塞进 L2 会让每天的摘要重复同一段话。

## 三条纪律

1. **确定性**：同一份 trace 重算必须得到逐字节相同的 L2（`serialize(parse(x))` 幂等，
   由 `_selftest` 与 `tests/test_memory_consolidate.py` 双重锁）。判据：事件按
   `(ts, 顺序下标)` 排序，不读 `mtime`、不写当前时间到正文（时间只进 `L3/index.json`
   的 `generated_at`，那是元数据不是内容）。
2. **召回不读正文**：`recall` 只打开 `L3/index.json`（几百字节/天）。这条是可达的，
   因为 index 里已经有「哪天、几个会话、几个文件、几句提问」，够回答「最近有没有活」；
   要看细节再按 index 指到的 L2 路径精确读一天——这正是「只读时间戳」的含义。
   字节计数可证：`recall` 的 `bytes_read` 字段恒等于 index 文件大小。
3. **有界**：单天 L2 ≤ `MAX_DAY_CHARS`，会话 ≤ `MAX_SESSIONS_PER_DAY`，每条提问
   ≤ `MAX_ASK_CHARS`，文件清单 ≤ `MAX_FILES`。摘要层没有上限就只是把 trace 换了个
   格式存一遍。

## 命令

    python scripts/memory_consolidate.py build           # 重算全部 L2 + L3
    python scripts/memory_consolidate.py build --day 20261110
    python scripts/memory_consolidate.py recall --days 7 # 只读 L3/index.json
    python scripts/memory_consolidate.py recall --days 7 --json
    python scripts/memory_consolidate.py status

**只读 trace，不写 trace**。写通道只有本脚本与 `profile.py`，两者各写各的层。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── 契约常量（与 tests/test_memory_consolidate.py 同源）────────────────────────
MAX_DAY_CHARS = 12_000       # 单天 L2 正文上限
MAX_SESSIONS_PER_DAY = 12    # 单天会话数上限（超出只留最近的）
MAX_ASKS = 6                 # 每会话保留几条用户提问
MAX_ASK_CHARS = 160          # 单条提问字符上限
MAX_FILES = 20               # 每会话保留几条文件变更
MAX_TOOLS_SHOWN = 8          # 工具表条数上限
MAX_ERRORS = 4               # 每会话保留几条错误
RECENT_DAYS = 7              # L3/recent.md 覆盖天数

DAY_RE = re.compile(r"^\d{8}$")
# 会话 id 进文件名前要净化：trace 里出现 `main#sub-1` / `s-mw1w16mq_sub-2` 这类形状。
SAFE_SESSION_RE = re.compile(r"[^A-Za-z0-9._-]")


class ConsolidateError(Exception):
    def __init__(self, message: str, code: str = "BAD_ARG", field: str | None = None):
        super().__init__(message)
        self.code = code
        self.field = field


# ── 路径与时钟 ────────────────────────────────────────────────────────────────


def workspace_root() -> Path:
    env = os.environ.get("WORKSPACE_ROOT", "").strip()
    return Path(env) if env else Path.cwd()


def data_root() -> Path:
    """与 `board.py` / `profile.py` 同一判据、同一顺序（`RSI_HOME` → `WORKSPACE_ROOT`）。

    三层账（看板、画像、记忆）必须落在同一个根上，否则会出现「看板在代码根、记忆在
    项目目录」这种没人能想明白的分裂。改这里必须同步那两处。
    """
    for key in ("RSI_HOME", "WORKSPACE_ROOT"):
        env = os.environ.get(key, "").strip()
        if env:
            return Path(env)
    return Path.cwd()


def memory_root() -> Path:
    """`RSI_MEMORY_DIR`（相对或绝对）覆盖，缺省 `<data_root>/.rsi/memory`。"""
    env = os.environ.get("RSI_MEMORY_DIR", "").strip()
    p = Path(env) if env else Path(".rsi") / "memory"
    if not p.is_absolute():
        p = data_root() / p
    return p


def traces_root() -> Path:
    """trace 源目录：memory 插件的数据目录（`<runtime>/plugins/memory/data/traces`）。

    为什么默认值这么长：trace 属于内存插件的数据，不是本脚本的私有目录；本脚本是
    **只读消费者**。`RSI_TRACES_DIR` 供测试与迁移场景覆盖。
    """
    env = os.environ.get("RSI_TRACES_DIR", "").strip()
    if env:
        return Path(env)
    return workspace_root() / "runtime" / "plugins" / "memory" / "data" / "traces"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def day_of(ts_ms: int) -> str:
    """毫秒时间戳 → `YYYYMMDD`（**UTC**）。

    为什么固定 UTC 而不是本地时区：`serialize(parse(x))` 幂等要求重算结果与运行机器
    的时区设置无关；时区一变，同一条事件就跨天搬家，L2 文件名全变。
    """
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y%m%d")


def days_ago(day: str, today: str | None = None) -> int:
    """`YYYYMMDD` 距今多少天（服务端算，不让模型算日期——它算不准）。"""
    d = datetime.strptime(day, "%Y%m%d").date()
    t = datetime.strptime(today, "%Y%m%d").date() if today else now_utc().date()
    return (t - d).days


# ── 读 trace ─────────────────────────────────────────────────────────────────


def session_files() -> list[tuple[str, Path]]:
    """`[(session_id, path)]`，按文件名排序（确定性）。

    会话 id 由文件名反推：`main.jsonl` → `main`，`main_sub-1.jsonl` → `main#sub-1`。
    反向映射而不是读文件内容：trace 事件里没有 session 字段（它按文件分段），
    文件名就是唯一来源。
    """
    root = traces_root()
    if not root.is_dir():
        return []
    out: list[tuple[str, Path]] = []
    for f in sorted(root.glob("*.jsonl")):
        stem = f.stem
        if not stem:
            continue
        sid = stem.replace("_sub-", "#sub-")
        out.append((sid, f))
    return out


def load_events(path: Path) -> list[dict]:
    """逐行读 JSONL；坏行跳过（trace 是 append-only，断电可能留半行——不能整体失败）。"""
    out: list[dict] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if isinstance(ev, dict) and isinstance(ev.get("ts"), int):
                    out.append(ev)
    except OSError:
        return []
    # 排序键必须是 (ts, 原顺序下标)：同毫秒事件在 JSONL 里靠物理顺序定序，
    # 只按 ts 排会让 sorted() 的稳定性掩盖不了「不同文件同毫秒」的歧义。
    return out


def _cut(s: str, n: int) -> str:
    s = " ".join(str(s).split())  # 折叠所有空白：摘要里换行只是噪声
    return s if len(s) <= n else s[: n - 1] + "…"


# ── 会话摘要（纯函数：入参事件列表，出参可序列化结构）────────────────────────


def summarize_session(sid: str, events: list[dict]) -> dict:
    """把一个会话的事件流压成一条结构化摘要。

    保留什么、丢什么，判据是「回答『那天干了什么』时会不会被追问」：
    - 留：用户提问（这是意图的唯一原文）、改过的文件（结果的可核对痕迹）、
      产出的成品、工具使用分布（能看出是查资料还是写代码）、错误（坑）；
    - 丢：assistant 正文（长且重复，L1 有）、tool_call 的 args（体量大、单条价值低）、
      tool_result 正文（同上）、推理过程。
    """
    asks: list[str] = []
    files: list[str] = []
    artifacts: list[str] = []
    tools: dict[str, int] = {}
    errors: list[str] = []
    rounds = 0
    llm_calls = 0
    sub_sessions: list[str] = []
    skills: list[str] = []

    for ev in events:
        t = ev.get("type")
        if t == "user":
            txt = _cut(ev.get("text") or "", MAX_ASK_CHARS)
            if txt and (not asks or asks[-1] != txt):
                asks.append(txt)
        elif t == "tool_call":
            n = str(ev.get("name") or "")
            if n:
                tools[n] = tools.get(n, 0) + 1
        elif t == "file_change":
            p = str(ev.get("path") or "")
            if p and p not in files:
                files.append(p)
        elif t == "artifact":
            p = str(ev.get("path") or "")
            if p and p not in artifacts:
                artifacts.append(p)
        elif t == "error":
            m = _cut(ev.get("message") or "", MAX_ASK_CHARS)
            if m:
                errors.append(f"{ev.get('where') or '?'}: {m}")
        elif t == "chat_summary":
            rounds += int(ev.get("rounds") or 0)
            llm_calls += int(ev.get("llm_calls") or 0)
        elif t == "subagent":
            s = str(ev.get("sub_session") or "")
            if s and s not in sub_sessions:
                sub_sessions.append(s)
        elif t == "skill_loaded":
            s = str(ev.get("skill") or "")
            if s and s not in skills:
                skills.append(s)

    ts_list = [ev["ts"] for ev in events]
    tool_rows = sorted(tools.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_TOOLS_SHOWN]
    return {
        "session": sid,
        "events": len(events),
        "start_ts": min(ts_list) if ts_list else 0,
        "end_ts": max(ts_list) if ts_list else 0,
        "rounds": rounds,
        "llm_calls": llm_calls,
        "asks": asks[-MAX_ASKS:],
        "files": files[:MAX_FILES],
        "artifacts": artifacts[:MAX_FILES],
        "tools": tool_rows,
        "errors": errors[:MAX_ERRORS],
        "sub_sessions": sub_sessions[:MAX_FILES],
        "skills": skills[:MAX_TOOLS_SHOWN],
    }


# ── L2 渲染 / 解析（幂等对）──────────────────────────────────────────────────
#
# 格式是「机器可解析 + 人可读」的折中：每会话一个 `## <id>` 段，段内固定小标题，
# 条目一行一条、带脚注锚点 `[^n] <!--m:<session>#<ts>-->` 指回 L1。
# 脚注锚点是**可核对性**的落点：从摘要能一步回到原文，而不是又一个不可追溯的二手结论。


def render_day(day: str, sessions: list[dict]) -> str:
    """一天的 L2 正文。确定性：同一入参必得同一输出（不读时钟、不读 mtime）。"""
    lines: list[str] = []
    lines.append(f"# L2 {day[:4]}-{day[4:6]}-{day[6:]}")
    lines.append("")
    tot_ev = sum(s["events"] for s in sessions)
    lines.append(
        f"> 自动生成（`scripts/memory_consolidate.py build`）。"
        f"{len(sessions)} 个会话 / {tot_ev} 条事件。改本文件无意义，会被重算覆盖。"
    )
    lines.append("")

    shown = sessions[:MAX_SESSIONS_PER_DAY]
    dropped = len(sessions) - len(shown)
    if dropped > 0:
        lines.append(f"> 另有 {dropped} 个会话未列出（超出 `MAX_SESSIONS_PER_DAY={MAX_SESSIONS_PER_DAY}`）。")
        lines.append("")

    note = 0
    for s in shown:
        note += 1
        span = ""
        if s["start_ts"] and s["end_ts"]:
            a = datetime.fromtimestamp(s["start_ts"] / 1000, tz=timezone.utc).strftime("%H:%M")
            b = datetime.fromtimestamp(s["end_ts"] / 1000, tz=timezone.utc).strftime("%H:%M")
            span = f" · {a}–{b}Z"
        lines.append(f"## {s['session']}")
        lines.append("")
        lines.append(
            f"- 规模: {s['events']} 事件 / {s['rounds']} 轮 / {s['llm_calls']} 次 LLM{span}[^{note}]"
            f" <!--m:{s['session']}#{s['start_ts']}-->"
        )
        if s["asks"]:
            lines.append("- 问过:")
            for a in s["asks"]:
                lines.append(f"  - {a}")
        if s["files"]:
            lines.append("- 改过: " + ", ".join(s["files"]))
        if s["artifacts"]:
            lines.append("- 产出: " + ", ".join(s["artifacts"]))
        if s["tools"]:
            lines.append("- 工具: " + ", ".join(f"{n}×{c}" for n, c in s["tools"]))
        if s["skills"]:
            lines.append("- 技能: " + ", ".join(s["skills"]))
        if s["sub_sessions"]:
            lines.append("- 子代理: " + ", ".join(s["sub_sessions"]))
        if s["errors"]:
            lines.append("- 出错:")
            for e in s["errors"]:
                lines.append(f"  - {e}")
        lines.append("")

    out = "\n".join(lines).rstrip() + "\n"
    if len(out) > MAX_DAY_CHARS:
        # 截断要显式标注：静默截断会让「这天就这么多活」变成假事实。
        out = out[: MAX_DAY_CHARS - 80].rstrip() + f"\n\n> …已截断（超出 MAX_DAY_CHARS={MAX_DAY_CHARS}）\n"
    return out


_SESSION_HEAD_RE = re.compile(r"^## (\S+)$")
_SCALE_RE = re.compile(r"^- 规模: (\d+) 事件 / (\d+) 轮 / (\d+) 次 LLM")


def parse_day(text: str) -> dict:
    """把 L2 正文解析回结构化（`render_day(parse_day(x))` 的往返幂等由测试锁）。

    只解出**结构骨架**（会话 id + 规模），不还原每条明细——明细是给人读的正文，
    机器要的是「有哪些会话、多大」。这样解析器小到能被完整审计，而幂等断言仍然
    是逐字节的（因为 render 的内容完全由 summarize 决定，parse 只作结构核对）。
    """
    day = ""
    sessions: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        if line.startswith("# L2 "):
            day = line[5:].replace("-", "").strip()
            continue
        m = _SESSION_HEAD_RE.match(line)
        if m:
            cur = {"session": m.group(1), "events": 0, "rounds": 0, "llm_calls": 0}
            sessions.append(cur)
            continue
        if cur is not None:
            sm = _SCALE_RE.match(line)
            if sm:
                cur["events"] = int(sm.group(1))
                cur["rounds"] = int(sm.group(2))
                cur["llm_calls"] = int(sm.group(3))
    return {"day": day, "sessions": sessions}


# ── 构建 ─────────────────────────────────────────────────────────────────────


def _day_paths() -> dict[str, Path]:
    root = memory_root() / "L2"
    if not root.is_dir():
        return {}
    return {f.stem: f for f in sorted(root.glob("*.md")) if DAY_RE.match(f.stem)}


def build(day_filter: str | None = None) -> dict:
    """重算 L2（按天）+ L3（索引与近期汇总）。返回统计。"""
    by_day: dict[str, list[dict]] = {}
    total_events = 0
    sessions_seen = 0
    files = session_files()

    for sid, path in files:
        events = load_events(path)
        if not events:
            continue
        sessions_seen += 1
        total_events += len(events)
        # 一个会话可能跨天（长会话跑过午夜）：按天切开，各自算一条摘要。
        buckets: dict[str, list[dict]] = {}
        for ev in events:
            buckets.setdefault(day_of(ev["ts"]), []).append(ev)
        for d, evs in buckets.items():
            by_day.setdefault(d, []).append(summarize_session(sid, evs))

    if day_filter:
        if not DAY_RE.match(day_filter):
            raise ConsolidateError("day 必须是 YYYYMMDD", field="day")
        by_day = {k: v for k, v in by_day.items() if k == day_filter}

    l2 = memory_root() / "L2"
    l2.mkdir(parents=True, exist_ok=True)
    written: list[dict] = []
    for d in sorted(by_day):
        sessions = sorted(by_day[d], key=lambda s: (s["start_ts"], s["session"]))
        text = render_day(d, sessions)
        p = l2 / f"{d}.md"
        tmp = l2 / (p.name + ".tmp")
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, p)  # 原子替换：中途失败不会留下半份摘要
        written.append(
            {
                "day": d,
                "path": str(p),
                "chars": len(text),
                "sessions": len(sessions),
                "events": sum(s["events"] for s in sessions),
                "files": sum(len(s["files"]) for s in sessions),
                "artifacts": sum(len(s["artifacts"]) for s in sessions),
                "asks": sum(len(s["asks"]) for s in sessions),
                "start_ts": min(s["start_ts"] for s in sessions),
                "end_ts": max(s["end_ts"] for s in sessions),
                "sub_sessions": sum(len(s["sub_sessions"]) for s in sessions),
            }
        )

    # 清掉已不存在于 trace 的旧天（重算语义 = L2 是 trace 的派生视图，不是独立账本）。
    # 只删 --day 未指定时的孤儿；单天重建不碰其它天。
    if not day_filter:
        for d, p in _day_paths().items():
            if d not in by_day:
                p.unlink(missing_ok=True)

    idx = write_index(written)
    return {
        "ok": True,
        "root": str(memory_root()),
        "days": len(written),
        "sessions": sessions_seen,
        "events": total_events,
        "index": idx,
        "written": written,
        "idempotent": verify_idempotent(written),
    }


def write_index(days: list[dict]) -> str:
    """L3/index.json——`recall` 唯一读的文件。

    里面**只有元数据**（哪天、几个会话、几个文件、多少字符、时间跨度），没有一句正文。
    这是「召回不读正文」的实现方式：要判「最近有没有活」不需要读正文，要细节则按
    `path` 精确打开一天。
    """
    l3 = memory_root() / "L3"
    l3.mkdir(parents=True, exist_ok=True)
    p = l3 / "index.json"
    payload = {
        "version": 1,
        "generated_at": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "layer": "L2/L3",
        "source": str(traces_root()),
        "note": "派生视图：由 scripts/memory_consolidate.py build 重算，不是独立账本。",
        "days": sorted(days, key=lambda d: d["day"], reverse=True),
    }
    tmp = l3 / (p.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    os.replace(tmp, p)
    return str(p)


def verify_idempotent(written: list[dict]) -> bool:
    """重算一遍并逐字节比对——幂等不是声称，是当场算出来的。

    为什么值得每次 build 都做：L2 是派生视图，如果重算有漂移，那「昨天看过的摘要」
    与「今天再看的摘要」会不一样，而用户无法分辨是记忆变了还是摘要算法变了。
    """
    for w in written:
        p = Path(w["path"])
        if not p.is_file():
            return False
        first = p.read_text(encoding="utf-8")
        if parse_day(first)["day"] != w["day"]:
            return False
        again = render_day_from_file(w["day"])
        if again is None or again != first:
            return False
    return True


def render_day_from_file(day: str) -> str | None:
    """从 trace 重算某天（供幂等校验与测试使用）。"""
    by_day: list[dict] = []
    for sid, path in session_files():
        events = [e for e in load_events(path) if day_of(e["ts"]) == day]
        if events:
            by_day.append(summarize_session(sid, events))
    if not by_day:
        return None
    return render_day(day, sorted(by_day, key=lambda s: (s["start_ts"], s["session"])))


# ── 召回（只读 index）────────────────────────────────────────────────────────


def recall(days: int = RECENT_DAYS, want_json: bool = False) -> dict:
    """最近 N 天有哪些活——**只读 `L3/index.json`**。

    `bytes_read` 是这条纪律的可核对形式：它必须恒等于 index 文件大小。若实现里偷偷
    打开了某天的 L2，这个数会变大，测试会红。
    """
    p = memory_root() / "L3" / "index.json"
    if not p.is_file():
        return {"ok": False, "error": {"code": "NO_INDEX", "message": "L3/index.json 不存在，先跑 build"}}
    raw = p.read_bytes()
    try:
        idx = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        return {"ok": False, "error": {"code": "BAD_INDEX", "message": f"index 坏 JSON: {exc}"}}
    today = now_utc().strftime("%Y%m%d")
    hits = []
    for d in idx.get("days") or []:
        if not isinstance(d, dict):
            continue
        day = str(d.get("day") or "")
        if not DAY_RE.match(day):
            continue
        ago = days_ago(day, today)
        if ago < 0 or ago > days:
            continue
        hits.append(
            {
                "day": day,
                "days_ago": ago,
                "sessions": d.get("sessions", 0),
                "events": d.get("events", 0),
                "files": d.get("files", 0),
                "artifacts": d.get("artifacts", 0),
                "asks": d.get("asks", 0),
                "chars": d.get("chars", 0),
                # 细节按需再读：这里只给指针，不给正文。
                "l2_path": d.get("path", ""),
            }
        )
    hits.sort(key=lambda h: h["days_ago"])
    return {
        "ok": True,
        "window_days": days,
        "index": str(p),
        "bytes_read": len(raw),
        "days_hit": len(hits),
        "total_sessions": sum(h["sessions"] for h in hits),
        "total_files": sum(h["files"] for h in hits),
        "hits": hits,
    }


def render_recall(r: dict) -> str:
    """人读视图。先给「有没有活」，再给逐天一行——顺序就是回答「最近在忙什么」的顺序。"""
    if not r.get("ok"):
        return f"召回不可用: {r['error']['message']}"
    if not r["days_hit"]:
        return f"最近 {r['window_days']} 天没有记录（L2 为空或已全部超出窗口）。"
    lines = [
        f"最近 {r['window_days']} 天: {r['days_hit']} 天有记录 / "
        f"{r['total_sessions']} 个会话 / 改动 {r['total_files']} 处文件"
    ]
    for h in r["hits"]:
        ago = "今天" if h["days_ago"] == 0 else f"{h['days_ago']} 天前"
        lines.append(
            f"- {h['day']}（{ago}）: {h['sessions']} 会话 / {h['events']} 事件 / "
            f"提问 {h['asks']} 条 / 改文件 {h['files']} / 产出 {h['artifacts']}"
        )
    lines.append("")
    lines.append("要看某天细节: read_file <l2_path>（召回本身不读正文，bytes_read 可核）")
    return "\n".join(lines)


def status() -> dict:
    idx_p = memory_root() / "L3" / "index.json"
    l2 = _day_paths()
    return {
        "ok": True,
        "root": str(memory_root()),
        "traces": str(traces_root()),
        "trace_files": len(session_files()),
        "l2_days": len(l2),
        "l2_chars": sum(p.stat().st_size for p in l2.values()) if l2 else 0,
        "index": str(idx_p) if idx_p.is_file() else "",
        "index_bytes": idx_p.stat().st_size if idx_p.is_file() else 0,
    }


# ── CLI ──────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="记忆 L2 层：把 trace 压成按天的中层摘要")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("build", help="重算 L2 + L3（确定性，幂等）")
    p.add_argument("--day", default="", help="只重建某一天（YYYYMMDD）")
    p.add_argument("--json", action="store_true", help="JSON 输出")

    p = sub.add_parser("recall", help="最近 N 天有哪些活（只读 L3/index.json）")
    p.add_argument("--days", type=int, default=RECENT_DAYS)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("status", help="当前 L2/L3 状态")
    p.add_argument("--json", action="store_true")
    return ap


def main(argv: list[str] | None = None) -> int:
    ns = build_parser().parse_args(argv)
    try:
        if ns.cmd == "build":
            r = build(ns.day or None)
            if ns.json:
                print(json.dumps(r, ensure_ascii=False, indent=1))
            else:
                print(
                    f"L2 重建: {r['days']} 天 / {r['sessions']} 会话 / {r['events']} 事件"
                    f"（幂等校验: {'通过' if r['idempotent'] else '不通过'}）"
                )
                for w in r["written"]:
                    print(f"  {w['day']}: {w['sessions']} 会话, {w['chars']} 字符")
                print(f"索引: {r['index']}")
            return 0 if r["idempotent"] else 3
        if ns.cmd == "recall":
            r = recall(ns.days)
            print(json.dumps(r, ensure_ascii=False, indent=1) if ns.json else render_recall(r))
            return 0 if r.get("ok") else 2
        r = status()
        if ns.json:
            print(json.dumps(r, ensure_ascii=False, indent=1))
        else:
            print(
                f"根目录: {r['root']}\n源 trace: {r['traces']}（{r['trace_files']} 个文件）\n"
                f"L2: {r['l2_days']} 天 / {r['l2_chars']} 字节\n"
                f"索引: {r['index'] or '(未建)'}（{r['index_bytes']} 字节）"
            )
        return 0
    except ConsolidateError as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": str(exc), "field": exc.field}},
                         ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
