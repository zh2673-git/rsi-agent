#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""secretary — 秘书视角的全局盘点（只读）。

## 为什么需要它

worker 的视野是「当前这个任务」，而用户真正常问的是「我手上这些事现在什么情况、
哪些做完了、哪些没人认领、能交给谁」。这些问题的答案散在三处（任务、灵感、技能库），
让模型每轮自己去 join，代价是一次次读全量 board.json，且结果不稳定。

本工具只做一件事：**一次进程内把三份事实 join 成一份有界的快照**。

## 判据：为什么是 join，不是推理

- 「做了没有」= `status` + `evaluation.verdict` + `checks` 三者的组合，是纯数据问题。
- 「能交给谁」= 任务需要的技能 (`resourcing.skills`) ∩ 技能库实际能力，也是 join。
- 只有「两边都缺」时才需要判断（→ 该造技能），这一条留给 SKILL.md 讲。

把 join 交给推理，得到的是自信的胡说：模型会说「这件事交给 tdd」而不去看 tdd 到底在不在。

## 空间契约

**只读**。数据仍只有一本账（`board.py::data_root`），写通道仍唯一是 `board.py` 与
`/api/board`。秘书若可写，「告诉我没做」会滑向「顺手帮我做掉」，用户失去只问答的入口。

## 时间契约

现算不缓存：看板是分钟级变化，缓存只会让用户拿到上一秒的答案
（与 `board_ctx.rs` 的判据一致）。

用法：
    python scripts/secretary.py brief            # 人读视图
    python scripts/secretary.py brief --json     # 给下游 / 前端
    python scripts/secretary.py brief --limit 5  # 每个分区最多几条
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import board as B  # noqa: E402  同源读板：路径/锁/空板语义都不重复实现

# 输出有界：秘书的价值是「一眼看完」，不是「再给一份看板全文」。
MAX_SECTION_ITEMS = 12
MAX_LINE_CHARS = 160


# ── 技能库（谁能干什么）─────────────────────────────────────────────────────

def _frontmatter(p: Path) -> dict:
    """从 SKILL.md 头部 YAML frontmatter 取 name/description（只认单行 `key: value`）。

    为什么不引入 YAML 解析器：这里只需要两个字段，且技能 frontmatter 是受控格式
    （name/description/origin 三个单行键）。为一个两字段读取加依赖不划算。
    """
    try:
        text = p.read_text(encoding="utf-8")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out: dict[str, str] = {}
    for line in text[3:end].splitlines():
        if ":" not in line or line.strip().startswith("#"):
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if k and v:
            out[k] = v
    return out


def skill_catalog() -> dict[str, dict]:
    """读技能目录，返回 {name: {description, outputs, tools, status}}。

    **以目录为准，不以 skill.json 为准**——这是本轮修掉的一个真 bug：
    初版只扫 `skills/*/skill.json`，于是 `rsi-board` / `git-ops` / `trace-analysis`
    这些「有 SKILL.md 但没 skill.json」的技能在派活映射里被判成「不在库里」，
    秘书会告诉用户「这件事缺 rsi-board，得先造技能」——而它就在那儿。
    可信度判据：技能**能不能用**取决于目录里有没有 SKILL.md（assets 插件扫的就是它）；
    skill.json 只提供 outputs/tools 这类更细的契约字段，缺了不影响「能不能干」。

    失败静默降级：目录缺失 → 空（整体快照仍出；秘书不能因技能库坏了就拒绝回答）。
    """
    root = Path(__file__).resolve().parent.parent / "skills"
    out: dict[str, dict] = {}
    if not root.is_dir():
        return out
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        md = d / "SKILL.md"
        if not md.is_file():
            continue
        fm = _frontmatter(md)
        name = str(fm.get("name") or d.name)
        entry = {"description": str(fm.get("description") or ""),
                 "outputs": [], "tools": [], "status": ""}
        # skill.json 有则补细字段（它比 frontmatter 多了 outputs/tools/status）
        sj = d / "skill.json"
        if sj.is_file():
            try:
                j = json.loads(sj.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                j = None
            if isinstance(j, dict):
                entry["outputs"] = [str(x) for x in (j.get("outputs") or [])]
                entry["tools"] = [str(x) for x in (j.get("tools") or [])]
                entry["status"] = str(j.get("status") or "")
                if not entry["description"]:
                    entry["description"] = str(j.get("description") or "")
        out[name] = entry
    return out


# ── 任务侧 ────────────────────────────────────────────────────────────────

def _cut(text: str, n: int = MAX_LINE_CHARS) -> str:
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def is_reproducible(t: dict) -> bool:
    """「做完了」是否有证据：有 checks 且 verdict=pass，或有 artifacts。

    为什么不用 status=done 单独判定：status 是 agent 的自述，verdict 才是证据
    （rsi-board 的裁决：有 checks 却 verdict≠pass 就是自证）。
    """
    ev = t.get("evaluation") or {}
    checks = t.get("checks") or []
    arts = t.get("artifacts") or []
    if checks and str(ev.get("verdict") or "") == "pass":
        return True
    return bool(arts)


def task_line(t: dict) -> str:
    prog = t.get("progress") or {}
    done, total = int(prog.get("done") or 0), int(prog.get("total") or 0)
    bits = [str(t.get("id") or ""), f"「{_cut(t.get('title'), 60)}」"]
    bits.append(f"priority={t.get('priority') or '-'}")
    if total:
        bits.append(f"progress={done}/{total}")
    ev = t.get("evaluation") or {}
    if checks := (t.get("checks") or []):
        bits.append(f"checks={len(checks)}/{ev.get('verdict') or 'none'}")
    return " ".join(bits)


def next_action(t: dict) -> str:
    """从 plan 里取第一个未完成步；没有 plan 就用 outcomes.brief 的缺口。"""
    for step in (t.get("plan") or []):
        if str(step.get("status") or "") in ("completed", "cancelled"):
            continue
        return _cut(step.get("step"), 80)
    if str(t.get("status") or "") in ("verifying",):
        return "跑 checks 并写 verdict"
    return ""


def task_survey(tasks: list[dict]) -> dict:
    """按状态分组，外加两类「需要人管」的异常。"""
    groups: dict[str, list[dict]] = {}
    for t in tasks:
        groups.setdefault(str(t.get("status") or "planning"), []).append(t)
    # 自称完成但无证据：done 却没有 verdict=pass 也没有 artifacts。
    # 这类条目在「做完了吗」这个问题上最误导人，必须单独列。
    claimed = [t for t in tasks
               if str(t.get("status") or "") == "done" and not is_reproducible(t)]
    return {"groups": groups, "claimed_done_without_proof": claimed}


# ── 灵感侧 ────────────────────────────────────────────────────────────────

def inspiration_survey(tasks: list[dict], insps: list[dict]) -> dict:
    """灵感分三类：已采纳 / 无人认领 / 已归档。

    「无人认领」= status=open 且没有任何任务在 `inspirations[]` 里引用它。
    为什么要看任务侧的反向引用而不只看 status：用户可能在 UI 里手改 status，
    而任务侧的 inspirations 是 agent 建的，两处不一致时以**任务侧为准**
    （那是有据可查的一次采纳动作），并把不一致如实报出来。
    """
    referenced: set[str] = set()
    for t in tasks:
        for i in (t.get("inspirations") or []):
            referenced.add(str(i))
    adopted, orphan, archived = [], [], []
    for i in insps:
        st = str(i.get("status") or "open")
        if st == "archived":
            archived.append(i)
        elif st == "adopted" or str(i.get("id")) in referenced:
            adopted.append(i)
        else:
            orphan.append(i)
    # 不一致：灵感自称 adopted 但没有任务引用它（可能是任务被删了）。
    dangling = [i for i in adopted
                if str(i.get("status") or "") == "adopted"
                and str(i.get("id")) not in referenced]
    return {"adopted": adopted, "orphan": orphan, "archived": archived,
            "adopted_without_task": dangling}


def insp_line(i: dict) -> str:
    tags = ",".join(str(x) for x in (i.get("tags") or []))
    tail = f" tags={tags}" if tags else ""
    return f"{i.get('id')} 「{_cut(i.get('text'), 70)}」{tail}"


# ── 派活（join）─────────────────────────────────────────────────────────────

def assign_map(tasks: list[dict], catalog: dict[str, dict]) -> dict:
    """把「待办任务需要的技能」映射到「技能库里有没有这个能力」。

    三种结局都要明确：
      - covered   = 需要的技能都在库里 → 直接可派
      - missing   = 需要的技能不在库里 → 该造技能（走 creat-skill）
      - unassigned= 任务没写 resourcing.skills → 未指派（最该提醒用户的一类）
    """
    covered, missing, unassigned = [], [], []
    for t in tasks:
        if str(t.get("status") or "") in ("done", "cancelled"):
            continue
        skills = [str(x) for x in ((t.get("resourcing") or {}).get("skills") or [])]
        if not skills:
            unassigned.append(t)
            continue
        gap = [s for s in skills if s not in catalog]
        if gap:
            missing.append({"task": t, "missing": gap, "have": skills})
        else:
            covered.append({"task": t, "skills": skills})
    return {"covered": covered, "missing": missing, "unassigned": unassigned}


def skill_usage(tasks: list[dict]) -> dict[str, int]:
    """每门技能被多少任务用过——「这门技能到底有没有在用」的证据。"""
    counts: dict[str, int] = {}
    for t in tasks:
        for s in ((t.get("resourcing") or {}).get("skills") or []):
            counts[str(s)] = counts.get(str(s), 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


# ── 组装 ──────────────────────────────────────────────────────────────────

def build(limit: int = MAX_SECTION_ITEMS) -> dict:
    board = B.load()
    tasks = board["tasks"]
    insps = board["inspirations"]
    catalog = skill_catalog()

    tv = task_survey(tasks)
    iv = inspiration_survey(tasks, insps)
    av = assign_map(tasks, catalog)

    status_counts = {s: 0 for s in ("planning", "doing", "verifying", "done", "blocked", "cancelled")}
    for t in tasks:
        st = str(t.get("status") or "planning")
        status_counts[st] = status_counts.get(st, 0) + 1

    return {
        "ok": True,
        "corrupt": bool(board.get("corrupt")),
        "data_root": str(B.board_path()),
        "counts": {
            "tasks": len(tasks),
            "by_status": status_counts,
            "inspirations": {
                "total": len(insps),
                "adopted": len(iv["adopted"]),
                "orphan": len(iv["orphan"]),
                "archived": len(iv["archived"]),
            },
            "skills": len(catalog),
        },
        "open_tasks": [t for t in tasks
                       if str(t.get("status") or "") not in ("done", "cancelled")],
        "claimed_done_without_proof": tv["claimed_done_without_proof"],
        "orphan_inspirations": iv["orphan"],
        "adopted_without_task": iv["adopted_without_task"],
        "assign": av,
        "skill_usage": skill_usage(tasks),
        "limit": limit,
    }


def render(d: dict) -> str:
    """人读视图。分区顺序 = 用户问「现在什么情况」时最想先知道的顺序。"""
    c = d["counts"]
    lim = int(d.get("limit") or MAX_SECTION_ITEMS)
    out: list[str] = []

    if d.get("corrupt"):
        out.append("⚠ 看板文件读不出来（坏 JSON）——以下是空板，请先修 .rsi/board.json。\n")

    bs = c["by_status"]
    out.append(f"# 全局快照（{c['tasks']} 任务 / {c['inspirations']['total']} 灵感 / {c['skills']} 技能）")
    out.append("状态: " + " / ".join(f"{k}={v}" for k, v in bs.items() if v)
               + f" / 灵感 adopted={c['inspirations']['adopted']} open={c['inspirations']['orphan']}"
               + f" archived={c['inspirations']['archived']}")

    open_tasks = d["open_tasks"]
    out.append("\n## 1. 在做的事（未完成）")
    if not open_tasks:
        out.append("- （无）")
    for t in open_tasks[:lim]:
        out.append(f"- {task_line(t)}")
        na = next_action(t)
        if na:
            out.append(f"  下一步: {na}")
    if len(open_tasks) > lim:
        out.append(f"- …共 {len(open_tasks)} 件未完成（`board.py list --status doing` 看全部）")

    out.append("\n## 2. 说做完了但拿不出证据")
    claimed = d["claimed_done_without_proof"]
    if not claimed:
        out.append("- （无：所有 done 都有 checks=pass 或产物）")
    for t in claimed[:lim]:
        out.append(f"- {task_line(t)}")
    if len(claimed) > lim:
        out.append(f"- …共 {len(claimed)} 件（`board.py eval <ID>` 可跑 checks 补证据）")

    out.append("\n## 3. 没人认领的灵感")
    orphan = d["orphan_inspirations"]
    if not orphan:
        out.append("- （无：所有 open 灵感都已被任务采纳）")
    for i in orphan[:lim]:
        out.append(f"- {insp_line(i)}")
    if len(orphan) > lim:
        out.append(f"- …共 {len(orphan)} 条")

    dangling = d["adopted_without_task"]
    if dangling:
        out.append("\n   ⚠ 自称已采纳但无任务引用（任务可能被删了）:")
        for i in dangling[:lim]:
            out.append(f"   - {insp_line(i)}")

    out.append("\n## 4. 能交给谁（按技能派活）")
    av = d["assign"]
    if av["covered"]:
        for a in av["covered"][:lim]:
            out.append(f"- {task_line(a['task'])} → {','.join(a['skills'])}")
    else:
        out.append("- （无已指派的在办任务）")
    if av["missing"]:
        out.append("\n   ⚠ 需要的技能不在库里（该造技能，走 creat-skill）:")
        for m in av["missing"][:lim]:
            out.append(f"   - {task_line(m['task'])} → 缺 {','.join(m['missing'])}")
    if av["unassigned"]:
        out.append("\n   ⚠ 未指派技能（不知道该给谁干）:")
        for t in av["unassigned"][:lim]:
            out.append(f"   - {task_line(t)}")

    out.append("\n## 5. 技能使用情况（谁真的在干活）")
    usage = d["skill_usage"]
    if not usage:
        out.append("- （无任务声明技能）")
    else:
        out.append("- " + " / ".join(f"{k}×{v}" for k, v in list(usage.items())[:lim]))

    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="秘书视角：全局任务/灵感/技能盘点（只读）")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("brief", help="全局快照")
    p.add_argument("--json", action="store_true", help="机读 JSON")
    p.add_argument("--limit", type=int, default=MAX_SECTION_ITEMS, help="每分区条数上限")
    args = ap.parse_args()
    if args.cmd != "brief":
        ap.print_help()
        return 2
    d = build(limit=max(1, args.limit))
    if args.json:
        # JSON 模式下不内联 board 全文：open_tasks 已含完整对象，其余是派生结论。
        B.emit({k: v for k, v in d.items()})
    else:
        print(render(d))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
