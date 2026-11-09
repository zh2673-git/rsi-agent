#!/usr/bin/env python
"""任务看板 / 灵感看板 CLI —— agent 侧对 `.rsi/board.json` 的**唯一写口（仅任务）**。

**灵感归用户，agent 只读**（I-20261108-04 第 1 条）。原话：「灵感是用户记录碎片想法的地方。
不需要呈现 agent 对灵感的总结。agent 运行的时候在需要的情况下只是读取灵感，agent 不能编辑，
用户可以编辑。」故本 CLI 侧移除了全部灵感写命令（`insp-add`/`insp-set`/`insp-adopt`/
`insp-edit`/`insp-rm`）：agent 对灵感的权限收缩为**读**（`list`/`show`/`stats`/`resolve`）。
灵感的增删改只走 UI（host `/api/board` 的 inspiration.* op，唯一调用方是用户界面）。

那「这条灵感被哪件任务采纳」怎么记？**记在任务一侧**（`task-upsert` 的 `inspirations`
字段），不反向改灵感对象。理由：一个事实只存一处，就不存在「两边说法不一致」；
而任务本来就是 agent 的领域，把关联写在任务上是权限的自然延伸，不是越界。

为什么是 CLI 而不是技能工具：技能工具（skills/*/tools.json）装载后默认**未启用**，需用户在
设置面板批准；bash 是缺省启用集。若 agent 的写作通道依赖「要人点一下才生效」的入口，任务
看板的闭环就断在配置上。故 CLI 是保证通道，`skills/rsi-board/` 只承载「怎么想、怎么写」。

数据契约见 `docs/self-evolution/01-单会话与任务看板.md` §2；Rust 侧 `host/src/web/api/board.rs`
是同一份契约的**灵感写**实现（UI 用）。两侧共享三条纪律：
  1. 读 → 改 → 写，按 id 合并，不做整表覆盖（两边并发写不互相吞条目）；
  2. 写盘 tmp + 原子替换（半截 JSON 永不落地）；
  3. 状态枚举封闭、字段长度与条数上限固定（越界即拒，不静默截断）。

用法（agent 侧全部命令；**灵感无写命令**）：
    python scripts/board.py list [--status doing] [--compact]
    python scripts/board.py show T-20261107-01
    python scripts/board.py stats
    python scripts/board.py task-upsert --file plan.json        # JSON 文件或 - 读 stdin
    python scripts/board.py task-status T-20261107-01 doing --note "开始改 Rust"
    python scripts/board.py task-progress T-20261107-01 3/5 --note "路由已通"
    python scripts/board.py task-append T-... --artifact outputs/x.md
    python scripts/board.py refresh            # 只会重建缺失字段（不删条目）

退出码：0 成功；1 业务失败（打印 {"ok":false,"error":{...}}）；2 参数错。
"""

from __future__ import annotations

from contextlib import nullcontext

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
# D5 分解与委派：每个 plan 步必须显式说是谁干——否则「计划」只是一句话列表，
# 看不出哪步该交给子代理/哪步要现造技能。owner 是**决策记录**，不是调度指令。
PLAN_OWNERS = ("self", "subagent", "skill")
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


def data_root() -> Path:
    """看板/画像的数据根：`RSI_HOME`（代码根）优先，退化到工作区。

    为什么数据跟着代码根走、而不是跟着工作区走（v11，I-20261108-14）：
    v10 只修了「能力在哪」（RSI_HOME 让子窗口找得到 board.py），但「数据在哪」
    仍绑 WORKSPACE_ROOT。结果每个窗口各有一块板：主窗口 22 条、子窗口 0 条，
    两边的板永不相见——用户实测「新窗口里任务在跑、左侧看板没变化」。

    判据：看板是 agent 与用户之间的**账**，账只有一本；工作区只是「这本账
    当前记到哪个项目」。把账拆成 N 份，等于让用户在每个窗口重新建立上下文，
    而看板存在的全部理由就是避免这件事。

    与 Rust 侧 `host/src/web/api/board.rs::data_root` 判定顺序必须逐字一致，
    否则 CLI 与 UI 会写两份文件——那是最难查的一种不一致。
    """
    for key in ("RSI_HOME", "WORKSPACE_ROOT"):
        env = os.environ.get(key, "").strip()
        if env:
            return Path(env)
    return Path.cwd()


def board_path() -> Path:
    """`RSI_BOARD_PATH`（相对或绝对）覆盖，缺省 `<data_root>/.rsi/board.json`。"""
    env = os.environ.get("RSI_BOARD_PATH", "").strip()
    p = Path(env) if env else Path(".rsi") / "board.json"
    if not p.is_absolute():
        p = data_root() / p
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


def _lock_path() -> Path:
    return board_path().parent / "board.lock"


class BoardLock:
    """跨进程独占锁（G4a）：读→改→写整段互斥。

    为什么必须有：`board.py`（agent）与 host `/api/board`（UI）都是「load → 改 → save」。
    两路并行时 A 读到旧快照、B 写入新条目、A 再整体覆盖 → B 的条目凭空消失。
    这不是理论风险：I-20261108-06 要求「不同任务可以并行」，并行一旦开闸，两件任务
    各自登记进度就是常态，丢更新会直接表现为「我明明加了一步，看板上没有」。

    实现选型（三条取舍）：
    1. **文件锁而非内存锁**：写者是两个不同进程（Python CLI / Rust host），进程内锁拦不住。
    2. **`O_CREAT|O_EXCL` 而非 flock**：Windows 上 Python 的 `fcntl` 不存在，
       `msvcrt.locking` 语义又按字节区间、行为不一致。独占创建空文件跨平台一致，
       代价是崩溃可能留残锁——故带**过期时间**（stale 判定见 `_acquire`）。
    3. **拿不到就失败，不阻塞等待**：看板写是用户可感知的短操作，阻塞会让 UI 卡住；
       宁可明确报「正在被写入，请重试」，也不让调用方在锁上空转。
    """

    def __init__(self, timeout: float = 3.0, stale: float = 15.0):
        self.timeout = timeout      # 最多等多久（秒）：短重试窗口，不是无界等待
        self.stale = stale          # 锁超过这个年龄视为残锁（持锁者已死）
        self.fh = None

    def __enter__(self):
        import time
        p = _lock_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + self.timeout
        while True:
            try:
                self.fh = os.open(str(p), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fh, f"{os.getpid()} {time.time():.3f}".encode())
                return self
            except FileExistsError:
                # 残锁回收：进程崩在锁内时文件会留下。按 mtime 年龄判定，超龄即删。
                try:
                    age = time.time() - p.stat().st_mtime
                except OSError:
                    age = 0.0
                if age > self.stale:
                    try:
                        p.unlink()
                    except OSError:
                        pass  # 别人刚好也删了：让下一轮重试处理
                    continue
                if time.time() >= deadline:
                    raise BoardError(
                        "看板正在被另一个写入方修改（.rsi/board.lock 被占用），请稍后重试",
                        code="LOCKED", field="board",
                    ) from None
                time.sleep(0.05)

    def __exit__(self, *exc):
        p = _lock_path()
        if self.fh is not None:
            try:
                os.close(self.fh)
            finally:
                self.fh = None
        try:
            p.unlink()
        except OSError:
            pass
        return False


def save(board: dict) -> Path:
    """原子写盘。**调用方必须已持有 board.lock**（见 `BoardLock` / `locked()`）。"""
    p = board_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    board["version"] = 1
    board["updated_at"] = now_iso()
    board.pop("corrupt", None)
    tmp = p.parent / (p.name + ".tmp")
    tmp.write_text(json.dumps(board, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, p)  # 原子替换：崩溃不留半截 JSON
    return p


def locked() -> BoardLock:
    """写入口的统一用法：`with locked(): board = load(); …; save(board)`。"""
    return BoardLock()


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
            step = {
                "step": _str(st.get("step"), f"plan[{i}].step", MAX_STEP),
                "status": _enum(st.get("status"), f"plan[{i}].status", PLAN_STATUSES, default="pending"),
                # D5：谁执行这一步。self=本体会做；subagent=该交给子代理（省上下文）；
                # skill=要现造/现装技能或工具（物力自造的入口）。缺省 self 是安全的：
                # 不写 ≠ 委派，避免模型用「没填」隐式放大工作量。
                "owner": _enum(st.get("owner"), f"plan[{i}].owner", PLAN_OWNERS, default="self"),
            }
            note = st.get("note")
            if note is not None:
                step["note"] = _str(note, f"plan[{i}].note", MAX_STEP, required=False)
            plan.append(step)
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
    # D5 分解：parent = 本任务由哪个任务分解而来（空 = 顶层任务）。只做一层引用，
    # 不做递归树——「分解」的用途是「看这一大坨被拆成了哪几件」，不是另一套层级系统。
    parent = _str(raw.get("parent", base.get("parent")), "parent", MAX_ID, required=False)
    if parent:
        if not TASK_ID_RE.match(parent):
            raise BoardError(f"parent 形状不合法（应形如 T-20261107-01），收到 {parent!r}", field="parent")
        if parent == task["id"]:
            raise BoardError("parent 不能指向自己", field="parent")
    task["parent"] = parent
    task["artifacts"] = _str_list(raw.get("artifacts", base.get("artifacts")), "artifacts", 300, 50)
    # G5（I-20261108-04 第 3 条）：任务完成后**两条线**。
    # 用户原话：「一条是确认任务是否专业的、按照计划、需求完成了。另一条是需要把任务的
    # 结果通俗化的呈现出来，这才是看板的终极意义」。
    #   brief = 给人看的一句话结论（非专业读者能据此决定「接下来要不要管它」）
    #   pro   = 给 agent 自己看的专业结论（做了什么、怎么验证、遗留什么），供后续同类
    #           任务 digest 复用；此前这类内容散在对话里，换个任务就找不回来了。
    # 两个字段都**可选**：没到 done 的任务不该被逼着写结论（逼出来的是套话）。
    # 但 done 且两者皆空 → 给 warning（见 check_acceptance_warning），因为「做完了但
    # 说不清结果」正是用户抱怨的那件事。
    outs = raw.get("outcomes") if isinstance(raw.get("outcomes"), dict) else {
        k: raw.get(k) for k in ("brief", "pro") if k in raw
    }
    prev_outs = base.get("outcomes") if isinstance(base.get("outcomes"), dict) else {}
    task["outcomes"] = {
        "brief": _str(outs.get("brief", prev_outs.get("brief")), "outcomes.brief", MAX_GOAL, required=False),
        "pro": _str(outs.get("pro", prev_outs.get("pro")), "outcomes.pro", MAX_NOTE * 2, required=False),
    }
    task["session"] = _str(raw.get("session", base.get("session", "main")), "session", 64, required=False) or "main"
    task["created_at"] = str(base.get("created_at") or now_iso())
    task["updated_at"] = now_iso()
    del progresses
    return task


def check_acceptance_warning(task: dict) -> str | None:
    """收尾提醒：验收标准 / 机跑证据 / 结论。

    G5：三条都要报，不再「遇到第一条就返回」——以前 acceptance 空就只提 acceptance，
    用户补了验收再跑才看见「还缺结论」，一来一回多两轮。一次说全更省事。
    """
    warns: list[str] = []
    if task["status"] in ("verifying", "done") and not task["acceptance"]:
        warns.append(
            "acceptance 为空却已进入 "
            f"{task['status']}：没有验收标准的「完成」不可核对，请补 1-3 条可判定的验收条目。"
        )
    # C1：登记了可执行检查却没跑（或跑挂了）就宣告完成——这是「自证」而不是「证据」。
    checks = task.get("checks") or []
    verdict = (task.get("evaluation") or {}).get("verdict", "none")
    if checks and task["status"] == "done" and verdict != "pass":
        warns.append(
            f"checks 有 {len(checks)} 条但 evaluation.verdict={verdict} 却已 done："
            "请先跑 `python scripts/board.py eval <ID>`，全 PASS 再收尾。"
        )
    # G5：done 却说不出结果——「做完了但不知道做了啥」正是用户抱怨的那件事。
    # 提示级（不阻断）：检查全过但还没写结论，是常见的中途状态，不该卡住收尾。
    outs = task.get("outcomes") if isinstance(task.get("outcomes"), dict) else {}
    if task["status"] == "done" and not (outs.get("brief") or outs.get("pro")):
        warns.append(
            "任务已 done 但 outcomes 为空：给一句话结论（outcomes.brief，给人看："
            "「这件事现在是什么状态、你还要不要管它」）和专业结论（outcomes.pro，给 agent 看："
            "做了什么 / 怎么验证的 / 遗留什么）。看板的意义不只是「完成了」，而是「结果是什么」。"
        )
    return " ".join(warns) if warns else None


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
        # G5：同类归纳要带上「上次到底做成了什么」，否则 digest 只回答「做过」而不回答
        # 「结果如何」——那正是用户说「看板的终极意义是呈现结果」时缺的那半块。
        outs = t.get("outcomes") if isinstance(t.get("outcomes"), dict) else {}
        out["outcome_brief"] = outs.get("brief", "")
        out["outcome_pro"] = outs.get("pro", "")
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


def cmd_refresh(args: argparse.Namespace) -> dict:
    """只补缺失字段，不删条目：修手改坏的板子时安全。"""
    board = load()
    fixed = 0
    for t in board["tasks"]:
        for key, default in (("status", "planning"), ("priority", "P2"), ("plan", []),
                             ("acceptance", []), ("inspirations", []), ("artifacts", []),
                             ("checks", []), ("parent", "")):
            if key not in t:
                t[key] = default
                fixed += 1
        # D5：旧板子的 plan 步没有 owner —— 补 self（不写 ≠ 委派，补缺省是保守方向）。
        if isinstance(t.get("plan"), list):
            for st in t["plan"]:
                if isinstance(st, dict) and "owner" not in st:
                    st["owner"] = "self"
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
        if not isinstance(t.get("outcomes"), dict):
            t["outcomes"] = {"brief": "", "pro": ""}
            fixed += 1
    for i in board["inspirations"]:
        for key, default in (("tags", []), ("tasks", []), ("status", "open")):
            if key not in i:
                i[key] = default
                fixed += 1
    save(board)
    return {"ok": True, "fixed": fixed, "path": str(board_path())}


def cmd_task_rm(args: argparse.Namespace) -> dict:
    """删除任务（D1 可编辑的一部分）。

    为什么需要：用户原话「看板没有可编辑的功能吗，比如可以删除掉」——记错的任务
    若只能靠改状态成 cancelled 滚雪球，看板会越看越脏。删除是真删（不是归档），
    但**保留引用完整性**：被其他任务当 parent 的子任务会被摘掉 parent（不跟着删），
    灵感的 tasks 里指向它的引用一并清掉，避免留下指向空气的 ID。
    """
    board = load()
    idx = next((n for n, t in enumerate(board["tasks"]) if t.get("id") == args.id), None)
    if idx is None:
        raise BoardError(f"未找到任务 {args.id}", code="NOT_FOUND", field="id")
    removed = board["tasks"].pop(idx)
    detached = []
    for t in board["tasks"]:
        if t.get("parent") == args.id:
            t["parent"] = ""
            t["updated_at"] = now_iso()
            detached.append(t.get("id"))
    unlinked = []
    for i in board["inspirations"]:
        tasks = i.get("tasks") if isinstance(i.get("tasks"), list) else []
        if args.id in tasks:
            i["tasks"] = [x for x in tasks if x != args.id]
            i["updated_at"] = now_iso()
            unlinked.append(i.get("id"))
    save(board)
    out = {"ok": True, "id": args.id, "title": removed.get("title"),
           "path": str(board_path()), "detached": detached, "unlinked": unlinked}
    if not args.force and removed.get("status") not in ("done", "cancelled"):
        out["warning"] = f"删除的是未完结任务（status={removed.get('status')}）：若只是暂时不做，考虑 task-status {args.id} blocked"
    return out


def trace_dir() -> Path:
    """记忆插件的 trace 目录。

    判定顺序（次序本身就是结论，改动前先读这段）：
    1. **工作区里真有 trace 目录** → 用它。为什么排第一：`board.py` 是「贴在工作区里
       的工具」，它该描述**这个工作区**的记忆；而 `MEMORY_DATA_DIR` 是宿主进程 env，
       会被子进程继承——实测在宿主里跑 `board.py link` 时，env 指向的是**宿主自己**的
       记忆目录，于是 CLI 读到了另一个工作区的 trace（端到端发现的真实串扰）。
    2. 否则用 `MEMORY_DATA_DIR`（host 对 agent 子进程下发，两者同工作区时无歧义）。
    3. 都没有：回仓库缺省（调用方得到「文件不存在→空结果」，不误报）。
    """
    ws = workspace_root()
    for cand in (ws / "runtime" / "plugins" / "memory" / "data",
                 ws / "memory",
                 ws / "mem",
                 ws / "data" / "memory"):
        if (cand / "traces").is_dir():
            return cand / "traces"
    env = os.environ.get("MEMORY_DATA_DIR", "").strip()
    if env:
        p = Path(env)
        p = p if p.is_absolute() else ws / p
        return p / "traces"
    return ws / "runtime" / "plugins" / "memory" / "data" / "traces"


def scan_ref_turns(ref_id: str, session: str = "main", limit: int = 12) -> list[dict]:
    """D4 任务↔对话绑定：扫 trace 里带 refs 字段的 user 事件，找出引用过 ref_id 的轮次。

    为什么从 trace 反查而不是让模型登记：`@T-…` 是用户**明文**写出来的，天然就是
    关联键；让模型额外登记一次，它忘了就断链，而 trace 是系统写的、跑不掉的。
    `user_index`（第几条 user 事件，0 基）与前端回滚定位口径一致——点进去能直接跳到
    那一轮，不是「大概在这个会话里」。
    """
    f = trace_dir() / f"{session}.jsonl"
    if not f.is_file():
        return []
    out: list[dict] = []
    user_index = -1
    try:
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if not isinstance(ev, dict) or ev.get("type") != "user":
                continue
            user_index += 1
            refs = ev.get("refs")
            if not isinstance(refs, list) or ref_id not in refs:
                continue
            out.append({
                "user_index": user_index,
                "ts": ev.get("ts"),
                "text": (str(ev.get("text") or ""))[:200],
                "refs": refs,
            })
    except OSError:
        return []
    return out[-limit:]


def cmd_link(args: argparse.Namespace) -> dict:
    """任务/灵感 ↔ 对话轮次：读 trace 的 refs 字段（D4）。"""
    board = load()
    ids = {t.get("id") for t in board["tasks"]} | {i.get("id") for i in board["inspirations"]}
    if args.id not in ids:
        raise BoardError(f"未找到 {args.id}", code="NOT_FOUND", field="id")
    turns = scan_ref_turns(args.id, args.session, max(1, int(args.limit)))
    out = {"ok": True, "id": args.id, "session": args.session, "turns": turns,
           "total": len(turns), "trace": str(trace_dir() / f"{args.session}.jsonl")}
    if not turns:
        out["note"] = ("没有对话引用过它：只有在消息里写 `@" + str(args.id) +
                       "` 的轮次才会留下关联（@引用同时会把这件的上下文自动装进当轮提示词）")
    return out


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

    p = sub.add_parser("task-rm", help="删除任务（子任务摘 parent，灵感引用清空）")
    p.add_argument("id")
    p.add_argument("--force", action="store_true", help="未完结任务也删，不再提示")
    p.set_defaults(fn=cmd_task_rm)

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

    p = sub.add_parser("link", help="反查引用过该任务/灵感的对话轮次（读 trace 的 refs 字段）")
    p.add_argument("id")
    p.add_argument("--session", default="main")
    p.add_argument("--limit", default=12)
    p.set_defaults(fn=cmd_link)
    return ap


# 只读命令：不取锁（读不互斥，取锁只会让看板刷新互相排队）。
READ_ONLY_CMDS = frozenset({
    "list", "show", "stats", "digest", "resolve", "link",
})


def main(argv: list[str] | None = None) -> int:
    ns = build_parser().parse_args(argv)
    # G4a：写命令整段持 board.lock（读→改→写互斥），只读命令不加锁。
    # 加在 main 而不是每个 cmd_* 里：写命令有九个，逐个包 `with` 只要漏一个就是
    # 「并行时偶发丢更新」——那种 bug 极难复现、极难归因。集中在一处判定，
    # 新增写命令忘记加锁的唯一后果是「没锁」，而不是「锁了但写错位置」。
    ctx = nullcontext() if ns.cmd in READ_ONLY_CMDS else locked()
    try:
        with ctx:
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
