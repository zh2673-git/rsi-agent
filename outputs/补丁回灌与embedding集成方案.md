# 补丁回灌 + embedding 集成 + 三能力落地方案

> 版本：v1.0 ｜ 日期：2026-11-11 ｜ 任务：T-20261111-10
> 范围：react-agent（上游）→ rsi-agent（发行形态）两仓联动；RAG / 深度研究 / 教学三能力实施计划

---

## 0. 一句话结论

**回灌不是「把 240 条补丁搬过去」，而是「把其中 38 条真正通用的搬过去，剩下的 202 条本来就该留在 rsi-agent」。**
搬法也不是手工改上游，而是**在上游按同样顺序应用同一批补丁**——因为结果文件内容完全一致，rsi-agent 重新快照后**所有 RSI 补丁的锚点依然命中**，然后从补丁链里删掉那 38 条即可。

这个做法的关键性质：**行为零变化，补丁数净减 38 条，且可验证**（快照前后跑同一套测试）。

---

## 1. 现状实测（全部为本次实测，非引用 README）

### 1.1 两仓真实状态

| 项 | react-agent（上游） | rsi-agent（发行形态） |
|---|---|---|
| 仓库 | `D:\ZH\vibe code\skills\tool\react-agent` | `D:\ZH\vibe code\skills\tool\rsi-agent` |
| remote | `github.com/zh2673-git/react-agent` | `github.com/zh2673-git/rsi-agent` |
| 分支 / 版本 | `main` / `0.1.22` | `main` / `runtime/Cargo.toml` = `0.1.21` |
| 工作区 | 干净（0 改动） | 6 个未跟踪产物 |
| tag 数 | 22（v0.1.1 … v0.1.22） | 见 `git tag` |
| 测试设施 | `crates/agent-loop/tests/` 3 个 + `crates/host/tests/` 9 个 e2e | 同左（快照） |

**重要发现**：`runtime/Cargo.toml` 的 workspace 版本是 **0.1.21**，而 README 与快照声明是 **v0.1.22**——快照时版本号没同步。本次快照一并修正。

### 1.2 补丁链真实规模（240 条 active）

`scripts/patches/*.json` = **240** 条（另有 `blocks/*.txt` 长文本块 452 个、`retired/` 64 条、`q-round/` 47 条）。

**按「能否搬到干净上游」分桶（逐条实测锚点）：**

| 桶 | 条数 | 含义 | 处置 |
|---|---:|---|---|
| `NOFILE` | **74** | 目标文件在 react-agent **根本不存在**（`board.rs` / `profile_ctx.rs` / `turn.rs` / `app-board.js` …） | **永不回灌**，RSI 专属 |
| `MISS` | **88** | 目标文件存在，但锚点文本已被后续补丁改动（漂移） | 不可直接搬；需重写锚点才能搬 |
| `GENERIC` | **38** | 目标文件存在 **且锚点命中**，且不碰 RSI 专属文件/语义 | **本次回灌主体** |
| `RSI` | **29** | 锚点命中，但落在 RSI 专属文件或含 RSI 语义（看板/画像/发布） | 留 rsi-agent |
| `CREATE` | **10** | 新建文件（整文件注入） | 留 rsi-agent（都是 RSI 模块） |
| `OUTSIDE` | **1** | 目标在 `scripts/conformance_gate.py`，不在 runtime | 留 rsi-agent |

> 240 = 74 + 88 + 38 + 29 + 10 + 1 ✓

### 1.3 补丁链增长轨迹（回答「为什么又堆回来了」）

逐 commit 统计 active 补丁数：

| 日期 | active | 事件 |
|---|---:|---|
| 11-04 17:00 | **13** | 回灌成功（commit `0cc73df`），补丁层清到 13 条 |
| 11-06 | 47 | Q 轮（前端队列/缓存） |
| 11-08 | 162 | 看板五轮 |
| 11-09 | 253 | 一本账 / 秘书 / replay 优化 |
| 11-11 | **240** | 三机制（deferred / L2 / 回合持久化） |

**7 天涨了 227 条。** 结论：回灌是一次性人工动作，而写补丁是顺手动作；**没有触发条件，回灌必然反弹**。本方案第 6 节给出防反弹机制。

### 1.4 38 条通用补丁的分布（回灌实际工作量）

只涉及 **13 个文件**：

**A. 干净文件（6 个，回灌零风险）**

| 文件 | 补丁 |
|---|---|
| `crates/agent-loop/src/compaction.rs` | `X-compaction-pending` |
| `crates/agent-loop/src/subagent.rs` | `G5-TASK-SPEC-DEFERRED` |
| `crates/host/src/web/api/config.rs` | `F4-ENV-LOCK-T3` |
| `plugins/memory/memory_plugin.ts` | `X3-TRACE-READ-PRECISE`, `X3b-TRACE-READ-CALL` |
| `plugins/tools/tools/bash.py` | `X-bash-discipline`, `X-bash-discipline-nosandbox` |
| `plugins/tools/tools_plugin.py` | `G10-TOOLS-MCP-DEFERRED` |

**B. 与 RSI 改动同文件、不同区域（7 个，需顺序应用后验证）**

| 文件 | 通用补丁数 | 同文件 RSI/漂移补丁数 |
|---|---:|---:|
| `crates/agent-loop/src/chat.rs` | 8 | 8 |
| `crates/agent-loop/src/lib.rs` | 6 | 15 |
| `crates/agent-loop/tests/react_mocks.rs` | 8 | 1 |
| `crates/host/src/config.rs` | 3 | 2 |
| `crates/agent-loop/src/contract.rs` | 2 | 1 |
| `crates/agent-loop/src/tools_exec.rs` | 2 | 1 |
| `plugins/tools/tools/files.py` | 1 | 2 |

### 1.5 为什么「同文件」不是障碍

关键性质：

> 若在上游**按 rsi-agent 里同样的顺序**应用同一批通用补丁，则产物文件中这些区域的**字节内容与 rsi-agent 现状完全一致**。
> 因此 rsi-agent 重新快照后，那些锚定在相邻区域的 RSI 补丁**仍然命中**。

这是本方案可行性的全部依据。它把「回灌」从「重写上游代码」降级为「重放同一串替换」，风险从「未知」降到「可 diff 验证」。

---

## 2. 回灌方案

### 2.1 分层判据（唯一标准）

一条补丁该不该回灌，只问一句：

> **「去掉 rsi-agent 这个发行形态，这条改进对任何 react-agent 用户还有意义吗？」**

| 答案 | 归属 | 例 |
|---|---|---|
| 有 | **回灌上游** | deferred 工具按需装载、回合持久化、bash 纪律、trace 读取精度 |
| 没有 | **留 rsi-agent** | 任务看板、灵感、习惯画像、内容分发、git 认证 |

辅助判据（用于机器分桶，非最终裁决）：
1. 目标文件是否存在于上游 → 不存在则必然 RSI 专属；
2. 是否触碰 RSI 专属文件名（`board`/`profile`/`publish`/`git_auth`/`q-session`/`app-*`/`index.html`/`style.css`/`instances`）；
3. 描述是否含 RSI 语义词（看板/灵感/画像/发布/分发/秘书/车道）。

### 2.2 回灌清单（38 条，分四组）

**组 1 — deferred 工具按需装载（11 条）** — 通用价值最高
`G1-CONTRACT-DEFERRED`、`G2-LIB-DEFER-MOD`、`G5-TASK-SPEC-DEFERRED`、`G6-RESERVED-LOAD-TOOLS`、`G7-CHAT-DEFER-SPLIT`、`G8-CHAT-DEFER-ROUND-TOOLS`、`G9A-CHAT-NEWLY-VISIBLE`、`G9B-CHAT-COLLECT-LOADED`、`G9C-CHAT-VISIBLE-MERGE`、`G10-TOOLS-MCP-DEFERRED`、`G11-ACT-EXEC-DEFERRED`、`G12-DEFER-TESTS`

解决的问题：工具数量增长后，全部 schema 每轮下发会撑爆上下文。按需装载让「名字常驻、schema 按需」。**任何 agent 框架都会遇到这个问题。**

**组 2 — 回合持久化 + ask_user（10 条）** — 通用价值次高
`G21-LIB-TURN-MOD`、`G23-CONTRACT-TURN-REPLY`、`G25-ACT-EXEC-ASK-USER`、`G28-CHAT-REPLY-INJECT`、`G29-CHAT-ASK-USER-PAUSE`、`G31-CHAT-PAUSED-CAPTURE`、`G32-CHAT-RUN-TURN`、`G33-CHAT-BODY-FILL`、`G35-CHAT-ASK-SPEC-VAR`、`G36-LIB-TURN-OPS`、`G37-TURN-TESTS`

解决的问题：agent 中途需要问用户时，会话状态要能挂起并恢复，而不是把问题塞进一条 tool 结果里假装连贯。**这是通用交互模式。**

**组 3 — 工具/记忆通用修复（7 条）**
`X-bash-discipline`、`X-bash-discipline-nosandbox`（bash 工具描述纪律：禁 `cd /d` 前缀）、`X3-TRACE-READ-PRECISE`、`X3b-TRACE-READ-CALL`（trace 逐行读精度，原先每行白读 1MB）、`X-webread-budget`、`X-webread-budget-test`（web_read 回喂预算 4×）、`P5B-VERIFY`

**组 4 — 测试与工程卫生（10 条）**
`F4-ENV-LOCK`、`F4-ENV-LOCK-T1`、`F4-ENV-LOCK-T2`、`F4-ENV-LOCK-T3`（并行测试的进程级 env 互斥——**这条是治「19 个用例被 env 泄漏淹掉」的根因**）、`S4B-LOCK-DEFINE`、`V12-ENV-LOCK-RESTORE`、`L5`（跨会话真并行回归）、`L6`、`L7`（env 保存改 RAII，panic 安全）、`X-compaction-pending`（压缩摘要「待办优先」口径）

### 2.3 明确不回灌的（并说明为什么）

| 类别 | 条数 | 不回的硬理由 |
|---|---:|---|
| 看板 / 灵感 / 画像 / 发布 / git 认证 | 74（NOFILE）+ 29（RSI）+ 10（CREATE） | 上游是通用 agent 框架，**不该认识「任务看板」这个业务概念**。`docs/02-架构设计.md` 的三层边界原文：内核「不承载业务语义」；同理执行体也不该承载发行形态的业务语义 |
| 锚点漂移（88） | 88 | 非「不该回灌」，而是「当前无法直接搬」。其中一部分确实通用，但需重写锚点。**列入下一轮**，本轮不做——理由见 §2.5 |

### 2.4 执行步骤（可回滚）

```
Phase R1  在 react-agent 建分支 reflush/v0.1.23
Phase R2  按文件分组、按 order 字段顺序，逐条应用 38 条补丁（替换脚本 = 复用 rsi-agent 的补丁语义）
Phase R3  cargo build --workspace          # 必须过
Phase R4  cargo test --workspace           # 必须全绿；有红即回退该文件组
Phase R5  git diff 逐文件人工核对（38 条替换的 diff 应只含预期区域）
Phase R6  commit → push → tag v0.1.23 → release
```

**回退点**：Phase R2 前后各打一次 tag（`reflush-base` / `reflush-done`），任一步失败 `git reset --hard reflush-base`。

### 2.5 为什么本轮不处理 88 条漂移

漂移补丁的锚点指向「被后续补丁改过的原文」。要搬它，必须先算出**最终态**再反推锚点——这不是替换，是重写。而重写 88 条补丁的错误率远高于收益，且其中多数（`B4a`/`B4b`/`B6`/`C-STYLE`/`D14`…）本身就是看板/前端类 RSI 专属。

**结论：88 条里先筛出真正通用的子集，作为 v0.1.24 的工作项**，本轮只交付确定正确的 38 条。

### 2.6 88 条漂移补丁的最终处置（v0.0.18 已完成，取代 §2.5 的「留待下一轮」）

§2.5 把 88 条当「一个待办」处理，实测后证明这是个分类错误——它们是**三个不同的问题**。v0.0.18 逐条核对完毕：

| 桶 | 条数 | 判据 | 处置 |
|---|---:|---|---|
| 上游已含等价改动 | **16** | 补丁的「新增行」100% 已存在于 react-agent 上游，**且**已存在于本地 runtime → 重放等于第三次写同样的东西 | 退休到 `scripts/patches/retired/`，零行为变化 |
| 发行形态专属 | **72** | 目标改动本身就是发行形态里唯一的定义（看板/画像/灵感/发布/自更新/账号签到），上游没有对应物 | 留本地 |

**判据的修正**：§2.5 隐含的判据是「描述里有没有看板字样」，那个判据会误判——`D5-USER-REFS`（chat.rs 给 trace 事件加 refs 字段）、`G17-CHAT-MEMORY-CTX-WIRE` 这类落在通用文件里、描述里只有「看板上下文」一个词，但改动本身是「把某段上下文拼进 system prompt」，形式上通用、语义上专属。

改用**行级判据**：把补丁的 `patch` 与 `anchor` 做行差集得到「新增行」，再查这每一行是否已在上游目标文件里。这个判据可机检、无歧义：

```
added   = patch 行 - anchor 行
present = [x for x in added if x in upstream_content]
ALREADY ⟺ len(present) == len(added)
```

按此判据，16 条的 `present/added` 全为满分，且同时在本地 runtime 满分 → 退休安全。72 条的 `present` 多为 0（上游确实没有），确认是真专属。

**补丁链净变化**：213（v0.0.17 后）→ 197（退休 16）→ 201（+4 条 NW18 测试隔离）= **201 条 active**，`--dry-run` 209 项全 OK、0 FAIL、0 ANCHOR-MISS。

---

## 3. embedding 集成方案（react-agent v0.1.23）

### 3.1 落点判定（回答「改哪一层」）

| 层 | 该不该改 | 依据 |
|---|---|---|
| agent-kernel | **不改** | 源码不在本仓（git 依赖 tag v0.1.8）；内核管「空间/时间/规则」，不认识「模型」这个概念，embedding 对它无意义 |
| **react-agent（`runtime/` 对应物）** | **改这里** | llm-adapter 是它自己的插件（`plugins/llm_adapter/`），宿主配置是它自己的（`crates/host/src/config.rs`） |
| rsi-agent | 只消费 | 配 `config.json` 的 `embedding` 段即可用 |

### 3.2 设计：两条通道，一次给全

**通道 A — 模型可调用（embed op）**

```
req : {"op":"embed", "input":["文本1","文本2"], "model"?: "..."}
resp: {"ok":true, "vectors":[[0.1,...],...], "dim":1024, "model":"...", "usage":{...}}
    | {"ok":false,"error":{"code":"K400"|"LLM_ERROR","message":"..."}}
```

实现位置：
- `plugins/llm_adapter/llm_plugin.py` — 分派 `op == "embed"`，走 provider registry 的 `embed` 键；
- `plugins/llm_adapter/providers/base.py` — 加 `norm_embed()` 归一化助手；
- `plugins/llm_adapter/providers/openai_compat.py` — 实现 `embed()`：`POST {base_url}/embeddings`，body `{"model":..., "input":[...]}`；
- `plugins/llm_adapter/providers/registry.py` — `_validate` 允许可选 `embed` 键（有则校验签名，无则不报错，保持既有 pack 兼容）；
- `plugins/llm_adapter/providers/mock.py` — 实现确定性 mock `embed`（**测试闭环必需**，无网络即可测）。

**通道 B — 脚本可直接用（env）**

`crates/host/src/config.rs` 新增 `embedding` 段 → `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_KEY`，并加入 `passthrough_env()`，使技能脚本（bash 调的 python）能直接 HTTP 调 embedding 端点。

设计要点：
- **与 `media` 段同构**（`config.rs:304-330` 是现成模板），复用同一套「段 → env」映射写法，不引入新概念；
- **空串不覆盖**（沿用 media 的既有语义，`config.rs:308`）；
- **`EMBEDDING_*` 缺省回落 `LLM_*`**：未配 embedding 段时，若 provider 是 openai 兼容，用同一个 base_url/key。这样**零配置也能用**（很多网关的 chat 与 embedding 同端点同密钥）。

### 3.3 为什么不做「向量库」

实测：全仓 `embedding|vector|faiss|qdrant|lancedb|cosine` **零命中**。本机语料 `.rsi/memory/L2/*.md` 仅 10 个文件 56 KB。SQLite FTS5 可用（3.41.2）。

**结论：v1 只做「取向量」这一步，不做索引层。** 索引/召回放到 RAG 实施文档（§7）里按需演进——先有向量，再谈用什么存。

### 3.4 测试闭环设计（无网络可跑）

| 层 | 用例 | 断言 |
|---|---|---|
| provider 单元 | `mock.embed({"input":["a","b"]})` | `ok=true`、`vectors` 长度 2、每条维度一致、确定性（同输入同输出） |
| 分派 | `op=embed` 走 mock provider | 不报 `unknown op` |
| 参数校验 | `input` 缺失 / 非数组 / 空数组 | `K400` + 字段级错误 |
| 配置映射 | `config.json` 含 `embedding` 段 | `EMBEDDING_BASE_URL`/`MODEL`/`KEY` 三个 env 被设置 |
| 回落 | 无 embedding 段、有 `llm` 段 | `EMBEDDING_*` 回落到 `LLM_*` 值 |
| 空串不覆盖 | `embedding.key = ""` | 该 env **不**被设置 |

### 3.5 版本与兼容

- `Cargo.toml` version `0.1.22` → **`0.1.23`**；
- embed op 是**新增 op**，既有 `chat` 契约零改动 → 向后兼容；
- provider pack 的 `embed` 键是**可选**的 → 既有 pack 不需要改，registry 校验不因缺失而失败。

---

## 4. rsi-agent 侧：快照与精简

### 4.1 步骤

```
Phase S1  用 react-agent v0.1.23 覆盖 runtime/（排除 .git/.instances/.stream/target）
Phase S2  重放「快照适配」（当前 5 处：guest_sdk.ts 导入路径 / files.py _CORE_BLOCKLIST 加 runtime /
          host config.rs apply_rsi_layout_defaults / bash.py _shell_cwd 剥 \\?\ / 核心写保护前缀闸）
Phase S3  python scripts/apply-tool-patches.py --dry-run    # 预期：38 条应报「已应用过」
Phase S4  从 scripts/patches/ 移走这 38 条 → scripts/patches/retired/
Phase S5  python scripts/apply-tool-patches.py --dry-run    # 剩余 202 条应全部 OK
Phase S6  cargo test --workspace（rsi-agent 侧）
Phase S7  更新 README 的补丁数字（现写「13」，实测 240 → 精简后应为 202）
Phase S8  commit → push → tag v0.0.16 → release
```

### 4.2 关键验证点

**S3 是本方案的安全阀**：如果快照后 38 条仍报「锚点未命中」，说明回灌产物与 rsi-agent 现状不一致，**必须停下人工 diff**，不得强行移走补丁。

### 4.3 快照纪律（当前是手工，本次不改机制）

`README.md:161-169` 记录的同步方式是「重新复制文件 + 重放 5 处适配」，纯手工。本次沿用，但**在文档里把 5 处写成可执行清单**（现在正文说「4 处」却列了 5 条，自相矛盾，一并修正）。

---

## 5. 交付物与验收

### 5.1 交付清单

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 本方案 | `outputs/补丁回灌与embedding集成方案.md` |
| 2 | react-agent v0.1.23（embedding + 38 条回灌） | GitHub release |
| 3 | rsi-agent v0.0.16（新快照 + 补丁 240→202） | GitHub release |
| 4 | RAG 实施计划 | `outputs/能力-01-RAG实施计划.md` |
| 5 | 深度研究实施计划 | `outputs/能力-02-深度研究实施计划.md` |
| 6 | 教学实施计划 | `outputs/能力-03-教学实施计划.md` |

### 5.2 验收标准（P / Q / I）

**P 前置**：两仓工作区干净；`cargo --version` 可用（1.98.0 已确认）；宿主进程存在（构建需先停或隔离 target）。

**Q 后置**：
- `cargo test --workspace` 在 react-agent 全绿；
- `cargo test --workspace` 在 rsi-agent 全绿；
- embed op 的 6 类用例全绿；
- `apply-tool-patches.py --dry-run` 无 FAIL。

**I 不变量**：
- 既有 `chat` op 契约不变（`contract_conformance.rs` 全绿）；
- provider pack 缺 `embed` 键不报错；
- 补丁数 240 → 202，且被移走的 38 条全部有「上游已含」证据（release note 逐条列出）；
- 无新增运行时概念（embedding 段与 media 段同构）。

---

## 6. 防反弹机制（否则 7 天后又是 240 条）

回灌做过一次（11-04 清到 13 条），7 天后回到 240 条。**没有触发条件，回灌必然反弹。**

建议三条，按成本排序：

1. **补丁必须打层标签**（低成本，可立即做）
   `scripts/patches/*.json` 增加 `"layer": "upstream" | "distro"`。`apply-tool-patches.py` 输出按层统计。这样「该回灌多少条」是一个可随时查询的数字，而不是需要重新分析一遍的考古工作。

2. **发版前跑层统计闸**（中成本）
   `python scripts/patch-audit.py` 输出：`upstream` 类补丁数 > N（建议 20）则拒绝发版，提示「先回灌」。

3. **回灌做成脚本**（高成本，收益最大）
   当前 `apply-tool-patches.py` 只有 apply/revert，**没有回灌工具**。回灌靠人手工搬，所以没人做。若能把「按层筛选 → 在另一仓按序应用 → 生成 diff → 跑测试」做成一条命令，回灌成本从「半天」降到「十分钟」。

**本次先做第 1 条**（打标签），因为它让第 2、3 条成为可能。

---

## 7. 三能力实施计划（摘要，详见各自文档）

三份文档的共同前提：**能力靠「技能 + 脚本」落地，不靠改 Rust**。理由：`skills/` 是唯一免提权的扩展通道（`files.py:44-54` 把 `runtime` 列为 `_CORE_BLOCKLIST` 首项）。

| 能力 | 落地形态 | 依赖 | 顺序 |
|---|---|---|---|
| **RAG** | 技能 `rag/` + `scripts/` 下索引/召回 CLI；embedding 走本次新通道 | embedding（本次交付） | 第 1 |
| **深度研究** | 技能 `deep-research/` + 多轮检索编排脚本 + 账本 | RAG 的召回层 | 第 2 |
| **教学** | 技能 `teach/` + 课件生成脚本 | RAG（知识来源） | 第 3 |

排序理由：RAG 提供「取到正确材料」的能力；深度研究是「多轮取材料 + 记账」；教学是「把材料变成课件」。**后者依赖前者，不能并行。**

详见 `outputs/能力-01/02/03`。

---

## 8. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| 38 条补丁在上游编译失败 | 中 | 按文件分组应用，每组应用后 `cargo build`；失败只回退该组 |
| 快照后 38 条仍报锚点未命中 | 中 | S3 安全阀：停下人工 diff，不移补丁 |
| 宿主进程锁住 target，构建失败 | 高 | 用隔离 `CARGO_TARGET_DIR`（`.scratch/target`），不杀用户实例 |
| 88 条漂移补丁中混有通用项 | 确定 | 明确列入 v0.1.24，不在本轮承诺 |
| push 触发 CI 失败 | 低 | 先本地 `cargo test --workspace` 全绿再 push |

---

## 9. 不做的事（明确排除，避免范围蔓延）

- **不把看板/画像/发布回灌上游**——那是发行形态的业务语义；
- **不改 agent-kernel**——源码不在本仓，且内核不该理解模型；
- **不引入向量库**——语料 56 KB，FTS5 够用；
- **不做 88 条漂移补丁的重写**——错误率高于收益，列入下一轮；
- **不把回灌做成自动脚本**——本轮先打标签，工具化留下轮；
- **不修改 `_CORE_BLOCKLIST`**——补丁链是唯一合法通道，保持现有边界。
