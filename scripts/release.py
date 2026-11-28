"""One-click release for rsi-agent (run on the dev machine, needs cargo + gh).

    python scripts/release.py --version 0.1.27

Steps (each printed, fail-fast):
  1. git add + commit + tag v<version> (the bundle is built from `git ls-files`, so the
     sources must be committed first or they will not be in the zip)
  2. cargo build --release --manifest-path runtime/Cargo.toml -p react-agent-host
     (skipped when BOTH runtime/target/release/{react-agent-host,sandbox-run}.exe are newer
      than every tracked source file under runtime/; refuses to run while a host instance is
      alive, because its image file is locked and cargo would fail with os error 5)
  3. scripts/release-bundle.py -> outputs/rsi-agent-<version>-win.zip + .sha256
     (--with-env also cuts runtime-env.zip + runtime-env.json; --with-installer also builds
      rsi-agent-<version>-setup.exe via scripts/build-installer.py)
  4. git push (branch + tag) and gh release create with every built asset
Nothing is pushed unless the bundle built cleanly.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REL = REPO / "runtime/target/release"
EXE = REL / "react-agent-host.exe"
SANDBOX = REL / "sandbox-run.exe"
# a running host keeps its image file locked (os error 5), so releasing while the app is open
# builds into a sibling target dir instead of asking the user to close the window first
ALT_TARGET = REPO / "runtime/target/alt"
ALT_REL = ALT_TARGET / "release"
GIT = ["git", "-c", "core.quotepath=false"]
# run.cmd starts from the repo root, so cargo needs an explicit manifest
CARGO = ["cargo", "build", "--release", "--manifest-path", "runtime/Cargo.toml", "-p", "react-agent-host"]


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print(f"[release] {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.stdout.strip():
        print(r.stdout.rstrip()[-2000:])
    if r.returncode != 0:
        print(r.stderr.rstrip()[-3000:], file=sys.stderr)
        raise SystemExit(f"[release] FAILED ({r.returncode}): {' '.join(cmd)}")
    return r


def exe_stale() -> bool:
    # both binaries ship in the zip, so a stale sandbox-run.exe is just as fatal
    for exe in (EXE, SANDBOX):
        if not exe.is_file():
            return True
    t = min(EXE.stat().st_mtime, SANDBOX.stat().st_mtime)
    for sub in ("runtime/crates", "runtime/plugins", "runtime/kernel"):
        for p in (REPO / sub).rglob("*"):
            if p.is_file() and "target" not in p.parts and p.suffix in (".rs", ".py", ".toml", ".html", ".js", ".css", ".json", ".wasm"):
                if p.stat().st_mtime > t:
                    return True
    return False


def running_host_pids() -> list[int]:
    """PIDs of a live react-agent-host.exe. Its image file is locked, so cargo cannot
    relink it (os error 5) until it exits -- the user's own instance must be closed first."""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command",
                            "(Get-Process react-agent-host -ErrorAction SilentlyContinue).Id"],
                           capture_output=True, text=True, timeout=30)
    except Exception:
        return []
    return [int(x) for x in r.stdout.split() if x.strip().isdigit()]


def build_host() -> Path:
    """Build both binaries and return the release dir holding them.

    A live host locks its own image, so cargo cannot relink it (os error 5). In that case we
    build into runtime/target/alt and package from there -- the user should not have to close
    the app just to cut a release."""
    pids = running_host_pids()
    if not pids:
        run(CARGO)
        return REL
    print(f"[release] host running (PID {', '.join(map(str, pids))}) -> building into {ALT_TARGET}", flush=True)
    run([*CARGO, "--target-dir", str(ALT_TARGET)])
    return ALT_REL


def main() -> int:
    ap = argparse.ArgumentParser(description="one-click release: commit, tag, build, bundle, publish")
    ap.add_argument("--version", required=True, help="release version without v, e.g. 0.1.27")
    ap.add_argument("--message", default=None, help="commit + release title (default: auto)")
    ap.add_argument("--no-commit", action="store_true", help="sources already committed; only build/bundle/publish")
    ap.add_argument("--dry-run", action="store_true", help="do everything except push / gh release create")
    ap.add_argument("--with-env", action="store_true",
                    help="also upload runtime-env.zip + runtime-env.json (only needed when the "
                         "portable Python/Node payload changed; it is ~53 MB)")
    ap.add_argument("--with-installer", action="store_true",
                    help="also build + upload the one-click setup.exe (~42 MB, the end-user artifact)")
    ns = ap.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", ns.version):
        raise SystemExit(f"bad version: {ns.version}")
    tag = f"v{ns.version}"
    title = ns.message or f"rsi-agent {tag}"

    # 1. commit (explicit pathspec: never stage other sessions' stray files)
    if not ns.no_commit:
        paths = ["run.cmd", "release.cmd", "PLAN.md", "README.md", ".gitignore",
                 "scripts/sync_runtime.py", "scripts/release-bundle.py",
                 "scripts/release.py", "scripts/update_check.py", "scripts/patches",
                 "scripts/fetch-runtime.py", "scripts/build-installer.py",
                 "scripts/runtime-sitecustomize.py", "scripts/apply-env-update.ps1",
                 "runtime/crates/host/src", "runtime/crates/host/web-dist",
                 "config.example.json",
                "runtime/crates/agent-loop",
                 "runtime/plugins/llm_adapter", "runtime/Cargo.toml", "runtime/Cargo.lock",
                 # desktop shell sources (the built exe itself is never committed: 8.8 MB binary,
                 # and scripts/build-installer.py reads it straight from the working tree)
                 "desktop/src", "desktop/Cargo.toml", "desktop/Cargo.lock",
                 "desktop/tauri.conf.json", "desktop/build.rs"]
        run([*GIT, "add", "--", *paths])
        staged = run([*GIT, "diff", "--cached", "--name-only"]).stdout.split()
        if staged:
            run([*GIT, "commit", "-m", ns.message or f"feat(release): {tag} - zip 分发 + 更新自动提醒 + 一键更新"])
        run([*GIT, "tag", "-f", tag])

    # 2. build the host (the shipped exe must contain the self-update patches)
    bin_dir = build_host() if exe_stale() else REL
    for name in ("react-agent-host.exe", "sandbox-run.exe"):
        if not (bin_dir / name).is_file():
            raise SystemExit(f"binary missing after build: {bin_dir / name}")

    # 3. bundle. The app zip is the updater payload and is built every time; the 53 MB runtime
    #    zip is only cut when the portable Python/Node payload actually changed (--with-env),
    #    because uploading it on every patch release would make each update 6x bigger.
    out = REPO / "outputs"
    what = "all" if ns.with_env else "app"
    run([sys.executable, "scripts/release-bundle.py", "--out", str(out),
         "--version", ns.version, "--bin-dir", str(bin_dir), "--what", what])
    assets = [out / f"rsi-agent-{ns.version}-win.zip",
              out / f"rsi-agent-{ns.version}-win.zip.sha256"]
    if ns.with_env:
        assets += [out / "runtime-env.zip", out / "runtime-env.zip.sha256",
                   out / "runtime-env.json"]
    if ns.with_installer:
        run([sys.executable, "scripts/build-installer.py", "--out", str(out),
             "--version", ns.version, "--bin-dir", str(bin_dir)])
        assets += [out / f"rsi-agent-{ns.version}-setup.exe",
                   out / f"rsi-agent-{ns.version}-setup.exe.sha256"]
    for p in assets:
        if not p.is_file():
            raise SystemExit(f"bundle output missing: {p}")

    # 4. publish
    if ns.dry_run:
        print(f"[release] DRY-RUN: would push HEAD + {tag} and create the GitHub release")
        print(f"[release] DRY-RUN assets: {', '.join(p.name for p in assets)}")
        print(f"[release] OK  {tag}  {assets[0]}")
        return 0
    run([*GIT, "push", "origin", "HEAD"])
    run([*GIT, "push", "origin", tag])
    notes = ("Windows 一键安装包：下载 rsi-agent-<ver>-setup.exe 双击安装（无需 Python/Node/Rust）。"
             if ns.with_installer else
             "Windows zip 包：解压后双击 run.cmd 即可运行（无需 Rust 工具链）。")
    run(["gh", "release", "create", tag, *[str(p) for p in assets], "--title", title,
         "--notes", notes + " sha256 见同名 .sha256 文件。"])
    print(f"[release] OK  {tag}  {assets[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
