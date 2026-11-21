"""网关入口：按配置启动钉钉/QQ 适配器。

用法（在仓库根目录）：
    python im-gateway/run.py                # 按 config.local.json / 环境变量开关启动
    python im-gateway/run.py --platform dingtalk
    python im-gateway/run.py --platform qq
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# 让 `python im-gateway/run.py` 能 import im_gateway 包
sys.path.insert(0, str(Path(__file__).resolve().parent))

from im_gateway.config import GatewayConfig  # noqa: E402
from im_gateway.core import GatewayCore  # noqa: E402
from im_gateway.host_client import HostClient  # noqa: E402


async def _run_platform(platform: str, cfg: GatewayConfig, core: GatewayCore) -> None:
    if platform == "dingtalk":
        from im_gateway.adapters import dingtalk
        await asyncio.to_thread(dingtalk.run, cfg, core)
    elif platform == "qq":
        from im_gateway.adapters import qq
        await asyncio.to_thread(qq.run, cfg, core)
    else:
        raise ValueError(f"未知平台: {platform}")


async def amain(cfg: GatewayConfig, platforms: list[str]) -> None:
    core = GatewayCore(cfg, HostClient(cfg.host_base, cfg.chat_timeout_secs))
    print("[gw] config:", cfg.redacted(), flush=True)
    if len(platforms) == 1:
        await _run_platform(platforms[0], cfg, core)
        return
    # 多平台并发运行
    await asyncio.gather(*(_run_platform(p, cfg, core) for p in platforms))


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
        asyncio.run(amain(cfg, platforms))
    except KeyboardInterrupt:
        print("[gw] stopped", flush=True)


if __name__ == "__main__":
    main()
