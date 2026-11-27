"""Fetch the portable runtime that makes rsi-agent a one-click install.

    python scripts/fetch-runtime.py            # build runtime-env/ (idempotent)
    python scripts/fetch-runtime.py --verify   # only check an existing runtime-env/
    python scripts/fetch-runtime.py --force    # rebuild from scratch

What it produces (all under <repo>/runtime-env/, gitignored):

    runtime-env/python/python.exe            portable CPython (embeddable distro)
    runtime-env/python/Lib/site-packages/    grpcio, protobuf, httpx + deps (native win_amd64)
    runtime-env/node/node.exe                portable Node.js (no installer, no registry)
    runtime-env/kernel-node/node_modules/    @grpc/grpc-js + proto-loader (staging copy)
    runtime-env/runtime.json                 pinned versions + sha256 (the update baseline)

The packager (release-bundle.py) moves runtime-env/kernel-node/node_modules to
runtime/kernel/bindings/typescript/node_modules, because Node resolves bare `import "@grpc/..."`
only by walking up from the importing file -- NODE_PATH does not apply to ESM imports.

Why this shape:
  - The embeddable CPython is a plain file tree: copy it anywhere and it runs. No installer,
    no registry, no system Python needed. `python311._pth` is rewritten so that
      * `Lib\\site-packages` is importable (embeddable distro disables site by default), and
      * `<repo>/runtime/kernel/bindings/python` is on sys.path BY PATH, not via PYTHONPATH.
    The second point is not cosmetic: the presence of a `._pth` file puts CPython in isolated
    mode, where PYTHONPATH from the environment is IGNORED. host's spawn.rs:52 sets
    PYTHONPATH=<kernel>/bindings/python, so relying on it silently breaks every Python plugin.
  - Node ships as a single node.exe. npm/npx/corepack are dropped: at run time the kernel TS
    SDK only needs @grpc/* resolved from node_modules, never npm itself.
  - Wheels are installed with `pip --target --only-binary --platform win_amd64`, so the build
    machine's interpreter is irrelevant and no compiler is involved.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENV = REPO / "runtime-env"
# shipped into runtime-env/python/Lib/site-packages/ so the embeddable interpreter behaves like
# a normal one (isolated mode otherwise drops sys.path[0]); see the file's own docstring
SITECUSTOMIZE = REPO / "scripts" / "runtime-sitecustomize.py"

# --- pinned runtime (bump deliberately, not automatically) -------------------------------
# Both are mirrored by npmmirror: nodejs.org and python.org are unreachable/slow from CN,
# and the mirror serves the identical bytes (verified by sha256 below).
PY_VER = "3.11.9"
NODE_VER = "22.23.3"
PY_URL = f"https://registry.npmmirror.com/-/binary/python/{PY_VER}/python-{PY_VER}-embed-amd64.zip"
PY_SHA256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b"
NODE_URL = f"https://registry.npmmirror.com/-/binary/node/v{NODE_VER}/node-v{NODE_VER}-win-x64.zip"
NODE_SHA256 = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71"

PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"
# what the Python plugins import: host/plugins/*.py + kernel bindings/python/agent_kernel
PY_PACKAGES = ["grpcio", "protobuf", "httpx"]
# what the TS kernel SDK imports (runtime/kernel/bindings/typescript/package.json dependencies).
# Installed here as a staging copy; the packager places them at
# runtime/kernel/bindings/typescript/node_modules, which is the only path Node's ESM resolver
# will look at (NODE_PATH is ignored for `import`, so it cannot live elsewhere).
NODE_DEPS = {"@grpc/grpc-js": "^1.14.4", "@grpc/proto-loader": "^0.8.1"}


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch(url: str, dst: Path, sha256: str = "", timeout: int = 300) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_file() and (not sha256 or _sha256(dst) == sha256):
        print(f"[fetch-runtime] cached {dst.name}")
        return dst
    print(f"[fetch-runtime] download {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "rsi-agent-fetch-runtime"})
    tmp = dst.with_suffix(dst.suffix + ".part")
    with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    got = _sha256(tmp)
    if sha256 and got != sha256:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"[fetch-runtime] sha256 mismatch for {dst.name}\n"
                         f"  expected {sha256}\n  got      {got}")
    tmp.replace(dst)
    return dst


def _pip_ready(site: Path) -> bool:
    """True when the pinned packages are already in place (idempotent re-runs skip pip)."""
    return all(any(site.glob(f"{name}-*.dist-info")) for name in PY_PACKAGES)


def _pip_target(site: Path, packages: list[str]) -> None:
    """Install exact win_amd64 wheels into <site> using THIS interpreter's pip.

    Cross-platform/version flags mean the build host's Python version does not matter, and
    --only-binary forbids source builds (no MSVC on a clean machine).
    """
    site.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "pip", "install", "--target", str(site),
           "--only-binary=:all:", "--platform", "win_amd64",
           "--python-version", "3.11", "--implementation", "cp",
           "--index-url", PIP_INDEX, "--upgrade", "--no-warn-script-location",
           *packages]
    print(f"[fetch-runtime] pip install --target {site.name}: {' '.join(packages)}")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit("[fetch-runtime] pip failed:\n" + (r.stderr or r.stdout)[-2000:])
    # pip drops console scripts into <site>/bin; nothing at run time needs them
    shutil.rmtree(site / "bin", ignore_errors=True)
    for junk in site.rglob("__pycache__"):
        shutil.rmtree(junk, ignore_errors=True)


def _node_modules(target: Path) -> None:
    """npm-install the two @grpc packages into <target> (pure JS, no native build)."""
    target.mkdir(parents=True, exist_ok=True)
    pkg = target / "package.json"
    pkg.write_text(json.dumps({"name": "rsi-kernel-node", "private": True,
                               "version": "0.0.0", "dependencies": NODE_DEPS},
                              indent=2), encoding="utf-8")
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("[fetch-runtime] npm not found (needed once, at build time only)")
    print(f"[fetch-runtime] npm install @grpc/* -> {target}")
    r = subprocess.run([npm, "install", "--omit=dev", "--no-audit", "--no-fund"],
                       cwd=target, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit("[fetch-runtime] npm failed:\n" + (r.stderr or r.stdout)[-2000:])


def _wire_python(py_dir: Path) -> None:
    """Rewrite pythonXY._pth so site-packages and the kernel bindings are importable.

    A `._pth` file implies isolated mode: environment PYTHONPATH is ignored, so the kernel
    bindings path must be listed here (relative to the ._pth file, i.e. to python.exe).
    """
    pth = next(py_dir.glob("python*._pth"), None)
    if pth is None:
        raise SystemExit(f"[fetch-runtime] no python*._pth in {py_dir}")
    # ../../runtime/kernel/bindings/python relative to <root>/runtime-env/python/
    kernel_rel = "..\\..\\runtime\\kernel\\bindings\\python"
    lines = ["python311.zip", ".", "Lib\\site-packages", kernel_rel, "import site"]
    pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # python311.zip must keep its own name; rename if the distro used a different minor
    zipname = next((p.name for p in py_dir.glob("python*.zip")), None)
    if zipname and zipname != "python311.zip":
        lines[0] = zipname
        pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # isolated mode also drops "sys.path[0] = the script's own directory", which every plugin
    # relies on (`from providers.registry import ...`, `from skillkit import ...`, `from tools
    # import ...`). sitecustomize.py puts it back; `import site` above is what loads it.
    dst = py_dir / "Lib" / "site-packages" / "sitecustomize.py"
    shutil.copy2(SITECUSTOMIZE, dst)


def build(force: bool = False) -> dict:
    if force and ENV.exists():
        shutil.rmtree(ENV)
    cache = ENV / ".cache"
    py_dir = ENV / "python"
    node_dir = ENV / "node"

    if not (py_dir / "python.exe").is_file():
        z = _fetch(PY_URL, cache / f"python-{PY_VER}-embed-amd64.zip", PY_SHA256)
        py_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(z) as zf:
            zf.extractall(py_dir)
    site = py_dir / "Lib" / "site-packages"
    if not _pip_ready(site):
        _pip_target(site, PY_PACKAGES)
    _wire_python(py_dir)

    if not (node_dir / "node.exe").is_file():
        z = _fetch(NODE_URL, cache / f"node-v{NODE_VER}-win-x64.zip", NODE_SHA256)
        with zipfile.ZipFile(z) as zf:
            names = zf.namelist()
            top = names[0].split("/")[0]
            for n in names:
                # keep only node.exe: npm/npx/corepack are build-time tools, not runtime deps
                if n == f"{top}/node.exe" or n == f"{top}/LICENSE":
                    node_dir.mkdir(parents=True, exist_ok=True)
                    (node_dir / Path(n).name).write_bytes(zf.read(n))

    node_modules = ENV / "kernel-node"
    if not (node_modules / "node_modules/@grpc/grpc-js").is_dir():
        _node_modules(node_modules)
    shutil.rmtree(cache, ignore_errors=True)

    meta = {
        "schema": 1,
        "python": {"version": PY_VER, "url": PY_URL, "sha256": PY_SHA256,
                   "packages": PY_PACKAGES},
        "node": {"version": NODE_VER, "url": NODE_URL, "sha256": NODE_SHA256,
                 "packages": NODE_DEPS},
        "files": _tree_digest(ENV),
    }
    (ENV / "runtime.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def _tree_digest(root: Path) -> dict:
    # dot dirs are build-time caches (downloads, the portable NSIS), never shipped: including
    # them would make `--verify` report CHANGED as soon as build-installer.py fetched makensis.
    # __pycache__ is written by merely RUNNING the bundled python, so it cannot be part of a
    # reproducible fingerprint either (it is skipped by the packager as well).
    files = [p for p in root.rglob("*")
             if p.is_file() and p.name != "runtime.json"
             and not any(part.startswith(".") or part == "__pycache__"
                         for part in p.relative_to(root).parts[:-1])]
    total = sum(p.stat().st_size for p in files)
    h = hashlib.sha256()
    for p in sorted(files):
        h.update(str(p.relative_to(root)).replace("\\", "/").encode())
        h.update(_sha256(p).encode())
    return {"count": len(files), "bytes": total, "sha256": h.hexdigest()}


def verify() -> int:
    meta_path = ENV / "runtime.json"
    if not meta_path.is_file():
        print("[fetch-runtime] runtime-env/ not built")
        return 1
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    now = _tree_digest(ENV)
    ok = now == meta["files"]
    py = ENV / "python/python.exe"
    node = ENV / "node/node.exe"
    print(f"[fetch-runtime] python {meta['python']['version']}  {py.is_file()}")
    print(f"[fetch-runtime] node   {meta['node']['version']}  {node.is_file()}")
    print(f"[fetch-runtime] files  {now['count']}  {now['bytes']/1e6:.1f} MB")
    print(f"[fetch-runtime] digest {'match' if ok else 'CHANGED'}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="build the portable runtime for rsi-agent")
    ap.add_argument("--force", action="store_true", help="rebuild runtime-env from scratch")
    ap.add_argument("--verify", action="store_true", help="only verify an existing runtime-env")
    ns = ap.parse_args(argv)
    if ns.verify:
        return verify()
    meta = build(ns.force)
    print(f"[fetch-runtime] python {meta['python']['version']} + node {meta['node']['version']}")
    print(f"[fetch-runtime] {meta['files']['count']} files, "
          f"{meta['files']['bytes']/1e6:.1f} MB -> {ENV}")
    return verify()


if __name__ == "__main__":
    sys.exit(main())
