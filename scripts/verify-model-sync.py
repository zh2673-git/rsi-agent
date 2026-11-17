#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""模型目录一致性校验（看板 T-20261116-15 / c3 判据）。

判据：Magpie 网关 ``/v1/models`` 与 RSI Host ``/api/models`` 必须是**同一个集合**——
数量相等、逐 id 相等。二者都从 ``/v1/models`` 转发，任何差异都说明前端/后端有一处
在自行过滤或缓存了旧快照。

用法::

    python scripts/verify-model-sync.py                    # 默认网关 127.0.0.1:3425、RSI 127.0.0.1:8710
    python scripts/verify-model-sync.py --gw 3425 --rsi 8710
    python scripts/verify-model-sync.py --rsi 8711          # 校验另一个 RSI 实例

退出码：0 = 一致；1 = 不一致；2 = 连不上（当作失败，不静默跳过）。
只依赖标准库，不读任何配置文件，不改任何状态。
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import urllib.request

TIMEOUT = 20


def _get(url: str):
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:  # noqa: S310 (本机回环)
        return json.loads(r.read().decode("utf-8", "replace"))


def gw_models(port: int) -> list[str]:
    """网关 OpenAI 兼容清单：{"data": [{"id": ...}, ...]}。"""
    d = _get(f"http://127.0.0.1:{port}/v1/models")
    return [m["id"] for m in d.get("data") or []]


def rsi_models(port: int) -> list[str]:
    """RSI Host 清单：{"models": ["provider/model", ...]}（老版本可能返回 {"data": [...]}）。"""
    d = _get(f"http://127.0.0.1:{port}/api/models")
    ms = d.get("models")
    if ms is None:
        ms = [m.get("id") if isinstance(m, dict) else m for m in d.get("data") or []]
    return [m for m in ms if m]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", type=int, default=3425, help="Magpie 网关端口（默认 3425）")
    ap.add_argument("--rsi", type=int, default=8710, help="RSI Host 端口（默认 8710）")
    a = ap.parse_args()

    try:
        gw = gw_models(a.gw)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL 网关 127.0.0.1:{a.gw}/v1/models 不可达：{e}")
        return 2
    try:
        rsi = rsi_models(a.rsi)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL RSI 127.0.0.1:{a.rsi}/api/models 不可达：{e}")
        return 2

    only_gw = sorted(set(gw) - set(rsi))
    only_rsi = sorted(set(rsi) - set(gw))
    dup_rsi = [k for k, n in collections.Counter(rsi).items() if n > 1]

    print(f"网关 /v1/models : {len(gw)} 个")
    print(f"RSI  /api/models: {len(rsi)} 个")
    for prov, n in sorted(collections.Counter(m.split("/")[0] for m in gw).items()):
        print(f"  {prov}: {n}")

    ok = True
    if len(gw) != len(rsi) or only_gw or only_rsi:
        ok = False
        print(f"FAIL 集合不一致：仅网关 {len(only_gw)} 个 {only_gw[:10]}")
        print(f"     仅 RSI  {len(only_rsi)} 个 {only_rsi[:10]}")
    if dup_rsi:
        ok = False
        print(f"FAIL RSI 清单有重复 id：{dup_rsi[:10]}")
    # auto/<model> 路由组是用户的自定义入口，必须真的存在于网关清单里
    auto = [m for m in gw if m.startswith("auto/")]
    if not auto:
        ok = False
        print("FAIL 网关清单里没有任何 auto/<model> 路由组")
    print(f"auto 组: {len(auto)} 个 {auto}")

    print("OK 模型目录一致" if ok else "FAIL 模型目录不一致")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
