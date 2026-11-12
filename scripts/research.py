"""深度研究账本：来源 ledger + 子问题计划 + 引用机检。

为什么需要它（不是「再加一个搜索工具」）
----------------------------------------
`web_search` / `web_read` / `task` 并行子代理已经够跑「搜→读→综合」。
缺的是**研究这件事的持久状态**：本轮预算到界（`CHAT_BUDGET_SECS` 缺省 900s）就会收尾，
中间产物若只在上下文里，撞墙即全部作废。而且来源只以观测胸牌流向前端，跑完散在 trace 里，
下一轮无法据此核对「这条断言有没有出处」。

三件产物，都在 `.rsi/research/<topic>/`：

  plan.json     子问题列表 + 每项状态 + 已完成部分的结论摘要（断点恢复唯一载体）
  sources.jsonl append-only 来源账本（id/url/title/fetched_at/quote/used_by）
  draft.md      增量成稿（每条事实性断言带 [S7]）

用法
----
  python scripts/research.py new "<topic>" --questions "q1" "q2" ...
  python scripts/research.py plan                       # 看进度
  python scripts/research.py done <idx> --note "<结论摘要>"
  python scripts/research.py add --url U --title T --quote "..." [--id S7]
  python scripts/research.py link S7 --claim claim-3
  python scripts/research.py list [--topic t]
  python scripts/research.py check <report.md> [--topic t]   # 机检引用
  python scripts/research.py resume                     # 下一个待办子问题 + 已有结论

`check` 的三条判据（比「让模型注意别瞎编」硬一个数量级）：
  ① 报告里每个 [S*] 引用在账本里存在；
  ② 每条账本条目至少被引用一次（找出「读了没用」的浪费）；
  ③ 报出没有引用标记的事实性段落数（列表项与长段落，代码块/标题不计）。
退出码：0 全过；1 有问题（便于 CI / 技能验收直接判）。

设计纪律
--------
- 账本 append-only：add 只追加，不修改既有条目（来源是事实，事实不该被覆盖）。
- 文件按 topic 隔离：一个研究一个目录，互不污染。
- 确定性输出：`plan` / `resume` 不带时间戳，同样输入同样输出（可 diff、可断言）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent


def rsi_home() -> Path:
    return Path(os.environ.get("RSI_HOME") or ROOT)


def research_root() -> Path:
    d = Path(os.environ.get("RSI_RESEARCH_DIR") or (rsi_home() / ".rsi" / "research"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def topic_dir(topic: str) -> Path:
    # topic 只允许安全字符：它直接当目录名，且会被 CLI 参数带进来
    safe = re.sub(r"[^A-Za-z0-9_\u4e00-\u9fff.-]+", "-", topic).strip("-") or "untitled"
    d = research_root() / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- plan.json --------------------------------------------------------------

def load_plan(tdir: Path) -> dict:
    p = tdir / "plan.json"
    if not p.is_file():
        return {"topic": tdir.name, "questions": [], "created_at": None}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        print(f"[research] plan.json 损坏: {exc}", file=sys.stderr)
        return {"topic": tdir.name, "questions": [], "created_at": None}


def save_plan(tdir: Path, plan: dict) -> None:
    (tdir / "plan.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def cmd_new(args) -> int:
    tdir = topic_dir(args.topic)
    plan = load_plan(tdir)
    if plan["questions"]:
        print(f"已存在（{len(plan['questions'])} 个子问题），未覆盖: {tdir}", file=sys.stderr)
        return 1
    plan = {
        "topic": args.topic,
        "created_at": _now(),
        "questions": [
            {"idx": i + 1, "q": q, "status": "pending", "note": ""}
            for i, q in enumerate(args.questions)
        ],
    }
    save_plan(tdir, plan)
    print(f"建计划 {tdir}（{len(plan['questions'])} 个子问题）")
    return 0


def cmd_plan(args) -> int:
    tdir = topic_dir(args.topic) if args.topic else None
    dirs = [tdir] if tdir else sorted(p for p in research_root().iterdir() if p.is_dir())
    if not dirs:
        print("（还没有研究计划）")
        return 0
    for d in dirs:
        plan = load_plan(d)
        qs = plan.get("questions") or []
        if not qs:
            continue
        done = sum(1 for q in qs if q.get("status") == "done")
        print(f"\n## {plan.get('topic') or d.name}  [{done}/{len(qs)}]  {d}")
        for q in qs:
            mark = "[x]" if q.get("status") == "done" else "[ ]"
            note = f"  — {q['note']}" if q.get("note") else ""
            print(f"  {mark} {q['idx']}. {q['q']}{note}")
    return 0


def cmd_done(args) -> int:
    tdir = topic_dir(args.topic)
    plan = load_plan(tdir)
    hit = next((q for q in plan.get("questions") or [] if q.get("idx") == args.idx), None)
    if not hit:
        print(f"没有子问题 {args.idx}（{tdir}/plan.json）", file=sys.stderr)
        return 1
    hit["status"] = "done"
    if args.note:
        hit["note"] = args.note
    save_plan(tdir, plan)
    total = len(plan["questions"])
    done = sum(1 for q in plan["questions"] if q.get("status") == "done")
    print(f"{args.idx} done（{done}/{total}）")
    return 0


def cmd_resume(args) -> int:
    tdir = topic_dir(args.topic)
    plan = load_plan(tdir)
    qs = plan.get("questions") or []
    pending = [q for q in qs if q.get("status") != "done"]
    print(f"## {plan.get('topic') or tdir.name}")
    if not pending:
        print("全部子问题已完成。" if qs else "（没有计划，先 `new`）")
        return 0
    nxt = pending[0]
    print(f"下一个: {nxt['idx']}. {nxt['q']}")
    known = [q for q in qs if q.get("status") == "done" and q.get("note")]
    if known:
        print("\n已有结论:")
        for q in known:
            print(f"  {q['idx']}. {q['note']}")
    return 0


# ---- sources.jsonl ----------------------------------------------------------

def ledger_path(tdir: Path) -> Path:
    return tdir / "sources.jsonl"


def load_sources(tdir: Path) -> list[dict]:
    p = ledger_path(tdir)
    if not p.is_file():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def next_id(existing: list[dict]) -> str:
    nums = [int(s["id"][1:]) for s in existing if re.fullmatch(r"S\d+", str(s.get("id")))]
    return f"S{max(nums, default=0) + 1}"


def cmd_add(args) -> int:
    tdir = topic_dir(args.topic)
    existing = load_sources(tdir)
    sid = args.id or next_id(existing)
    if any(s.get("id") == sid for s in existing):
        print(f"{sid} 已存在（账本 append-only，不覆盖）", file=sys.stderr)
        return 1
    if not args.url and not args.quote:
        print("add 需要 --url 或 --quote 至少一项", file=sys.stderr)
        return 1
    entry = {
        "id": sid,
        "url": args.url or "",
        "title": args.title or "",
        "fetched_at": _now(),
        "quote": (args.quote or "")[:1200],
        "used_by": [],
    }
    with ledger_path(tdir).open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"{sid} 已记录 → {ledger_path(tdir)}")
    return 0


def cmd_link(args) -> int:
    tdir = topic_dir(args.topic)
    p = ledger_path(tdir)
    rows = load_sources(tdir)
    hit = next((s for s in rows if s.get("id") == args.id), None)
    if not hit:
        print(f"账本里没有 {args.id}", file=sys.stderr)
        return 1
    if args.claim not in hit.setdefault("used_by", []):
        hit["used_by"].append(args.claim)
    # link 是账本里唯一允许改的字段（used_by 是引用关系，不是事实本身）
    with p.open("w", encoding="utf-8", newline="\n") as fh:
        for s in rows:
            fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"{args.id} ← {args.claim}")
    return 0


def cmd_list(args) -> int:
    tdir = topic_dir(args.topic)
    rows = load_sources(tdir)
    if not rows:
        print("（账本为空）")
        return 0
    for s in rows:
        used = ",".join(s.get("used_by") or []) or "未引用"
        print(f"{s['id']:<5} {used:<20} {s.get('title') or s.get('url')}")
    print(f"\n共 {len(rows)} 条；{sum(1 for s in rows if not s.get('used_by'))} 条尚未被引用")
    return 0


# ---- 引用机检 ---------------------------------------------------------------

CITE = re.compile(r"\[(S\d+)\]")
# 「事实性段落」判据：以列表项或普通文本开头，且长度足够（短句/纯链接不算断言）。
# 代码块、标题、表格分隔行、引用块都不计入——它们不是断言。
FENCE = re.compile(r"^\s*(```|~~~)")


def factual_paragraphs(text: str) -> list[tuple[int, str]]:
    lines = text.splitlines()
    out: list[tuple[int, str]] = []
    in_fence = False
    buf: list[str] = []
    start = 0

    def flush(at: int) -> None:
        nonlocal buf
        joined = " ".join(x.strip() for x in buf).strip()
        if len(joined) >= 30:
            out.append((start, joined))
        buf = []

    for i, line in enumerate(lines, 1):
        if FENCE.match(line):
            in_fence = not in_fence
            flush(i)
            continue
        if in_fence:
            continue
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("|") or s.startswith(">"):
            flush(i)
            continue
        if not buf:
            start = i
        buf.append(line)
    flush(len(lines) + 1)
    return out


def cmd_check(args) -> int:
    tdir = topic_dir(args.topic)
    report = Path(args.report)
    if not report.is_file():
        print(f"报告不存在: {report}", file=sys.stderr)
        return 2
    text = report.read_text(encoding="utf-8", errors="replace")
    sources = load_sources(tdir)
    have = {s["id"] for s in sources}
    cited = CITE.findall(text)
    cited_set = set(cited)

    problems: list[str] = []

    missing = sorted(cited_set - have)
    if missing:
        problems.append(f"引用了账本里不存在的来源: {', '.join(missing)}")

    unused = sorted(have - cited_set)
    if unused:
        problems.append(f"账本条目未被报告引用（读了没用）: {', '.join(unused)}")

    uncited = [(line, para) for line, para in factual_paragraphs(text) if not CITE.search(para)]
    if uncited:
        problems.append(f"{len(uncited)} 段事实性文字没有引用标记")

    print(json.dumps({
        "report": str(report),
        "ledger": str(ledger_path(tdir)),
        "sources": len(sources),
        "citations": len(cited),
        "distinct_cited": len(cited_set),
        "missing": missing,
        "unused": unused,
        "uncited_paragraphs": [{"line": ln, "head": p[:80]} for ln, p in uncited[:20]],
        "ok": not problems,
    }, ensure_ascii=False, indent=1))

    if problems:
        print("\n问题:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("\n引用完整。", file=sys.stderr)
    return 0


# ---- CLI --------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="深度研究账本（plan / sources / 引用机检）")
    ap.add_argument("--topic", default=None, help="研究主题（目录名；缺省从 RSI_RESEARCH_TOPIC 或最近一个）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("new", help="建计划")
    n.add_argument("topic")
    n.add_argument("--questions", nargs="+", default=[])

    p = sub.add_parser("plan", help="看进度")
    p.add_argument("--topic", default=None)

    d = sub.add_parser("done", help="标记子问题完成")
    d.add_argument("idx", type=int)
    d.add_argument("--note", default="")
    d.add_argument("--topic", default=None)

    r = sub.add_parser("resume", help="下一个待办 + 已有结论")
    r.add_argument("--topic", default=None)

    a = sub.add_parser("add", help="追加来源")
    a.add_argument("--url", default="")
    a.add_argument("--title", default="")
    a.add_argument("--quote", default="")
    a.add_argument("--id", default="")
    a.add_argument("--topic", default=None)

    lk = sub.add_parser("link", help="来源 ↔ 断言 关联")
    lk.add_argument("id")
    lk.add_argument("--claim", required=True)
    lk.add_argument("--topic", default=None)

    ls = sub.add_parser("list", help="列账本")
    ls.add_argument("--topic", default=None)

    c = sub.add_parser("check", help="机检报告引用")
    c.add_argument("report")
    c.add_argument("--topic", default=None)

    args = ap.parse_args()

    # topic 解析顺序：--topic > 子命令自带 topic > RSI_RESEARCH_TOPIC > 唯一的已有目录
    if getattr(args, "topic", None) is None and hasattr(args, "topic"):
        args.topic = os.environ.get("RSI_RESEARCH_TOPIC") or ""
    if args.cmd == "new":
        return cmd_new(args)
    if not args.topic:
        dirs = [p for p in research_root().iterdir() if p.is_dir()]
        if len(dirs) == 1:
            args.topic = dirs[0].name
        else:
            print("需要 --topic（或 RSI_RESEARCH_TOPIC；已有多个研究时无法自动选）", file=sys.stderr)
            return 2

    return {
        "plan": cmd_plan,
        "done": cmd_done,
        "resume": cmd_resume,
        "add": cmd_add,
        "link": cmd_link,
        "list": cmd_list,
        "check": cmd_check,
    }[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
