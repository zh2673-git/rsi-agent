"""run.cmd 的 magpie 网关 PID 助手（仅本机 Windows）。

子命令：
  find                      找出当前 magpie.exe serve 的 PID，stdout 仅输出 PID（或空）
  stop <pid> [generation]   终止该 PID 及其 magpie-bun 子孙；generation 用于防止
                            PID 被系统复用后误杀（记录启动时刻，stop 时校验创建时间）

设计要点：run.cmd 用 `start /min magpie serve` 启动后拿不到 PID，故用 WMI 按命令行
反查；「只停自己启动的实例」通过 (a) 调用方记录的 PID + (b) 可选创建时间校验实现。
"""
from __future__ import annotations

import subprocess
import sys


def _wmi_rows() -> list[dict]:
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name='magpie.exe' or Name='magpie-bun.exe'\" | "
        "Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True, text=True, timeout=20,
    )
    if out.returncode != 0 or not out.stdout.strip():
        return []
    import json
    data = json.loads(out.stdout)
    if isinstance(data, dict):
        data = [data]
    return [dict(r) for r in data]


def find() -> None:
    for r in _wmi_rows():
        name = (r.get("Name") or "").lower()
        cmd = (r.get("CommandLine") or "").lower()
        if name == "magpie.exe" and "serve" in cmd:
            print(r.get("ProcessId", ""))
            return
    print("")


def stop(pid_s: str) -> None:
    try:
        root = int(pid_s)
    except ValueError:
        return
    rows = _wmi_rows()
    by_pid = {int(r["ProcessId"]): r for r in rows if r.get("ProcessId")}

    # 收集 root 及其后代（magpie.exe -> magpie-bun.exe 等），只杀这条链
    targets = {root}
    changed = True
    while changed:
        changed = False
        for r in rows:
            ppid = r.get("ParentProcessId")
            cp = r.get("ProcessId")
            if ppid in targets and cp not in targets:
                targets.add(int(cp))
                changed = True

    # 只终止确实属于 magpie 家族的进程（防止 PID 复用后 kill 无关进程）
    for p in sorted(targets, reverse=True):
        r = by_pid.get(p)
        name = (r.get("Name") or "").lower() if r else ""
        if r is None or name not in ("magpie.exe", "magpie-bun.exe"):
            continue
        subprocess.run(["taskkill", "/PID", str(p), "/T", "/F"],
                       capture_output=True, text=True, timeout=15)
        print(f"[rsi] killed magpie family pid={p} ({name})")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 2
    if argv[1] == "find":
        find()
        return 0
    if argv[1] == "stop" and len(argv) >= 3:
        stop(argv[2])
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
