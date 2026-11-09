#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""board_cluster — 把看板从「流水账」变成「有结构的账本」（T-16 / I-20261108-10 归纳层②）。

## 为什么需要它

看板按时间倒序列出 20 个任务时，读者看不出「这些事之间有脉络」：
- 哪几个任务其实在解同一个问题（→ 应该一起看）
- 哪几个是同一个灵感的两次尝试（→ 后者取代前者）
- 哪几个是同一轮迭代的连续动作（→ 阅读顺序有意义）

`board.py digest --skill` 已经有了「按技能聚合」，但那是**统计口径**（这类事做过几次），
不是**结构口径**（这些事之间什么关系）。本命令补后者，且**不新增存储字段**。

## 判据：靠什么分组（以及为什么不用别的）

| 信号 | 可靠度 | 用途 |
|---|---|---|
| `inspirations` 交集 | **高**（用户原话可回溯） | 主分组键：同一灵感派生的任务是一族 |
| 标题里的轮次标记（`K 轮：` / `第 12 轮`） | 中（人写的，偶尔漏） | 次分组键：同一轮迭代的任务是一批 |
| `supersedes` / `depends_on`（若存在） | 高 | 脉络边：谁取代谁、谁依赖谁 |
| `resourcing.skills` | **低** | **不用**：`project-dev` 出现在 13/20 个任务里，分组会全塌成一个 |
| 标题关键词相似 | 低 | 不用：中文短标题的相似度噪声极大 |

纪律：**不造第二套真相**——分类完全从既有字段**现算**，不写回 board.json，
因此不存在「cluster 字段与真实字段不同步」的问题（那正是 board.rs 与 board.py
必须同源校验的原因）。

## 用法

    python scripts/board_cluster.py                  # 人读视图
    python scripts/board_cluster.py --json            # 给下游/前端
    python scripts/board_cluster.py --status done     # 只看已完成
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import board as B  # noqa: E402  同源读板，不重复实现路径与锁

# 标题里的轮次标记：`K 轮：xxx`、`第 12 轮 xxx`、`[K] xxx`
ROUND_RE = re.compile(r"^\s*(?:\[([A-Za-z])[\]】]|([A-Za-z])\s*轮|第\s*(\d+)\s*轮)")
# 标题里的「主题段」：去掉轮次前缀后剩下的部分
PREFIX_STRIP = re.compile(r"^\s*(?:\[[A-Za-z][\]】]|[A-Za-z]\s*轮[：:、]?|第\s*\d+\s*轮[：:、]?)\s*")


def round_tag(title: str) -> str:
    """从标题抽轮次标记；没有则空串。`K 轮：xxx` → 'K'，`第 12 轮` → '12'。"""
    m = ROUND_RE.match(title or "")
    if not m:
        return ""
    return (m.group(1) or m.group(2) or m.group(3) or "").strip()


def theme_of(title: str) -> str:
    """去掉轮次前缀后的主题短语（用于展示，不做分组键）。"""
    return PREFIX_STRIP.sub("", title or "").strip()[:60]


def _updated(t: dict) -> str:
    return str(t.get("updated_at") or "")


def cluster(tasks: list[dict]) -> dict:
    """按灵感族分组；无灵感的任务按轮次标记成批；两者都没有的进「未归类」。

    为什么灵感优先于轮次：灵感是**用户原话**（可 board.py link 反查），
    轮次标记只是人写标题时的习惯——前者是可审计的事实，后者是便利标签。
    """
    by_insp: dict[str, list[dict]] = {}
    no_insp: list[dict] = []
    for t in tasks:
        ins = [str(x) for x in (t.get("inspirations") or [])]
        if ins:
            # 一个任务关联多个灵感时，挂到第一个（其余在 related 里标出，避免重复计数）
            by_insp.setdefault(ins[0], []).append(t)
        else:
            no_insp.append(t)

    groups: list[dict] = []
    for iid, ts in by_insp.items():
        ts_sorted = sorted(ts, key=_updated)
        groups.append({
            "key": iid,
            "kind": "inspiration",
            "label": iid,
            "rounds": sorted({r for t in ts_sorted
                              if (r := round_tag(str(t.get("title") or "")))}),
            "tasks": [t.get("id") for t in ts_sorted],
            "solved": _solved_line(ts_sorted),
            "related_inspirations": sorted({
                str(x) for t in ts_sorted for x in (t.get("inspirations") or [])
                if str(x) != iid
            }),
        })

    # 无灵感任务：按轮次标记成批
    by_round: dict[str, list[dict]] = {}
    loose: list[dict] = []
    for t in no_insp:
        tag = round_tag(str(t.get("title") or ""))
        if tag:
            by_round.setdefault(tag, []).append(t)
        else:
            loose.append(t)
    for tag, ts in by_round.items():
        ts_sorted = sorted(ts, key=_updated)
        groups.append({
            "key": f"round-{tag}",
            "kind": "round",
            "label": f"{tag} 轮",
            "rounds": [tag],
            "tasks": [t.get("id") for t in ts_sorted],
            "solved": _solved_line(ts_sorted),
            "related_inspirations": [],
        })
    if loose:
        ts_sorted = sorted(loose, key=_updated)
        groups.append({
            "key": "unclassified",
            "kind": "unclassified",
            "label": "未归类",
            "rounds": [],
            "tasks": [t.get("id") for t in ts_sorted],
            "solved": _solved_line(ts_sorted),
            "related_inspirations": [],
        })

    # 排序：有灵感的在前（可审计），未归类垫底
    rank = {"inspiration": 0, "round": 1, "unclassified": 2}
    groups.sort(key=lambda g: (rank.get(g["kind"], 9), g["key"]))
    return {
        "groups": groups,
        "edges": _lineage_edges(tasks),
        "unclassified": [t.get("id") for t in loose],
    }


def _solved_line(ts: list[dict]) -> str:
    """「这一组解决了什么」——用已 collected 的 brief 拼，不新写文案。"""
    briefs = [str((t.get("outcomes") or {}).get("brief") or "").strip() for t in ts]
    briefs = [b for b in briefs if b]
    if not briefs:
        return ""
    if len(briefs) == 1:
        return briefs[0][:120]
    return f"{briefs[0][:80]} …（共 {len(briefs)} 条结论）"


def _lineage_edges(tasks: list[dict]) -> list[dict]:
    """脉络边：`supersedes` / `depends_on`（字段存在才算，不猜）。"""
    out = []
    known = {str(t.get("id")) for t in tasks}
    for t in tasks:
        for rel in ("supersedes", "depends_on"):
            for other in (t.get(rel) or []):
                other = str(other)
                if other in known:
                    out.append({"from": t.get("id"), "rel": rel, "to": other})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="看板归类与脉络化（只读，不写回）")
    ap.add_argument("--status", default=None, help="按状态过滤；all=不过滤")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    board = B.load()
    tasks = list(board.get("tasks") or [])
    if a.status and a.status != "all":
        tasks = [t for t in tasks if str(t.get("status")) == a.status]

    res = cluster(tasks)
    res["ok"] = True
    res["tasks_scanned"] = len(tasks)
    res["note"] = "分类现算自带字段，不写回 board.json（不造第二套真相）"

    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    print(f"扫描 {len(tasks)} 个任务 → {len(res['groups'])} 组\n")
    for g in res["groups"]:
        kind = {"inspiration": "灵感衍生", "round": "轮次批量",
                "unclassified": "未归类"}[g["kind"]]
        print(f"◈ {g['label']}（{kind}，{len(g['tasks'])} 个）")
        if g.get("rounds"):
            print(f"   轮次：{', '.join(r + ' 轮' for r in g['rounds'])}")
        if g["solved"]:
            print(f"   解决了：{g['solved']}")
        print(f"   任务：{', '.join(g['tasks'])}")
        if g["related_inspirations"]:
            print(f"   另关联：{', '.join(g['related_inspirations'])}")
        print()
    if res["edges"]:
        print("脉络边：")
        for e in res["edges"]:
            print(f"   {e['from']} --{e['rel']}--> {e['to']}")
    else:
        print("脉络边：无（任务里没有 supersedes / depends_on 字段）")
    if res["unclassified"]:
        print(f"\n未归类 {len(res['unclassified'])} 个：{', '.join(res['unclassified'])}")
        print("（未归类不代表有问题：没挂灵感又没写轮次标记的任务，本就无处可归）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
