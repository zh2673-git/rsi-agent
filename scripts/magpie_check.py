"""magpie 网关接入检查：Phase 0 硬门 + R3/R4/R5 冒烟（不启动 host，不跑 agent）。

Phase 0 门（决定能不能接入）：
  endpoint   GET /v1/models 可达
  loopback   只监听 127.0.0.1（不允许 0.0.0.0）
  admin_face 管理面 /api/providers 不可达（必须用 `magpie serve`，不能用 `magpie web`）
  isolation  当前账户读不到 magpie 的 providers.json（R6：密钥隔离）

冒烟（决定兼容性）：
  chat / stream / tools / usage / abort

用法：
    python scripts/magpie_check.py                 # 全部检查
    python scripts/magpie_check.py --skip-smoke    # 只做 Phase 0 门
    python scripts/magpie_check.py --quiet         # 只输出一行（run.cmd 探测用）
    python scripts/magpie_check.py --json
    python scripts/magpie_check.py --magpie-user magpie-run

环境：MAGPIE_BASE_URL（默认 http://127.0.0.1:3425/v1）、MAGPIE_WEB_KEY（默认 magpie）

退出码：0 全过；1 有失败；2 网关不可达（blocked，不计为失败）
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

SKIP_SMOKE = False
BASE = ""
ROOT = ""
AUTH = ""


def _http(method: str, url: str, body: dict | None = None, stream: bool = False,
          timeout: float = 20.0):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {AUTH}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if stream:
        req.add_header("Accept", "text/event-stream")
    return urllib.request.urlopen(req, timeout=timeout)


def _json(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    with _http(method, BASE + path, body) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        try:
            return resp.status, json.loads(raw)
        except ValueError:
            return resp.status, {"_raw": raw[:200]}


def _models() -> tuple[list[str], str]:
    _, data = _json("GET", "/models")
    ids = [str(m.get("id")) for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")]
    return ids, ""


def _check_endpoint(state: dict) -> dict:
    try:
        status, data = _json("GET", "/models")
    except urllib.error.URLError as exc:
        return {"status": "blocked", "detail": f"网关不可达 {BASE}: {exc.reason}"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "blocked", "detail": f"网关不可达 {BASE}: {exc}"}
    ids = [str(m.get("id")) for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")]
    state["models"] = ids
    if status != 200:
        return {"status": "fail", "detail": f"GET /v1/models 返回 {status}"}
    if not ids:
        return {"status": "fail", "detail": "模型列表为空：magpie 里还没配 provider"}
    return {"status": "ok", "detail": f"{len(ids)} 个模型，首个: {ids[0]}"}


def _check_loopback(state: dict) -> dict:
    port = urlsplit(BASE).port or 3425
    try:
        if platform.system() == "Windows":
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15).stdout
            rows = [ln.split()[1] for ln in out.splitlines() if "LISTENING" in ln and f":{port}" in ln]
        else:
            out = subprocess.run(["ss", "-lnt"], capture_output=True, text=True, timeout=15).stdout
            rows = [ln.split()[3] for ln in out.splitlines() if f":{port}" in ln]
    except Exception as exc:  # noqa: BLE001
        return {"status": "skip", "detail": f"无法读取监听表: {exc}"}
    if not rows:
        return {"status": "skip", "detail": f"未找到端口 {port} 的监听行"}
    local = {r.split(":")[0] for r in rows}
    bad = sorted(a for a in local if a not in ("127.0.0.1", "::1", "[::1]"))
    state["port"] = port
    if bad:
        return {"status": "fail", "detail": f"监听地址不止回环: {bad}（关闭 LAN / 禁用 0.0.0.0）"}
    return {"status": "ok", "detail": f"端口 {port} 仅回环: {sorted(local)}"}


def _check_admin_face(state: dict) -> dict:
    url = f"{ROOT}/api/providers"
    try:
        with _http("GET", url, timeout=5) as resp:
            body = resp.read(64).decode("utf-8", errors="replace")
            return {"status": "fail",
                    "detail": f"管理面可达（{resp.status}）：说明跑的是 magpie web，"
                              f"agent 可改写 provider；请改用 magpie serve。{body[:40]}"}
    except urllib.error.HTTPError as exc:
        return {"status": "ok", "detail": f"管理面不可用（{exc.code}）"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "ok", "detail": f"管理面不可用（{type(exc).__name__}）"}


def _probe_secret(path: Path) -> str:
    """'readable' / 'denied' / 'missing'"""
    if not path.exists():
        return "missing"
    try:
        with path.open("rb") as fh:
            fh.read(16)
        return "readable"
    except PermissionError:
        return "denied"
    except OSError:
        return "denied"


def _check_isolation(state: dict, magpie_user: str) -> dict:
    home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
    own = _probe_secret(home / ".config" / "magpie" / "providers.json")
    if own == "readable":
        return {"status": "fail",
                "detail": "当前账户能读 .config/magpie/providers.json：magpie 与 agent 同一账户，"
                          "密钥隔离不成立（改用独立账户运行 magpie）"}
    if magpie_user:
        target = Path("C:/Users") / magpie_user
        if not target.exists():
            return {"status": "skip", "detail": f"账户 {magpie_user} 的 profile 不存在（尚未创建/首次登录）"}
        secret = _probe_secret(target / ".config" / "magpie" / "providers.json")
        if secret == "readable":
            return {"status": "fail", "detail": f"当前账户能读 {target} 下 magpie 密钥：隔离不成立"}
        if secret == "denied":
            return {"status": "ok", "detail": f"读 {target} 下 magpie 密钥被拒绝"}
        return {"status": "skip", "detail": f"{target} 下没有 providers.json（magpie 尚未在该账户配置）"}
    return {"status": "ok", "detail": f"当前账户自身无 magpie 配置（{own}）；建议加 --magpie-user 复核边界"}


def _pick_model(state: dict) -> str:
    if os.environ.get("MAGPIE_MODEL"):
        return os.environ["MAGPIE_MODEL"]
    return state.get("models", [""])[0] if state.get("models") else ""


def _check_chat(state: dict) -> dict:
    model = _pick_model(state)
    if not model:
        return {"status": "skip", "detail": "没有可用模型 id"}
    status, data = _json("POST", "/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "只回复两个字符：ok"}],
        "max_tokens": 128,
    })
    if status != 200:
        return {"status": "fail", "detail": f"POST /v1/chat/completions 返回 {status}"}
    msg = ((data.get("choices") or [{}])[0].get("message") or {})
    got = (msg.get("content") or "").strip()
    actual = data.get("model") or "?"
    state["actual_model"] = actual
    if not got:
        return {"status": "fail", "detail": "返回内容为空"}
    return {"status": "ok", "detail": f"content={got[:20]!r}；实际模型={actual}"}


def _check_stream(state: dict) -> dict:
    model = _pick_model(state)
    if not model:
        return {"status": "skip", "detail": "没有可用模型 id"}
    try:
        resp = _http("POST", BASE + "/chat/completions", {
            "model": model, "stream": True,
            "messages": [{"role": "user", "content": "数到三"}],
            "max_tokens": 256,
        }, stream=True)
    except Exception as exc:  # noqa: BLE001
        return {"status": "fail", "detail": f"流式请求失败: {exc}"}
    deltas, done = 0, False
    try:
        for _ in range(400):
            line = resp.readline().decode("utf-8", errors="replace").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                done = True
                break
            try:
                chunk = json.loads(payload)
            except ValueError:
                continue
            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("content") or delta.get("reasoning") or delta.get("tool_calls"):
                deltas += 1
    finally:
        resp.close()
    if deltas == 0:
        return {"status": "fail", "detail": f"没有收到 delta（done={done}）"}
    return {"status": "ok", "detail": f"{deltas} 个 delta，[DONE]={done}"}


def _check_tools(state: dict) -> dict:
    model = _pick_model(state)
    if not model:
        return {"status": "skip", "detail": "没有可用模型 id"}
    status, data = _json("POST", "/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "调用 probe_echo 工具，text 填 hi"}],
        "tools": [{"type": "function", "function": {
            "name": "probe_echo", "description": "回显文本（不产生副作用）",
            "parameters": {"type": "object", "properties": {"text": {"type": "string"}},
                           "required": ["text"]}}}],
        "tool_choice": "auto", "max_tokens": 64,
    })
    if status != 200:
        return {"status": "fail", "detail": f"工具调用请求返回 {status}"}
    calls = (data.get("choices") or [{}])[0].get("message", {}).get("tool_calls") or []
    if not calls:
        return {"status": "fail", "detail": "未返回 tool_calls：该上游不支持工具调用，RSI 循环不可用"}
    name = (calls[0].get("function") or {}).get("name")
    args = (calls[0].get("function") or {}).get("arguments")
    if not name or not args:
        return {"status": "fail", "detail": f"tool_calls 不完整: {calls[0]}"}
    return {"status": "ok", "detail": f"{len(calls)} 个调用，name={name}"}


def _check_usage(state: dict) -> dict:
    try:
        status, data = _json("GET", "/magpie/usage")
    except urllib.error.HTTPError as exc:
        return {"status": "skip", "detail": f"/v1/magpie/usage 返回 {exc.code}"}
    if status != 200:
        return {"status": "skip", "detail": f"/v1/magpie/usage 返回 {status}"}
    keys = sorted(data.keys())[:8] if isinstance(data, dict) else []
    return {"status": "ok", "detail": f"对账端点可用；字段: {keys}"}


def _check_abort(state: dict) -> dict:
    model = _pick_model(state)
    if not model:
        return {"status": "skip", "detail": "没有可用模型 id"}
    try:
        resp = _http("POST", BASE + "/chat/completions", {
            "model": model, "stream": True,
            "messages": [{"role": "user", "content": "输出 200 行数字"}], "max_tokens": 256,
        }, stream=True, timeout=15)
    except Exception as exc:  # noqa: BLE001
        return {"status": "fail", "detail": f"流式建立失败: {exc}"}
    try:
        for _ in range(2):
            resp.readline()
    finally:
        resp.close()
    return {"status": "ok", "detail": "中途关流未触发网关错误"}


def main() -> int:
    global BASE, ROOT, AUTH, SKIP_SMOKE
    ap = argparse.ArgumentParser(description="magpie 网关接入检查")
    ap.add_argument("--skip-smoke", action="store_true", help="只做 Phase 0 门")
    ap.add_argument("--gateway-only", action="store_true", help="只探网关是否可达（run.cmd 预检用）")
    ap.add_argument("--quiet", action="store_true", help="只输出一行")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--magpie-user", default=os.environ.get("MAGPIE_USER", ""),
                    help="运行 magpie 的独立 Windows 账户名（用于隔离复核）")
    args = ap.parse_args()
    SKIP_SMOKE = args.skip_smoke
    BASE = os.environ.get("MAGPIE_BASE_URL", "http://127.0.0.1:3425/v1").rstrip("/")
    ROOT = BASE[:-3] if BASE.endswith("/v1") else BASE
    AUTH = os.environ.get("MAGPIE_WEB_KEY") or "magpie"

    state: dict = {}
    results: list[dict] = []

    def run(name, fn, *a):
        try:
            r = fn(*a)
        except Exception as exc:  # noqa: BLE001
            r = {"status": "fail", "detail": f"检查异常: {type(exc).__name__}: {exc}"}
        results.append({"name": name, **r})
        return r

    run("endpoint", _check_endpoint, state)
    if not args.gateway_only:
        run("isolation", _check_isolation, state, args.magpie_user)  # 不依赖网关，始终检查
    if results[0]["status"] == "blocked" or args.gateway_only:
        for name in ("loopback", "admin_face"):
            results.append({"name": name, "status": "skip", "detail": "仅探网关，跳过" if args.gateway_only else "网关不可达，跳过"})
    else:
        run("loopback", _check_loopback, state)
        run("admin_face", _check_admin_face, state)
        if not SKIP_SMOKE:
            run("chat", _check_chat, state)
            run("stream", _check_stream, state)
            run("tools", _check_tools, state)
            run("usage", _check_usage, state)
            run("abort", _check_abort, state)

    blocked = any(r["status"] == "blocked" for r in results)
    failed = [r for r in results if r["status"] == "fail"]

    if args.json:
        print(json.dumps({"base": BASE, "ok": not blocked and not failed,
                          "blocked": blocked, "checks": results,
                          "actual_model": state.get("actual_model"),
                          "models": state.get("models", [])}, ensure_ascii=False, indent=2))
    elif args.quiet:
        verdict = "blocked" if blocked else ("fail" if failed else "ok")
        print(f"[magpie] {verdict}")
    else:
        print(f"magpie 网关检查: {BASE}")
        for r in results:
            mark = {"ok": "[ok]", "fail": "[FAIL]", "skip": "[skip]", "blocked": "[blocked]"}[r["status"]]
            print(f"  {mark:11s} {r['name']:10s} {r['detail']}")
        verdict = "blocked（网关未启动）" if blocked else (
            f"fail（{len(failed)} 项）" if failed else "ok")
        print(f"结论: {verdict}")

    if blocked and not failed:
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
