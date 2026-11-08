"""安装内容分发执行体：把上游 social-auto-upload（sau）装进 tools/sau。

为什么需要这个脚本：
  tools/sau 不入库（venv 262MB + 各平台登录态 cookie），换台机器 / 清仓后必须能一条命令重建。
  装法本身踩过两个国内环境的坑（pypi 直连超时、patchright 下不到 chromium-1208），
  写死在这里比写在文档里可靠——文档会被跳过，脚本会被运行。

用法（在工作区根执行）：
  python scripts/install_sau.py            # 装 / 重装
  python scripts/install_sau.py --check    # 只体检，不动手

退出码：0 = 就绪；1 = 未就绪（会打印下一步该做什么）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SAU_DIR = REPO / "tools" / "sau"
VENV = SAU_DIR / ".venv"
SAU_EXE = VENV / ("Scripts/sau.exe" if os.name == "nt" else "bin/sau")

# 上游项目（MIT）。国内直连 github 会超时，走 gh-proxy 镜像。
UPSTREAM = "https://github.com/dreammis/social-auto-upload"
ZIP_URLS = [
    "https://gh-proxy.com/https://github.com/dreammis/social-auto-upload/archive/refs/heads/main.zip",
    "https://ghfast.top/https://github.com/dreammis/social-auto-upload/archive/refs/heads/main.zip",
    "https://github.com/dreammis/social-auto-upload/archive/refs/heads/main.zip",
]

# 国内 pypi 直连超时（实测 15s 无响应），阿里云镜像 1.76s 装完依赖
PIP_INDEX = os.environ.get("UV_DEFAULT_INDEX", "https://mirrors.aliyun.com/pypi/simple/")

CHROME_CANDIDATES = [
    r"C:/Program Files/Google/Chrome/Application/chrome.exe",
    r"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe"),
]


def log(msg: str) -> None:
    print(f"[sau] {msg}", flush=True)


def find_chrome() -> str | None:
    """系统 Chrome。用来绕开 patchright 的 chromium-1208 下载（国内 CDN 拿不到）。"""
    for p in CHROME_CANDIDATES:
        if p and Path(p).is_file():
            return p.replace("\\", "/")
    found = shutil.which("chrome") or shutil.which("chrome.exe")
    return found.replace("\\", "/") if found else None


def write_conf() -> str | None:
    """写 conf.py。返回 Chrome 路径（None = 没找到，需要用户自己装 Chrome）。"""
    chrome = find_chrome()
    conf = SAU_DIR / "conf.py"
    body = [
        "from pathlib import Path",
        "",
        "BASE_DIR = Path(__file__).parent.resolve()",
        'XHS_SERVER = "http://127.0.0.1:11901"  # only used by xhs-related flows',
    ]
    if chrome:
        body += [
            f'LOCAL_CHROME_PATH = "{chrome}"'
            "  # 系统 Chrome，绕开 patchright chromium-1208 下载",
            "LOCAL_CHROME_HEADLESS = True  # 无可见窗口：扫码时二维码落成本地图片",
            "DEBUG_MODE = True",
            "YT_PROXY = None",
        ]
    # 没有 Chrome 就不写 LOCAL_CHROME_PATH，让 patchright 走它自己的 chromium（能下到就能用）
    conf.write_text("\n".join(body) + "\n", encoding="utf-8")
    return chrome


def download_upstream() -> None:
    """取上游源码到 tools/sau（已存在则跳过）。"""
    if (SAU_DIR / "sau_cli.py").is_file():
        log(f"上游源码已在 {SAU_DIR.relative_to(REPO)}，跳过下载")
        return
    SAU_DIR.parent.mkdir(parents=True, exist_ok=True)
    tmp = SAU_DIR.parent / "_sau.zip"
    last_err = ""
    for url in ZIP_URLS:
        log(f"下载 {url}")
        try:
            # urllib 比 requests 少一层依赖；超时给足（镜像冷启动慢）
            import urllib.request

            with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as f:
                shutil.copyfileobj(r, f)
            log(f"下载完成 {tmp.stat().st_size / 1048576:.1f} MB")
            break
        except Exception as e:  # noqa: BLE001 - 逐个镜像试，最后统一报错
            last_err = f"{type(e).__name__}: {e}"
            log(f"失败：{last_err}")
    else:
        raise SystemExit(f"所有镜像都下不到上游源码：{last_err}\n  → 手动 clone {UPSTREAM} 到 tools/sau 后重跑")

    with zipfile.ZipFile(tmp) as z:
        root = z.namelist()[0].split("/")[0]
        z.extractall(SAU_DIR.parent / "_sau_tmp")
    src = SAU_DIR.parent / "_sau_tmp" / root
    shutil.move(str(src), str(SAU_DIR))
    shutil.rmtree(SAU_DIR.parent / "_sau_tmp", ignore_errors=True)
    tmp.unlink(missing_ok=True)
    log(f"已解压到 {SAU_DIR.relative_to(REPO)}")


def build_venv() -> None:
    if SAU_EXE.is_file():
        log(f"venv 已存在：{SAU_EXE.relative_to(REPO)}，跳过创建")
        return
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("未找到 uv。先装 uv：https://docs.astral.sh/uv/  （或 pip install uv）")
    log("创建 venv（python 3.11）")
    subprocess.run([uv, "venv", "--python", "3.11", str(VENV)], check=True, cwd=SAU_DIR)
    py = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    log(f"安装依赖（index={PIP_INDEX}）")
    env = dict(os.environ, UV_DEFAULT_INDEX=PIP_INDEX)
    subprocess.run(
        [uv, "pip", "install", "--python", str(py), "-e", "."],
        check=True,
        cwd=SAU_DIR,
        env=env,
    )


def check() -> int:
    """体检：只报事实，不修。返回 0 = 就绪。"""
    ok = True
    if not (SAU_DIR / "sau_cli.py").is_file():
        log(f"✗ 上游源码缺失：{SAU_DIR.relative_to(REPO)}")
        ok = False
    if not SAU_EXE.is_file():
        log(f"✗ sau 入口缺失：{SAU_EXE.relative_to(REPO)}")
        ok = False
    if not (SAU_DIR / "conf.py").is_file():
        log("✗ conf.py 缺失")
        ok = False
    elif not find_chrome() and "LOCAL_CHROME_PATH" not in (SAU_DIR / "conf.py").read_text("utf-8"):
        log("! 未找到系统 Chrome，patchright 将尝试下载 chromium-1208（国内常失败）")
    if ok:
        r = subprocess.run([str(SAU_EXE), "--help"], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            log(f"✗ sau --help 失败：{r.stderr.strip()[:400]}")
            ok = False
        else:
            log(f"✓ sau 可用：{SAU_EXE.relative_to(REPO)}")
    log("就绪" if ok else "未就绪 —— 运行 python scripts/install_sau.py 安装")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="安装内容分发执行体（sau）")
    ap.add_argument("--check", action="store_true", help="只体检，不安装")
    args = ap.parse_args()
    if args.check:
        return check()

    download_upstream()
    chrome = write_conf()
    if chrome:
        log(f"conf.py 使用系统 Chrome：{chrome}")
    else:
        log("! 未找到系统 Chrome —— 请装 Chrome，或让 patchright 自备 chromium")
    build_venv()
    return check()


if __name__ == "__main__":
    sys.exit(main())
