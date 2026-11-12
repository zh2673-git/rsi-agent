# rsi-agent v0.0.18

三件遗留闭环。都不是新功能，是把上一轮明确留下的口子补上。

## 1. 88 条漂移补丁：每条都有去向，不再悬空

上一轮把补丁链里「锚点相对上游已漂移」的 88 条明确排到本版，理由是「重写锚点错误率高于收益」。这版逐条核对后，结论比原判更清楚——**它们不是一个待办，是三个不同的问题**：

| 桶 | 条数 | 判定 | 处置 |
|---|---:|---|---|
| 上游已含等价改动 | 16 | 补丁的「新增行」100% 已存在于 react-agent 上游，**且**已存在于本地 runtime | 退休到 `retired/`，零行为变化 |
| 发行形态专属 | 72 | 目标改动本身就是发行形态里唯一的定义（看板/画像/灵感/发布/自更新/账号签到），上游没有对应物 | 留本地 |

关键判据不是「描述里有没有看板字样」，而是**补丁新增的每一行是否已在上游目标文件里**。按这个判据，16 条的重放等于第三次写同样的东西——纯冗余。

补丁链：213 → 197（退休 16）+ 4 条 NW18 = **201 条 active**，`--dry-run` 209 项全 OK、0 FAIL、0 ANCHOR-MISS。

## 2. 5 个技能补齐验收段

`skill_validate --all` 原先对 `content-publish` / `git-ops` / `make-video` / `memory-recall` / `trace-analysis` 报 `E_ACCEPTANCE_MISSING`。现全部补上，且不是加个标题了事——每节写可机检的判据、每条附「怎么核」、并显式列出反例：

- **memory-recall**：条数 ≤5 且每条带路径、注入 ≤25KB、密钥零明文（给了自检 grep）、对三处禁写路径零改动。
- **trace-analysis**：零新建探针脚本、stdout 是单个可解析 JSON 且无 traceback、数字能交叉复算（`toolmix` 各项之和 = `summary` 的 calls）、trace 只读。
- **git-ops**：暂存即所想（**未用 `git add -A`**）、`git diff --cached` 密钥零命中、一笔一事、`git log origin/main..HEAD` 为空。
- **content-publish**：先 status 后动手、干跑先于真发、二维码是展示不是路径、按平台列结果、零凭证落盘。
- **make-video**：8 条出片前逐条打勾（内容门零 error / 真在用 LLM / 逐镜原创 / 切点有动机 / 机位合规 / 素材可溯 / 换声逐字对 / 现场可追）。

现 `skill_validate --all` **零 error**。

## 3. `cargo test` 不再往仓库写 `.rsi/turns`

### 现象

跑一次测试，仓库里就长出几十个 `.rsi/turns/*.json`。更麻烦的是它**看不见**——`.gitignore` 已经忽略 `.rsi/`，所以 `git status` 干净、review 也发现不了。

### 根因

`agent-loop` 的 `turn::turns_root()` 是三级回落：

```
RSI_TURNS_DIR → RSI_HOME → WORKSPACE_ROOT → cwd
```

测试进程里前三个都没设置，于是落到 `cwd/.rsi/turns`，而 cwd 正是 crate 目录。**任何** dispatch 一次 `chat` 的用例都会触发。这不是某个用例的疏忽，是测试没隔离数据根。

### 修法

在两个**共同入口**各挂一次隔离，而不是逐用例插桩：

| 挂点 | 覆盖 |
|---|---|
| `host/tests/common/mod.rs` → `fresh_kernel()` 内 | 全部 host e2e |
| `agent-loop/tests/react_mocks.rs` → `boot()` 内 | 全部 69 个用例 |
| `contract_conformance.rs` 两处 `AGENT_STREAM_DIR` 旁 | 该文件 2 个 chat 用例 |

`isolate_turns_dir()` 用 `OnceLock` 做进程级幂等，把落点钉到临时目录。

**为什么不逐用例插**：`env` 是进程全局的，逐处插入既容易漏，也会让同一进程内不同用例各自设不同目录互相踩。共同入口各挂一次，后续新增用例自动覆盖。

同步到上游 react-agent **v0.1.25**（commit `3e4037b`）。

## 验证

```
runtime cargo test         # 19 binary, 159 passed, 0 failed
dir /s /b /ad .rsi crates\agent-loop\.rsi crates\host\.rsi
# File Not Found ×3
apply-tool-patches --dry-run  # 201 条 active, 209 项 OK, 0 FAIL
skill_validate --all          # ok: true, errors: []
```

## 补丁链现状

- active：**201** 条（原 213，退休 16 条冗余，新增 4 条 NW18）
- `retired/`：102 条
- 全部 `--dry-run` 通过，无待应用项
