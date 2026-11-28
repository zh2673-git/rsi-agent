"""rsi-agent 更新侧车（zip 分发用户专用；开发树用户走 cargo 自更新）。

子命令：
  current                 打印本地版本（manifest.json > git describe > unknown）
  check [--json]          查 GitHub Releases 最新版，比对本地；exit 0=有更新, 10=已最新, 1=出错
  ensure                  check + 有更新则 download；exit 0=ready.json 已写, 10=已最新, 1=出错
  download <ver> <url>    下载 zip 到 .rsi/update-staging/，校验 sha256，解包（校验路径），
                          替换非 exe 文件，把新 exe 放 staging 根，写 ready.json
  stage-env               比对 release 上的 runtime-env.json 与本地 runtime-env/runtime.json，
                          运行时变了才把 runtime-env.zip 落到 staging（不落盘覆盖，见下）
  finalize                新进程启动后调用：把 staging 内 exe 落位到 runtime/target/release/

两个包，不能混：
  rsi-agent-<ver>-win.zip   应用包（~8MB）——每次更新都下
  runtime-env.zip           运行时（~53MB）——只有 files.sha256 变了才下，且必须由
                            run.cmd 在**任何 python 启动之前**解包（scripts/apply-env-update.ps1），
                            因为替换 python.exe/node.exe 时它们不能是正在运行的镜像。

设计约束：
  - 运行中的 host.exe 被锁，不能覆盖；所以新 exe 从 staging 启动，由 finalize 落位。
  - 只信任 manifest.json 内的版本号，不读 Cargo.toml（host 不暴露 /api/version）。
  - 网络失败一律 exit 1 且不写任何文件；已最新 exit 10（run.cmd 用它跳过横幅）。
  - runtime-env.zip 必须在 finalize 的清理里保留，否则更新完成后运行时补丁就丢了。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO_SLUG = "zh2673-git/rsi-agent"
# RSI_UPDATE_API lets a mirror / an offline test serve the same release JSON; unset = GitHub.
API = os.environ.get("RSI_UPDATE_API") or f"https://api.github.com/repos/{REPO_SLUG}/releases/latest"
UA = {"User-Agent": "rsi-agent-update-check"}
STAGING = ".rsi/update-staging"
EXE = "react-agent-host.exe"
# same package as the host; assemble.rs looks for it next to current_exe() (fail-closed without it)
SANDBOX_EXE = "sandbox-run.exe"

# desktop shell: shipped inside the app zip (0.1.32+). Its image is locked while the shell
# runs, so download() only stages it and finalize() swaps it via a rename.
SHELL_REL = "desktop/rsi-agent-desktop.exe"
SHELL_EXE = "rsi-agent-desktop.exe"


def repo_root() -> Path:
    r = os.environ.get("REPO_ROOT") or os.environ.get("WORKSPACE_ROOT")
    p = Path(r) if r else Path.cwd()
    if not (p / "runtime").is_dir():
        # fall back to this script's parent (scripts/ -> repo)
        p = Path(__file__).resolve().parent.parent
    if not (p / "runtime").is_dir():
        sys.stderr.write("update_check: cannot locate repo root\n")
        sys.exit(2)
    return p


def current_version(root: Path) -> str:
    m = root / "manifest.json"
    if m.is_file():
        try:
            return json.loads(m.read_text(encoding="utf-8")).get("version", "unknown")
        except Exception:
            return "unknown"
    import subprocess
    try:
        out = subprocess.run(["git", "describe", "--tags", "--abbrev=0"], cwd=root, capture_output=True, text=True, timeout=10)
        v = out.stdout.strip().lstrip("v")
        return v or "unknown"
    except Exception:
        return "unknown"


def _ver_key(v: str) -> tuple:
    parts = []
    for x in v.split("."):
        try:
            parts.append(int(x))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def latest() -> dict:
    req = urllib.request.Request(API, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        j = json.loads(r.read())
    assets = [(a["name"], a["browser_download_url"], a.get("size", 0)) for a in j.get("assets", [])]
    return {"tag": j.get("tag_name", "").lstrip("v"), "assets": assets, "notes": j.get("body", "") or ""}


# the two payloads are different kinds of thing and must never be confused:
#   app  = rsi-agent-<ver>-win.zip  (~8 MB, every update)
#   env  = runtime-env.zip          (~53 MB, only when the runtime fingerprint changes)
ENV_ZIP = "runtime-env.zip"
ENV_META = "runtime-env.json"


def _asset(info: dict, name: str) -> str | None:
    return next((u for n, u, _ in info["assets"] if n == name), None)


def app_url(info: dict) -> str | None:
    """The application zip -- never runtime-env.zip (that would re-download 53 MB every time)."""
    cands = [(n, u) for n, u, _ in info["assets"] if n.endswith(".zip") and n != ENV_ZIP]
    cands.sort(key=lambda x: (not x[0].startswith("rsi-agent-"), x[0]))
    return cands[0][1] if cands else None


def _local_env_digest(root: Path) -> str:
    m = root / "runtime-env" / "runtime.json"
    try:
        return json.loads(m.read_text(encoding="utf-8")).get("files", {}).get("sha256", "") or ""
    except Exception:
        return ""


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch(url: str, dest: Path, timeout: int = 300) -> str:
    """Stream url -> dest, return sha256 hex. Raises on network error."""
    req = urllib.request.Request(url, headers=UA)
    h = hashlib.sha256()
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    return h.hexdigest()


def check() -> int:
    root = repo_root()
    cur = current_version(root)
    try:
        info = latest()
    except Exception as e:
        sys.stderr.write(f"update_check: network error {type(e).__name__}\n")
        print(json.dumps({"current": cur, "latest": None, "error": type(e).__name__}))
        return 1
    lv = info["tag"]
    url = app_url(info)
    upd = bool(lv) and _ver_key(lv) > _ver_key(cur)
    print(json.dumps({"current": cur, "latest": lv, "update_available": bool(upd and url),
                      "asset": url, "env_changed": env_changed(info)}))
    return 0 if (upd and url) else 10


def env_changed(info: dict) -> bool:
    """True only when the release's runtime fingerprint differs from the installed one.

    Cheap: fetches the small runtime-env.json sidecar, never the 53 MB zip. Unknown (offline,
    missing sidecar, dev tree) is reported as False -- an env update is never guessed at.
    """
    root = repo_root()
    local = _local_env_digest(root)
    if not local:
        return False
    url = _asset(info, ENV_META)
    if not url:
        return False
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            remote = json.loads(r.read()).get("files", {}).get("sha256", "") or ""
    except Exception:
        return False
    return bool(remote) and remote != local



def _safe_name(n: str) -> bool:
    n = n.replace("\\", "/")
    return not (n.startswith("/") or ".." in n.split("/") or ":" in n)


def _unlink_quiet(p: Path) -> None:
    """Best-effort delete. A download zip can still be held by an AV scanner or a killed-but-not-yet-
    reaped process; failing here must not mask the real error (the caller is already on an error
    path), and a stale file is retried on the next attempt anyway."""
    try:
        p.unlink(missing_ok=True)
    except OSError:
        pass


def download(ver: str, url: str) -> int:
    root = repo_root()
    st = root / STAGING
    st.mkdir(parents=True, exist_ok=True)
    zpath = st / "download.zip"
    try:
        got = _fetch(url, zpath, timeout=180)
    except Exception as e:
        _unlink_quiet(zpath)
        sys.stderr.write(f"update_check: download failed {type(e).__name__}\n")
        return 1
    try:
        req2 = urllib.request.Request(url + ".sha256", headers=UA)
        with urllib.request.urlopen(req2, timeout=30) as r:
            expect = r.read().decode("utf-8").split()[0]
    except Exception:
        expect = ""
    if expect and got != expect:
        _unlink_quiet(zpath)
        sys.stderr.write("update_check: sha256 mismatch\n")
        return 1
    digest = got
    exe_dir = st / "runtime/target/release"
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        for n in names:
            if not _safe_name(n):
                sys.stderr.write(f"update_check: unsafe path in zip {n}\n")
                return 1
        top = names[0].split("/")[0]
        for n in names:
            rel = n[len(top) + 1:] if n.startswith(top + "/") else n
            if not rel or rel.endswith("/"):
                continue
            data = z.read(n)
            if rel == f"runtime/target/release/{EXE}":
                exe_dir.mkdir(parents=True, exist_ok=True)
                (exe_dir / EXE).write_bytes(data)
                continue
            if rel == f"runtime/target/release/{SANDBOX_EXE}":
                # not locked (short-lived child), but keep it next to the staged host: the new
                # process resolves the helper via current_exe().parent() until the next restart
                exe_dir.mkdir(parents=True, exist_ok=True)
                (exe_dir / SANDBOX_EXE).write_bytes(data)
                continue
            if rel == SHELL_REL:
                # stage only: the live shell has its own image locked, and download() must not
                # depend on finalize()'s rename trick having run yet
                sd = st / SHELL_REL
                sd.parent.mkdir(parents=True, exist_ok=True)
                sd.write_bytes(data)
                continue
            if rel.startswith("runtime/target/release/"):
                # web-dist lives beside the exe (web/mod.rs candidate 3), so it must exist next to
                # BOTH the staged host (used right after handoff) and the installed one
                for base in (root, st):
                    d = base / rel
                    d.parent.mkdir(parents=True, exist_ok=True)
                    d.write_bytes(data)
                continue
            dst = root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
    if not (exe_dir / EXE).is_file():
        sys.stderr.write("update_check: exe missing in zip\n")
        return 1
    _unlink_quiet(zpath)
    ready = {"version": ver, "exe": str(exe_dir / EXE), "sha256": digest}
    (st / "ready.json").write_text(json.dumps(ready), encoding="utf-8")
    print(json.dumps({"ok": True, "version": ver, "ready": str(st / "ready.json")}))
    return 0

def _wait_pid_exit(pid: int, timeout: float) -> bool:
    """Block until <pid> exits. Returns True if it exited, False on timeout."""
    import ctypes
    k32 = ctypes.windll.kernel32
    SYNCHRONIZE = 0x00100000
    h = k32.OpenProcess(SYNCHRONIZE, False, pid)
    if not h:
        return True  # already gone
    try:
        return k32.WaitForSingleObject(h, int(timeout * 1000)) == 0
    finally:
        k32.CloseHandle(h)


def _replace_locked(dst: Path, src: Path) -> bool:
    """Replace dst with src even when dst is a running image.

    Windows locks a running exe against write/delete but NOT against rename, so the swap is:
    try a plain copy (works when the file is not in use), else rename the old image aside and
    write the new one. The old process keeps its handle on the renamed file, so it keeps
    running; the rename is cleaned up on a later start. Returns False if even the rename
    fails (e.g. an ACL problem) -- the caller degrades to "update on next reinstall".
    """
    import shutil

    try:
        shutil.copy2(src, dst)
        return True
    except OSError:
        pass
    if not dst.is_file():
        return False
    aside = dst.with_name(f"{dst.name}.old-{os.getpid()}")
    try:
        os.replace(dst, aside)
    except OSError:
        return False
    try:
        shutil.copy2(src, dst)
    except OSError:
        try:
            os.replace(aside, dst)  # roll back, keep the old shell usable
        except OSError:
            pass
        return False
    try:
        aside.unlink(missing_ok=True)  # fails while the old shell still runs -> retried next boot
    except OSError:
        pass
    return True


def finalize(wait_pid: int = 0) -> int:
    root = repo_root()
    st = root / STAGING
    ready = st / "ready.json"
    if not ready.is_file():
        return 10
    if wait_pid:
        if not _wait_pid_exit(wait_pid, 180.0):
            sys.stderr.write("update_check: old host did not exit in 180s, finalize aborted\n")
            return 1
    info = json.loads(ready.read_text(encoding="utf-8"))
    src = Path(info["exe"])
    dst_dir = root / "runtime" / "target" / "release"
    dst_dir.mkdir(parents=True, exist_ok=True)
    import shutil
    shutil.copy2(src, dst_dir / EXE)
    # sandbox helper must exist in both places: the running (staged) host looks for it next to
    # itself, the next regular start looks for it in the install root
    sandbox_src = src.parent / SANDBOX_EXE
    if sandbox_src.is_file():
        shutil.copy2(sandbox_src, dst_dir / SANDBOX_EXE)
    # desktop shell: same handoff as the host exe, but the old image is still mapped by the
    # running shell, so it is renamed aside rather than overwritten (see _replace_locked).
    shell_src = st / SHELL_REL
    if shell_src.is_file():
        shell_dst = root / SHELL_REL
        shell_dst.parent.mkdir(parents=True, exist_ok=True)
        if _replace_locked(shell_dst, shell_src):
            sys.stderr.write("update_check: desktop shell replaced\n")
        else:
            sys.stderr.write("update_check: desktop shell not replaced (locked); "
                             "it will update on the next install\n")
    ready.unlink(missing_ok=True)
    # keep the staged exe dir (the staged host IS the running process until next restart, and it
    # resolves web-dist/ + sandbox-run.exe beside its own image); drop everything else --
    # EXCEPT runtime-env.zip: it is applied by run.cmd *before* python starts on the next boot,
    # so wiping it here would silently lose the runtime update.
    keep_dir = src.parent
    for p in st.rglob("*"):
        if not p.is_file() or p == src or keep_dir in p.parents:
            continue
        if p.name in (ENV_ZIP, "env.json"):
            continue
        p.unlink(missing_ok=True)
    print(json.dumps({"ok": True, "installed": str(dst_dir / EXE)}))
    return 0


def stage_env(info: dict | None = None) -> int:
    """Download runtime-env.zip into staging, but only when the fingerprint actually changed.

    Deliberately does NOT unpack over the live runtime-env/: python.exe and node.exe are running
    images right now (the host spawned them), so the swap has to happen in run.cmd before any
    python starts -- that is what scripts/apply-env-update.ps1 does on the next boot.
    exit 0 = staged or nothing to do; 1 = error.
    """
    root = repo_root()
    st = root / STAGING
    if info is None:
        try:
            info = latest()
        except Exception as e:
            sys.stderr.write(f"update_check: network error {type(e).__name__}\n")
            return 1
    if not env_changed(info):
        print(json.dumps({"ok": True, "env_changed": False}))
        return 0
    url = _asset(info, ENV_ZIP)
    if not url:
        sys.stderr.write("update_check: runtime changed but runtime-env.zip is not published\n")
        return 1
    st.mkdir(parents=True, exist_ok=True)
    zpath = st / ENV_ZIP
    try:
        got = _fetch(url, zpath, timeout=600)
    except Exception as e:
        _unlink_quiet(zpath)
        sys.stderr.write(f"update_check: runtime download failed {type(e).__name__}\n")
        return 1
    try:
        req2 = urllib.request.Request(url + ".sha256", headers=UA)
        with urllib.request.urlopen(req2, timeout=30) as r:
            expect = r.read().decode("utf-8").split()[0]
    except Exception:
        expect = ""
    if expect and got != expect:
        _unlink_quiet(zpath)
        sys.stderr.write("update_check: runtime sha256 mismatch\n")
        return 1
    meta_url = _asset(info, ENV_META)
    meta = {}
    if meta_url:
        try:
            req3 = urllib.request.Request(meta_url, headers=UA)
            with urllib.request.urlopen(req3, timeout=15) as r:
                meta = json.loads(r.read())
        except Exception:
            meta = {}
    (st / "env.json").write_text(json.dumps({"sha256": got, "meta": meta}), encoding="utf-8")
    print(json.dumps({"ok": True, "env_changed": True, "zip": str(zpath), "sha256": got}))
    return 0


def ensure() -> int:
    """check -> download when a newer zip release exists. Writes ready.json only on success.
    exit 0 = ready.json written (or already present); 10 = already latest; 1 = error (nothing written).

    A changed runtime is staged in the same pass (runtime-env.zip), but its failure never blocks
    the app update: the app is what the user asked for, the runtime can be retried next boot.
    """
    root = repo_root()
    if (root / STAGING / "ready.json").is_file():
        print(json.dumps({"current": current_version(root), "update_available": True, "staged": True}))
        return 0
    cur = current_version(root)
    try:
        info = latest()
    except Exception as e:
        sys.stderr.write(f"update_check: network error {type(e).__name__}\n")
        return 1
    lv = info["tag"]
    url = app_url(info)
    if not lv or not url or _ver_key(lv) <= _ver_key(cur):
        print(json.dumps({"current": cur, "latest": lv, "update_available": False}))
        # an app-version bump is not the only reason to refresh the runtime (e.g. a republished
        # runtime-env.zip for the same tag), so still stage it when the fingerprint differs
        stage_env(info)
        return 10
    print(json.dumps({"current": cur, "latest": lv, "update_available": True, "asset": url}))
    rc = download(lv, url)
    stage_env(info)
    return rc


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write(__doc__)
        return 2
    cmd, rest = argv[1], argv[2:]
    if cmd == "current":
        print(current_version(repo_root()))
        return 0
    if cmd == "check":
        return check()
    if cmd == "ensure":
        return ensure()
    if cmd == "stage-env":
        return stage_env()
    if cmd == "download":
        if len(rest) < 2:
            sys.stderr.write("usage: download <ver> <url>\n")
            return 2
        return download(rest[0], rest[1])
    elif cmd == "finalize":
        pid = 0
        if "--wait" in rest:
            i = rest.index("--wait")
            pid = int(rest[i + 1]) if i + 1 < len(rest) else 0
        return finalize(pid)
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
