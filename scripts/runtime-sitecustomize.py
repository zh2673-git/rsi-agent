"""Restore sys.path[0] for the embeddable CPython that ships in runtime-env/.

Why this file exists
-------------------
The embeddable distro runs in *isolated* mode as soon as a `pythonXY._pth` file is present:
sys.path becomes exactly the entries listed there, and the usual "prepend the script's own
directory" step is skipped. That breaks every plugin and script that imports a sibling module:

    runtime/plugins/llm_adapter/llm_plugin.py   ->  from providers.registry import resolve
    runtime/plugins/assets/assets_plugin.py     ->  from skillkit import parse_frontmatter
    runtime/plugins/tools/tools_plugin.py       ->  from tools import ToolError

With a normal CPython install those work because `python <file>` puts <file>'s directory at
sys.path[0]. This module puts it back, so the bundled interpreter behaves like a normal one
while keeping the ._pth (which is what makes Lib\\site-packages importable at all -- and the
._pth cannot be dropped, because then PYTHONPATH would have to carry site-packages, and the
host runs many scripts with PYTHONPATH unset).

Loaded automatically by `site` (sitecustomize is imported from sys.path when `import site`
is listed in the ._pth). Nothing here is project specific -- it only mirrors CPython's
default path setup.
"""
import os
import sys


def _restore_script_dir() -> None:
    argv0 = sys.argv[0] if sys.argv else ""
    # "" / "-c" / "-m": interactive or module mode, where CPython would add the cwd instead
    if not argv0 or argv0 in ("-c", "-m") or argv0.startswith("-"):
        if "" not in sys.path:
            sys.path.insert(0, "")
        return
    here = os.path.dirname(os.path.abspath(argv0))
    if here and here not in sys.path:
        sys.path.insert(0, here)


try:
    _restore_script_dir()
except Exception:  # never let path fixing break an interpreter startup
    pass
