#!/usr/bin/env python
"""repo_query 工具执行器：stdin 读 {"args":{"query":"..."}}，stdout 回 {"ok":true,...}。"""

from __future__ import annotations

import json
import sys

import repo_query


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        q = str((payload.get("args") or {}).get("query") or "status").strip()
        sub = q.split()[0] if q else "status"
        print(json.dumps({"ok": True, **repo_query.query(sub)}, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": {"code": "REPO_QUERY_FAILED", "message": str(e)}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
