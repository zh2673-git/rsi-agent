"""Build the distributable artifacts of rsi-agent.

    python scripts/release-bundle.py [--out outputs] [--version X.Y.Z] [--what app|env|all]

Three artifacts, all from one entry list so they can never disagree:

  rsi-agent-<ver>-win.zip   the application only (~8 MB) -- this is what the in-app updater
                            downloads; it must NOT carry the runtime, otherwise every update
                            re-downloads 52 MB of Python/Node for nothing.
  runtime-env.zip           the portable runtime (~52 MB): CPython + grpc/httpx + node.exe +
                            the kernel TS SDK's node_modules. Only shipped again when the
                            runtime itself changes; runtime-env.json is the cheap fingerprint
                            the updater compares before pulling the big file.
  rsi-agent-<ver>-setup.exe one-click installer (built by scripts/build-installer.py):
                            app + runtime in a single per-user NSIS setup.

What goes into the app zip (tracked files only, read via `git ls-files` so nothing private
or machine-local slips in):
  run.cmd, release.cmd, config.example.json, README.md, scripts/   -- launcher + tooling
  runtime/plugins (code only), runtime/kernel, skills/ (code only),
  desktop/start-desktop.ps1 + .pyw                                -- optional shell entry
  runtime/target/release/react-agent-host.exe                     -- the host binary
  runtime/target/release/sandbox-run.exe                          -- bash sandbox (fail-closed)
  runtime/target/release/web-dist/                                -- frontend, re-rooted here

The frontend is NOT shipped at its source path `runtime/crates/host/web-dist/`:
web/mod.rs resolves `web-dist/` beside `current_exe()` (its other candidate is
the compile-time CARGO_MANIFEST_DIR, a build-machine absolute path), so a zip
that kept the source layout would 500 on every page for real users.

The runtime comes from `scripts/fetch-runtime.py` (runtime-env/, gitignored). It is laid out
so that a single unzip over the install dir yields a runnable tree:
  runtime-env/python/                                     portable CPython + site-packages
  runtime-env/node/node.exe                               portable Node
  runtime/kernel/bindings/typescript/node_modules/        @grpc/*, moved OUT of kernel-node/
That last move is not cosmetic: Node resolves a bare `import "@grpc/grpc-js"` only by walking
up from the importing file, so NODE_PATH cannot substitute for this exact location.

Deliberately left out: runtime/target* (build caches), plugins/memory/data,
config.json (secrets), .rsi/, outputs/, scripts/patches/ (the shipped runtime/ is already
patched), the Tauri desktop shell sources (they need cargo to build).

Output: <out>/<artifact> + .sha256, plus a manifest json inside each zip.
A failing build exits non-zero (this is a release tool, not a startup step).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EXE = REPO / "runtime/target/release/react-agent-host.exe"
# sandbox-run.exe sits next to the host binary; without it assemble.rs fail-closes and drops
# bash from TOOLS_ENABLED entirely, so it must ship in the same zip
SANDBOX_EXE = REPO / "runtime/target/release/sandbox-run.exe"
# portable runtime produced by scripts/fetch-runtime.py (gitignored, ~136 MB on disk)
ENV_DIR = REPO / "runtime-env"
KERNEL_NODE_MODULES = "runtime/kernel/bindings/typescript/node_modules/"
# tracked trees to include (prefix match); memory data and caches excluded below
# NOTE: runtime/crates/host/web-dist is NOT listed here -- it is re-rooted next to the exe
# below, because web/mod.rs only looks for `web-dist/` beside current_exe() (plus the
# compile-time CARGO_MANIFEST_DIR path, which only exists on the build machine).
INCLUDE = (
    "run.cmd", "release.cmd", "config.example.json", "README.md",
    "scripts/", "runtime/plugins/", "runtime/kernel/",
    "skills/", "desktop/start-desktop.ps1", "desktop/start-desktop-silent.pyw",
)
WEB_DIST_SRC = "runtime/crates/host/web-dist/"
WEB_DIST_DST = "runtime/target/release/web-dist/"
EXCLUDE_DIR_PARTS = {"__pycache__", "node_modules", "data", "state", "outputs", "target", ".venv"}
# core-patch sources: the shipped runtime/ is already patched, end users never run apply-tool-patches.py
EXCLUDE_PREFIX = ("scripts/patches/",)
EXCLUDE_SUFFIX = (".pyc", ".patchbak", ".bak", ".log")
EXCLUDE_FILES = {"runtime/.sync-stamp", "runtime/.sync-manifest"}

Entry = tuple[Path, str]  # (source file on this machine, path inside the archive)


def _git(*args: str) -> str:
    r = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=REPO,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def version() -> str:
    m = re.search(r'^version\s*=\s*"([^"]+)"', (REPO / "runtime/Cargo.toml").read_text(encoding="utf-8"), re.M)
    tag = _git("describe", "--tags", "--abbrev=0").strip() or "v0.0.0"
    return tag.lstrip("v") or (m.group(1) if m else "0.0.0")


def files() -> list[str]:
    out = []
    for rel in _git("ls-files").splitlines():
        rel = rel.strip()
        if not rel or rel in EXCLUDE_FILES:
            continue
        if rel.startswith(EXCLUDE_PREFIX):
            continue
        # web-dist is packaged separately, re-rooted next to the exe
        if rel.startswith(WEB_DIST_SRC):
            continue
        if not any(rel == p or rel.startswith(p) for p in INCLUDE):
            continue
        parts = rel.split("/")
        if any(p in EXCLUDE_DIR_PARTS for p in parts[:-1]):
            continue
        if rel.endswith(EXCLUDE_SUFFIX):
            continue
        out.append(rel)
    return sorted(out)


def web_files() -> list[str]:
    """Frontend assets, re-rooted to sit beside the exe (web/mod.rs candidate 3)."""
    return sorted(rel for rel in _git("ls-files", WEB_DIST_SRC).splitlines()
                  if rel.strip() and not rel.strip().endswith(EXCLUDE_SUFFIX))


def _bin_dir(bin_dir: Path | None) -> Path:
    d = bin_dir or EXE.parent
    for name in ("react-agent-host.exe", "sandbox-run.exe"):
        if not (d / name).is_file():
            raise SystemExit(f"{name} not found in {d}\n"
                             "build it first: cargo build --release --manifest-path runtime/Cargo.toml "
                             "-p react-agent-host")
    return d


def app_entries(ver: str, bin_dir: Path | None = None) -> list[Entry]:
    """Application files only -- no runtime. This is the in-app updater's payload."""
    d = _bin_dir(bin_dir)
    out: list[Entry] = [(REPO / rel, rel) for rel in files()]
    out.append((d / "react-agent-host.exe", "runtime/target/release/react-agent-host.exe"))
    out.append((d / "sandbox-run.exe", "runtime/target/release/sandbox-run.exe"))
    for rel in web_files():
        out.append((REPO / rel, WEB_DIST_DST + rel[len(WEB_DIST_SRC):]))
    return out


def env_entries() -> list[Entry]:
    """Portable runtime files, re-rooted so that unzipping over the install dir just works."""
    if not (ENV_DIR / "python/python.exe").is_file() or not (ENV_DIR / "node/node.exe").is_file():
        raise SystemExit(f"runtime not built: {ENV_DIR}\nrun first: python scripts/fetch-runtime.py")
    out: list[Entry] = []
    for p in sorted(ENV_DIR.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ENV_DIR).as_posix()
        # dot dirs (.tools/ = build-time makensis cache, .cache/ = download cache) are not runtime,
        # and __pycache__ is written by running the bundled python -- never ship it
        if any(part.startswith(".") or part == "__pycache__" for part in rel.split("/")[:-1]):
            continue
        if rel.startswith("kernel-node/node_modules/"):
            arc = KERNEL_NODE_MODULES + rel[len("kernel-node/node_modules/"):]
        elif rel.startswith("kernel-node/"):
            # package.json / package-lock.json are build-time bookkeeping, not runtime input
            continue
        else:
            arc = "runtime-env/" + rel
        out.append((p, arc))
    return out


def env_meta() -> dict:
    """The runtime fingerprint the updater compares (cheap: one small json, no 52 MB download)."""
    m = ENV_DIR / "runtime.json"
    if not m.is_file():
        raise SystemExit(f"{m} missing -- run python scripts/fetch-runtime.py")
    meta = json.loads(m.read_text(encoding="utf-8"))
    return {"schema": meta.get("schema", 1), "python": meta.get("python", {}),
            "node": meta.get("node", {}), "files": meta.get("files", {})}


def _write_zip(zip_path: Path, entries: list[Entry], extra: dict[str, str] | None = None,
               root: str = "") -> str:
    prefix = (root + "/") if root else ""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for src, arc in entries:
            z.write(src, prefix + arc)
        # written inside the `with` block: a writestr after close raises ValueError
        for arc, text in (extra or {}).items():
            z.writestr(prefix + arc, text)
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    (zip_path.with_name(zip_path.name + ".sha256")).write_text(
        f"{digest}  {zip_path.name}\n", encoding="utf-8")
    return digest


def build_app(out_dir: Path, ver: str, bin_dir: Path | None = None) -> tuple[Path, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    entries = app_entries(ver, bin_dir)
    name = f"rsi-agent-{ver}-win"
    zip_path = out_dir / f"{name}.zip"
    manifest = {"name": "rsi-agent", "version": ver, "platform": "win",
                "kind": "app", "files": len(entries) + 1,
                "git_head": _git("rev-parse", "--short", "HEAD").strip()}
    # the frontend banner reads /vendor/manifest.json to learn its own version
    # (dev trees have no such file -> fetch 500/404 -> banner stays silent)
    # root=<name>/: one folder on unzip, and update_check.py already strips that top dir
    digest = _write_zip(zip_path, entries, {
        f"{WEB_DIST_DST}vendor/manifest.json": json.dumps({"version": ver}, indent=2),
        "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2),
    }, root=name)
    print(f"[bundle] {zip_path}  ({zip_path.stat().st_size / 1e6:.1f} MB, {len(entries) + 2} files, "
          f"sha256 {digest[:12]}...)")
    return zip_path, digest


def build_env(out_dir: Path) -> tuple[Path, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    entries = env_entries()
    zip_path = out_dir / "runtime-env.zip"
    digest = _write_zip(zip_path, entries)
    # tiny sidecar: the updater downloads THIS to decide whether the 52 MB zip is needed at all
    meta = env_meta()
    (out_dir / "runtime-env.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[bundle] {zip_path}  ({zip_path.stat().st_size / 1e6:.1f} MB, {len(entries)} files, "
          f"runtime {meta['python'].get('version')}/{meta['node'].get('version')}, "
          f"digest {meta['files'].get('sha256', '')[:12]}...)")
    return zip_path, digest


def build(out_dir: Path, ver: str, bin_dir: Path | None = None) -> tuple[Path, str]:
    """Back-compat alias: the app zip is the primary artifact."""
    return build_app(out_dir, ver, bin_dir)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="build rsi-agent distributable artifacts")
    ap.add_argument("--out", default=str(REPO / "outputs"))
    ap.add_argument("--version", default=None, help="override version (default: latest git tag)")
    ap.add_argument("--bin-dir", default=None, help="dir holding react-agent-host.exe + sandbox-run.exe (default: runtime/target/release)")
    ap.add_argument("--what", choices=("app", "env", "all"), default="all",
                    help="app = updater payload, env = portable runtime, all = both (default)")
    ns = ap.parse_args(argv)
    out = Path(ns.out)
    ver = ns.version or version()
    if ns.what in ("app", "all"):
        build_app(out, ver, Path(ns.bin_dir) if ns.bin_dir else None)
    if ns.what in ("env", "all"):
        build_env(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
