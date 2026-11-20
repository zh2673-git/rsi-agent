"""Silent launcher for rsi-agent desktop shell (no console window).

Invoked by the desktop shortcut via pythonw.exe. Builds the Tauri shell if
missing, then starts it detached with no visible console. Host startup is
handled by the shell itself (cmd /C run.cmd with CREATE_NO_WINDOW).
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EXE = os.path.join(HERE, "target", "debug", "rsi-agent-desktop.exe")
CARGO = os.path.join(HERE, "Cargo.toml")

# Windows: detach from any console and start a new process group.
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


def main():
    if not os.path.isfile(EXE):
        try:
            subprocess.run(
                ["cargo", "build", "--manifest-path", CARGO, "--quiet"],
                cwd=REPO,
                check=True,
                creationflags=CREATE_NO_WINDOW,
            )
        except Exception as exc:  # noqa: BLE001 - surface via abort only
            sys.exit("build failed: %s" % exc)

    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen([EXE], cwd=HERE, creationflags=flags)


if __name__ == "__main__":
    main()
