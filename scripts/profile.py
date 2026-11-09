"""用户/模型习惯画像 CLI —— `.rsi/profile.json` 的唯一写口。

为什么要有这个文件（I-20261107-04 的原话）：
  「会话框是用户与 agent 交互的唯一地方，所以用户的提问、agent 的回答等可以从中
   分析出用户的习惯，以及对应回答模型的特点与习惯，这是非常重要的上下文，agent
   需要有这种留存上下文的机制。」

要点不是「多存一份聊天记录」（trace 已是全量、append-only、可回放），而是
**把从记录里提炼出的规律固化下来**，好让下一次 chat 不必重新观察一遍：

| 层 | 载体 | 谁写 | 生命周期 |
|---|---|---|---|
| 原始交互 | `memory` 事件/trace | 系统 | 全量、可回滚、不删 |
| 提炼的习惯 | 本文件 `profile.json` | **agent 主动写**（经本 CLI） | 跨会话长期，可人工编辑 |
| 当轮上下文 | `profile_ctx.rs` 注入 | 系统读 | 每轮重读，有界 |

## v2：两级作用域（I-20261107-07 的落点）

用户的提问是：「用户自己也是有角色分类的，比如生活、工作……这些上下文、记忆是不是
也应该分开？具体怎么分法比较科学。」答案不是按「角色」分，而是按**判据的作用范围**分，
且只分两级：

| 层 | 键 | 何时注入 | 判据 |
|---|---|---|---|
| 全局（global） | 顶层 `sections` / `notes` | **每轮都在** | 在任何域里都成立 |
| 域（domain） | `domains.<name>` 下同形的 sections/notes | 当前域命中时 | 换到别的域就**错** |

为什么只两级、为什么不做自动推断：
  1. 按「用户角色」分域要求重复维护跨域同一事实（「回答简洁」两处都要写），重复必漂移；
  2. 分域的收益是少注入无关内容，成本是该注入的没注入——角色边界本就模糊
     （工作的技术决策影响个人装机、个人的写作偏好影响工作文档），误判成本更高；
  3. **自动推断**（让模型每轮猜这是工作还是生活）会把偏好静默串错域，而错域的偏好
     比没有画像更坏：它带着错误的自信污染判断。所以切域必须是**可见的显式动作**。

继承规则：域内没写的键回落全局（只写差异，不重复）。冲突规则：域写了同 `id` 即覆盖
全局，注入时标注 `overrides global`——静默覆盖会让模型不知道该听谁的。

## 三条纪律（与看板同源，不另起一套）

  1. 读 → 改 → 写，按 id 合并（两侧并发写不吞条目）；
  2. tmp + 原子替换（半截 JSON 永不落地）；
  3. 枚举封闭 + 条数/长度上限（越界即拒，不静默截断）。

为什么是 CLI 不是技能工具：与 board.py 同一理由——技能工具装载后默认未启用，
而这条通道必须「装上就能用」。

用法：
    python scripts/profile.py show                      # 全量（人看）
    python scripts/profile.py brief                    # 有界摘要（进 prompt 用这个）
    python scripts/profile.py domains                  # 有哪些域 + 当前域
    python scripts/profile.py use work                 # 切到 work 域（不存在则建空域）
    python scripts/profile.py use --none               # 回全局
    python scripts/profile.py section-add --file s.json --domain work
    python scripts/profile.py note --file n.json [--domain work]
    python scripts/profile.py note-rm <id> [--domain work]
    python scripts/profile.py section-rm <name> [--domain work]
    python scripts/profile.py domain-rm work [--force]

域解析顺序（所有写命令与 brief 一致）：`--domain` 显式 > `RSI_PROFILE_DOMAIN` > 文件内
`current_domain` > 全局。`--domain none` / `--domain ""` 强制全局层。

退出码：0 成功；1 业务失败（打印 {"ok":false,"error":{...}}）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── 契约常量（与 runtime/crates/agent-loop/src/profile_ctx.rs 同源）─────────────
MAX_SECTIONS = 8
MAX_SECTION_ID = 24
MAX_SECTION_BODY = 1200
MAX_NOTES = 60
MAX_NOTE = 400
MAX_TAG = 32
MAX_TAGS = 6
# v2：域数量上限。为什么有上限：域是「少量稳定作用域」，放开就等于允许每个任务一个域，
# 那和 trace 没区别了（trace 已按 session 分段）。8 与章节上限同量级。
MAX_DOMAINS = 8
MAX_DOMAIN = 24

SECTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")

# 章节白名单（kind 决定注入顺序与语义）。为什么封闭：画像会进 system prompt，
# 自由章节等于让模型自己发明上下文结构——那和「多存一份聊天记录」没区别了。
SECTION_KINDS = ("user", "model", "workflow", "env")
KIND_ORDER = {k: i for i, k in enumerate(SECTION_KINDS)}

DEFAULT_PROFILE = {
    "version": 2,
    "updated_at": "",
    "current_domain": "",
    "sections": [],
    "notes": [],
    "domains": {},
}


class ProfileError(Exception):
    def __init__(self, message: str, code: str = "BAD_ARG", field: str | None = None):
        super().__init__(message)
        self.code = code
        self.field = field


# ── 路径与时钟 ────────────────────────────────────────────────────────────────


def workspace_root() -> Path:
    env = os.environ.get("WORKSPACE_ROOT", "").strip()
    return Path(env) if env else Path.cwd()


def data_root() -> Path:
    """画像的数据根：`RSI_HOME`（代码根）优先，退化到工作区。

    与 `scripts/board.py::data_root` 同一判据、同一顺序——画像与看板是同族的
    「长期账」，两者必须落在同一个根上，否则会出现「看板在代码根、画像在项目目录」
    这种没人能想明白的分裂。
    """
    for key in ("RSI_HOME", "WORKSPACE_ROOT"):
        env = os.environ.get(key, "").strip()
        if env:
            return Path(env)
    return Path.cwd()


def profile_path() -> Path:
    """`RSI_PROFILE_PATH`（相对或绝对）覆盖，缺省 `<data_root>/.rsi/profile.json`。"""
    env = os.environ.get("RSI_PROFILE_PATH", "").strip()
    p = Path(env) if env else Path(".rsi") / "profile.json"
    if not p.is_absolute():
        p = data_root() / p
    return p


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today() -> str:
    return datetime.now().strftime("%Y%m%d")


# ── 读写 ─────────────────────────────────────────────────────────────────────


def _clean_domain(v) -> str:
    """**读**侧规整：形状不合法的一律判空（读旧文件时不因脏键报错，只是忽略），
    大写折叠成小写（旧文件里 `Work` 与 `work` 视为同一个域，不让脏键凭空多出一个域）。"""
    if not isinstance(v, str):
        return ""
    s = v.strip().lower()
    return s if DOMAIN_RE.match(s) else ""


def _strict_domain(v: str) -> str:
    """**写**侧严格：大写不折叠而是拒——否则 `use Work` 静默变成 `work`，
    用户以为切到了新域却在往旧域写。章节 id 同纪律（`SECTION_ID_RE` 也是严格拒）。
    """
    s = (v or "").strip()
    return s if DOMAIN_RE.match(s) else ""


def empty_profile() -> dict:
    p = json.loads(json.dumps(DEFAULT_PROFILE))
    p["updated_at"] = now_iso()
    return p


def load() -> dict:
    p = profile_path()
    if not p.is_file():
        return empty_profile()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        out = empty_profile()
        out["corrupt"] = True
        return out
    if not isinstance(raw, dict):
        out = empty_profile()
        out["corrupt"] = True
        return out
    out = empty_profile()
    for k in ("sections", "notes"):
        v = raw.get(k)
        if isinstance(v, list):
            out[k] = [x for x in v if isinstance(x, dict)]
    out["current_domain"] = _clean_domain(raw.get("current_domain"))
    doms = raw.get("domains")
    if isinstance(doms, dict):
        for name, body in doms.items():
            n = _clean_domain(name)
            if not n or not isinstance(body, dict):
                continue
            d = {"sections": [], "notes": []}
            for k in ("sections", "notes"):
                v = body.get(k)
                if isinstance(v, list):
                    d[k] = [x for x in v if isinstance(x, dict)]
            out["domains"][n] = d
    if isinstance(raw.get("updated_at"), str) and raw["updated_at"]:
        out["updated_at"] = raw["updated_at"]
    return out


def save(profile: dict) -> Path:
    p = profile_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    profile["version"] = 2
    profile["updated_at"] = now_iso()
    profile.pop("corrupt", None)
    tmp = p.parent / (p.name + ".tmp")
    tmp.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, p)  # 原子替换
    return p


# ── 层解析 ───────────────────────────────────────────────────────────────────


def resolve_domain(p: dict, args: argparse.Namespace) -> str:
    """域解析：`--domain` 显式 > `RSI_PROFILE_DOMAIN` > 文件内 `current_domain` > 全局。"""
    raw = getattr(args, "domain", None)
    if raw is None:
        env = os.environ.get("RSI_PROFILE_DOMAIN", "")
        raw = env if env.strip() else str(p.get("current_domain") or "")
    raw = str(raw).strip().lower()
    if raw in ("", "none", "global"):
        return ""
    n = _clean_domain(raw)
    if not n:
        raise ProfileError(
            f"域名字形状不合法（小写字母/数字/连字符，≤{MAX_DOMAIN}）", field="domain"
        )
    return n


def layer_of(p: dict, domain: str, create: bool = False) -> dict:
    """取层（域空即顶层）。`create=True` 时按需建空域（受 MAX_DOMAINS 限）。"""
    if not domain:
        return p
    d = p["domains"].get(domain)
    if d is None:
        if not create:
            raise ProfileError(f"未找到域 {domain}", code="NOT_FOUND", field="domain")
        if len(p["domains"]) >= MAX_DOMAINS:
            raise ProfileError(
                f"域数量已达上限 {MAX_DOMAINS}，请先删掉不用的", code="LIMIT", field="domains"
            )
        d = {"sections": [], "notes": []}
        p["domains"][domain] = d
    return d


# ── 校验 ─────────────────────────────────────────────────────────────────────


def _str(v, field: str, limit: int, required: bool = True) -> str:
    if v is None:
        if required:
            raise ProfileError(f"{field} 不能为空", field=field)
        return ""
    if not isinstance(v, str):
        raise ProfileError(f"{field} 必须是字符串", field=field)
    s = v.strip()
    if required and not s:
        raise ProfileError(f"{field} 不能为空", field=field)
    if len(s) > limit:
        raise ProfileError(f"{field} 超过 {limit} 字符", field=field)
    return s


def validate_section(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ProfileError("section 必须是对象", field="section")
    sid = _str(raw.get("id"), "section.id", MAX_SECTION_ID)
    if not SECTION_ID_RE.match(sid):
        raise ProfileError("section.id 形状不合法（小写字母/数字/连字符）", field="section.id")
    kind = raw.get("kind") or "user"
    if kind not in SECTION_KINDS:
        raise ProfileError(f"section.kind 必须是 {list(SECTION_KINDS)} 之一，收到 {kind!r}", field="section.kind")
    return {
        "id": sid,
        "kind": kind,
        "title": _str(raw.get("title"), "section.title", 40, required=False) or sid,
        "body": _str(raw.get("body"), "section.body", MAX_SECTION_BODY),
        "updated_at": now_iso(),
    }


def validate_note(raw: dict, notes: list[dict]) -> dict:
    if not isinstance(raw, dict):
        raise ProfileError("note 必须是对象", field="note")
    kind = raw.get("kind") or "user"
    if kind not in SECTION_KINDS:
        raise ProfileError(f"note.kind 必须是 {list(SECTION_KINDS)} 之一，收到 {kind!r}", field="note.kind")
    tags_raw = raw.get("tags") or []
    if not isinstance(tags_raw, list):
        raise ProfileError("note.tags 必须是数组", field="note.tags")
    if len(tags_raw) > MAX_TAGS:
        raise ProfileError(f"note.tags 最多 {MAX_TAGS} 个", field="note.tags")
    tags = [_str(t, f"note.tags[{i}]", MAX_TAG) for i, t in enumerate(tags_raw)]
    used = {str(n.get("id", "")) for n in notes}
    nid = ""
    stamp = today()
    for n in range(1, 100):
        cand = f"N-{stamp}-{n:02d}"
        if cand not in used:
            nid = cand
            break
    if not nid:
        raise ProfileError("当日 note ID 已用尽（>99）", code="ID_EXHAUSTED", field="note.id")
    return {
        "id": nid,
        "kind": kind,
        "text": _str(raw.get("text"), "note.text", MAX_NOTE),
        "tags": tags,
        "created_at": now_iso(),
    }


# ── 命令 ─────────────────────────────────────────────────────────────────────


def cmd_show(args: argparse.Namespace) -> dict:
    p = load()
    out = {"ok": True, "path": str(profile_path()), "profile": p}
    if p.get("corrupt"):
        out["corrupt"] = True
        out["note"] = "profile.json 解析失败，已按空画像返回；原文件未改动，请人工核对"
    return out


def brief_text(p: dict, domain: str = "") -> str:
    """有界摘要：全局段（按 kind 钉死顺序）+ 当前域段 + 最近 notes。

    Rust 侧 profile_ctx.rs 读的是同一份 JSON 并做自己的渲染；这里给的是「人/模型直接看」
    的等价文本。域段只写差异（同 id 覆盖全局），与注入侧同口径。
    """
    lines: list[str] = []

    def emit(secs: list[dict], label: str, inherited: set[str]) -> None:
        secs = sorted(
            (s for s in secs if s.get("kind") in SECTION_KINDS),
            key=lambda s: (KIND_ORDER[s["kind"]], str(s.get("id", ""))),
        )
        if not secs:
            return
        if label:
            lines.append(f"--- {label} ---")
        for s in secs:
            mark = " (overrides global)" if label and str(s.get("id")) in inherited else ""
            lines.append(f"[{s.get('kind')}:{s.get('id')}]{mark} {s.get('title', '')}")
            lines.append(str(s.get("body", "")).strip())

    glob = p.get("sections") or []
    ids = {str(s.get("id")) for s in glob}
    emit(glob, "", ids)
    dom = p["domains"].get(domain) if domain else None
    if dom:
        emit(dom.get("sections") or [], f"domain:{domain}", ids)

    notes = (p.get("notes") or [])[-10:]
    dom_notes = []
    if dom:
        # 域内观察优先展示（更近、更贴当前活），全局观察补足
        dom_notes = (dom.get("notes") or [])[-6:]
        notes = (dom_notes + notes)[-10:]
    if notes:
        lines.append("recent observations:")
        for n in notes:
            tags = f" ({','.join(n.get('tags') or [])})" if n.get("tags") else ""
            lines.append(f"- [{n.get('kind')}] {n.get('text')}{tags}")
    return "\n".join(lines).strip()


def cmd_brief(args: argparse.Namespace) -> dict:
    p = load()
    if p.get("corrupt"):
        return {"ok": True, "brief": "", "corrupt": True}
    dom = resolve_domain(p, args)
    text = brief_text(p, dom)
    if len(text) > args.limit:
        text = text[: args.limit] + "…"
    return {"ok": True, "brief": text, "domain": dom,
            "sections": len(p.get("sections") or []),
            "notes": len(p.get("notes") or []),
            "domains": len(p.get("domains") or {})}


def cmd_domains(args: argparse.Namespace) -> dict:
    p = load()
    cur = resolve_domain(p, args)
    items = []
    for name in sorted(p["domains"]):
        d = p["domains"][name]
        items.append({"name": name, "sections": len(d.get("sections") or []),
                      "notes": len(d.get("notes") or []), "current": name == cur})
    return {"ok": True, "current": cur, "count": len(items), "domains": items}


def cmd_use(args: argparse.Namespace) -> dict:
    """切域：粘性状态写进 profile.json（单一事实源），不存在则建空域。

    为什么允许「切到一个还没内容的域」：先切域再记东西是自然顺序；要求先 section-add
    才有 use 会逼用户倒着操作。返回 `created` 让调用方知道这是新域。
    """
    p = load()
    if p.get("corrupt"):
        raise ProfileError("profile.json 无法解析，拒绝写入以免覆盖", code="CORRUPT", field="path")
    target = args.name.strip()
    if target.lower() in ("none", "global", ""):
        p["current_domain"] = ""
        save(p)
        return {"ok": True, "current": "", "created": False, "domains": len(p["domains"])}
    name = _strict_domain(target)
    if not name:
        raise ProfileError(
            f"域名字形状不合法（小写字母/数字/连字符，≤{MAX_DOMAIN}）：{target!r}", field="domain"
        )
    created = name not in p["domains"]
    layer_of(p, name, create=True)
    p["current_domain"] = name
    save(p)
    return {"ok": True, "current": name, "created": created, "domains": len(p["domains"])}


def cmd_domain_rm(args: argparse.Namespace) -> dict:
    p = load()
    if p.get("corrupt"):
        raise ProfileError("profile.json 无法解析，拒绝写入以免覆盖", code="CORRUPT", field="path")
    name = _strict_domain(args.name)
    if not name:
        raise ProfileError(f"未找到域 {args.name}", code="NOT_FOUND", field="domain")
    if name not in p["domains"]:
        raise ProfileError(f"未找到域 {args.name}", code="NOT_FOUND", field="domain")
    d = p["domains"][name]
    n = len(d.get("sections") or []) + len(d.get("notes") or [])
    if n and not args.force:
        raise ProfileError(
            f"域 {name} 还有 {n} 条内容；确认要整域删除请加 --force",
            code="NOT_EMPTY", field="domain",
        )
    del p["domains"][name]
    switched = ""
    if p.get("current_domain") == name:
        p["current_domain"] = ""
        switched = "已切回全局层（当前域被删除）"
    save(p)
    out = {"ok": True, "removed": name, "dropped": n, "domains": len(p["domains"])}
    if switched:
        out["note"] = switched
    return out


def cmd_section_add(args: argparse.Namespace) -> dict:
    """按 id 覆盖式写入一个章节（同 id 即更新，不追加重复章节）。"""
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "section" in raw:
        raw = raw["section"]
    sec = validate_section(raw)
    p = load()
    if p.get("corrupt"):
        raise ProfileError("profile.json 无法解析，拒绝写入以免覆盖", code="CORRUPT", field="path")
    dom = resolve_domain(p, args)
    layer = layer_of(p, dom, create=bool(dom))
    secs = [s for s in layer["sections"] if s.get("id") != sec["id"]]
    if len(secs) >= MAX_SECTIONS:
        raise ProfileError(f"章节数已达上限 {MAX_SECTIONS}，请先删掉不用的", code="LIMIT", field="sections")
    secs.append(sec)
    # 顺序钉死：user → model → workflow → env，同类内按 id——手改乱序也改不了结构。
    secs.sort(key=lambda s: (KIND_ORDER.get(s.get("kind", "user"), 99), str(s.get("id", ""))))
    layer["sections"] = secs
    save(p)
    return {"ok": True, "section": sec, "domain": dom, "sections": len(secs),
            "path": str(profile_path())}


def cmd_section_rm(args: argparse.Namespace) -> dict:
    p = load()
    dom = resolve_domain(p, args)
    if dom and dom not in p["domains"]:
        raise ProfileError(f"未找到域 {dom}", code="NOT_FOUND", field="domain")
    layer = layer_of(p, dom, create=False)
    n = len(layer["sections"])
    layer["sections"] = [s for s in layer["sections"] if s.get("id") != args.id]
    if len(layer["sections"]) == n:
        raise ProfileError(f"未找到章节 {args.id}", code="NOT_FOUND", field="id")
    save(p)
    return {"ok": True, "id": args.id, "domain": dom, "sections": len(layer["sections"])}


def all_note_ids(p: dict) -> list[dict]:
    """所有层（全局 + 各域）的 notes 汇总——只为取 id 用。

    为什么要跨层统一 ID：`note-rm <id>` 的 `--domain` 可选（还有环境变量与粘性状态两条
    隐式来源），若两层能出现同一个 id，同一条命令在不同域状态下会删掉不同东西——
    「看得见的同名字符串指向两个不同事实」是最难排查的一类错。所以 ID 全文件唯一。
    """
    out = list(p.get("notes") or [])
    for d in (p.get("domains") or {}).values():
        if isinstance(d, dict):
            out.extend(d.get("notes") or [])
    return out


def cmd_note(args: argparse.Namespace) -> dict:
    """追加一条观察。超过 MAX_NOTES 时**丢最旧**而不是拒绝：观察是可丢弃的
    （章节才是固化结论），拒绝写会让模型在画像满后彻底失去记录能力。"""
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "note" in raw:
        raw = raw["note"]
    p = load()
    if p.get("corrupt"):
        raise ProfileError("profile.json 无法解析，拒绝写入以免覆盖", code="CORRUPT", field="path")
    dom = resolve_domain(p, args)
    layer = layer_of(p, dom, create=bool(dom))
    item = validate_note(raw, all_note_ids(p))
    layer["notes"].append(item)
    dropped = []
    while len(layer["notes"]) > MAX_NOTES:
        dropped.append(layer["notes"].pop(0).get("id"))
    save(p)
    out = {"ok": True, "id": item["id"], "domain": dom, "notes": len(layer["notes"])}
    if dropped:
        out["dropped"] = dropped
    return out


def cmd_note_rm(args: argparse.Namespace) -> dict:
    p = load()
    dom = resolve_domain(p, args)
    if dom and dom not in p["domains"]:
        raise ProfileError(f"未找到域 {dom}", code="NOT_FOUND", field="domain")
    layer = layer_of(p, dom, create=False)
    n = len(layer["notes"])
    layer["notes"] = [x for x in layer["notes"] if x.get("id") != args.id]
    if len(layer["notes"]) == n:
        raise ProfileError(f"未找到观察 {args.id}", code="NOT_FOUND", field="id")
    save(p)
    return {"ok": True, "id": args.id, "domain": dom, "notes": len(layer["notes"])}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="用户/模型习惯画像 CLI（.rsi/profile.json）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("show", help="全量查看")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("brief", help="有界摘要（进 prompt 用这个）")
    p.add_argument("--limit", type=int, default=2000)
    p.add_argument("--domain", default=None, help="只看某个域（none=全局）")
    p.set_defaults(fn=cmd_brief)

    p = sub.add_parser("domains", help="列出域与当前域")
    p.add_argument("--domain", default=None)
    p.set_defaults(fn=cmd_domains)

    p = sub.add_parser("use", help="切换当前域（不存在则建空域）")
    p.add_argument("name", help="域名；none 表示回全局")
    p.set_defaults(fn=cmd_use)

    p = sub.add_parser("domain-rm", help="删除一个域")
    p.add_argument("name")
    p.add_argument("--force", action="store_true", help="域内有内容时也删")
    p.set_defaults(fn=cmd_domain_rm)

    p = sub.add_parser("section-add", help="覆盖式写入一个章节（JSON 文件）")
    p.add_argument("--file", required=True)
    p.add_argument("--domain", default=None)
    p.set_defaults(fn=cmd_section_add)

    p = sub.add_parser("section-rm", help="删除一个章节")
    p.add_argument("id")
    p.add_argument("--domain", default=None)
    p.set_defaults(fn=cmd_section_rm)

    p = sub.add_parser("note", help="追加一条观察（JSON 文件）")
    p.add_argument("--file", required=True)
    p.add_argument("--domain", default=None)
    p.set_defaults(fn=cmd_note)

    p = sub.add_parser("note-rm", help="删除一条观察")
    p.add_argument("id")
    p.add_argument("--domain", default=None)
    p.set_defaults(fn=cmd_note_rm)
    return ap


def main(argv: list[str] | None = None) -> int:
    ns = build_parser().parse_args(argv)
    try:
        out = ns.fn(ns)
    except ProfileError as e:
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
