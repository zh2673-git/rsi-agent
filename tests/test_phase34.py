"""Phase 3/4 自测：A/B、使用率/退役、例行复盘提案、健康报告与看板。

运行：python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import health_report  # noqa: E402
import rsi_common  # noqa: E402
import rsi_routine  # noqa: E402
import skill_ab  # noqa: E402
import usage_report  # noqa: E402


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def make_skill(root: Path, name: str, status: str = "active", tools: bool = False,
               card: dict | None = None) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: 测试技能 {name}\n---\n\n# {name}\n\n## 验收\n\n- [ ] 可执行\n",
        encoding="utf-8",
    )
    contract = {"name": name, "version": "1.0.0", "status": status,
                "description": f"测试技能 {name}", "verification": "verified"}
    (d / "skill.json").write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "state.json").write_text(json.dumps(
        {"skill": name, "status": status, "active_version": "1.0.0"}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    if tools:
        (d / "tools.json").write_text(json.dumps([{
            "name": "run_tests", "description": "d", "parameters": {},
            "exec": {"cmd": ["python", "-c", "print(1)"]},
        }]), encoding="utf-8")
    if card:
        results = d / "evals" / "results"
        results.mkdir(parents=True, exist_ok=True)
        (results / f"{card['version']}.json").write_text(
            json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
    return d


def scorecard(skill: str, version: str, cases: list[dict], eligible: bool = True,
              suite: str = "default") -> dict:
    decided = [c for c in cases if c.get("pass") is not None]
    rate = round(sum(1 for c in decided if c["pass"]) / len(decided), 4) if decided else 0.0
    return {
        "ok": True, "skill": skill, "version": version, "suite": suite,
        "summary": {"total": len(cases), "decided": len(decided), "pending": 0,
                    "invalid": 0, "pass_rate": rate},
        "cases": cases,
        "promotion": {"eligible": eligible, "reasons": []},
        "regressions": [], "degraded": False,
    }


class Phase34Test(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ledger = self.root / "ledger"
        self.skills = self.root / "skills"
        self.ledger.mkdir()
        self.skills.mkdir()
        self.env = patch.dict(os.environ, {
            "RSI_LEDGER_DIR": str(self.ledger),
            "SKILLS_DIR": str(self.skills),
        })
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    # ---- Phase 3：A/B ----

    def test_ab_rejects_regression_and_promotes_fix(self) -> None:
        a = scorecard("demo", "1.0.0", [
            {"id": "c1", "pass": False, "score": 0.0},
            {"id": "c2", "pass": True, "score": 1.0},
        ])
        b = scorecard("demo", "1.1.0", [
            {"id": "c1", "pass": True, "score": 1.0},
            {"id": "c2", "pass": False, "score": 0.0},
        ])
        bad = skill_ab.compare("demo", a, b, None, None)
        self.assertEqual(bad["verdict"], "reject")
        self.assertEqual(next(c for c in bad["cases"] if c["id"] == "c2")["status"], "regressed")

        b2 = scorecard("demo", "1.1.0", [
            {"id": "c1", "pass": True, "score": 1.0},
            {"id": "c2", "pass": True, "score": 1.0},
        ])
        good = skill_ab.compare("demo", a, b2, None, None)
        self.assertEqual(good["verdict"], "promote")
        self.assertEqual(good["summary"]["fixed"], 1)

        other_suite = scorecard("demo", "1.1.0", b2["cases"], suite="other")
        hold = skill_ab.compare("demo", a, other_suite, None, None)
        self.assertEqual(hold["verdict"], "hold")
        self.assertIn("不同 suite", hold["warnings"][0])

    # ---- Phase 3：使用率 / 退役 ----

    def _index(self, rows: list[dict]) -> None:
        with (self.ledger / "index.jsonl").open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps({"task": "t", "task_type": "", "keywords": [], "skills": [row["skill"]],
                                     "outcome": row["outcome"], "signals": row.get("signals", []),
                                     "decision": "", "created_at": row.get("created_at", now_iso()),
                                     "path": "work", "work_id": row["id"]}, ensure_ascii=False) + "\n")

    def test_usage_report_and_retire(self) -> None:
        card = scorecard("demo", "1.0.0", [{"id": "c1", "pass": True, "score": 1.0}])
        make_skill(self.skills, "demo", status="active", card=card)
        rows = [{"id": f"w{i}", "skill": "demo", "outcome": "fail" if i >= 2 else "success"}
                for i in range(5)]
        self._index(rows)

        report = usage_report.build_report()
        demo = next(s for s in report["skills"] if s["name"] == "demo")
        self.assertTrue(demo["retire_candidate"])
        self.assertEqual(demo["usage"]["uses"], 5)
        self.assertEqual(demo["usage"]["success_rate"], 0.4)

        applied = usage_report.apply_retire(report)
        self.assertTrue(applied["ok"], applied)
        state = json.loads((self.skills / "demo" / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "retired")

    # ---- Phase 4：例行复盘 ----

    def test_routine_scan_proposes_and_approves_knowledge(self) -> None:
        good = scorecard("demo", "1.0.0", [
            {"id": f"c{i}", "pass": True, "score": 1.0} for i in range(3)
        ])
        make_skill(self.skills, "demo", status="active", card=good)
        make_skill(self.skills, "tooly", status="active", tools=True)
        self._index([
            {"id": "w1", "skill": "demo", "outcome": "success", "signals": ["user_correction"]},
            {"id": "w2", "skill": "demo", "outcome": "fail"},
            {"id": "w3", "skill": "demo", "outcome": "fail"},
        ])

        result = rsi_routine.scan()
        kinds = {t["kind"] for t in result["triggers"]}
        self.assertIn("user_correction", kinds)
        self.assertIn("consecutive_failures", kinds)
        self.assertIn("periodic", kinds)

        proposed = []
        for t in result["triggers"]:
            if t["signal"] in ("E1", "E2", "E3"):
                proposed.append(rsi_routine.propose(t))
        self.assertTrue(proposed)
        knowledge = next(p for p in proposed if p["skill"] == "demo")
        ok = rsi_routine.approve(knowledge["id"], human=False)
        self.assertTrue(ok["ok"], ok)

        tool_prop = rsi_routine.propose({"skill": "tooly", "kind": "user_correction",
                                         "signal": "E1", "detail": "工具层改动"})
        rejected = rsi_routine.approve(tool_prop["id"], human=False)
        self.assertFalse(rejected["ok"])
        approved = rsi_routine.approve(tool_prop["id"], human=True)
        self.assertTrue(approved["ok"], approved)

    def test_quota_trigger_and_report(self) -> None:
        make_skill(self.skills, "s1", status="active")
        make_skill(self.skills, "s2", status="draft")
        cfg = {k: dict(v) for k, v in rsi_common.DEFAULT_CONFIG.items()}
        cfg["quota"] = {"max_active": 0, "max_total": 1}
        with patch.object(rsi_routine, "load_config", return_value=cfg):
            result = rsi_routine.scan()
        quota = next(t for t in result["triggers"] if t["kind"] == "quota")
        self.assertEqual(quota["signal"], "E5")
        self.assertIn("超配额", quota["detail"])

        month = datetime.now().strftime("%Y-%m")
        with patch.object(health_report, "load_config", return_value=cfg):
            data = health_report.build(month)
        self.assertTrue(data["summary"]["quota"]["violated"])
        rendered = health_report.render_markdown(data)
        self.assertIn("超限", rendered)

    def test_knowledge_requires_external_signal_and_eval(self) -> None:
        make_skill(self.skills, "demo", status="active")
        prop = rsi_routine.propose({"skill": "demo", "kind": "periodic",
                                    "signal": "E5", "detail": "周期性复盘"})
        result = rsi_routine.approve(prop["id"], human=False)
        self.assertFalse(result["ok"])

    # ---- Phase 3/4：报告与看板 ----

    def test_health_and_dashboard_outputs(self) -> None:
        make_skill(self.skills, "demo", status="active")
        self._index([{"id": "w1", "skill": "demo", "outcome": "success"}])
        month = datetime.now().strftime("%Y-%m")
        data = health_report.build(month)
        rendered = health_report.render_markdown(data)
        self.assertIn("RSI 技能库健康报告", rendered)
        self.assertIn("demo", rendered)

        import dashboard

        html = dashboard.render(usage_report.build_report())
        self.assertIn("RSI 技能看板", html)
        self.assertIn("demo", html)


if __name__ == "__main__":
    unittest.main()
