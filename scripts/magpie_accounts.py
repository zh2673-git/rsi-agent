"""Magpie 账号登记：从网关读取当前登录的供应商账号，去重后记入本地台账。

用途：多账号智能路由的前提是每个账号都已在某个 Agent 里登录过。本脚本周期探测
网关 /v1/magpie/quotas（账号台账，含别名/用户/计划），发现新账号才写入台账文件，
已登记的不动，本轮消失的只标 missing、不删记录（登录态由 Magpie 管理，这里只记账）。

台账文件（含邮箱等 PII，已 .gitignore，不入库）：
  config/magpie-accounts.json（可用 RSI_MAGPIE_ACCOUNTS 覆盖）

用法：
  python scripts/magpie_accounts.py scan                  # 探测一次，登记新账号
  python scripts/magpie_accounts.py watch --interval 15   # 边登录边检测（Ctrl+C 结束）
  python scripts/magpie_accounts.py list                  # 只看台账
  python scripts/magpie_accounts.py remove --provider workbuddy --user zh2673
                                                          # 手动移除一条记录（台账而已，不影响 Magpie 登录态）
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rsi_common import dumps, emit, read_json  # noqa: E402

GATEWAY = "http://127.0.0.1:3425"
QUOTAS_PATH = "/v1/magpie/quotas"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def ledger_path() -> Path:
    env = __import__("os").environ.get("RSI_MAGPIE_ACCOUNTS")
    if env:
        return Path(env)
    root = Path(__file__).resolve().parents[1]
    return root / "config" / "magpie-accounts.json"


def fetch_accounts(gateway: str) -> list[dict]:
    url = gateway.rstrip("/") + QUOTAS_PATH
    with urllib.request.urlopen(url, timeout=5) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload.get("data") or []


def identity_of(entry: dict) -> str:
    """账号身份键：别名 > 用户名 > 计划名（Magpie 面板同序）。"""
    for key in ("alias", "user", "plan"):
        value = entry.get(key)
        if value:
            return str(value)
    return "(unknown)"


def compact(entry: dict) -> dict:
    """只留登记需要的字段，密钥类信息网关本就不在 quotas 里暴露。"""
    return {
        "provider": entry.get("provider"),
        "provider_name": entry.get("name"),
        "identity": identity_of(entry),
        "alias": entry.get("alias"),
        "user": entry.get("user"),
        "plan": entry.get("plan"),
        "kind": entry.get("kind"),
        "windows": entry.get("windows") or [],
        "quota_read_at": entry.get("readAt"),
    }


def scan(gateway: str, ledger: Path) -> dict:
    data = read_json(ledger)
    accounts: dict[tuple, dict] = {}
    for rec in data.get("accounts", []):
        accounts[(rec.get("provider"), rec.get("identity"))] = rec

    live = fetch_accounts(gateway)
    added, known, missing_keys = [], [], set(accounts)

    for entry in live:
        rec = compact(entry)
        key = (rec["provider"], rec["identity"])
        missing_keys.discard(key)
        if key not in accounts:
            rec["first_seen"] = now_iso()
            rec["last_seen"] = rec["first_seen"]
            rec["state"] = "active"
            accounts[key] = rec
            added.append(rec)
        else:
            old = accounts[key]
            old.update({k: v for k, v in rec.items() if v is not None})
            old["last_seen"] = now_iso()
            old["state"] = "active"
            known.append(old)

    for key in missing_keys:  # 本轮没出现：标 missing，不删（重新登录即恢复）
        accounts[key]["state"] = "missing"

    payload = {
        "version": 1,
        "gateway": gateway,
        "updated_at": now_iso(),
        "accounts": [accounts[k] for k in sorted(accounts)],
    }
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(dumps(payload) + "\n", encoding="utf-8")
    return {
        "added": [r["provider"] + ":" + r["identity"] for r in added],
        "known": [r["provider"] + ":" + r["identity"] for r in known],
        "missing": [k[0] + ":" + k[1] for k in sorted(missing_keys)],
        "total": len(payload["accounts"]),
        "ledger": str(ledger),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Magpie 账号登记台账")
    ap.add_argument("command", choices=["scan", "watch", "list", "remove"])
    ap.add_argument("--interval", type=int, default=15, help="watch 轮询秒数（默认 15）")
    ap.add_argument("--gateway", default=GATEWAY)
    ap.add_argument("--provider", help="remove：厂商 id（如 workbuddy）")
    ap.add_argument("--user", help="remove：账号 identity")
    args = ap.parse_args()

    ledger = ledger_path()

    if args.command == "list":
        emit(read_json(ledger) or {"accounts": [], "note": "台账为空，先 scan"})
        return 0

    if args.command == "remove":
        if not (args.provider and args.user):
            print("remove 需要 --provider 与 --user", file=sys.stderr)
            return 2
        data = read_json(ledger)
        before = data.get("accounts", [])
        after = [a for a in before if not (a.get("provider") == args.provider and a.get("identity") == args.user)]
        if len(after) == len(before):
            print(f"未找到 {args.provider}:{args.user}", file=sys.stderr)
            return 1
        data["accounts"] = after
        data["updated_at"] = now_iso()
        ledger.write_text(dumps(data) + "\n", encoding="utf-8")
        emit({"removed": f"{args.provider}:{args.user}", "total": len(after)})
        return 0

    if args.command == "scan":
        try:
            emit(scan(args.gateway, ledger))
        except (OSError, ValueError) as exc:
            emit({"error": f"网关不可达或响应异常: {exc}", "gateway": args.gateway})
            return 2
        return 0

    # watch：边登录边检测，新账号立即报
    print(f"[watch] {args.gateway}{QUOTAS_PATH} → {ledger.name}，每 {args.interval}s（Ctrl+C 结束）", file=sys.stderr)
    try:
        while True:
            try:
                result = scan(args.gateway, ledger)
                mark = " ++新账号 " + ",".join(result["added"]) if result["added"] else "ok"
                print(f"[{now_iso()}] total={result['total']}{mark}", file=sys.stderr)
            except (OSError, ValueError) as exc:
                print(f"[{now_iso()}] 网关不可达: {exc}", file=sys.stderr)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        emit({"watch": "stopped", "ledger": str(ledger)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
