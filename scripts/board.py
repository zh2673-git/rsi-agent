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
# 评价体系（C1）：acceptance = 人读的标准；checks = 机跑的证明；evaluation = 跑出来的结论。
MAX_CHECKS = 30
MAX_CMD = 500
CHECK_KINDS = ("cmd", "file", "grep", "manual")
CHECK_STATUSES = ("pending", "pass", "fail", "skip")
VERDICTS = ("none", "pending", "pass", "fail")
# 受约束的插件化看板（C4）：声明式布局，白名单校验，顺序由 kind 钉死。
LAYOUT_KINDS = ("tasks", "inspirations", "metrics")
GROUP_BYS = ("status", "priority", "skill")
FILTERS = ("all", "open", "done")
METRIC_IDS = ("by_status", "by_skill", "verdict", "acceptance")
MAX_SECTIONS = 6
MAX_SECTION_TITLE = 40
SECTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")

DEFAULT_LAYOUT = {
    "sections": [
        {"id": "tasks", "kind": "tasks", "title": "任务看板", "group_by": "status", "filter": "all", "limit": 30},
        {"id": "insp", "kind": "inspirations", "title": "灵感"},
    ]
}

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
    return {"version": 1, "updated_at": now_iso(), "tasks": [], "inspirations": [],
            "layout": json.loads(json.dumps(DEFAULT_LAYOUT))}


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
    lay = raw.get("layout")
    if isinstance(lay, dict) and isinstance(lay.get("sections"), list):
        board["layout"] = lay
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


def validate_layout(raw: dict) -> dict:
    """受约束的插件化看板（C4）：章节声明式，但**枚举封闭 + 顺序钉死**。

    为什么不是自由排布：用户明确「应该有约束，而不是随意排布」。故这里只允许
    三类章节（tasks/inspirations/metrics）、三种分组维度、三种筛选、四个指标，
    且**章节在文件里的先后不影响渲染顺序**——顺序由 kind 的固定优先级决定
    （tasks → metrics → inspirations），同类内按数组顺序。这样即使配置文件被
    手改成乱序，界面仍稳定可预期。
    """
    if not isinstance(raw, dict):
        raise BoardError("layout 必须是对象", field="layout")
    secs_raw = raw.get("sections")
    if not isinstance(secs_raw, list):
        raise BoardError("layout.sections 必须是数组", field="layout.sections")
    if len(secs_raw) > MAX_SECTIONS:
        raise BoardError(f"layout.sections 最多 {MAX_SECTIONS} 个", field="layout.sections")
    seen: set[str] = set()
    out: list[dict] = []
    for i, s in enumerate(secs_raw):
        if not isinstance(s, dict):
            raise BoardError(f"sections[{i}] 必须是对象", field="sections")
        sid = _str(s.get("id"), f"sections[{i}].id", 24)
        if not SECTION_ID_RE.match(sid):
            raise BoardError(f"sections[{i}].id 形状不合法（小写字母/数字/连字符）", field="sections")
        if sid in seen:
            raise BoardError(f"sections[{i}].id 重复：{sid}", field="sections")
        seen.add(sid)
        kind = _enum(s.get("kind"), f"sections[{i}].kind", LAYOUT_KINDS)
        sec: dict = {"id": sid, "kind": kind,
                     "title": _str(s.get("title"), f"sections[{i}].title", MAX_SECTION_TITLE,
                                   required=False) or sid}
        if kind == "tasks":
            sec["group_by"] = _enum(s.get("group_by"), f"sections[{i}].group_by", GROUP_BYS, default="status")
            sec["filter"] = _enum(s.get("filter"), f"sections[{i}].filter", FILTERS, default="all")
            lim = s.get("limit", 30)
            if isinstance(lim, bool) or not isinstance(lim, int) or not (1 <= lim <= 200):
                raise BoardError(f"sections[{i}].limit 必须是 1..200 的整数", field="sections")
            sec["limit"] = lim
        elif kind == "metrics":
            sec["metrics"] = _str_list(s.get("metrics") or list(METRIC_IDS),
                                      f"sections[{i}].metrics", 16, len(METRIC_IDS))
            bad = [m for m in sec["metrics"] if m not in METRIC_IDS]
            if bad or not sec["metrics"]:
                raise BoardError(f"sections[{i}].metrics 只能是 {list(METRIC_IDS)} 的非空子集，"
                                 f"收到 {bad or '空'}", field="metrics")
        out.append(sec)
    if not out:
        raise BoardError("layout.sections 不能为空（至少一个章节）", field="layout.sections")
    # 顺序钉死：kind 优先级固定，同类内保持声明顺序——配置乱序也不影响渲染。
    rank = {k: n for n, k in enumerate(("tasks", "metrics", "inspirations"))}
    out.sort(key=lambda s: rank[s["kind"]])
    return {"sections": out}


def validate_checks(raw) -> list[dict]:
    """可执行验收（C1）：`cmd`/`file`/`grep` 由 CLI 跑，`manual` 只登记待人判。

    设计取舍：**不在看板里做沙箱**。cmd 走 subprocess 在工作区执行，等于把
    「agent 已经有的 bash 权限」搬到验收环节——问题不是权限，而是**把「我说做完了」
    换成「跑给你看」**。故不做白名单命令，只做：超时、工作区 cwd、输出截断、
    状态机封闭（pending/pass/fail/skip）、结果必须带证据（exit_code/摘录）。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise BoardError("checks 必须是数组", field="checks")
    if len(raw) > MAX_CHECKS:
        raise BoardError(f"checks 最多 {MAX_CHECKS} 条", field="checks")
    out = []
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            raise BoardError(f"checks[{i}] 必须是对象", field="checks")
        kind = _enum(c.get("kind") or "cmd", f"checks[{i}].kind", CHECK_KINDS)
        cid = _str(c.get("id") or f"c{i + 1}", f"checks[{i}].id", 24)
        if not SECTION_ID_RE.match(cid):
            raise BoardError(f"checks[{i}].id 形状不合法", field="checks")
        item: dict = {
            "id": cid,
            "kind": kind,
            "name": _str(c.get("name") or cid, f"checks[{i}].name", MAX_STEP),
            "status": _enum(c.get("status"), f"checks[{i}].status", CHECK_STATUSES, default="pending"),
        }
        if kind in ("cmd", "grep", "file"):
            item["target"] = _str(c.get("target"), f"checks[{i}].target", MAX_CMD)
            if kind == "cmd":
                to = c.get("timeout_secs", 60)
                if isinstance(to, bool) or not isinstance(to, int) or not (1 <= to <= 600):
                    raise BoardError(f"checks[{i}].timeout_secs 必须是 1..600 的整数", field="checks")
                item["timeout_secs"] = to
        out.append(item)
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
    # C1 评价体系：人读的标准（acceptance）+ 机跑的证明（checks）+ 跑出来的结论（evaluation）。
    if "checks" in raw:
        task["checks"] = validate_checks(raw.get("checks"))
    else:
        task["checks"] = validate_checks(base.get("checks"))
    evaluation = base.get("evaluation") if isinstance(base.get("evaluation"), dict) else {}
    task["evaluation"] = {
        "verdict": _enum(evaluation.get("verdict"), "evaluation.verdict", VERDICTS, default="none"),
        "ran_at": _str(evaluation.get("ran_at"), "evaluation.ran_at", 40, required=False),
        "pass": int(evaluation.get("pass") or 0) if isinstance(evaluation.get("pass"), (int, float)) else 0,
        "fail": int(evaluation.get("fail") or 0) if isinstance(evaluation.get("fail"), (int, float)) else 0,
        "skip": int(evaluation.get("skip") or 0) if isinstance(evaluation.get("skip"), (int, float)) else 0,
        "note": _str(evaluation.get("note"), "evaluation.note", MAX_NOTE, required=False),
    }

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
    # C1：登记了可执行检查却没跑（或跑挂了）就宣告完成——这是「自证」而不是「证据」。
    checks = task.get("checks") or []
    verdict = (task.get("evaluation") or {}).get("verdict", "none")
    if checks and task["status"] == "done" and verdict != "pass":
        return (
            f"checks 有 {len(checks)} 条但 evaluation.verdict={verdict} 却已 done："
            "请先跑 `python scripts/board.py eval <ID>`，全 PASS 再收尾。"
        )
    return None


# ── 命令 ─────────────────────────────────────────────────────────────────────


def _run_check(check: dict, ws: Path) -> dict:
    """跑一条可执行验收，返回 {status, evidence}。超过 scope 的条目记 skip 而非 fail：

    - `manual` 永远 skip（待人判，agent 不能自己给自己判过）；
    - `file` 只判存在性（内容判定交给 grep）；
    - `grep` 走纯 Python 扫描（不引第三方、不依赖 PATH 里的 findstr）；
    - `cmd` 走 shell，超时或非零退出即 fail，输出尾部 400 字进 evidence。
    """
    kind = check.get("kind")
    ev: dict = {"at": now_iso()}
    if kind == "manual":
        return {"status": "skip", "evidence": {**ev, "reason": "human-judged"}}
    target = str(check.get("target") or "")
    if kind == "file":
        p = Path(target)
        p = p if p.is_absolute() else ws / p
        try:
            exists = p.exists()
        except OSError:
            exists = False
        return {"status": "pass" if exists else "fail",
                "evidence": {**ev, "path": target, "exists": exists}}
    if kind == "grep":
        pattern = str(check.get("pattern") or target)
        scope = str(check.get("scope") or ".")
        root = Path(scope)
        root = root if root.is_absolute() else ws / root
        hits = 0
        sample: list[str] = []
        try:
            for f in root.rglob("*"):
                if not f.is_file() or f.stat().st_size > 1_000_000:
                    continue
                if any(part in (".git", "node_modules", "target", "target-selfupdate",
                                "__pycache__", ".venv") for part in f.parts):
                    continue
                try:
                    text = f.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                if pattern and pattern in text:
                    hits += 1
                    if len(sample) < 5:
                        sample.append(str(f.relative_to(ws)) if str(f).startswith(str(ws)) else str(f))
                if hits >= 200:
                    break
        except OSError as e:
            return {"status": "fail", "evidence": {**ev, "error": str(e)}}
        return {"status": "pass" if hits else "fail",
                "evidence": {**ev, "pattern": pattern, "scope": scope, "hits": hits, "sample": sample}}
    if kind == "cmd":
        import subprocess
        to = int(check.get("timeout_secs") or 60)
        try:
            r = subprocess.run(target, shell=True, cwd=str(ws), capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=to)
        except subprocess.TimeoutExpired:
            return {"status": "fail", "evidence": {**ev, "timeout_secs": to}}
        except OSError as e:
            return {"status": "fail", "evidence": {**ev, "error": str(e)}}
        tail = ((r.stdout or "") + (r.stderr or "")).strip()[-400:]
        return {"status": "pass" if r.returncode == 0 else "fail",
                "evidence": {**ev, "exit_code": r.returncode, "tail": tail}}
    return {"status": "skip", "evidence": {**ev, "reason": f"未实现的 kind: {kind}"}}


def cmd_eval(args: argparse.Namespace) -> dict:
    """C1 评价执行器：把「我说做完了」换成「跑给你看」。"""
    board = load()
    task = next((t for t in board["tasks"] if t.get("id") == args.id), None)
    if task is None:
        raise BoardError(f"未找到任务 {args.id}", code="NOT_FOUND", field="id")
    checks = task.get("checks") if isinstance(task.get("checks"), list) else []
    if not checks:
        raise BoardError(
            "该任务没有可执行检查（checks 为空）：先在 task-upsert 里写 checks，"
            "或用 `task-status` 的 acceptance 走人判路径",
            code="NO_CHECKS", field="checks",
        )
    only = {c.strip() for c in (args.only or "").split(",") if c.strip()}
    ws = workspace_root()
    results, npass, nfail, nskip = [], 0, 0, 0
    for c in checks:
        if only and c.get("id") not in only:
            results.append({"id": c.get("id"), "status": c.get("status", "pending"),
                            "kept": True})
            continue
        r = _run_check(c, ws)
        c["status"] = r["status"]
        c["evidence"] = r["evidence"]
        c["last_run"] = now_iso()
        npass += r["status"] == "pass"
        nfail += r["status"] == "fail"
        nskip += r["status"] == "skip"
        results.append({"id": c.get("id"), "name": c.get("name"), "kind": c.get("kind"),
                        "status": r["status"]})
    verdict = "fail" if nfail else ("pass" if npass else "pending")
    prev = task.get("evaluation") if isinstance(task.get("evaluation"), dict) else {}
    task["evaluation"] = {
        "verdict": verdict, "ran_at": now_iso(),
        "pass": npass, "fail": nfail, "skip": nskip,
        "note": _str(args.note, "evaluation.note", MAX_NOTE, required=False) or prev.get("note", ""),
    }
    task["checks"] = checks
    if verdict == "fail" and task.get("status") in ("verifying", "done"):
        task["status"] = "doing"  # 验收挂了不许停在验收/完成态（把「假完成」退回执行）
    task["updated_at"] = now_iso()
    save(board)
    out = {"ok": True, "id": args.id, "verdict": verdict,
           "pass": npass, "fail": nfail, "skip": nskip,
           "status": task.get("status"), "checks": results}
    if nfail:
        out["failed"] = [r["id"] for r in results if r["status"] == "fail"]
    return out


def cmd_check_add(args: argparse.Namespace) -> dict:
    """追加一条可执行检查（不必整表重写任务）。"""
    board = load()
    task = next((t for t in board["tasks"] if t.get("id") == args.id), None)
    if task is None:
        raise BoardError(f"未找到任务 {args.id}", code="NOT_FOUND", field="id")
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "checks" not in raw:
        raw = {"checks": [raw]}
    checks = validate_checks(task.get("checks"))
    for c in validate_checks(raw.get("checks") if isinstance(raw, dict) else raw):
        if any(x["id"] == c["id"] for x in checks):
            raise BoardError(f"checks id 重复：{c['id']}", field="checks")
        checks.append(c)
    task["checks"] = validate_checks(checks)
    task["updated_at"] = now_iso()
    save(board)
    return {"ok": True, "id": args.id, "checks": len(task["checks"])}


def cmd_layout(args: argparse.Namespace) -> dict:
    """C4 受约束的插件化看板：读 / 写 layout（白名单校验，写盘即规整）。"""
    board = load()
    if args.file:
        raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
        if isinstance(raw, dict) and "sections" not in raw and "layout" in raw:
            raw = raw["layout"]
        board["layout"] = validate_layout(raw)
        save(board)
        return {"ok": True, "layout": board["layout"], "path": str(board_path())}
    secs = (board.get("layout") or {}).get("sections")
    if not isinstance(secs, list):
        secs = json.loads(json.dumps(DEFAULT_LAYOUT))["sections"]
    return {"ok": True, "layout": {"sections": secs}, "path": str(board_path())}


def _task_digest(t: dict, brief: bool = False) -> dict:
    """跨任务聚合的最小信息面（C3）：够判「同类」，不带整块正文。"""
    res = t.get("resourcing") if isinstance(t.get("resourcing"), dict) else {}
    ev = t.get("evaluation") if isinstance(t.get("evaluation"), dict) else {}
    out = {
        "id": t.get("id"), "title": t.get("title"), "status": t.get("status"),
        "priority": t.get("priority"),
        "progress": t.get("progress"), "skills": res.get("skills") or [],
        "model": res.get("model"), "effort": res.get("effort"),
        "verdict": ev.get("verdict", "none"),
        "checks": len(t.get("checks") or []),
        "updated_at": t.get("updated_at"),
    }
    if not brief:
        out["goal"] = t.get("goal", "")
        out["acceptance"] = t.get("acceptance") or []
        out["artifacts"] = t.get("artifacts") or []
        out["note"] = (t.get("progress") or {}).get("note", "") if isinstance(t.get("progress"), dict) else ""
    return out


def cmd_digest(args: argparse.Namespace) -> dict:
    """C3 跨任务聚合：按 skill / 状态 / 时间聚合同类任务，回答「这类事以前怎么做的」。

    为什么在 CLI 而不在每轮 prompt：整块看板塞进上下文是 O(看板) 的每轮开销。
    聚合是**按需检索**——要归纳同类任务时才查一次，结果自己控制粒度（--limit / --brief）。
    """
    board = load()
    tasks = board["tasks"]
    if args.skill:
        tasks = [t for t in tasks
                 if args.skill in ((t.get("resourcing") or {}).get("skills") or [])]
    if args.status:
        _enum(args.status, "status", TASK_STATUSES)
        tasks = [t for t in tasks if t.get("status") == args.status]
    order = {s: i for i, s in enumerate(TASK_STATUSES)}
    tasks = sorted(tasks, key=lambda t: order.get(str(t.get("status")), 99))
    tasks = tasks[: max(1, int(args.limit))]
    by_skill: dict[str, dict] = {}
    for t in board["tasks"]:
        for s in ((t.get("resourcing") or {}).get("skills") or []):
            slot = by_skill.setdefault(s, {"skill": s, "total": 0, "open": 0, "done": 0})
            slot["total"] += 1
            if t.get("status") in ("done",):
                slot["done"] += 1
            elif t.get("status") not in ("cancelled", "blocked"):
                slot["open"] += 1
    out = {"ok": True, "tasks": [_task_digest(t, args.brief) for t in tasks],
           "total": len(tasks)}
    if by_skill:
        out["by_skill"] = sorted(by_skill.values(), key=lambda x: -x["total"])
    if args.with_inspirations:
        out["inspirations"] = [
            {"id": i.get("id"), "text": i.get("text"), "status": i.get("status"),
             "tags": i.get("tags") or []}
            for i in board["inspirations"][:20]
        ]
    return out


RESOLVE_RE = re.compile(r"@([TI]-\d{8}-\d{2,3})")


def cmd_resolve(args: argparse.Namespace) -> dict:
    """C2 @引用装载：把用户文本里的 `@T-…` / `@I-…` 解析成上下文块。

    为什么由 CLI 预解析而不是让模型自己 `show`：引用是**输入的一部分**，不是
    待办事项。让模型先发一次工具调用再回答，会在多引用时变成 N 次往返；这里一次
    调用给全（含任务的目标/计划/验收/检查结论、灵感原文与关联任务）。
    """
    board = load()
    text = args.text or ""
    ids = []
    for m in RESOLVE_RE.finditer(text):
        if m.group(1) not in ids:
            ids.append(m.group(1))
    tasks = {t.get("id"): t for t in board["tasks"]}
    insps = {i.get("id"): i for i in board["inspirations"]}
    blocks, missing = [], []
    for i in ids:
        if i in tasks:
            t = tasks[i]
            blocks.append({
                "ref": i, "type": "task",
                "title": t.get("title"), "status": t.get("status"), "priority": t.get("priority"),
                "goal": t.get("goal", ""),
                "plan": t.get("plan") or [], "acceptance": t.get("acceptance") or [],
                "checks": [{"id": c.get("id"), "name": c.get("name"), "kind": c.get("kind"),
                            "status": c.get("status")} for c in (t.get("checks") or [])],
                "evaluation": t.get("evaluation") or {},
                "resourcing": t.get("resourcing") or {},
                "progress": t.get("progress") or {},
                "artifacts": t.get("artifacts") or [],
                "inspirations": t.get("inspirations") or [],
            })
        elif i in insps:
            it = insps[i]
            blocks.append({
                "ref": i, "type": "inspiration",
                "text": it.get("text"), "tags": it.get("tags") or [],
                "status": it.get("status"),
                "tasks": [{k: tasks.get(x, {}).get(k) for k in ("id", "title", "status")}
                          for x in (it.get("tasks") or [])],
            })
        else:
            missing.append(i)
    # @引用同现时的排序提示：任务按状态机顺序，灵感在后（任务是账，灵感是料）。
    order = {s: n for n, s in enumerate(TASK_STATUSES)}
    blocks.sort(key=lambda b: (0 if b["type"] == "task" else 1,
                               order.get(b.get("status"), 99)))
    out = {"ok": True, "refs": blocks, "count": len(blocks)}
    if missing:
        out["missing"] = missing
    if not ids:
        out["note"] = "未发现 @T-/@I- 引用；本命令只做解析，不改板"
    return out


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
                             ("acceptance", []), ("inspirations", []), ("artifacts", []),
                             ("checks", [])):
            if key not in t:
                t[key] = default
                fixed += 1
        if not isinstance(t.get("evaluation"), dict):
            t["evaluation"] = {"verdict": "none", "ran_at": "", "pass": 0, "fail": 0, "skip": 0, "note": ""}
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

    p = sub.add_parser("eval", help="跑可执行验收（checks），写回 evaluation")
    p.add_argument("id")
    p.add_argument("--only", default="", help="只跑指定 id，逗号分隔")
    p.add_argument("--note", default=None)
    p.set_defaults(fn=cmd_eval)

    p = sub.add_parser("check-add", help="追加一条可执行检查（JSON 文件）")
    p.add_argument("id")
    p.add_argument("--file", required=True)
    p.set_defaults(fn=cmd_check_add)

    p = sub.add_parser("layout", help="读/写看板布局（受约束的插件化章节）")
    p.add_argument("--file", default=None, help="JSON 文件；省略则只读")
    p.set_defaults(fn=cmd_layout)

    p = sub.add_parser("digest", help="跨任务聚合（同类任务归纳）")
    p.add_argument("--skill", default="", help="只聚合用了该技能的任务")
    p.add_argument("--status", default="")
    p.add_argument("--limit", default=20)
    p.add_argument("--brief", action="store_true", help="只给最小信息面")
    p.add_argument("--with-inspirations", action="store_true")
    p.set_defaults(fn=cmd_digest)

    p = sub.add_parser("resolve", help="解析文本里的 @T-/@I- 引用为上下文块")
    p.add_argument("text", nargs="?", default="")
    p.set_defaults(fn=cmd_resolve)
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
