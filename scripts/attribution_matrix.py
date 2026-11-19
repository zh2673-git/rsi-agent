#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""三仓归属矩阵对账器（read-only）。

为什么需要它：405 条补丁的归属判定是**人做的语义判断**，结果落在
`outputs/三仓优化归属与回灌方案.md` 的逐组明细里。但「判断」必须能对账——
上游发版、rsi 退休补丁之后，补丁集会变少，本脚本能立刻回答：
  · 报告里的 45 组是否仍然覆盖当前 scripts/patches/*.json 的全部补丁；
  · 有没有补丁没被任何组认领（漏判）；
  · 有没有补丁被两个组重复认领（双判）；
  · 有没有补丁 ID 在报告里出现但实际不存在（幻觉 ID）。

用法：
    python scripts/attribution_matrix.py            # 对账 + 刷新 outputs/三仓归属矩阵.json
    python scripts/attribution_matrix.py --check    # 只对账，不写文件（CI 用）

退出码：0 = 对账通过；1 = 有漏判/重复/幻觉 ID。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATCH_DIR = ROOT / "scripts" / "patches"
REPORT = ROOT / "outputs" / "三仓优化归属与回灌方案.md"
MATRIX_JSON = ROOT / "outputs" / "三仓归属矩阵.json"

# 报告里逐组明细的行格式（由 gen-report 统一生成）
_HEAD_RE = re.compile(r"^##### (\S+)　(.+)$", re.M)
_SIZE_RE = re.compile(r"\*\*变更组规模\*\*：(\d+) 条")
_BUCKET_RE = re.compile(r"\*\*归属\*\*：(.+?)　\|")
_FORM_RE = re.compile(r"\*\*迁移形式\*\*：(.+?)　\|")
_TARGET_RE = re.compile(r"\*\*目标文件\*\*：(.+)")
_MEM_RE = re.compile(r"\*\*成员补丁\*\*：(.+)")


def load_patches() -> dict[str, dict]:
    """读取当前 active 外挂补丁：scripts/patches/*.json（不是 blocks/）。"""
    out: dict[str, dict] = {}
    for jf in sorted(PATCH_DIR.glob("*.json")):
        try:
            d = json.loads(jf.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[{jf.name}] SKIP 格式错误: {e}", file=sys.stderr)
            continue
        pid = str(d.get("id", jf.stem))
        out[pid] = {
            "id": pid,
            "file": str(d.get("file", "")),
            "description": str(d.get("description", "")),
            "json": jf.name,
        }
    return out


def parse_report_groups(text: str) -> list[dict]:
    """从报告逐组明细解析出 45 组的判定数据。"""
    blocks = re.split(r"^##### ", text, flags=re.M)[1:]
    groups: list[dict] = []
    for b in blocks:
        head = b.split("\n", 1)[0]
        gid = head.split("　")[0].strip()
        name = head.split("　", 1)[1].strip() if "　" in head else head.strip()
        m_size = _SIZE_RE.search(b)
        m_bucket = _BUCKET_RE.search(b)
        m_form = _FORM_RE.search(b)
        m_target = _TARGET_RE.search(b)
        m_mem = _MEM_RE.search(b)
        members = [x.strip() for x in m_mem.group(1).split(",")] if m_mem else []
        groups.append({
            "gid": gid,
            "name": name,
            "bucket": m_bucket.group(1).strip() if m_bucket else "",
            "form": m_form.group(1).strip() if m_form else "",
            "targets": m_target.group(1).strip() if m_target else "",
            "n": int(m_size.group(1)) if m_size else 0,
            "members": members,
        })
    return groups


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只对账，不写 outputs/三仓归属矩阵.json")
    args = ap.parse_args()

    if not REPORT.exists():
        print(f"FAIL 报告不存在: {REPORT}", file=sys.stderr)
        return 1
    text = REPORT.read_text(encoding="utf-8")
    groups = parse_report_groups(text)
    patches = load_patches()

    # --- 对账 ---
    seen: dict[str, str] = {}
    dup: list[tuple[str, str]] = []
    for g in groups:
        for m in g["members"]:
            if m in seen:
                dup.append((m, f"{seen[m]} / {g['gid']}"))
            else:
                seen[m] = g["gid"]
    missing = sorted(set(patches) - set(seen))          # 有补丁没人认领
    unknown = sorted(set(seen) - set(patches))           # 报告里有、实际没有
    size_bad = [g["gid"] for g in groups if g["n"] != len(g["members"])]

    by_bucket: dict[str, dict] = {}
    for g in groups:
        b = by_bucket.setdefault(g["bucket"], {"groups": 0, "patches": 0})
        b["groups"] += 1
        b["patches"] += len(g["members"])

    print("=" * 64)
    print("三仓归属矩阵对账")
    print("=" * 64)
    print(f"active 补丁: {len(patches)} 条 / 报告组: {len(groups)} 组 / 认领: {len(seen)} 条")
    for name in sorted(by_bucket):
        print(f"  {name:<16} {by_bucket[name]['groups']:>3} 组  {by_bucket[name]['patches']:>4} 条")
    print(f"  {'合计':<16} {len(groups):>3} 组  {sum(b['patches'] for b in by_bucket.values()):>4} 条")
    print("-" * 64)
    ok = True
    if missing:
        ok = False
        print(f"FAIL 漏判 {len(missing)} 条（无人认领）: {missing[:20]}")
    if dup:
        ok = False
        print(f"FAIL 重复认领 {len(dup)} 条: {dup[:20]}")
    if unknown:
        ok = False
        print(f"FAIL 幻觉 ID {len(unknown)} 条（报告有、实际无）: {unknown[:20]}")
    if size_bad:
        ok = False
        print(f"FAIL 规模标注不符 {size_bad}")
    if ok:
        print("PASS 全部补丁恰好被认领一次，无漏判/重复/幻觉 ID")

    if ok and not args.check:
        out = {
            "generated_for": "T-20261119-06",
            "report": "outputs/三仓优化归属与回灌方案.md",
            "totals": {
                "groups": len(groups),
                "patches": len(patches),
                "by_bucket": by_bucket,
            },
            "groups": [
                {
                    "gid": g["gid"],
                    "name": g["name"],
                    "bucket": g["bucket"],
                    "form": g["form"],
                    "patch_count": len(g["members"]),
                    "members": g["members"],
                }
                for g in groups
            ],
        }
        MATRIX_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"WRITE {MATRIX_JSON.relative_to(ROOT)}")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
