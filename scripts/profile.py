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

三条纪律（与看板同源，不另起一套）：
  1. 读 → 改 → 写，按 id 合并（两侧并发写不吞条目）；
  2. tmp + 原子替换（半截 JSON 永不落地）；
  3. 枚举封闭 + 条数/长度上限（越界即拒，不静默截断）。

为什么是 CLI 不是技能工具：与 board.py 同一理由——技能工具装载后默认未启用，
而这条通道必须「装上就能用」。

用法：
    python scripts/profile.py show                      # 全量（人看）
    python scripts/profile.py brief                     # 有界摘要（进 prompt 用这个）
    python scripts/profile.py section-add --file s.json # 覆盖式写入一个章节
    python scripts/profile.py note --file n.json        # 追加一条观察
    python scripts/profile.py note-rm <id>
    python scripts/profile.py section-rm <name>

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
SECTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")

# 章节白名单（kind 决定注入顺序与语义）。为什么封闭：画像会进 system prompt，
# 自由章节等于让模型自己发明上下文结构——那和「多存一份聊天记录」没区别了。
SECTION_KINDS = ("user", "model", "workflow", "env")
KIND_ORDER = {k: i for i, k in enumerate(SECTION_KINDS)}

DEFAULT_PROFILE = {
    "version": 1,
    "updated_at": "",
    "sections": [],
    "notes": [],
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


def profile_path() -> Path:
    """`RSI_PROFILE_PATH`（工作区相对或绝对）覆盖，缺省 `<WORKSPACE_ROOT>/.rsi/profile.json`。"""
    env = os.environ.get("RSI_PROFILE_PATH", "").strip()
    p = Path(env) if env else Path(".rsi") / "profile.json"
    if not p.is_absolute():
        p = workspace_root() / p
    return p


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today() -> str:
    return datetime.now().strftime("%Y%m%d")


# ── 读写 ─────────────────────────────────────────────────────────────────────


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
    if isinstance(raw.get("updated_at"), str) and raw["updated_at"]:
        out["updated_at"] = raw["updated_at"]
    return out


def save(profile: dict) -> Path:
    p = profile_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    profile["version"] = 1
    profile["updated_at"] = now_iso()
    profile.pop("corrupt", None)
    tmp = p.parent / (p.name + ".tmp")
    tmp.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, p)  # 原子替换
    return p


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


def brief_text(p: dict) -> str:
    """有界摘要：章节（按 kind 钉死顺序）+ 最近 notes 若干。Rust 侧 profile_ctx.rs
    读的是同一份 JSON 并做自己的渲染；这里给的是「人/模型直接看」的等价文本。"""
    secs = sorted(
        (s for s in p.get("sections") or [] if s.get("kind") in SECTION_KINDS),
        key=lambda s: (KIND_ORDER[s["kind"]], str(s.get("id", ""))),
    )
    lines: list[str] = []
    for s in secs:
        lines.append(f"[{s.get('kind')}:{s.get('id')}] {s.get('title', '')}")
        lines.append(str(s.get("body", "")).strip())
    notes = (p.get("notes") or [])[-10:]
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
    text = brief_text(p)
    if len(text) > args.limit:
        text = text[: args.limit] + "…"
    return {"ok": True, "brief": text, "sections": len(p.get("sections") or []),
            "notes": len(p.get("notes") or [])}


def cmd_section_add(args: argparse.Namespace) -> dict:
    """按 id 覆盖式写入一个章节（同 id 即更新，不追加重复章节）。"""
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "section" in raw:
        raw = raw["section"]
    sec = validate_section(raw)
    p = load()
    if p.get("corrupt"):
        raise ProfileError("profile.json 无法解析，拒绝写入以免覆盖", code="CORRUPT", field="path")
    secs = [s for s in p["sections"] if s.get("id") != sec["id"]]
    if len(secs) >= MAX_SECTIONS:
        raise ProfileError(f"章节数已达上限 {MAX_SECTIONS}，请先删掉不用的", code="LIMIT", field="sections")
    secs.append(sec)
    # 顺序钉死：user → model → workflow → env，同类内按 id——手改乱序也改不了结构。
    secs.sort(key=lambda s: (KIND_ORDER.get(s.get("kind", "user"), 99), str(s.get("id", ""))))
    p["sections"] = secs
    save(p)
    return {"ok": True, "section": sec, "sections": len(secs), "path": str(profile_path())}


def cmd_section_rm(args: argparse.Namespace) -> dict:
    p = load()
    n = len(p["sections"])
    p["sections"] = [s for s in p["sections"] if s.get("id") != args.id]
    if len(p["sections"]) == n:
        raise ProfileError(f"未找到章节 {args.id}", code="NOT_FOUND", field="id")
    save(p)
    return {"ok": True, "id": args.id, "sections": len(p["sections"])}


def cmd_note(args: argparse.Namespace) -> dict:
    """追加一条观察。超过 MAX_NOTES 时**丢最旧**而不是拒绝：观察是可丢弃的
    （章节才是固化结论），拒绝写会让模型在画像满后彻底失去记录能力。"""
    raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "note" in raw:
        raw = raw["note"]
    p = load()
    if p.get("corrupt"):
        raise ProfileError("profile.json 无法解析，拒绝写入以免覆盖", code="CORRUPT", field="path")
    item = validate_note(raw, p["notes"])
    p["notes"].append(item)
    dropped = []
    while len(p["notes"]) > MAX_NOTES:
        dropped.append(p["notes"].pop(0).get("id"))
    save(p)
    out = {"ok": True, "id": item["id"], "notes": len(p["notes"])}
    if dropped:
        out["dropped"] = dropped
    return out


def cmd_note_rm(args: argparse.Namespace) -> dict:
    p = load()
    n = len(p["notes"])
    p["notes"] = [x for x in p["notes"] if x.get("id") != args.id]
    if len(p["notes"]) == n:
        raise ProfileError(f"未找到观察 {args.id}", code="NOT_FOUND", field="id")
    save(p)
    return {"ok": True, "id": args.id, "notes": len(p["notes"])}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="用户/模型习惯画像 CLI（.rsi/profile.json）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("show", help="全量查看")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("brief", help="有界摘要（进 prompt 用这个）")
    p.add_argument("--limit", type=int, default=2000)
    p.set_defaults(fn=cmd_brief)

    p = sub.add_parser("section-add", help="覆盖式写入一个章节（JSON 文件）")
    p.add_argument("--file", required=True)
    p.set_defaults(fn=cmd_section_add)

    p = sub.add_parser("section-rm", help="删除一个章节")
    p.add_argument("id")
    p.set_defaults(fn=cmd_section_rm)

    p = sub.add_parser("note", help="追加一条观察（JSON 文件）")
    p.add_argument("--file", required=True)
    p.set_defaults(fn=cmd_note)

    p = sub.add_parser("note-rm", help="删除一条观察")
    p.add_argument("id")
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
