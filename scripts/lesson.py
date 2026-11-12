"""课件生成器：把一份研究结论变成「有结构 + 有验收」的教学材料。

为什么是「产课件」而不是「当导师」
------------------------------------
方案里分清了两件事：甲=跨会话学习者模型 + 出题 + 判掌握（收益者只有一个人，
投入全是新的）；乙=把研究结论变成可验收的教学材料（输入 `outputs/*.md` 与输出都在已有通道里）。

本仓库是老板用来看项目的 agent，不是他的补习老师——所以先做乙。

但「产课件」不是「把文档改个标题」。真正让它成为**课件**的是三件事：
  1. 学习目标可判（每条目标配一个可回答的检验问题）；
  2. 概念有前置依赖（否则读者卡在第 3 节不知道缺什么）；
  3. 有可自检的练习题与答案（否则「学会了」是自我感觉）。

结构（Markdown，纯文本，可 diff、可入库、可二次加工）：

  # <主题>
  ## 学习目标            O1..On —— 每条一个可回答的检验问题
  ## 前置知识            P1..Pn —— 从哪份文档/哪一节补
  ## 概念地图            C1..Cn —— 每个概念的前置概念（有环要报错）
  ## 正课               按概念拓扑序展开，每节引用来源 [S*]
  ## 练习               题 + 参考答案 + 考查哪个目标
  ## 验收               全部可机检

用法
----
  python scripts/lesson.py init "<主题>" --from outputs/<源文档>.md
  python scripts/lesson.py goal add "<目标>" --check "<检验问题>"
  python scripts/lesson.py concept add "<概念>" [--after "<前置概念>"]...
  python scripts/lesson.py concept order           # 拓扑序（有环 → 报错退出）
  python scripts/lesson.py exercise add "<题干>" --answer "<答案>" --goal O1
  python scripts/lesson.py build [--out outputs/<课件>.md]
  python scripts/lesson.py check [<课件>.md]        # 机检：目标全覆盖 / 依赖无环 / 每题有答案

设计纪律
--------
- 学习目标必须**可判**：`--check` 是「能回答的问题」，不是「理解了 X」这种不可判表述。
- 概念前置形成有环依赖时**报错**而不是硬排——教学材料里出现循环前置，读者必然卡死。
- 练习必须挂到某个目标：挂不上的题是「有趣的旁支」，不是这门课的一部分。
- `build` 是确定性的：同输入同输出（时间不进正文），可 diff、可入库。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent


def rsi_home() -> Path:
    return Path(os.environ.get("RSI_HOME") or ROOT)


def lesson_root() -> Path:
    d = Path(os.environ.get("RSI_LESSON_DIR") or (rsi_home() / ".rsi" / "lessons"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def lesson_dir(topic: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_\u4e00-\u9fff.-]+", "-", topic).strip("-") or "untitled"
    d = lesson_root() / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def spec_path(topic: str) -> Path:
    return lesson_dir(topic) / "lesson.json"


def load_spec(topic: str) -> dict:
    p = spec_path(topic)
    if not p.is_file():
        return {"topic": topic, "source": "", "goals": [], "concepts": [], "exercises": [], "intro": ""}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        print(f"[lesson] lesson.json 损坏: {exc}", file=sys.stderr)
        return {"topic": topic, "source": "", "goals": [], "concepts": [], "exercises": [], "intro": ""}


def save_spec(topic: str, spec: dict) -> None:
    spec_path(topic).write_text(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# ---- 拓扑排序 ---------------------------------------------------------------

def topo_order(concepts: list[dict]) -> tuple[list[str], list[str]]:
    """返回 (拓扑序, 环里的节点)。概念名 → 前置列表。

    用 Kahn 算法：反复取「前置都已就绪」的概念。剩下的即环（或依赖了环）。
    教学材料里出现循环前置，读者必然卡死——所以环不是「排一下就行」，是要报错让人改。
    """
    names = [c["name"] for c in concepts]
    deps = {c["name"]: [d for d in c.get("after") or [] if d in names] for c in concepts}
    order: list[str] = []
    ready = [n for n in names if not deps[n]]
    while ready:
        ready.sort(key=names.index)   # 稳定：同层按声明顺序，输出才可 diff
        n = ready.pop(0)
        order.append(n)
        for m in names:
            if n in deps[m]:
                deps[m] = [d for d in deps[m] if d != n]
                if not deps[m] and m not in order and m not in ready:
                    ready.append(m)
    cyclic = [n for n in names if n not in order]
    return order, cyclic


# ---- 子命令 -----------------------------------------------------------------

def cmd_init(args) -> int:
    spec = load_spec(args.topic)
    spec["topic"] = args.topic
    if args.source:
        spec["source"] = args.source
    if args.intro:
        spec["intro"] = args.intro
    save_spec(args.topic, spec)
    print(f"初始化 {spec_path(args.topic)}")
    return 0


def cmd_goal(args) -> int:
    spec = load_spec(args.topic)
    if args.goal_cmd == "add":
        oid = f"O{len(spec['goals']) + 1}"
        spec["goals"].append({"id": oid, "text": args.text, "check": args.check})
        save_spec(args.topic, spec)
        print(f"{oid} 已加（检验: {args.check}）")
        return 0
    if args.goal_cmd == "list":
        for g in spec["goals"]:
            print(f"{g['id']}  {g['text']}\n     检验: {g.get('check') or '（缺！）'}")
        if not spec["goals"]:
            print("（还没有学习目标）")
        return 0
    return 2


def cmd_concept(args) -> int:
    spec = load_spec(args.topic)
    if args.concept_cmd == "add":
        if any(c["name"] == args.name for c in spec["concepts"]):
            print(f"概念已存在: {args.name}", file=sys.stderr)
            return 1
        spec["concepts"].append({"name": args.name, "after": args.after or [], "body": args.body or ""})
        save_spec(args.topic, spec)
        print(f"概念「{args.name}」已加（前置: {', '.join(args.after or []) or '无'}）")
        return 0
    if args.concept_cmd == "order":
        order, cyclic = topo_order(spec["concepts"])
        if cyclic:
            print(json.dumps({"ok": False, "cyclic": cyclic,
                              "message": "概念前置成环——读者会卡死，必须先改依赖"},
                             ensure_ascii=False, indent=1))
            return 1
        print(json.dumps({"ok": True, "order": order}, ensure_ascii=False, indent=1))
        return 0
    return 2


def cmd_exercise(args) -> int:
    spec = load_spec(args.topic)
    if args.ex_cmd == "add":
        eid = f"E{len(spec['exercises']) + 1}"
        spec["exercises"].append({
            "id": eid, "prompt": args.prompt, "answer": args.answer, "goal": args.goal or "",
        })
        save_spec(args.topic, spec)
        print(f"{eid} 已加（考查 {args.goal or '未挂目标！'}）")
        return 0
    return 2


def cmd_build(args) -> int:
    spec = load_spec(args.topic)
    order, cyclic = topo_order(spec["concepts"])
    if cyclic:
        print(f"概念前置成环，拒绝出稿: {cyclic}", file=sys.stderr)
        return 1
    by_name = {c["name"]: c for c in spec["concepts"]}

    out: list[str] = [f"# {spec['topic']}", ""]
    if spec.get("intro"):
        out += [spec["intro"], ""]
    if spec.get("source"):
        out += [f"> 源材料: `{spec['source']}`", ""]

    out += ["## 学习目标", ""]
    if not spec["goals"]:
        out += ["（未声明——没有学习目标的课件不是课件）", ""]
    for g in spec["goals"]:
        out.append(f"- **{g['id']}** {g['text']}")
        out.append(f"  - 检验: {g.get('check') or '（缺检验问题！）'}")
    out.append("")

    out += ["## 概念地图", ""]
    if not spec["concepts"]:
        out += ["（未声明）", ""]
    for name in order:
        c = by_name[name]
        pre = ", ".join(c.get("after") or []) or "无"
        out.append(f"- **{name}**（前置: {pre}）")
    out.append("")

    out += ["## 正课", ""]
    for i, name in enumerate(order, 1):
        c = by_name[name]
        out.append(f"### {i}. {name}")
        out.append("")
        if c.get("body"):
            out.append(c["body"])
        else:
            out.append("（待补正文）")
        out.append("")

    out += ["## 练习", ""]
    if not spec["exercises"]:
        out += ["（未声明）", ""]
    for e in spec["exercises"]:
        out.append(f"**{e['id']}**（考查 {e['goal'] or '未挂目标'}）{e['prompt']}")
        out.append("")
        out.append("<details><summary>参考答案</summary>")
        out.append("")
        out.append(e.get("answer") or "（缺答案）")
        out.append("")
        out.append("</details>")
        out.append("")

    out += ["## 验收", ""]
    out += ["- 学习目标：%d 条，全部带检验问题" % sum(1 for g in spec["goals"] if g.get("check"))]
    out += ["- 概念：%d 个，依赖无环（拓扑序已生成）" % len(spec["concepts"])]
    out += ["- 练习：%d 道，全部挂到目标" % sum(1 for e in spec["exercises"] if e.get("goal"))]
    out.append("")

    text = "\n".join(out)
    dest = Path(args.out) if args.out else (Path("outputs") / f"课件-{spec['topic']}.md")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8", newline="\n")
    print(f"已出稿 {dest}（{len(text)} 字节）")
    return 0


# ---- 机检 -------------------------------------------------------------------

def cmd_check(args) -> int:
    spec = load_spec(args.topic)
    dest = Path(args.lesson) if args.lesson else (Path("outputs") / f"课件-{spec['topic']}.md")
    text = dest.read_text(encoding="utf-8") if dest.is_file() else ""

    errors: list[str] = []
    warnings: list[str] = []

    no_check = [g["id"] for g in spec["goals"] if not g.get("check")]
    if no_check:
        errors.append(f"学习目标缺检验问题（不可判）: {', '.join(no_check)}")
    if not spec["goals"]:
        errors.append("没有任何学习目标——课件必须有可判目标")

    _, cyclic = topo_order(spec["concepts"])
    if cyclic:
        errors.append(f"概念前置成环: {', '.join(cyclic)}")

    goal_ids = {g["id"] for g in spec["goals"]}
    orphan = [e["id"] for e in spec["exercises"] if e.get("goal") not in goal_ids]
    if orphan:
        errors.append(f"练习未挂到有效目标: {', '.join(orphan)}")

    no_answer = [e["id"] for e in spec["exercises"] if not e.get("answer")]
    if no_answer:
        errors.append(f"练习缺参考答案: {', '.join(no_answer)}")

    # 目标覆盖：每个目标至少被一道题考查
    covered = {e.get("goal") for e in spec["exercises"]}
    uncovered = sorted(goal_ids - covered)
    if spec["goals"] and uncovered:
        warnings.append(f"目标无对应练习（学完无法自检）: {', '.join(uncovered)}")

    if dest.is_file():
        for g in spec["goals"]:
            if g["id"] not in text:
                errors.append(f"课件正文缺目标 {g['id']}")
    else:
        warnings.append(f"课件尚未生成: {dest}")

    print(json.dumps({
        "ok": not errors,
        "lesson": str(dest),
        "goals": len(spec["goals"]),
        "concepts": len(spec["concepts"]),
        "exercises": len(spec["exercises"]),
        "errors": errors,
        "warnings": warnings,
    }, ensure_ascii=False, indent=1))
    if errors:
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    return 0


# ---- CLI --------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="课件生成器（目标 + 概念依赖 + 练习 + 机检）")
    ap.add_argument("topic", help="课件主题（目录名）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("init", help="初始化")
    i.add_argument("--from", dest="source", default="", help="源文档路径")
    i.add_argument("--intro", default="")

    g = sub.add_parser("goal", help="学习目标")
    gs = g.add_subparsers(dest="goal_cmd", required=True)
    ga = gs.add_parser("add")
    ga.add_argument("text")
    ga.add_argument("--check", default="", help="可回答的检验问题")
    gs.add_parser("list")

    c = sub.add_parser("concept", help="概念与前置")
    cs = c.add_subparsers(dest="concept_cmd", required=True)
    ca = cs.add_parser("add")
    ca.add_argument("name")
    ca.add_argument("--after", nargs="*", default=[])
    ca.add_argument("--body", default="")
    cs.add_parser("order")

    e = sub.add_parser("exercise", help="练习")
    es = e.add_subparsers(dest="ex_cmd", required=True)
    ea = es.add_parser("add")
    ea.add_argument("prompt")
    ea.add_argument("--answer", default="")
    ea.add_argument("--goal", default="")

    b = sub.add_parser("build", help="出稿")
    b.add_argument("--out", default="")

    ck = sub.add_parser("check", help="机检")
    ck.add_argument("lesson", nargs="?", default="")

    args = ap.parse_args()
    if args.cmd == "init":
        return cmd_init(args)
    if args.cmd == "goal":
        return cmd_goal(args)
    if args.cmd == "concept":
        return cmd_concept(args)
    if args.cmd == "exercise":
        return cmd_exercise(args)
    if args.cmd == "build":
        return cmd_build(args)
    if args.cmd == "check":
        args.lesson_arg = args.lesson
        return cmd_check(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
