"""IM 会话可读元数据：供电脑端侧栏按平台分组展示。

写入 <repo>/im-gateway/data/im-sessions.json（网关可控、非受保护路径）。
host 经 GET /api/im/sessions 只读消费；本模块不依赖 host 侧任何代码。

契约：
  { "<session_id>": {
      "platform": "qq" | "dingtalk" | ...,
      "chat_id":   "<群/频道/会话标识>",
      "user_id":   "<发送者标识>",
      "last_ts":   <毫秒时间戳>
  } }

只保留最近 MAX_SESSIONS 条（按 last_ts 倒序），避免文件无限增长。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .envelope import Envelope
from .session import safe_session_key

# im-gateway/im_gateway/session_meta.py → parents[1] = im-gateway/
_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
_META_FILE = _DATA_DIR / "im-sessions.json"
MAX_SESSIONS = 200


def meta_path() -> Path:
    """允许测试替换；生产固定指向 im-gateway/data/im-sessions.json。"""
    return _META_FILE


def record(env: Envelope, *, now_ms: int | None = None) -> str:
    """记录一条入站消息对应的会话元数据，返回 session_id。

    写入失败（磁盘只读等）不影响网关主流程——元数据只是展示增强。
    """
    sid = safe_session_key(env.platform, env.chat_id, env.user_id)
    ts = int(now_ms if now_ms is not None else time.time() * 1000)
    data = _load()
    data[sid] = {
        "platform": env.platform,
        "chat_id": env.chat_id,
        "user_id": env.user_id,
        "last_ts": ts,
    }
    if len(data) > MAX_SESSIONS:
        keep = sorted(data, key=lambda k: data[k].get("last_ts", 0), reverse=True)[:MAX_SESSIONS]
        data = {k: data[k] for k in keep}
    _save(data)
    return sid


def _load() -> dict[str, dict[str, Any]]:
    path = meta_path()
    try:
        with path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, dict)}


def _save(data: dict[str, dict[str, Any]]) -> None:
    path = meta_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        # 展示元数据非关键路径：写失败静默，绝不拖垮入站消息处理。
        pass


def list_sessions() -> dict[str, dict[str, Any]]:
    """读回全部会话元数据（host 侧接口/test 用）。"""
    return _load()
