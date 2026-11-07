#!/usr/bin/env python
"""任务看板 / 灵感看板 CLI —— agent 侧对 `.rsi/board.json` 的唯一写口。

为什么是 CLI 而不是技能工具：技能工具（skills/*/tools.json）装载后默认**未启用**，需用户在
设置面板批准；bash 是缺省启用集。若 agent 的写作通道依赖「要人点一下才生效」的入口，任务
看板的闭环就断在配置上。故 CLI 是保证通道，`skills/rsi-board/` 只承载「怎么想、怎么写」。

数据契约见 `docs/self-evolution/01-单会话与任务看板.md` §2；Rust 侧 `host/src/web/api/board.rs`
是同一份契约的只读+灵感写实现（UI 用）。两侧共享三条纪律：
  1. 读 → 改 → 写，按 id 合并，不做整表覆盖（两边并发写不互相吞条目）；
  2. 写盘 tmp + 原子替换（半截 JSON 永不落地）；
  3. 状态枚举封闭、字段长度与条数上限固定（越界即拒，不静默截断）。

用法：
    python scripts/board.py list [--status doing] [--compact]
    python scripts/board.py show T-20261107-01
    python scripts/board.py stats
    python scripts/board.py task-upsert --file plan.json        # JSON 文件或 - 读 stdin
    python scripts/board.py task-status T-20261107-01 doing --note "开始改 Rust"
    python scripts/board.py task-progress T-20261107-01 3/5 --note "路由已通"
    python scripts/board.py task-append T-... --artifact outputs/x.md
    python scripts/board.py insp-add "左栏应该只有任务与灵感" --tags ui,idea
    python scripts/board.py insp-set I-20261107-01 adopted
    python scripts/board.py insp-adopt I-20261107-01 T-20261107-01
    python scripts/board.py refresh            # 只会重建缺失字段（不删条目）

退出码：0 成功；1 业务失败（打印 {"ok":false,"error":{...}}）；2 参数错。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── 契约常量（与 Rust 侧 board.rs 逐字一致；改一侧必须改另一侧）────────────────
TASK_STATUSES = ("planning", "doing", "verifying", "done", "blocked", "cancelled")
PLAN_STATUSES = ("pending", "in_progress", "completed", "cancelled")
PRIORITIES = ("P0", "P1", "P2", "P3")
EFFORTS = ("small", "medium", "large")
INSP_STATUSES = ("open", "adopted", "archived")
MAX_TASKS = 200
MAX_INSP = 500
MAX_PLAN = 50
MAX_ACCEPTANCE = 30
MAX_TAGS = 10
MAX_TITLE = 120
MAX_GOAL = 500
MAX_STEP = 200
MAX_NOTE = 500
MAX_INSP_TEXT = 2000
MAX_TAG = 32
MAX_ID = 40

TASK_ID_RE = re.compile(r"^T-\d{8}-\d{2,3}$")
INSP_ID_RE = re.compile(r"^I-\d{8}-\d{2,3}$")


class BoardError(Exception):
    """业务错误：带 code/field，CLI 出口统一序列化。"""

    def __init__(self, message: str, code: str = "BAD_ARG", field: str | None = None):
        super().__init__(message)
        self.code = code
        self.field = field


# ── 路径与时钟 ────────────────────────────────────────────────────────────────


def workspace_root() -> Path:
    env = os.environ.get("WORKSPACE_ROOT", "").strip()
    return Path(env) if env else Path.cwd()


def board_path() -> Path:
    """`RSI_BOARD_PATH`（工作区相对或绝对）覆盖，缺省 `<WORKSPACE_ROOT>/.rsi/board.json`。"""
    env = os.environ.get("RSI_BOARD_PATH", "").strip()
    p = Path(env) if env else Path(".rsi") / "board.json"
    if not p.is_absolute():
        p = workspace_root() / p
    return p


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today() -> str:
    return datetime.now().strftime("%Y%m%d")


# ── 读写 ─────────────────────────────────────────────────────────────────────


def empty_board() -> dict:
    return {"version": 1, "updated_at": now_iso(), "tasks": [], "inspirations": []}


def load() -> dict:
    """读板。缺文件 → 空板；坏 JSON → 空板 + corrupt 标记（调用方决定是否提示，绝不静默覆盖坏文件）。"""
    p = board_path()
    if not p.is_file():
        return empty_board()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        board = empty_board()
        board["corrupt"] = True
        return board
    if not isinstance(raw, dict):
        board = empty_board()
        board["corrupt"] = True
        return board
    board = empty_board()
    for k in ("tasks", "inspirations"):
        v = raw.get(k)
        if isinstance(v, list):
            board[k] = [x for x in v if isinstance(x, dict)]
    board["updated_at"] = str(raw.get("updated_at") or board["updated_at"])
    return board


def save(board: dict) -> Path:
    p = board_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    board["version"] = 1
    board["updated_at"] = now_iso()
    board.pop("corrupt", None)
    tmp = p.parent / (p.name + ".tmp")
    tmp.write_text(json.dumps(board, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, p)  # 原子替换：崩溃不留半截 JSON
    return p


# ── 校验 ─────────────────────────────────────────────────────────────────────


def _str(v, field: str, limit: int, required: bool = True) -> str:
    if v is None:
        if required:
            raise BoardError(f"{field} 不能为空", field=field)
        return ""
    if not isinstance(v, str):
        raise BoardError(f"{field} 必须是字符串", field=field)
    s = v.strip()
    if required and not s:
        raise BoardError(f"{field} 不能为空", field=field)
    if len(s) > limit:
        raise BoardError(f"{field} 超过 {limit} 字符", field=field)
    return s


def _enum(v, field: str, allowed: tuple, default: str | None = None) -> str:
    if v is None:
        if default is not None:
            return default
        raise BoardError(f"{field} 缺失（可选 {list(allowed)}）", field=field)
    if not isinstance(v, str) or v not in allowed:
        raise BoardError(f"{field} 必须是 {list(allowed)} 之一，收到 {v!r}", field=field)
    return v


def _str_list(v, field: str, limit_item: int, limit_count: int) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise BoardError(f"{field} 必须是数组", field=field)
    if len(v) > limit_count:
        raise BoardError(f"{field} 最多 {limit_count} 项", field=field)
    out = []
    for i, x in enumerate(v):
        out.append(_str(x, f"{field}[{i}]", limit_item))
    return out


def _next_id(items: list[dict], prefix: str, pattern: re.Pattern) -> str:
    stamp = today()
    used = {str(t.get("id", "")) for t in items}
    for n in range(1, 100):
        cand = f"{prefix}-{stamp}-{n:02d}"
        if cand not in used:
            return cand
    raise BoardError(f"{prefix} 当日 ID 已用尽（>99）", code="ID_EXHAUSTED", field="id")


def validate_task(raw: dict, existing: dict | None) -> dict:
    """把外部 JSON 规整为合法任务；未给字段沿用 existing（更新语义），新任务给缺省。"""
    base = dict(existing or {})
    task = {
        "id": _str(raw.get("id") or base.get("id"), "id", MAX_ID),
        "title": _str(raw.get("title") if "title" in raw else base.get("title"), "title", MAX_TITLE),
        "status": _enum(
            raw.get("status") if "status" in raw else base.get("status"),
            "status", TASK_STATUSES, default="planning",
        ),
        "priority": _enum(
            raw.get("priority") if "priority" in raw else base.get("priority"),
            "priority", PRIORITIES, default="P2",
        ),
        "goal": _str(raw.get("goal") if "goal" in raw else base.get("goal"), "goal", MAX_GOAL, required=False),
    }
    if not TASK_ID_RE.match(task["id"]):
        raise BoardError(f"id 形状不合法（应形如 T-20261107-01），收到 {task['id']!r}", field="id")

    # plan：给了就整表替换（与 todo 工具同款「全量替换」语义，避免增量合并歧义）
    plan_raw = raw.get("plan") if "plan" in raw else base.get("plan")
    plan = []
    if isinstance(plan_raw, list):
        if len(plan_raw) > MAX_PLAN:
            raise BoardError(f"plan 最多 {MAX_PLAN} 步", field="plan")
        for i, st in enumerate(plan_raw):
            if not isinstance(st, dict):
                raise BoardError(f"plan[{i}] 必须是对象", field="plan")
            plan.append({
                "step": _str(st.get("step"), f"plan[{i}].step", MAX_STEP),
                "status": _enum(st.get("status"), f"plan[{i}].status", PLAN_STATUSES, default="pending"),
            })
    elif plan_raw is not None:
        raise BoardError("plan 必须是数组", field="plan")
    task["plan"] = plan

    # resourcing：人财物
    res_raw = raw.get("resourcing") if "resourcing" in raw else base.get("resourcing")
    res_raw = res_raw if isinstance(res_raw, dict) else {}
    prev_res = base.get("resourcing") if isinstance(base.get("resourcing"), dict) else {}
    effort_raw = res_raw.get("effort", prev_res.get("effort"))
    budget_raw = res_raw.get("budget_secs", prev_res.get("budget_secs", 0))
    if isinstance(budget_raw, bool) or not isinstance(budget_raw, int) or budget_raw < 0:
        raise BoardError("resourcing.budget_secs 必须是非负整数（0=不限）", field="resourcing.budget_secs")
    task["resourcing"] = {
        "model": _str(res_raw.get("model", prev_res.get("model", "current")),
                      "resourcing.model", 64, required=False) or "current",
        "effort": _enum(effort_raw, "resourcing.effort", EFFORTS, default="medium"),
        "skills": _str_list(res_raw.get("skills", prev_res.get("skills")), "resourcing.skills", 64, 20),
        "tools": _str_list(res_raw.get("tools", prev_res.get("tools")), "resourcing.tools", 64, 20),
        "budget_secs": budget_raw,
    }

    task["acceptance"] = _str_list(
        raw.get("acceptance", base.get("acceptance")), "acceptance", 300, MAX_ACCEPTANCE
    )

    # 验收闸：进 verifying/done 时 acceptance 不得为空（提示级——回写 warn 不阻断，
    # 因为「改一个错别字」这类任务写不出有意义验收项，硬闸会逼模型编造）。
    progresses = [s for s in plan if s["status"] in ("completed", "in_progress")]
    done = sum(1 for s in plan if s["status"] == "completed")
    prog_raw = raw.get("progress") if isinstance(raw.get("progress"), dict) else {}
    prev_prog = base.get("progress") if isinstance(base.get("progress"), dict) else {}
    total = prog_raw.get("total", len(plan) if plan else prev_prog.get("total", 0))
    done_n = prog_raw.get("done", done if plan else prev_prog.get("done", 0))
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise BoardError("progress.total 必须是非负整数", field="progress.total")
    if isinstance(done_n, bool) or not isinstance(done_n, int) or done_n < 0:
        raise BoardError("progress.done 必须是非负整数", field="progress.done")
    task["progress"] = {
        "done": min(done_n, total) if total else done_n,
        "total": total,
        "note": _str(prog_raw.get("note", prev_prog.get("note")), "progress.note", MAX_NOTE, required=False),
    }
    task["inspirations"] = _str_list(
        raw.get("inspirations", base.get("inspirations")), "inspirations", MAX_ID, 20
    )
    task["artifacts"] = _str_list(raw.get("artifacts", base.get("artifacts")), "artifacts", 300, 50)
    task["session"] = _str(raw.get("session", base.get("session", "main")), "session", 64, required=False) or "main"
    task["created_at"] = str(base.get("created_at") or now_iso())
    task["updated_at"] = now_iso()
    del progresses
    return task


def check_acceptance_warning(task: dict) -> str | None:
    if task["status"] in ("verifying", "done") and not task["acceptance"]:
        return (
            "acceptance 为空却已进入 "
            f"{task['status']}：没有验收标准的「完成」不可核对，请补 1-3 条可判定的验收条目。"
        )
    return None


# ── 命令 ─────────────────────────────────────────────────────────────────────


def cmd_list(args: argparse.Namespace) -> dict:
    board = load()
    tasks = board["tasks"]
    if args.status:
        _enum(args.status, "status", TASK_STATUSES)
        tasks = [t for t in tasks if t.get("status") == args.status]
    tasks = sorted(tasks, key=lambda t: (PRIORITIES.index(t.get("priority", "P2"))
                                         if t.get("priority") in PRIORITIES else 9,
                                         str(t.get("updated_at", ""))), reverse=False)
    order = {s: i for i, s in enumerate(TASK_STATUSES)}
    tasks = sorted(tasks, key=lambda t: order.get(str(t.get("status", "planning")), 99))
    if args.compact:
        tasks = [{k: t.get(k) for k in ("id", "title", "status", "priority", "progress")} for t in tasks]
    out = {"ok": True, "path": str(board_path()), "tasks": tasks, "total": len(tasks)}
    if board.get("corrupt"):
        out["corrupt"] = True
        out["note"] = "board.json 解析失败，已按空板返回；原文件未改动，请人工核对"
    return out


def cmd_show(args: argparse.Namespace) -> dict:
    board = load()
    for t in board["tasks"]:
        if t.get("id") == args.id:
            return {"ok": True, "task": t, "path": str(board_path())}
    for i in board["inspirations"]:
        if i.get("id") == args.id:
            return {"ok": True, "inspiration": i, "path": str(board_path())}
    raise BoardError(f"未找到 {args.id}", code="NOT_FOUND", field="id")


def cmd_stats(args: argparse.Namespace) -> dict:
    board = load()
    counts = {s: 0 for s in TASK_STATUSES}
    for t in board["tasks"]:
        counts[t.get("status", "planning")] = counts.get(t.get("status", "planning"), 0) + 1
    insp = {s: 0 for s in INSP_STATUSES}
    for i in board["inspirations"]:
        insp[i.get("status", "open")] = insp.get(i.get("status", "open"), 0) + 1
    return {
        "ok": True,
        "path": str(board_path()),
        "tasks": {"total": len(board["tasks"]), "by_status": counts},
        "inspirations": {"total": len(board["inspirations"]), "by_status": insp},
        "updated_at": board.get("updated_at"),
    }


def cmd_task_upsert(args: argparse.Namespace) -> dict:
    raw_text = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8")
    try:
        raw = json.loads(raw_text)
    except ValueError as e:
        raise BoardError(f"JSON 解析失败: {e}", field="file") from e
    if not isinstance(raw, dict):
        raise BoardError("顶层必须是对象", field="file")
    board = load()
    existing = None
    if not raw.get("id"):
        raw["id"] = _next_id(board["tasks"], "T", TASK_ID_RE)
    for t in board["tasks"]:
        if t.get("id") == raw["id"]:
            existing = t
            break
    task = validate_task(raw, existing)
    if existing is None and len(board["tasks"]) >= MAX_TASKS:
        raise BoardError(f"任务数已达上限 {MAX_TASKS}，请先归档/清理已完成的旧任务", code="LIMIT",
                         field="tasks")
    merged = [t for t in board["tasks"] if t.get("id") != task["id"]] + [task]
    order = {s: i for i, s in enumerate(TASK_STATUSES)}
    board["tasks"] = sorted(merged, key=lambda t: order.get(str(t.get("status")), 99))
    save(board)
    out = {"ok": True, "id": task["id"], "created": existing is None, "path": str(board_path())}
    warn = check_acceptance_warning(task)
    if warn:
        out["warning"] = warn
    return out


def cmd_task_status(args: argparse.Namespace) -> dict:
    status = _enum(args.status, "status", TASK_STATUSES)
    board = load()
    for t in board["tasks"]:
        if t.get("id") == args.id:
            t["status"] = status
            t["updated_at"] = now_iso()
            if args.note:
                t.setdefault("progress", {})
                if isinstance(t["progress"], dict):
                    t["progress"]["note"] = _str(args.note, "progress.note", MAX_NOTE, required=False)
            save(board)
            out = {"ok": True, "id": args.id, "status": status}
            warn = check_acceptance_warning(t)
            if warn:
                out["warning"] = warn
            return out
    raise BoardError(f"未找到任务 {args.id}", code="NOT_FOUND", field="id")


def cmd_task_progress(args: argparse.Namespace) -> dict:
    if "/" not in args.ratio:
        raise BoardError("进度格式应为 done/total（如 3/5）", field="ratio")
    d, _, t = args.ratio.partition("/")
    try:
        done, total = int(d), int(t)
    except ValueError as e:
        raise BoardError("进度两端必须是整数（如 3/5）", field="ratio") from e
    if done < 0 or total < 0:
        raise BoardError("进度不能为负", field="ratio")
    board = load()
    for task in board["tasks"]:
        if task.get("id") == args.id:
            prev = task.get("progress") if isinstance(task.get("progress"), dict) else {}
            task["progress"] = {
                "done": min(done, total) if total else done,
                "total": total,
                "note": _str(args.note if args.note is not None else prev.get("note"),
                             "progress.note", MAX_NOTE, required=False),
            }
            if task.get("status") in ("planning",) and done > 0:
                task["status"] = "doing"  # 有进展即离开始计划态（省一次显式调用）
            task["updated_at"] = now_iso()
            save(board)
            return {"ok": True, "id": args.id, "progress": task["progress"], "status": task.get("status")}
    raise BoardError(f"未找到任务 {args.id}", code="NOT_FOUND", field="id")


def cmd_task_append(args: argparse.Namespace) -> dict:
    board = load()
    for task in board["tasks"]:
        if task.get("id") == args.id:
            arts = task.get("artifacts") if isinstance(task.get("artifacts"), list) else []
            insps = task.get("inspirations") if isinstance(task.get("inspirations"), list) else []
            if args.artifact:
                for a in args.artifact:
                    _str(a, "artifact", 300)
                    if a not in arts:
                        arts.append(a)
            if args.inspiration:
                for i in args.inspiration:
                    _str(i, "inspiration", MAX_ID)
                    if i not in insps:
                        insps.append(i)
            if len(arts) > 50 or len(insps) > 20:
                raise BoardError("artifacts ≤50 / inspirations ≤20", field="task")
            task["artifacts"], task["inspirations"] = arts, insps
            task["updated_at"] = now_iso()
            save(board)
            return {"ok": True, "id": args.id, "artifacts": arts, "inspirations": insps}
    raise BoardError(f"未找到任务 {args.id}", code="NOT_FOUND", field="id")


def cmd_insp_add(args: argparse.Namespace) -> dict:
    text = _str(args.text, "text", MAX_INSP_TEXT)
    tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
    tags = [_str(t, f"tags[{i}]", MAX_TAG) for i, t in enumerate(tags)]
    if len(tags) > MAX_TAGS:
        raise BoardError(f"tags 最多 {MAX_TAGS} 个", field="tags")
    board = load()
    if len(board["inspirations"]) >= MAX_INSP:
        raise BoardError(f"灵感数已达上限 {MAX_INSP}，请先归档", code="LIMIT", field="inspirations")
    item = {
        "id": _next_id(board["inspirations"], "I", INSP_ID_RE),
        "text": text,
        "tags": tags,
        "status": "open",
        "tasks": [],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    board["inspirations"] = [item] + board["inspirations"]
    save(board)
    return {"ok": True, "id": item["id"], "path": str(board_path())}


def cmd_insp_set(args: argparse.Namespace) -> dict:
    status = _enum(args.status, "status", INSP_STATUSES)
    board = load()
    for item in board["inspirations"]:
        if item.get("id") == args.id:
            item["status"] = status
            item["updated_at"] = now_iso()
            save(board)
            return {"ok": True, "id": args.id, "status": status}
    raise BoardError(f"未找到灵感 {args.id}", code="NOT_FOUND", field="id")


def cmd_insp_adopt(args: argparse.Namespace) -> dict:
    board = load()
    task = next((t for t in board["tasks"] if t.get("id") == args.task), None)
    if task is None:
        raise BoardError(f"未找到任务 {args.task}", code="NOT_FOUND", field="task")
    item = next((i for i in board["inspirations"] if i.get("id") == args.id), None)
    if item is None:
        raise BoardError(f"未找到灵感 {args.id}", code="NOT_FOUND", field="id")
    insps = task.get("inspirations") if isinstance(task.get("inspirations"), list) else []
    if args.id not in insps:
        insps.append(args.id)
    task["inspirations"] = insps
    task["updated_at"] = now_iso()
    tasks = item.get("tasks") if isinstance(item.get("tasks"), list) else []
    if args.task not in tasks:
        tasks.append(args.task)
    item["tasks"] = tasks
    item["status"] = "adopted"
    item["updated_at"] = now_iso()
    save(board)
    return {"ok": True, "inspiration": args.id, "task": args.task}


def cmd_refresh(args: argparse.Namespace) -> dict:
    """只补缺失字段，不删条目：修手改坏的板子时安全。"""
    board = load()
    fixed = 0
    for t in board["tasks"]:
        for key, default in (("status", "planning"), ("priority", "P2"), ("plan", []),
                             ("acceptance", []), ("inspirations", []), ("artifacts", [])):
            if key not in t:
                t[key] = default
                fixed += 1
        if not isinstance(t.get("resourcing"), dict):
            t["resourcing"] = {"model": "current", "effort": "medium", "skills": [], "tools": [], "budget_secs": 0}
            fixed += 1
        if not isinstance(t.get("progress"), dict):
            t["progress"] = {"done": 0, "total": 0, "note": ""}
            fixed += 1
    for i in board["inspirations"]:
        for key, default in (("tags", []), ("tasks", []), ("status", "open")):
            if key not in i:
                i[key] = default
                fixed += 1
    save(board)
    return {"ok": True, "fixed": fixed, "path": str(board_path())}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="任务看板 / 灵感看板 CLI（.rsi/board.json）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="列出任务")
    p.add_argument("--status", default="")
    p.add_argument("--compact", action="store_true")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("show", help="查看任务或灵感详情")
    p.add_argument("id")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("stats", help="计数概览")
    p.set_defaults(fn=cmd_stats)

    p = sub.add_parser("task-upsert", help="新建或更新任务（JSON 文件或 - 读 stdin）")
    p.add_argument("--file", required=True)
    p.set_defaults(fn=cmd_task_upsert)

    p = sub.add_parser("task-status", help="改任务状态")
    p.add_argument("id")
    p.add_argument("status")
    p.add_argument("--note", default=None)
    p.set_defaults(fn=cmd_task_status)

    p = sub.add_parser("task-progress", help="改进度 done/total")
    p.add_argument("id")
    p.add_argument("ratio")
    p.add_argument("--note", default=None)
    p.set_defaults(fn=cmd_task_progress)

    p = sub.add_parser("task-append", help="追加产物/关联灵感")
    p.add_argument("id")
    p.add_argument("--artifact", action="append")
    p.add_argument("--inspiration", action="append")
    p.set_defaults(fn=cmd_task_append)

    p = sub.add_parser("insp-add", help="记一条灵感")
    p.add_argument("text")
    p.add_argument("--tags", default="")
    p.set_defaults(fn=cmd_insp_add)

    p = sub.add_parser("insp-set", help="改灵感状态")
    p.add_argument("id")
    p.add_argument("status")
    p.set_defaults(fn=cmd_insp_set)

    p = sub.add_parser("insp-adopt", help="灵感被任务采纳")
    p.add_argument("id")
    p.add_argument("task")
    p.set_defaults(fn=cmd_insp_adopt)

    p = sub.add_parser("refresh", help="补齐缺失字段（不删条目）")
    p.set_defaults(fn=cmd_refresh)
    return ap


def main(argv: list[str] | None = None) -> int:
    ns = build_parser().parse_args(argv)
    try:
        out = ns.fn(ns)
    except BoardError as e:
        err = {"code": e.code, "message": str(e)}
        if e.field:
            err["field"] = e.field
        print(json.dumps({"ok": False, "error": err}, ensure_ascii=False))
        return 1
    except OSError as e:
        print(json.dumps({"ok": False, "error": {"code": "IO_ERROR", "message": str(e)}}, ensure_ascii=False))
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
