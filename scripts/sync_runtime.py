"""Report (and only on request apply) changes from the sibling react-agent repo.

rsi-agent's runtime/ is the single source of truth since v0.1.26: edits are made
here and NOT overwritten at startup. This script is now a pull-only tool:

  1. Default / --dry-run: print what upstream still differs in, write nothing.
  2. --force (or env RSI_SYNC_FORCE=1): actually pull upstream into runtime/,
     keep the rsi-agent-only trees, re-apply core patches, save the stamp.

A failing sync must never break startup: any error -> warn and exit 0, the
existing runtime/ keeps working.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RUNTIME = REPO / "runtime"
STAMP = RUNTIME / ".sync-stamp"
UPSTREAM = Path(os.environ["RSI_SYNC_UPSTREAM"]) if os.environ.get("RSI_SYNC_UPSTREAM") else REPO.parent / "react-agent"
# rsi-agent-only trees: never overwritten by react-agent
KEEP_LOCAL = ("kernel", "plugins/assets")
# path-class files: both repos are correct for their own layout (react-agent
# points at the sibling agent-kernel checkout; rsi-agent embeds runtime/kernel).
# Taking upstream here breaks the plugin. NEVER sync these.
KEEP_FILES = ("plugins/memory/guest_sdk.ts",)


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(
        ["git", "-c", "core.quotepath=false", *args],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git {' '.join(args)} failed")
    return r.stdout


def upstream_head() -> str:
    return _git(UPSTREAM, "rev-parse", "HEAD").strip()


def tracked_files() -> list[str]:
    out = _git(UPSTREAM, "ls-files", "crates", "plugins", "Cargo.toml", "Cargo.lock")
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def _skip(rel: str) -> bool:
    return rel in KEEP_FILES or any(rel.startswith(k + "/") for k in KEEP_LOCAL)


def plan() -> tuple[str, list[tuple[Path, Path]], int]:
    """Return (head, [(src, dst)...] to copy, files_to_delete_count)."""
    head = upstream_head()
    copies: list[tuple[Path, Path]] = []
    deletes = 0
    for rel in tracked_files():
        if _skip(rel):
            continue
        src, dst = UPSTREAM / rel, RUNTIME / rel
        if not dst.exists() or not _same(src, dst):
            copies.append((src, dst))
    deletes = len(_stale_tracked())
    return head, copies, deletes


def _norm(data: bytes) -> bytes:
    """Compare text ignoring CRLF/LF: the two repos check out with different
    autocrlf settings, and a line-ending-only rewrite would make the release
    stamp think the code changed -> a full rebuild on every sync."""
    return data.replace(b"\r\n", b"\n")


def _same(a: Path, b: Path) -> bool:
    try:
        return _norm(a.read_bytes()) == _norm(b.read_bytes())
    except OSError:
        return False


def _stale_tracked() -> list[Path]:
    """Files we copied last time but upstream no longer has."""
    manifest = RUNTIME / ".sync-manifest"
    if not manifest.exists():
        return []
    out = []
    for rel in manifest.read_text(encoding="utf-8").splitlines():
        if rel.strip() and not (UPSTREAM / rel).exists():
            out.append(RUNTIME / rel)
    return out


def apply(copies: list[tuple[Path, Path]]) -> None:
    for src, dst in copies:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    for p in _stale_tracked():
        p.unlink(missing_ok=True)
    (RUNTIME / ".sync-manifest").write_text(
        "\n".join(r for r in tracked_files() if not _skip(r)) + "\n", encoding="utf-8"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="pull runtime/ from sibling react-agent (only with --force)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing (default)")
    ap.add_argument("--force", action="store_true",
                    help="actually copy upstream into runtime/ (default: report only)")
    ns = ap.parse_args(argv)
    force = ns.force or os.environ.get("RSI_SYNC_FORCE") == "1"
    try:
        if not UPSTREAM.exists():
            print("[sync] sibling react-agent not found; skip")
            return 0
        head, copies, deletes = plan()
        stamp = STAMP.read_text(encoding="utf-8").strip() if STAMP.exists() else ""
        if head == stamp and not copies and not deletes:
            print(f"[sync] runtime/ already at react-agent {head[:7]}")
            return 0
        print(f"[sync] react-agent {head[:7]} (local stamp {stamp[:7] or 'never'}): "
              f"{len(copies)} file(s) differ, {deletes} stale")
        if ns.dry_run or not force:
            for src, dst in copies:
                print(f"  {dst.relative_to(REPO)}")
            if not ns.dry_run:
                print("[sync] report only: runtime/ is the source of truth, nothing was written. "
                      "Use --force to pull upstream.")
            return 0
        apply(copies)
        STAMP.write_text(head, encoding="utf-8")
        rc = subprocess.run([sys.executable, str(REPO / "scripts" / "apply-tool-patches.py")],
                            cwd=REPO).returncode
        warn = "" if rc == 0 else " -- WARN: core patches failed to re-apply, see console above"
        print(f"[sync] runtime/ synced to react-agent {head[:7]}; rebuild needed{warn}")
        return 0
    except Exception as e:  # never break startup
        print(f"[sync] skipped: {e}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
