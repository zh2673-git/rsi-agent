"""技能评测：回放案例 → 判分 → 汇总 → 对比基线 → 晋升建议。

设计（docs/05 §1）：
- assert/test：确定性检查（contains / not_contains / regex / exact / any_of）；
- judge：外部裁判命令（stdin 收 {case, output}，stdout 回 {"score":0..1}），无裁判则 pending；
- human：outputs 里带 confirmed/score；
- 没有完整判分的案例不算决定案例；决定案例不足 min_cases 不可晋升。

用法：
    python scripts/run_evals.py --skill skills/rsi-steward --set-baseline
    python scripts/run_evals.py --skill skills/rsi-steward --outputs outputs.jsonl
    python scripts/run_evals.py --skill skills/rsi-steward --judge-cmd "python judge.py"
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import dumps, emit, evidence_dir, ledger_dir, load_config, read_json, resolve_skill  # noqa: E402

REQUIRED = ("id", "input", "expect", "rubric", "signal", "source")
SIGNALS = ("assert", "judge", "human", "test")
EVIDENCE_ORDER = {"E1": 3, "E2": 2, "E3": 1, "E4": 0, "E5": -1}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def load_cases(path: Path) -> tuple[list[dict], list[dict]]:
    if not path.is_file():
        return [], [{"code": "E_CASES_MISSING", "path": str(path), "message": "案例文件不存在"}]
    cases, errors = [], []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            case = json.loads(line)
        except ValueError:
            errors.append({"code": "E_CASE_JSON", "path": f"{path}#L{i}", "message": "不是合法 JSON"})
            continue
        missing = [k for k in REQUIRED if not case.get(k)]
        if missing:
            errors.append({"code": "E_CASE_FIELDS", "path": f"{path}#L{i}", "message": f"缺字段: {', '.join(missing)}"})
            continue
        if case.get("signal") not in SIGNALS:
            errors.append({"code": "E_CASE_SIGNAL", "path": f"{path}#L{i}", "message": f"signal 非法: {case.get('signal')}"})
            continue
        if str(case.get("source", "")).strip() in ("模型认为", "model", "AI"):
            errors.append({"code": "E_CASE_SOURCE", "path": f"{path}#L{i}", "message": "来源必须可追溯，不能用「模型认为」"})
            continue
        cases.append(case)
    return cases, errors


def load_outputs(path: Path | None) -> dict:
    if path is None:
        return {}
    if not path.is_file():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        cid = item.get("id")
        if cid:
            out[cid] = item
    return out


def check_output(check: dict, text: str) -> tuple[bool, str]:
    kind = (check or {}).get("kind")
    value = (check or {}).get("value")
    if kind == "contains":
        values = value if isinstance(value, list) else [value]
        missing = [v for v in values if str(v) not in text]
        return (not missing, "全部命中" if not missing else f"缺少: {missing}")
    if kind == "not_contains":
        values = value if isinstance(value, list) else [value]
        hits = [v for v in values if str(v) in text]
        return (not hits, "未出现禁用词" if not hits else f"出现: {hits}")
    if kind == "regex":
        pattern = (check or {}).get("pattern") or value
        try:
            hit = re.search(str(pattern), text)
        except re.error as exc:
            return False, f"正则非法: {exc}"
        return (bool(hit), "匹配" if hit else f"未匹配 /{pattern}/")
    if kind == "exact":
        return (text.strip() == str(value).strip(), "完全一致" if text.strip() == str(value).strip() else "不一致")
    if kind == "any_of":
        values = value if isinstance(value, list) else [value]
        hits = [v for v in values if str(v) in text]
        return (bool(hits), f"命中任一: {hits}" if hits else "一个都未命中")
    return False, f"未知 check.kind: {kind}"


def run_judge(cmd: str, case: dict, output: str) -> tuple[float | None, str]:
    if not cmd:
        return None, "未提供 --judge-cmd（pending）"
    payload = dumps({"case": case, "output": output})
    try:
        proc = subprocess.run(
            shlex.split(cmd, posix=False),
            input=payload,
            capture_output=True,
            text=True,
            timeout=120,
            encoding="utf-8",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"裁判执行失败: {exc}"
    if proc.returncode != 0:
        return None, f"裁判退出码 {proc.returncode}: {proc.stderr.strip()[:200]}"
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        return None, "裁判输出不是 JSON"
    score = data.get("score")
    if isinstance(score, (int, float)) and 0 <= float(score) <= 1:
        return float(score), data.get("reason", "")
    return None, "裁判未返回 0..1 的 score"


def _score_case(case: dict, item: dict, cfg: dict, judge_cmd: str) -> dict:
    cid = case["id"]
    signal = case["signal"]
    text = str(item.get("output") or "")
    base = {"id": cid, "signal": signal, "weight": float(case.get("weight", 1))}
    if not text and signal in ("assert", "test"):
        return {**base, "status": "pending", "score": None, "pass": None, "reason": "缺少产物（--outputs）"}
    if signal in ("assert", "test"):
        check = case.get("check")
        if not check:
            return {**base, "status": "invalid", "score": None, "pass": None, "reason": "assert/test 案例缺 check"}
        passed, reason = check_output(check, text)
        return {**base, "status": "decided", "score": 1.0 if passed else 0.0, "pass": passed, "reason": reason}
    if signal == "judge":
        if item.get("score") is not None:
            score = float(item["score"])
            return {**base, "status": "decided", "score": score,
                    "pass": score >= cfg["eval"].get("judge_pass", 0.6), "reason": "outputs 自带 score"}
        score, reason = run_judge(judge_cmd, case, text)
        if score is None:
            return {**base, "status": "pending", "score": None, "pass": None, "reason": reason}
        return {**base, "status": "decided", "score": score,
                "pass": score >= cfg["eval"].get("judge_pass", 0.6), "reason": reason}
    if signal == "human":
        if item.get("confirmed") is True:
            return {**base, "status": "decided", "score": 1.0, "pass": True, "reason": "人工确认"}
        if item.get("confirmed") is False:
            return {**base, "status": "decided", "score": 0.0, "pass": False, "reason": "人工否决"}
        return {**base, "status": "pending", "score": None, "pass": None, "reason": "等待人工确认"}
    return {**base, "status": "invalid", "score": None, "pass": None, "reason": f"未知 signal: {signal}"}


def evaluate(skill_dir: Path, suite: Path, outputs_path: Path | None, judge_cmd: str,
             baseline_path: Path, version: str | None) -> dict:
    cfg = load_config()
    contract = read_json(skill_dir / "skill.json")
    name = contract.get("name") or skill_dir.name
    version = version or contract.get("version") or "0.1.0"
    if contract.get("legacy"):
        legacy = True
    else:
        legacy = not (skill_dir / "evals" / "cases.jsonl").is_file()

    cases, case_errors = load_cases(suite)
    if case_errors:
        return {"ok": False, "skill": name, "version": version, "errors": case_errors}
    min_cases = int(cfg["lifecycle"].get("min_cases", 3))
    if len(cases) < min_cases:
        return {"ok": False, "skill": name, "version": version,
                "errors": [{"code": "E_CASES_LESS_THAN_MIN", "path": str(suite),
                            "message": f"案例数 {len(cases)} < {min_cases}"}]}

    outputs = load_outputs(outputs_path)
    results = []
    for case in cases:
        item = outputs.get(case["id"]) or {}
        if not item and case.get("output"):
            item = {"output": case["output"]}
        results.append(_score_case(case, item, cfg, judge_cmd))

    decided = [r for r in results if r["status"] == "decided"]
    invalid = [r for r in results if r["status"] == "invalid"]
    pending = [r for r in results if r["status"] == "pending"]
    weight_sum = sum(r["weight"] for r in decided) or 1.0
    pass_rate = sum(r["weight"] for r in decided if r["pass"]) / weight_sum
    pass_rate = round(pass_rate, 4)

    baseline = read_json(baseline_path)
    prev = (baseline.get("skills") or {}).get(name) or {}
    prev_cases = {k: bool(v) for k, v in (prev.get("cases") or {}).items()}
    regressions = [r["id"] for r in results if prev_cases.get(r["id"]) and r["pass"] is False]
    tolerance = float(cfg["eval"].get("baseline_tolerance", 0.05))
    degraded = bool(prev) and pass_rate < float(prev.get("pass_rate", 0)) - tolerance
    threshold = float(cfg["eval"].get("pass_threshold", 0.8))

    reasons = []
    if invalid:
        reasons.append(f"存在无效案例: {[r['id'] for r in invalid]}")
    if len(decided) < min_cases:
        reasons.append(f"决定案例不足: {len(decided)} < {min_cases}")
    if regressions:
        reasons.append(f"旧案例退化: {regressions}")
    if degraded:
        reasons.append(f"总分低于基线 {prev.get('pass_rate')} - {tolerance}")
    if pass_rate < threshold:
        reasons.append(f"总分 {pass_rate} < 门槛 {threshold}")
    if legacy:
        reasons.append("legacy 技能不可自动晋升（需人工确认）")
    eligible = not reasons

    scorecard = {
        "ok": not invalid and not regressions and not degraded,
        "skill": name,
        "version": version,
        "suite": str(suite),
        "evaluated_at": _now(),
        "summary": {"total": len(cases), "decided": len(decided), "pending": len(pending),
                    "invalid": len(invalid), "pass_rate": pass_rate},
        "cases": results,
        "baseline": {"path": str(baseline_path),
                     "version": prev.get("version"),
                     "pass_rate": prev.get("pass_rate")},
        "regressions": regressions,
        "degraded": degraded,
        "promotion": {"eligible": eligible, "reasons": reasons,
                      "note": "仍需至少一条 E1/E2/E3 外部信号（见 skill_state.py promote）"},
    }
    return scorecard


def _write_results(skill_dir: Path, card: dict) -> str:
    out_dir = skill_dir / "evals" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{card['version']}.json"
    path.write_text(dumps(card) + "\n", encoding="utf-8")
    ev = evidence_dir() / card["skill"] / card["version"]
    ev.mkdir(parents=True, exist_ok=True)
    (ev / "scorecard.json").write_text(dumps(card) + "\n", encoding="utf-8")
    return str(path)


def _set_baseline(baseline_path: Path, card: dict) -> None:
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    data = read_json(baseline_path) or {}
    data.setdefault("skills", {})[card["skill"]] = {
        "version": card["version"],
        "pass_rate": card["summary"]["pass_rate"],
        "cases": {c["id"]: bool(c["pass"]) for c in card["cases"] if c["status"] == "decided"},
        "updated_at": _now(),
    }
    baseline_path.write_text(dumps(data) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="技能评测（案例回放 + 基线对比）")
    ap.add_argument("--skill", required=True, help="技能目录或名称")
    ap.add_argument("--suite", default=None, help="案例文件（默认 <skill>/evals/cases.jsonl）")
    ap.add_argument("--outputs", default=None, help="产物 JSONL：{id, output, score?, confirmed?}")
    ap.add_argument("--judge-cmd", default="", help="裁判命令（stdin 收 {case,output}，stdout 回 {score}")
    ap.add_argument("--baseline", default=None, help="基线文件（默认 ledger/baseline.json）")
    ap.add_argument("--version", default=None, help="覆盖 skill.json 的版本号")
    ap.add_argument("--set-baseline", action="store_true", help="把本次结果写为基线")
    args = ap.parse_args()

    skill_dir = resolve_skill(args.skill)
    if not skill_dir.is_dir():
        emit({"ok": False, "error": {"code": "E_SKILL_DIR", "message": f"目录不存在: {skill_dir}"}})
        return 2
    suite = Path(args.suite) if args.suite else skill_dir / "evals" / "cases.jsonl"
    baseline = Path(args.baseline) if args.baseline else ledger_dir() / "baseline.json"
    card = evaluate(skill_dir, suite, Path(args.outputs) if args.outputs else None,
                    args.judge_cmd, baseline, args.version)
    if card.get("ok") is False and card.get("errors"):
        emit(card)
        return 2
    card["results_path"] = _write_results(skill_dir, card)
    if args.set_baseline:
        _set_baseline(baseline, card)
        card["baseline_written"] = str(baseline)
    emit(card)
    return 0 if card["promotion"]["eligible"] or args.set_baseline else 1


if __name__ == "__main__":
    raise SystemExit(main())
