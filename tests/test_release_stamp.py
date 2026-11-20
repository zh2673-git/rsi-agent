"""Tests for scripts/release_stamp.py - release 启动变更检测。"""
from __future__ import annotations

import os
from pathlib import Path

from scripts import release_stamp as rs


def _fake_repo(tmp_path: Path) -> Path:
    (tmp_path / "runtime" / "crates" / "host" / "src").mkdir(parents=True)
    (tmp_path / "runtime" / "plugins" / "data").mkdir(parents=True)
    (tmp_path / "runtime" / "Cargo.lock").write_text("x", encoding="utf-8")
    (tmp_path / "runtime" / "crates" / "host" / "src" / "main.rs").write_text("fn main(){}", encoding="utf-8")
    # 运行时数据文件：不应纳入指纹
    (tmp_path / "runtime" / "plugins" / "data" / "session.index.json").write_text("{}", encoding="utf-8")
    return tmp_path


def test_runtime_data_not_in_fingerprint(tmp_path):
    repo = _fake_repo(tmp_path)
    fp1 = rs._fingerprint(repo)
    data = repo / "runtime" / "plugins" / "data" / "session.index.json"
    os.utime(data, (fp1[0] + 1000, fp1[0] + 1000))
    assert rs._fingerprint(repo) == fp1, "运行时数据写入不应改变代码指纹"


def test_check_then_stamp_then_mock_unchanged(tmp_path):
    repo = _fake_repo(tmp_path)
    stamp = tmp_path / "stamp.txt"
    # 无 stamp -> 需要构建
    assert rs.main(["x", "check", str(repo), str(stamp)]) == 0
    assert rs._read_stamp(stamp) is None
    # stamp 后 -> 不变
    rs.main(["x", "stamp", str(repo), str(stamp)])
    assert rs._read_stamp(stamp) is not None
    # check 逻辑：直接比较（捕获 stdout）
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()):
        rs.main(["x", "stamp", str(repo), str(stamp)])  # 重打 stamp，隔离 check 输出
    with contextlib.redirect_stdout(buf):
        rs.main(["x", "check", str(repo), str(stamp)])
    assert buf.getvalue().strip() == "0"


def test_code_change_detected(tmp_path):
    repo = _fake_repo(tmp_path)
    stamp = tmp_path / "stamp.txt"
    rs.main(["x", "stamp", str(repo), str(stamp)])
    src = repo / "runtime" / "crates" / "host" / "src" / "main.rs"
    cur = rs._fingerprint(repo)[0]
    os.utime(src, (cur + 100, cur + 100))
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rs.main(["x", "check", str(repo), str(stamp)])
    assert buf.getvalue().strip() == "1"
