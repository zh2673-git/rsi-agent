"""Build the one-click Windows installer (setup.exe) for rsi-agent.

    python scripts/build-installer.py                 # -> outputs/rsi-agent-<ver>-setup.exe
    python scripts/build-installer.py --skip-env      # app only, no portable runtime
    python scripts/build-installer.py --out DIR --version X.Y.Z

What it does:
  1. asks scripts/release-bundle.py for the exact same file lists the zips are built from
     (app_entries / env_entries), so the installer can never drift from the release zips;
  2. fetches a portable NSIS (makensis) into runtime-env/.tools/nsis-<ver>/ when none is
     installed -- the user machine never needs NSIS, and neither does the dev machine;
  3. generates a per-user .nsi and compiles it with LZMA solid compression.

Why per-user (`RequestExecutionLevel user`, `$LOCALAPPDATA\\Programs\\rsi-agent`):
  no UAC prompt, no admin password, no Program Files ACL problems, and the portable
  Python/Node tree inside the package can write its own __pycache__ next to itself.

Layout the installer produces is exactly what run.cmd expects:
  <INSTDIR>\\run.cmd                                   launcher (prepends runtime-env to PATH)
  <INSTDIR>\\runtime-env\\python\\python.exe           portable CPython + grpc/httpx/protobuf
  <INSTDIR>\\runtime-env\\node\\node.exe               portable Node
  <INSTDIR>\\runtime\\kernel\\bindings\\typescript\\node_modules\\  @grpc/* (ESM needs this exact path)
  <INSTDIR>\\runtime\\target\\release\\*.exe           prebuilt host + sandbox helper

Uninstall keeps user data: only generated trees (runtime, runtime-env, scripts, skills,
desktop) are removed, then $INSTDIR itself is RMDir'd without /r, which silently fails while
config.json / .rsi / ledger / outputs are still there.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENV_DIR = REPO / "runtime-env"
# build-time tool cache; inside runtime-env/ (gitignored) but dot-prefixed so the packager skips it
TOOLS = ENV_DIR / ".tools"
WORK = REPO / ".scratch/nsis-work"

NSIS_VER = "3.10"
NSIS_URL = f"https://downloads.sourceforge.net/project/nsis/NSIS%203/{NSIS_VER}/nsis-{NSIS_VER}.zip"
NSIS_SHA256 = "fcdce3229717a2a148e7cda0ab5bdb667f39d8fb33ede1da8dabc336bd5ad110"

APP_NAME = "rsi-agent"
UNINST_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\rsi-agent"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


bundle = _load("rsi_release_bundle", "release-bundle.py")
fetch = _load("rsi_fetch_runtime", "fetch-runtime.py")


# --- NSIS acquisition ----------------------------------------------------------------

def find_makensis() -> Path | None:
    """Installed NSIS > our portable copy > PATH. Returns makensis.exe or None."""
    for cand in (Path(r"C:\Program Files (x86)\NSIS\makensis.exe"),
                 Path(r"C:\Program Files\NSIS\makensis.exe")):
        if cand.is_file():
            return cand
    # The portable zip extracts to nsis-<ver>/nsis-<ver>/makensis.exe (two levels), so the
    # single-level glob alone never matches and every run re-extracted into a locked tree.
    cached = (sorted(TOOLS.glob("nsis-*/makensis.exe"))
              + sorted(TOOLS.glob("nsis-*/*/makensis.exe")))
    if cached:
        return cached[0]
    hit = shutil.which("makensis")
    return Path(hit) if hit else None


def ensure_makensis() -> Path:
    exe = find_makensis()
    if exe:
        print(f"[installer] makensis {exe}")
        return exe
    z = fetch._fetch(NSIS_URL, TOOLS / f"nsis-{NSIS_VER}.zip", NSIS_SHA256)
    dest = TOOLS / f"nsis-{NSIS_VER}"
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(z) as zf:
        zf.extractall(dest)
    exe = next(dest.rglob("makensis.exe"), None)
    if exe is None:
        raise SystemExit(f"[installer] makensis.exe not found under {dest}")
    print(f"[installer] makensis {exe} (portable, {NSIS_VER})")
    return exe


def _find_gateway_cli() -> Path | None:
    """Locate the local gateway CLI to ship at bin/magpie.exe. Same order as run.cmd:
    MAGPIE_EXE env > %USERPROFILE%\\.local\\bin\\magpie.exe > PATH."""
    env = os.environ.get("MAGPIE_EXE")
    if env and Path(env).is_file():
        return Path(env)
    prof = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    if prof:
        p = Path(prof) / ".local" / "bin" / "magpie.exe"
        if p.is_file():
            return p
    hit = shutil.which("magpie")
    return Path(hit) if hit else None


# --- .nsi generation -----------------------------------------------------------------

def _q(p: Path) -> str:
    return '"' + str(p).replace("$", "$$") + '"'


PS_EXE = r"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

LOCK_GUARD_PS1 = r"""
param([Parameter(Mandatory=$true)][string]$Root, [string]$Mode = 'check')
# exit 0 = nothing running under $Root    -> safe to write
# exit 2 = something running, check mode  -> installer must ask
# exit 1 = killed, nothing left           -> safe to write
# exit 3 = killed, survivors remain       -> still locked
#
# Detection MUST go through WMI/CIM, not Get-Process. The installer is an x86-unicode NSIS
# binary, so $SYSDIR resolves to SysWOW64 and this script runs under 32-bit PowerShell,
# which cannot read .Path of 64-bit processes -- Get-Process reports nothing and the guard
# would silently never fire. Win32_Process.ExecutablePath is bitness-agnostic.
#
# Prefix compare, so "D:\app" never matches "D:\app2".
function Get-Hits {
  $q = @()
  try {
    $q = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ExecutablePath)
  } catch {
    $q = @(Get-WmiObject Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ExecutablePath)
  }
  foreach ($p in $q) {
    if ($p.ExecutablePath -and
        $p.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { $p }
  }
}
$t = @(Get-Hits)
if ($t.Count -eq 0) { exit 0 }
if ($Mode -ne 'kill') { exit 2 }
foreach ($p in $t) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
Start-Sleep -Milliseconds 1500
$left = @(Get-Hits).Count
if ($left -eq 0) { exit 1 } else { exit 3 }
"""

GUARD_NSI = r"""
Function __NAME__
  ; A previous rsi-agent still holds runtime-env\node\node.exe and runtime-env\python\python.exe
  ; open. NSIS then dies mid-install with "无法打开要写入的文件" and leaves a half-written tree,
  ; so this check has to run before the first File instruction of the payload.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=rsi-stop.ps1 "{PS1}"
  nsExec::ExecToStack '{PSEXE} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rsi-stop.ps1" -Root "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "2" 0 guard_done
  MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "检测到 rsi-agent 正在运行：$INSTDIR$\r$\n$\r$\n安装程序要替换 node.exe、python.exe 等文件，它们正被这些进程占用，直接继续会失败。$\r$\n$\r$\n[是] 自动结束这些进程并继续$\r$\n[否] 我先自己退出（请从托盘图标退出），然后继续$\r$\n[取消] 退出安装" /SD IDYES IDYES guard_kill IDNO guard_done
  Quit
  guard_kill:
  nsExec::ExecToStack '{PSEXE} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rsi-stop.ps1" -Root "$INSTDIR" -Mode kill'
  Pop $0
  Pop $1
  StrCmp $0 "1" guard_done
  MessageBox MB_OK|MB_ICONSTOP "仍有 rsi-agent 进程没能退出，文件仍被占用。$\r$\n$\r$\n请从托盘图标退出 rsi-agent（或重启电脑）后再运行安装程序。" /SD IDOK
  Quit
  guard_done:
FunctionEnd"""


def _write_lock_guard(dest: Path) -> Path:
    """Materialise the process-lock probe that the installer ships in $PLUGINSDIR.

    A separate .ps1 rather than an inline command line: NSIS would have to escape quotes
    and `$` through two layers, and -EncodedCommand cannot take the -Root argument that
    this needs. `$SYSDIR` is used by the caller so a hostile PATH cannot pick another
    powershell.exe.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(LOCK_GUARD_PS1, encoding="utf-8", newline="")
    return dest


def _guard_func(lock_ps1: Path) -> str:
    """Render the guard twice (install + un.), with the .ps1 location baked in.

    `File` needs a compile-time source path, so this cannot live in a Section.
    """
    ps1 = str(lock_ps1).replace("$", "$$")
    body = GUARD_NSI.replace("{PS1}", ps1).replace("{PSEXE}", PS_EXE)
    # NSIS allows the uninstaller to call only un.-prefixed functions, so the same guard
    # is emitted under both names; the .ps1 payload is embedded in each (~1 KB).
    return (body.replace("__NAME__", "GuardRunning")
            + "\r\n" + body.replace("__NAME__", "un.GuardRunning"))


def _nsi(ver: str, out_exe: Path, entries: list[tuple[Path, str]], est_kb: int,
         lock_ps1: Path) -> str:
    """Render the installer script.

    Files are grouped by destination directory: one SetOutPath per directory, then a File
    line each. NSIS stores every File as its own compressed entry, so grouping is only about
    keeping the script readable.

    Launch target: the prebuilt Tauri shell (desktop/rsi-agent-desktop.exe) when it is in the
    payload, otherwise run.cmd. The shell is a real window (no console, no browser tab) and
    starts run.cmd hidden underneath, so it is what the shortcuts point to when present.
    """
    groups: dict[str, list[Path]] = {}
    for src, arc in entries:
        parent, _, name = arc.rpartition("/")
        groups.setdefault(parent, []).append(src)
    has_shell = any(arc == "desktop/rsi-agent-desktop.exe" for _, arc in entries)
    launch = "$INSTDIR\\desktop\\rsi-agent-desktop.exe" if has_shell else "$INSTDIR\\run.cmd"
    # the shell finds run.cmd by walking up from its own exe dir, so its "working dir" is irrelevant

    lines: list[str] = [
        "; generated by scripts/build-installer.py -- do not edit",
        "Unicode true",
        "!include \"MUI2.nsh\"",
        "!include \"FileFunc.nsh\"",
        f"Name \"{APP_NAME}\"",
        f"OutFile {_q(out_exe.resolve())}",
        f"InstallDir \"$LOCALAPPDATA\\Programs\\{APP_NAME}\"",
        f"InstallDirRegKey HKCU \"Software\\{APP_NAME}\" \"InstallDir\"",
        "RequestExecutionLevel user",
        "SetCompressor /SOLID lzma",
        "SetCompressorDictSize 64",
        f"BrandingText \"{APP_NAME} {ver}\"",
        "VIProductVersion \"" + (ver + ".0" if ver.count(".") == 2 else ver) + "\"",
        f"VIAddVersionKey /LANG=2052 \"ProductName\" \"{APP_NAME}\"",
        f"VIAddVersionKey /LANG=2052 \"ProductVersion\" \"{ver}\"",
        f"VIAddVersionKey /LANG=2052 \"FileVersion\" \"{ver}\"",
        f"VIAddVersionKey /LANG=2052 \"FileDescription\" \"{APP_NAME} 安装程序\"",
        f"VIAddVersionKey /LANG=2052 \"LegalCopyright\" \"{APP_NAME}\"",
        "",
        "!define MUI_ABORTWARNING",
        f"!define MUI_FINISHPAGE_RUN \"{launch}\"",
        "!define MUI_FINISHPAGE_RUN_TEXT \"立即启动 rsi-agent\"",
        "!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp",
        "!insertmacro MUI_PAGE_WELCOME",
        "!insertmacro MUI_PAGE_DIRECTORY",
        "!insertmacro MUI_PAGE_INSTFILES",
        "!insertmacro MUI_PAGE_FINISH",
        "!insertmacro MUI_LANGUAGE \"SimpChinese\"",
        "!insertmacro MUI_LANGUAGE \"English\"",
        "",
        "Function LaunchApp",
        "  ; must exec the SAME target as the shortcuts: a function overrides MUI_FINISHPAGE_RUN,",
        "  ; so hard-coding run.cmd here silently reopens the console even when the shell is bundled",
        f"  ExecShell \"open\" \"{launch}\" \"\" SW_SHOWNORMAL",
        "FunctionEnd",
        "",
        "__GUARD__",
        "Section \"Install\" SecInstall",
        "  Call GuardRunning",
        "  SetOutPath \"$INSTDIR\"",
        "  WriteUninstaller \"$INSTDIR\\uninstall.exe\"",
    ]
    for parent in sorted(groups):
        sub = "" if not parent else "\\" + parent.replace("/", "\\")
        lines.append(f"  SetOutPath \"$INSTDIR{sub}\"")
        for src in sorted(groups[parent]):
            lines.append(f"  File {_q(src)}")
    lines += [
        "",
        "  CreateDirectory \"$SMPROGRAMS\\rsi-agent\"",
        "  ; CreateShortCut args: link, target, params, icon, icon_index, start_options,",
        "  ; keyboard_shortcut, description (SW_SHOWNORMAL belongs in start_options)",
        "  CreateShortCut \"$SMPROGRAMS\\rsi-agent\\rsi-agent.lnk\" \"" + launch + "\" \"\" "
        f"\"{launch}\" 0 SW_SHOWNORMAL \"\" \"rsi-agent\"",
        "  CreateShortCut \"$DESKTOP\\rsi-agent.lnk\" \"" + launch + "\" \"\" "
        f"\"{launch}\" 0 SW_SHOWNORMAL \"\" \"rsi-agent\"",
        "",
        f"  WriteRegStr HKCU \"Software\\{APP_NAME}\" \"InstallDir\" \"$INSTDIR\"",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"DisplayName\" \"{APP_NAME}\"",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"DisplayVersion\" \"{ver}\"",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"DisplayIcon\" \"$INSTDIR\\runtime\\target\\release\\react-agent-host.exe\"",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"InstallLocation\" \"$INSTDIR\"",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"Publisher\" \"{APP_NAME}\"",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"UninstallString\" '\"$INSTDIR\\uninstall.exe\"'",
        f"  WriteRegStr HKCU \"{UNINST_KEY}\" \"QuietUninstallString\" '\"$INSTDIR\\uninstall.exe\" /S'",
        f"  WriteRegDWORD HKCU \"{UNINST_KEY}\" \"NoModify\" 1",
        f"  WriteRegDWORD HKCU \"{UNINST_KEY}\" \"NoRepair\" 1",
        f"  WriteRegDWORD HKCU \"{UNINST_KEY}\" \"EstimatedSize\" {est_kb}",
        "SectionEnd",
        "",
        "Section \"Uninstall\"",
        "  Call un.GuardRunning",
        "  Delete \"$DESKTOP\\rsi-agent.lnk\"",
        "  Delete \"$SMPROGRAMS\\rsi-agent\\rsi-agent.lnk\"",
        "  RMDir \"$SMPROGRAMS\\rsi-agent\"",
        "  ; generated trees only -- config.json / .rsi / ledger / outputs are the user's",
        "  RMDir /r \"$INSTDIR\\runtime\"",
        "  RMDir /r \"$INSTDIR\\runtime-env\"",
        "  RMDir /r \"$INSTDIR\\scripts\"",
        "  RMDir /r \"$INSTDIR\\skills\"",
        "  RMDir /r \"$INSTDIR\\desktop\"",
        "  Delete \"$INSTDIR\\run.cmd\"",
        "  Delete \"$INSTDIR\\release.cmd\"",
        "  Delete \"$INSTDIR\\README.md\"",
        "  Delete \"$INSTDIR\\config.example.json\"",
        "  Delete \"$INSTDIR\\manifest.json\"",
        "  Delete \"$INSTDIR\\uninstall.exe\"",
        "  ; gateway cli lives in bin/ (setup-only, never in the app update zip)",
        "  RMDir /r \"$INSTDIR\\bin\\\"",
        "  ; non-recursive: keeps the folder (and the data in it) when the user still has files",
        "  RMDir \"$INSTDIR\"",
        f"  DeleteRegKey HKCU \"{UNINST_KEY}\"",
        f"  DeleteRegKey HKCU \"Software\\{APP_NAME}\"",
        "SectionEnd",
        "",
    ]
    return "\r\n".join(lines).replace("__GUARD__", _guard_func(lock_ps1))


def _manifest_entries(ver: str, n_files: int) -> list[tuple[Path, str]]:
    """The two manifest files the app zip carries, materialised for the installer payload.

    They are what makes the update chain work at all:
      - <root>/manifest.json               -> scripts/update_check.py current_version()
      - <exe>/web-dist/vendor/manifest.json -> frontend banner (app-update.js)
    Without them an installed tree has no .git to `git describe` and no version endpoint,
    so `current` is "unknown" and the banner stays silent forever.
    """
    meta_dir = WORK / f"meta-{ver}"
    root_dir = meta_dir / "root"
    web_dir = meta_dir / "vendor"
    root_dir.mkdir(parents=True, exist_ok=True)
    web_dir.mkdir(parents=True, exist_ok=True)
    # both files must be NAMED manifest.json: NSIS `File` installs under the source basename,
    # so the only way to control the destination name is the source file's own name
    root_manifest = root_dir / "manifest.json"
    root_manifest.write_text(json.dumps({
        "name": APP_NAME, "version": ver, "platform": "win", "kind": "installer",
        "files": n_files, "git_head": bundle._git("rev-parse", "--short", "HEAD").strip(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    web_manifest = web_dir / "manifest.json"
    web_manifest.write_text(json.dumps({"version": ver}, indent=2), encoding="utf-8")
    return [(root_manifest, "manifest.json"),
            (web_manifest, bundle.WEB_DIST_DST + "vendor/manifest.json")]


def build(out_dir: Path, ver: str, bin_dir: Path | None, with_env: bool = True) -> Path:
    # absolute: makensis resolves relative File paths against the .nsi location
    # (.scratch/nsis-work), not the cwd, so a relative --bin-dir silently matches nothing
    entries = bundle.app_entries(ver, bin_dir.resolve() if bin_dir else None)
    if with_env:
        entries += bundle.env_entries()
    entries += _manifest_entries(ver, len(entries) + 2)
    if with_env:
        # local gateway CLI: setup.exe only (64 MB -- an in-app app update must not re-pull it).
        # First %USERPROFILE%\.local\bin copy, then PATH; found by neither -> package without it.
        cli = _find_gateway_cli()
        if cli is not None:
            entries.append((cli, "bin/magpie.exe"))
        else:
            print("[installer] gateway CLI not found; one-click gateway start will be unavailable "
                  "(install magpie or set MAGPIE_EXE)")
    # desktop shell: setup.exe only, for the same reason plus a harder one -- a running shell
    # holds its own image locked, so an in-app update could never overwrite it.
    shell = REPO / "desktop/rsi-agent-desktop.exe"
    if any(arc == "desktop/rsi-agent-desktop.exe" for _, arc in entries):
        pass  # bundle.app_entries() already carries it (0.1.32+); do not list it twice
    elif shell.is_file():
        entries.append((shell, "desktop/rsi-agent-desktop.exe"))
    else:
        print("[installer] desktop shell not built; shortcuts fall back to run.cmd "
              "(cargo build --release --manifest-path desktop/Cargo.toml, then copy the exe)")
    est_kb = sum(src.stat().st_size for src, _ in entries) // 1024
    out_dir.mkdir(parents=True, exist_ok=True)
    out_exe = out_dir / f"{APP_NAME}-{ver}-setup.exe"
    WORK.mkdir(parents=True, exist_ok=True)
    nsi = WORK / f"{APP_NAME}-{ver}.nsi"
    lock_ps1 = _write_lock_guard(WORK / "rsi-stop.ps1")
    # utf-8-sig: with `Unicode true`, makensis only accepts UTF-8 when the file starts with a
    # BOM -- without it any non-ASCII File path (Chinese skill/output names are all over this
    # repo) fails as "Bad text encoding".
    nsi.write_text(_nsi(ver, out_exe, entries, est_kb, lock_ps1), encoding="utf-8-sig", newline="")
    makensis = ensure_makensis()
    print(f"[installer] {len(entries)} files, {est_kb / 1024:.1f} MB payload -> {out_exe.name}")
    r = subprocess.run([str(makensis), "/V2", str(nsi)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    tail = (r.stdout or "").strip().splitlines()[-6:]
    for line in tail:
        print(f"[installer]   {line}")
    if r.returncode != 0 or not out_exe.is_file():
        print((r.stderr or "")[-2000:], file=sys.stderr)
        raise SystemExit(f"[installer] makensis failed (rc={r.returncode})")
    digest = hashlib.sha256(out_exe.read_bytes()).hexdigest()
    (out_exe.with_name(out_exe.name + ".sha256")).write_text(
        f"{digest}  {out_exe.name}\n", encoding="utf-8")
    print(f"[installer] OK {out_exe}  ({out_exe.stat().st_size / 1e6:.1f} MB, sha256 {digest[:12]}...)")
    return out_exe


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="build the rsi-agent one-click installer")
    ap.add_argument("--out", default=str(REPO / "outputs"))
    ap.add_argument("--version", default=None, help="override version (default: latest git tag)")
    ap.add_argument("--bin-dir", default=None, help="dir with react-agent-host.exe + sandbox-run.exe")
    ap.add_argument("--skip-env", action="store_true",
                    help="leave out runtime-env (dev build; the result needs system python/node)")
    ns = ap.parse_args(argv)
    build(Path(ns.out), ns.version or bundle.version(),
          Path(ns.bin_dir) if ns.bin_dir else None, with_env=not ns.skip_env)
    return 0


if __name__ == "__main__":
    sys.exit(main())

