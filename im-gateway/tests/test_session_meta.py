import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from im_gateway import session_meta  # noqa: E402
from im_gateway.envelope import Envelope  # noqa: E402


def _env(platform="qq", chat="g1", user="u1", msg="m1"):
    return Envelope(platform=platform, msg_id=msg, chat_id=chat, user_id=user, text="hi")


@pytest.fixture
def meta_file(tmp_path, monkeypatch):
    p = tmp_path / "im-sessions.json"
    monkeypatch.setattr(session_meta, "_META_FILE", p)
    monkeypatch.setattr(session_meta, "meta_path", lambda: p)
    return p


def test_record_and_list(meta_file):
    sid = session_meta.record(_env(), now_ms=1000)
    assert sid.startswith("qq-")
    sessions = session_meta.list_sessions()
    assert sessions[sid]["platform"] == "qq"
    assert sessions[sid]["chat_id"] == "g1"
    assert sessions[sid]["user_id"] == "u1"
    assert sessions[sid]["last_ts"] == 1000


def test_record_updates_last_ts(meta_file):
    sid = session_meta.record(_env(), now_ms=1000)
    session_meta.record(_env(msg="m2"), now_ms=2000)
    sessions = session_meta.list_sessions()
    assert len(sessions) == 1
    assert sessions[sid]["last_ts"] == 2000


def test_record_platform_prefix(meta_file):
    qq = session_meta.record(_env(platform="qq", chat="c", user="u"), now_ms=1)
    dt = session_meta.record(_env(platform="dingtalk", chat="c", user="u"), now_ms=2)
    assert qq.startswith("qq-")
    assert dt.startswith("dt-")
    sessions = session_meta.list_sessions()
    assert sessions[qq]["platform"] == "qq"
    assert sessions[dt]["platform"] == "dingtalk"


def test_corrupt_file_is_treated_as_empty(meta_file):
    meta_file.write_text("{bad json", encoding="utf-8")
    assert session_meta.list_sessions() == {}


def test_max_sessions_trims_oldest(meta_file, monkeypatch):
    monkeypatch.setattr(session_meta, "MAX_SESSIONS", 2)
    session_meta.record(_env(chat="a"), now_ms=1000)
    session_meta.record(_env(chat="b"), now_ms=2000)
    session_meta.record(_env(chat="c"), now_ms=3000)
    sessions = session_meta.list_sessions()
    assert len(sessions) == 2
    assert all(v["last_ts"] >= 2000 for v in sessions.values())
