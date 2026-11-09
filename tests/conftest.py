"""测试会话的全局隔离：**测试永远不许写进真实账本**。

为什么需要它（实测事故）：本机 agent 进程把 `RSI_HOME`（代码根）设在环境里，
而 `board.py::data_root()` 的判定顺序是 `RSI_HOME` -> `WORKSPACE_ROOT`。
于是每个用例 `WORKSPACE_ROOT=<tempdir>` 之后仍然命中 `RSI_HOME`，
`task-upsert` 全部落进 `rsi-agent/.rsi/board.json` —— 一次全量跑把 34 条
「并发任务0」「测试任务」写进了用户的真实看板（任务号被占到 T-20261109-44）。

判定：用例要造数据，必须造在临时目录里。所以会话开始就把这两个变量摘掉，
让 `data_root()` 退到用例自己设的 `WORKSPACE_ROOT`。
需要 `RSI_HOME` 语义的用例（`test_board_contract`、`test_secretary`）
都在自己的 `env` 字典里显式给值，不依赖继承——摘掉不影响它们。
"""
from __future__ import annotations

import os

# 必须在任何用例导入 scripts/board.py 之前生效，故写在模块顶层。
for _k in ("RSI_HOME", "RSI_BOARD_PATH"):
    os.environ.pop(_k, None)
