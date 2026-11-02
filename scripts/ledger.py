"""工作账本：只追加、字段白名单、召回 ≤5 条摘要、写入前脱敏。

存储（默认 rsi-agent/ledger，可用 RSI_LEDGER_DIR 覆盖）：
    work/YYYY-MM/{work_id}.json
    index.jsonl
    feedback.jsonl
    baseline.json（由 run_evals --set-baseline 写入）

用法：
    python scripts/ledger.py append --record work.json
    python scripts/ledger.py query --skill rsi-steward --keyword 周报 --limit 5
    python scripts/ledger.py verify
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import dumps, emit, ledger_dir, load_config  # noqa: E402

WORK_FIELDS = (
    "work_id", "task", "task_type", "keywords", "acceptance", "skills", "steps",
    "outcome", "signals", "cost", "decision", "lessons", "artifacts", "llm", "created_at",
)
OUTCOMES = ("success", "fail", "partial", "blocked")
SIGNAL_TYPES = ("user_confirm", "user_correction", "assert", "test", "judge", "human", "real_result", "rollback")
LESSON_TYPES = ("failure_fix", "exemplar", "decision")
FEEDBACK_FIELDS = ("work_id", "skill", "kind", "note", "created_at")

SENSITIVE = (
    (re.compile(r"sk-[A-Za-z0-9]{16,}"), "api-key"),
    (re.compile(r"(?i)(api[_-]?key|password|passwd|secret|token|bearer)\s*[:=]\s*[^\s,;\"']+"), "secret"),
    (re.compile(r"(?<!\d)1[3-9][0-9]{9}(?!\d)"), "phone"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|cn|org|net|edu)"), "email"),
    (re.compile(r"(?<![0-9Xx])[0-9]{17}[0-9Xx](?![0-9Xx])"), "id-card"),
    (re.compile(r"BEGIN (?:RSA |EC )?PRIVATE KEY"), "private-key"),
)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _today() -> str:
    return datetime.now().strftime("%Y%m%d")


def _scrub(value, path: str, hits: list, redact: bool):
    if isinstance(value, str):
        cleaned = value
        for pattern, label in SENSITIVE:
            if pattern.search(cleaned):
                hits.append({"path": path, "kind": label})
                if redact:
                    cleaned = pattern.sub("[REDACTED]", cleaned)
        return cleaned
    if isinstance(value, list):
        return [_scrub(v, f"{path}[{i}]", hits, redact) for i, v in enumerate(value)]
    if isinstance(value, dict):
        return {k: _scrub(v, f"{path}.{k}", hits, redact) for k, v in value.items()}
    return value


def _validate(record: dict, redact: bool) -> tuple[dict, list]:
    errors, warnings = [], []
    unknown = [k for k in record if k not in WORK_FIELDS]
    if unknown:
        errors.append({"code": "E_LEDGER_FIELD", "path": "record", "message": f"不在白名单的字段: {unknown}"})
    if not record.get("task"):
        errors.append({"code": "E_LEDGER_TASK", "path": "record.task", "message": "task 必填"})
    elif len(str(record["task"])) > 120:
        errors.append({"code": "E_LEDGER_TOO_LONG", "path": "record.task", "message": "task 超过 120 字符"})
    if record.get("outcome") and record["outcome"] not in OUTCOMES:
        errors.append({"code": "E_LEDGER_OUTCOME", "path": "record.outcome", "message": f"outcome 必须属于 {OUTCOMES}"})
    keywords = record.get("keywords") or []
    if not isinstance(keywords, list) or len(keywords) > 20:
        errors.append({"code": "E_LEDGER_KEYWORDS", "path": "record.keywords", "message": "keywords 必须是最多 20 项的数组"})
    for item in record.get("signals") or []:
        if not isinstance(item, dict) or item.get("type") not in SIGNAL_TYPES:
            errors.append({"code": "E_LEDGER_SIGNAL", "path": "record.signals", "message": f"signal.type 必须属于 {SIGNAL_TYPES}"})
    for item in record.get("lessons") or []:
        if not isinstance(item, dict):
            errors.append({"code": "E_LEDGER_LESSON", "path": "record.lessons", "message": "lesson 必须是对象"})
            continue
        if item.get("type") not in LESSON_TYPES:
            errors.append({"code": "E_LEDGER_LESSON", "path": "record.lessons", "message": f"lesson.type 必须属于 {LESSON_TYPES}"})
        if item.get("type") == "failure_fix" and not item.get("case_id"):
            errors.append({"code": "E_LEDGER_CASE_ID", "path": "record.lessons", "message": "failure_fix 必须带 case_id"})
        if len(str(item.get("summary", ""))) > 200:
            errors.append({"code": "E_LEDGER_TOO_LONG", "path": "record.lessons", "message": "lesson.summary 超过 200 字符"})

    hits: list = []
    cleaned = _scrub(record, "record", hits, redact)
    if hits and not redact:
        errors.append({"code": "E_LEDGER_SENSITIVE", "path": "record",
                       "message": f"检测到敏感信息: {[h['path'] for h in hits]}"})
    return cleaned, errors


def _redacted_warnings(record: dict, redact: bool) -> list:
    if not redact:
        return []
    hits: list = []
    _scrub(record, "record", hits, True)
    return [{"code": "W_LEDGER_REDACTED", **h} for h in hits]


def _index_entry(work_id: str, record: dict, path: Path) -> dict:
    return {
        "work_id": work_id,
        "task": record.get("task"),
        "task_type": record.get("task_type"),
        "keywords": record.get("keywords") or [],
        "skills": [s.get("name") for s in (record.get("skills") or []) if isinstance(s, dict) and s.get("name")],
        "outcome": record.get("outcome"),
        "signals": [s.get("type") for s in (record.get("signals") or []) if isinstance(s, dict)],
        "decision": record.get("decision"),
        "created_at": record.get("created_at") or _now(),
        "path": str(path),
    }


def append_work(record: dict, redact: bool = True) -> dict:
    rec = dict(record)
    rec.setdefault("created_at", _now())
    cleaned, errors = _validate(rec, redact)
    if errors:
        return {"ok": False, "errors": errors}
    warnings = _redacted_warnings(rec, redact)
    root = ledger_dir()
    work_id = cleaned.get("work_id")
    month_dir = root / "work" / datetime.now().strftime("%Y-%m")
    month_dir.mkdir(parents=True, exist_ok=True)
    if not work_id:
        prefix = f"work-{_today()}-"
        existing = len(list(month_dir.glob(prefix + "*.json")))
        work_id = f"{prefix}{existing + 1:03d}"
    cleaned["work_id"] = work_id
    path = month_dir / f"{work_id}.json"
    path.write_text(dumps(cleaned) + "\n", encoding="utf-8")
    with (root / "index.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_index_entry(work_id, cleaned, path), ensure_ascii=False) + "\n")
    return {"ok": True, "work_id": work_id, "path": str(path), "warnings": warnings}


def append_feedback(record: dict, redact: bool = True) -> dict:
    rec = dict(record)
    rec.setdefault("created_at", _now())
    unknown = [k for k in rec if k not in FEEDBACK_FIELDS]
    if unknown:
        return {"ok": False, "errors": [{"code": "E_LEDGER_FIELD", "path": "record", "message": f"不在白名单: {unknown}"}]}
    hits: list = []
    cleaned = _scrub(rec, "record", hits, redact)
    root = ledger_dir()
    with (root / "feedback.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(cleaned, ensure_ascii=False) + "\n")
    return {"ok": True, "path": str(root / "feedback.jsonl")}


def _load_index(root: Path) -> list[dict]:
    idx = root / "index.jsonl"
    entries = []
    if idx.is_file():
        for line in idx.read_text(encoding="utf-8").splitlines():
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
    if not entries:
        for f in sorted((root / "work").glob("*/*.json")):
            rec = json.loads(f.read_text(encoding="utf-8"))
            entries.append(_index_entry(rec.get("work_id", f.stem), rec, f))
    return entries


def load_index() -> list[dict]:
    """公开只读入口：使用率统计 / 例行复盘读取轻索引。"""
    return _load_index(ledger_dir())


def query(skill: str = "", task_type: str = "", outcome: str = "", keyword: str = "", limit: int = 5) -> dict:
    root = ledger_dir()
    cfg_limit = int(load_config()["recall"].get("limit", 5))
    limit = max(1, min(limit or cfg_limit, cfg_limit, 5))
    tokens = [t for t in re.split(r"[^\w\u4e00-\u9fff]+", keyword or "") if t]
    now = datetime.now(timezone.utc)
    scored = []
    for e in _load_index(root):
        if skill and skill not in (e.get("skills") or []):
            continue
        if task_type and e.get("task_type") != task_type:
            continue
        if outcome and e.get("outcome") != outcome:
            continue
        score = 0.0
        if skill:
            score += 2.0
        if task_type:
            score += 1.0
        haystack = " ".join([str(e.get("task", "")), " ".join(map(str, e.get("keywords") or [])),
                             " ".join(map(str, e.get("skills") or []))])
        for t in tokens:
            if t in haystack:
                score += 1.0
        try:
            ts = datetime.fromisoformat(e.get("created_at", "")).astimezone(timezone.utc)
            score += max(0.0, 1.0 - (now - ts).days / 30.0)
        except (ValueError, TypeError):
            pass
        if tokens and score <= 0:
            continue
        scored.append((score, e))
    scored.sort(key=lambda x: (x[0], x[1].get("created_at", "")), reverse=True)
    items = [{
        "work_id": e["work_id"], "task": e.get("task"), "skills": e.get("skills"),
        "outcome": e.get("outcome"), "decision": e.get("decision"),
        "created_at": e.get("created_at"), "path": e.get("path"),
    } for _, e in scored[:limit]]
    return {"ok": True, "count": len(items), "limit": limit, "items": items}


def verify() -> dict:
    root = ledger_dir()
    violations = []
    targets = [root / "index.jsonl", root / "feedback.jsonl", root / "baseline.json"]
    targets += sorted((root / "work").glob("*/*.json"))
    for f in targets:
        if not f.is_file():
            continue
        text = f.read_text(encoding="utf-8")
        for pattern, label in SENSITIVE:
            if pattern.search(text):
                violations.append({"code": "E_LEDGER_SENSITIVE", "path": str(f), "kind": label})
    return {"ok": not violations, "checked": len(targets), "violations": violations}


def main() -> int:
    ap = argparse.ArgumentParser(description="工作账本（追加/检索/脱敏校验）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_append = sub.add_parser("append")
    p_append.add_argument("--record", help="记录 JSON 文件；缺省从 stdin 读")
    p_append.add_argument("--feedback", action="store_true", help="写 feedback.jsonl 而不是工作账本")
    p_append.add_argument("--no-redact", action="store_true", help="检测到敏感信息时拒绝而不是脱敏")
    p_query = sub.add_parser("query")
    p_query.add_argument("--skill", default="")
    p_query.add_argument("--task-type", default="")
    p_query.add_argument("--outcome", default="")
    p_query.add_argument("--keyword", default="")
    p_query.add_argument("--limit", type=int, default=5)
    sub.add_parser("verify")
    args = ap.parse_args()

    if args.cmd == "append":
        raw = Path(args.record).read_text(encoding="utf-8") if args.record else sys.stdin.read()
        try:
            record = json.loads(raw)
        except ValueError as exc:
            emit({"ok": False, "error": {"code": "E_RECORD_JSON", "message": f"JSON 解析失败: {exc}"}})
            return 2
        fn = append_feedback if args.feedback else append_work
        result = fn(record, redact=not args.no_redact)
        emit(result)
        return 0 if result.get("ok") else 1
    if args.cmd == "query":
        result = query(args.skill, args.task_type, args.outcome, args.keyword, args.limit)
        emit(result)
        return 0
    result = verify()
    emit(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
