#!/usr/bin/env python3
"""pc-perf-doctor 采集脚本（Windows，只读，不改系统、不杀进程）。

用法：
  python collect.py                 # 全量快照：内存/CPU/进程数/Top10
  python collect.py --top 20         # 指定 Top N
  python collect.py --delta PID 3    # 测某进程 3 秒 CPU 增量（判风扇元凶）

实现：调用 PowerShell 的 CIM/Perf 计数器，全部只读。
输出为纯文本，便于直接贴进诊断报告作为 E1 证据。
"""
from __future__ import annotations

import argparse
import subprocess
import sys


def ps(script: str, timeout: int = 30) -> str:
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=timeout,
    )
    if r.returncode != 0:
        return f"[ps error rc={r.returncode}] {r.stderr.strip()}"
    return r.stdout.strip()


def snapshot(top: int) -> None:
    print("=== 内存 / CPU / 进程数 ===")
    print(ps(
        "$o=Get-CimInstance Win32_OperatingSystem; "
        "$c=Get-CimInstance Win32_Processor; "
        "'cpu_load_pct=' + $c.LoadPercentage; "
        "'mem_total_GB=' + [math]::Round($o.TotalVisibleMemorySize/1MB,1); "
        "'mem_free_GB=' + [math]::Round($o.FreePhysicalMemory/1MB,1); "
        "'commit_used_GB=' + [math]::Round(($o.TotalVirtualMemorySize-$o.FreeVirtualMemory)/1MB,1); "
        "'procs=' + $o.NumberOfProcesses"
    ))
    print()
    print(f"=== Top {top} 进程（按工作集 WS 排序）===")
    print(ps(
        f"Get-Process | Sort-Object WS -Descending | Select-Object -First {top} "
        "Name,Id,@{n='WS_GB';e={[math]::Round($_.WS/1GB,2)}},"
        "@{n='PM_GB';e={[math]::Round($_.PM/1GB,2)}},CPU | Format-Table -AutoSize"
    ))


def delta(pid: int, seconds: int) -> None:
    script = (
        f"$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; "
        "if(-not $p){'PROCESS_NOT_FOUND'; exit}; "
        "$c1=$p.CPU; "
        f"Start-Sleep -Seconds {seconds}; "
        f"$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; "
        "if(-not $p){'PROCESS_EXITED'; exit}; "
        "$c2=$p.CPU; "
        f"'{pid} cpu_delta_{seconds}s=' + [math]::Round(($c2-$c1),3); "
        f"'{pid} cores_used=' + [math]::Round(($c2-$c1)/{seconds},2); "
        "'name=' + $p.ProcessName"
    )
    print(ps(script, timeout=seconds + 20))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--delta", nargs=2, metavar=("PID", "SEC"), type=int)
    a = ap.parse_args()
    if a.delta:
        delta(a.delta[0], a.delta[1])
    else:
        snapshot(a.top)
    return 0


if __name__ == "__main__":
    sys.exit(main())
