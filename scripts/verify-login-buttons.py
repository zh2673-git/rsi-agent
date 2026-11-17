#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""登录渠道 UI ↔ API 一致性校验（看板 T-20261116-15 / c4 判据）。

判据：设置页「账号签到」区里 `#upstream-login-btns` 渲染出的按钮，其**数量、顺序、
文案、`disabled` 状态**必须与 `GET /api/upstream/providers` 返回的渠道清单**逐一相同**。

为什么要有这条判据：P3 的目标是「装了什么插件就有什么按钮」。只测 API 只能证明后端
读到了插件清单，证明不了前端真的按它渲染——前端完全可能还在用写死的渠道表，
或者把 `usable=false` 的渠道渲染成可点按钮（点了必然报错，比没有按钮更糟）。

用法::

    # 1) 对着已经在跑的 Host 校验
    python scripts/verify-login-buttons.py --rsi 8710

    # 2) 自己拉起一个刚构建的 exe（不碰用户正在用的实例）
    python scripts/verify-login-buttons.py --exe .scratch/target/debug/react-agent-host.exe

    # 2b) 先 cargo build 再拉起来（看板 c4 用这条：旧二进制会 404，不能当判据）
    python scripts/verify-login-buttons.py --build

    # 3) 只打 API 清单，不开浏览器（排障用）
    python scripts/verify-login-buttons.py --rsi 8710 --api-only

退出码：0 = 一致；1 = 不一致；2 = 环境不可用（连不上 / 没装 playwright / exe 起不来）。
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

TIMEOUT = 30


def _get(url: str):
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:  # noqa: S310 (本机回环)
        return json.loads(r.read().decode("utf-8", "replace"))


def expected_buttons(providers: list[dict]) -> list[tuple[str, str, bool]]:
    """由 API 清单推出 UI 应有的按钮：(provider_id, 文案, 是否禁用)。

    与 `web-dist/vendor/app-settings.js` 的 `refreshCheckinProviders()` 同口径：
    usable → `登录 <name> 账号`；不可用 → `登录 <name> 账号（需终端）` 且禁用。
    """
    out = []
    for p in providers:
        label = p.get("name") or p.get("id") or ""
        if p.get("usable"):
            out.append((p["id"], f"登录 {label} 账号", False))
        else:
            out.append((p["id"], f"登录 {label} 账号（需终端）", True))
    return out


def read_ui_buttons(page, port: int, gw_port: int) -> dict:
    """打开设置抽屉 → 把 base 指向本机回环网关（面板仅在回环 base 下显示）→ 读按钮。"""
    page.goto(f"http://127.0.0.1:{port}/", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.evaluate("() => document.querySelector('#gear').click()")
    page.wait_for_timeout(800)
    page.evaluate(
        "(base) => { document.querySelector('#llm-base').value = base; }",
        f"http://127.0.0.1:{gw_port}/v1",
    )
    page.evaluate("() => refreshUpstream()")
    page.wait_for_timeout(6000)
    return page.evaluate(
        """() => ({
            fieldHidden: document.querySelector('#upstream-checkin-field').hidden,
            buttons: Array.from(document.querySelectorAll('#upstream-login-btns button')).map(b => ({
                text: (b.textContent || '').trim(),
                disabled: !!b.disabled,
                title: (b.getAttribute('title') || '')
            }))
        })"""
    )


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_ready(port: int, secs: float = 90.0) -> bool:
    deadline = time.time() + secs
    while time.time() < deadline:
        try:
            _get(f"http://127.0.0.1:{port}/api/models")
            return True
        except Exception:  # noqa: BLE001
            time.sleep(1.0)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="登录渠道 UI ↔ /api/upstream/providers 一致性校验")
    ap.add_argument("--rsi", type=int, default=8710, help="已在运行的 RSI Host 端口（默认 8710）")
    ap.add_argument("--exe", default="", help="自己拉起这个 react-agent-host.exe（用空闲端口，不占 --rsi）")
    ap.add_argument("--build", action="store_true",
                    help="先 cargo build 到 .scratch/target，再用那个新 exe（看板 c4 用这条，"
                         "避免拿旧二进制验新路由）")
    ap.add_argument("--gw", type=int, default=3425, help="Magpie 网关端口，仅用于让前端识别「本机回环」（默认 3425）")
    ap.add_argument("--api-only", action="store_true", help="只打 API 清单，不开浏览器")
    a = ap.parse_args()

    proc = None
    port = a.rsi
    exe = a.exe
    if a.build:
        root = Path(__file__).resolve().parents[1]
        target = root / ".scratch" / "target"
        env = dict(os.environ)
        env["CARGO_TARGET_DIR"] = str(target)
        print(f"cargo build → {target}（manifest runtime/Cargo.toml）")
        r = subprocess.run(  # noqa: S603
            ["cargo", "build", "--manifest-path", str(root / "runtime" / "Cargo.toml"),
             "-p", "react-agent-host"],
            cwd=str(root), env=env,
        )
        if r.returncode != 0:
            print("FAIL cargo build 失败：不拿旧二进制冒充新路由")
            return 2
        exe = str(target / "debug" / ("react-agent-host.exe" if os.name == "nt" else "react-agent-host"))
    if exe:
        a.exe = exe
        if not os.path.exists(exe):
            print(f"FAIL exe 不存在: {exe}")
            return 2
        port = _free_port()
        env = dict(os.environ)
        env["WEB_ADDR"] = f"127.0.0.1:{port}"
        env["REACT_FRONTEND"] = "web"
        log_path = os.path.join(os.path.dirname(exe) or ".", "verify-login-buttons.log")
        log = open(log_path, "wb")
        proc = subprocess.Popen([exe], stdout=log, stderr=subprocess.STDOUT, env=env)  # noqa: S603
        print(f"已拉起 {exe} → 127.0.0.1:{port}（pid {proc.pid}）")
        if not _wait_ready(port):
            print("FAIL 新实例 90s 内未就绪")
            proc.kill()
            return 2

    try:
        try:
            data = _get(f"http://127.0.0.1:{port}/api/upstream/providers")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL GET /api/upstream/providers 不可达（{port}）：{e}")
            print("     若这是旧二进制，该路由根本不存在 → 会返回 404。重启 Host 或改用 --exe。")
            return 2
        providers = data.get("providers") or []
        expect = expected_buttons(providers)
        print(f"API 渠道: {len(expect)}")
        for pid, text, dis in expect:
            print(f"   {pid:24s} {'灰显' if dis else '可点'}  {text}")
        if a.api_only:
            return 0

        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:  # noqa: BLE001
            print(f"SKIP 未安装 playwright（{e}）：pip install playwright && playwright install chromium")
            return 2

        with sync_playwright() as pw:
            b = pw.chromium.launch()
            page = b.new_page()
            errs: list[str] = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            try:
                ui = read_ui_buttons(page, port, a.gw)
            finally:
                b.close()

        if ui["fieldHidden"]:
            print("FAIL 账号签到区仍隐藏：base 指向本机回环时应显示")
            return 1
        got = ui["buttons"]
        print(f"UI 按钮: {len(got)}")
        for g in got:
            print(f"   {'灰显' if g['disabled'] else '可点'}  {g['text']}")

        ok = True
        if len(got) != len(expect):
            ok = False
            print(f"MISMATCH 数量 {len(got)} != {len(expect)}")
        else:
            for i, (g, (pid, text, dis)) in enumerate(zip(got, expect)):
                if g["text"] != text or g["disabled"] != dis:
                    ok = False
                    print(f"MISMATCH[{i}] {pid}: UI={g['text']!r}/disabled={g['disabled']} "
                          f"期望={text!r}/disabled={dis}")
        for pid, text, dis in expect:
            if dis and not any(g["text"] == text and g["title"] for g in got):
                ok = False
                print(f"MISMATCH {pid}: 灰显按钮缺 title（应给出终端命令）")
        if errs:
            ok = False
            print("页面 JS 错误:", errs)
        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        if proc is not None:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
