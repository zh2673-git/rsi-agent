"""网关入口：按配置启动钉钉/QQ 适配器。

用法（在仓库根目录）：
    python im-gateway/run.py                # 按 config.local.json / 环境变量开关启动
    python im-gateway/run.py --platform dingtalk
    python im-gateway/run.py --platform qq

注意：botpy / dingtalk_stream 的 run() 会在本色线程创建自己的事件循环（botpy 构造时
就调 asyncio.get_event_loop()），因此必须在主线程同步运行，不能放进 asyncio.to_thread。
多平台时用独立子进程并发，各进程各跑一个主线程。
"""
from __future__ import annotations

import argparse
import multiprocessing
import sys
from pathlib import Path

# 让 `python im-gateway/run.py` 能 import im_gateway 包
sys.path.insert(0, str(Path(__file__).resolve().parent))

from im_gateway.config import GatewayConfig  # noqa: E402
from im_gateway.core import GatewayCore  # noqa: E402
from im_gateway.host_client import HostClient  # noqa: E402


def _run_platform(platform: str) -> None:
    """在当前线程同步运行单个平台（阻塞直到该平台客户端退出）。"""
    cfg = GatewayConfig.load()
    core = GatewayCore(cfg, HostClient(cfg.host_base, cfg.chat_timeout_secs))
    print(f"[gw] start {platform}:", cfg.redacted(), flush=True)
    if platform == "dingtalk":
        from im_gateway.adapters import dingtalk
        dingtalk.run(cfg, core)
    elif platform == "qq":
        from im_gateway.adapters import qq
        qq.run(cfg, core)
    else:
        raise ValueError(f"未知平台: {platform}")


def main() -> None:
    parser = argparse.ArgumentParser(description="RSI Agent IM 网关（钉钉 + QQ）")
    parser.add_argument("--platform", choices=["dingtalk", "qq"], action="append",
                        help="只启动指定平台；可多次指定。不传则按配置开关启动全部启用的平台。")
    args = parser.parse_args()

    cfg = GatewayConfig.load()
    platforms = args.platform or []
    if not platforms:
        if cfg.enable_dingtalk:
            platforms.append("dingtalk")
        if cfg.enable_qq:
            platforms.append("qq")
    if not platforms:
        parser.error("没有启用任何平台：设置 GW_ENABLE_DINGTALK/GW_ENABLE_QQ 或用 --platform 指定")

    try:
        if len(platforms) == 1:
            _run_platform(platforms[0])
        else:
            procs = [multiprocessing.Process(target=_run_platform, args=(p,), daemon=True)
                     for p in platforms]
            for p in procs:
                p.start()
            for p in procs:
                p.join()
    except KeyboardInterrupt:
        print("[gw] stopped", flush=True)


if __name__ == "__main__":
    main()
