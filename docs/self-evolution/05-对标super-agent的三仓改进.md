# 05 对标 super-agent 的三仓改进（计划与迭代记录）

> 首行声明：**生产**。模式 = 逆向审计（已完成，见 `outputs/super-agent-对标三仓审计与改进计划.md`）+ 优化（本文）。
> 本文是演进轨迹：每阶段记录 目标 → 方案 → 验收 → 结果。对外契约变更另行同步 README。

## 0. 范围与不在范围

**本轮实施**（用户指令：完整实施、测试通过后三仓分别推送、版本号顺延）

| 阶段 | 仓 | 内容 |
|---|---|---|
| S1 | rsi-agent | 看板归档（方案 A）：done/cancelled 不占上限；报错文案改正 |
| S2 | agent-kernel | 诚实性修复：实现最小 deny-by-default `CapabilityGate`，使文档与代码一致 |
| S3 | react-agent | 版本号与 tag 对齐（Cargo 0.1.25 → 0.1.29）+ 内核依赖 tag 升到 v0.1.9 |
| S4 | rsi-agent | 文档：本计划 + 审计报告 + 看板提示词同步 |

**已评估、本轮不做**（规模与风险超出一次发布的合理范围；方案已在审计报告 §8，留待后续迭代）
- Worker 目录隔离、取消传播、后台任务原语、队列落盘、Trigger 表、IM 去重落盘、observe 模式、Watchdog。
  理由：每一项都改动 `chat.rs` 主循环或新增持久化层，需要独立的设计评审与 e2e；塞进同一发布会让
  回滚粒度消失。它们在审计报告里各自带验收项，按 P1→P4 顺序逐个立任务。

## 1. S1 看板归档

### 1.1 本质与契约
看板 = 一份被两个进程（Python CLI / Rust host）读改写的 JSON。上限 `MAX_TASKS=200` 保护的是
**每次全量读写与提示词注入的体积**，所以不取消上限，而是让「已完结」任务退出热区。

- 数据规范：新增顶层键 `archived_tasks`（数组，元素形状与 `tasks` 相同）。
- 数据存储：同文件 `.rsi/board.json`，不新增文件。
- 数据流转：`task-archive <id|--all-done>` 把 `done|cancelled` 任务从 `tasks` 移到 `archived_tasks`；
  `task-unarchive <id>` 反向；未完结任务拒绝归档。
- 数据接口：
  - `list` / `stats` 的 `tasks.total` 只算热区（即占额度的数）；`stats` 另给 `archived` 计数。
  - `digest` 读 `tasks + archived_tasks`（归档的目的就是保留同类历史）。
  - `show` / `resolve` / `link` 对归档任务可用（`@T-` 引用与历史链接不断）。
  - 新建任务的 ID 候选集并入归档 ID（防撞号）。
- Rust host：`load_board` 必须带出 `archived_tasks`，否则 host 一次写（如改灵感）会把该键整个抹掉。
- 锁：`task-archive` 是写命令，不在 `READ_ONLY_CMDS` 即自动持锁。

### 1.2 验收
1. 归档后 `stats.tasks.total` 下降、`archived` 计数正确；`board.json` 仍含归档任务全文。
2. host 走一遍读改写后 `archived_tasks` 仍在。
3. 归档后新建任务 ID 不与归档 ID 重复。
4. `digest --status done` 仍返回归档任务。
5. 未完结任务归档被拒。
6. LIMIT 报错文案指向 `task-archive`。
7. 既有 `tests/` 全绿。

## 2. S2 agent-kernel CapabilityGate

文档（README、PROGRESS、docs/01~07）声明「✅ 已跑通 deny-by-default」，代码零实现。
两种诚实做法：实现它，或把文档改成「未实现」。选实现最小版，理由：内核的定位就是「强制校验契约与权限」，
缺这一层等于核心卖点不存在；且 `CapabilitySet`（`core/src/capability.rs`）已有数据结构，只缺判定与闸。

**实施前核实（以代码为准）**：
- `Manifest.capabilities` = 插件**提供**的能力；`Manifest.dependencies[].capability` = 插件**要调用**的能力——
  后者已是装载期依赖解析的输入，天然的「调用方声明授权集」。
- `HostApi::call_capability / call_capability_as` **不携带调用方身份**（`KernelHost` 只拿到 capability + trace_id +
  priority），无法在 trait 不变的前提下按调用方判定；`Envelope` 同样没有 caller 字段。
- 文档里的 `K301/K302` 已被 ApiVersion/硬依赖占用，门控另立码。

**实现（v0.1.9）**：
- `core::CapabilityGate`（`core/src/capability.rs`）：`from_granted(deps)` / `check(caller, &cap)`，
  未声明 ⇒ `KernelError::CapabilityDenied(caller, cap)` = **K405**（`core/src/error.rs`）。纯规则、无状态。
- `Kernel::call_capability(caller, capability, payload, deadline)`（`kernel/src/runtime/mod.rs`）：带调用方身份的
  寻址入口——查注册表取调用方清单 → 构造授权集 → 过闸 → 复用 K2 解析 + dispatch 全链（B5/B2/B4/deadline）。
  未注册调用方 ⇒ K401。`Kernel::granted(&id)` 回显授权集（热替换后随新清单变化）。
- **限制（如实记录）**：`HostApi::call_capability*` 保持原语义、不过闸（既有 K2 测试与下游不变）。
  插件经 HostApi 回调仍是「无身份调用」；要让它过闸需要给 `HostApi`/`Envelope` 加 caller 字段，属破坏性变更，
  留待首个破坏性版本。README 模块表已改为这个口径。

**与审计报告 §2.2 Mandate 的差距**：当前闸 = 「能力」一维；「范围 + Policy 版本」未做（`Capability` 是纯名字，
没有 `Fs:Write(path)` 这类带参枚举——文档 §E 的枚举形态与代码不符，本轮不改数据类型）。

**验收**：`cargo test -p agent-kernel-core`（gate 单测 2 条：空集全拒 / 声明放行+未声明拒）、
`cargo test -p agent-kernel-kernel`（invariants 12 条，新增 `e_gate_denies_undeclared_and_allows_declared_capability`：
K405 / 命中提供者 / `granted` / K401）。红已确认：回退实现后 `E0432 unresolved import CapabilityGate`。

## 3. S3 react-agent 版本对齐

`Cargo.toml` = 0.1.25 而 tag 已到 v0.1.28（三个 tag 打在同一版本号的提交上）。
- 把 `Cargo.toml` 直接提到 0.1.29（跳过 0.1.26–28：它们对应的提交本就是 0.1.25，没有可对齐的中间值）。
- **前提修正**：原计划「`board.rs` 的 `load_board` 同源保留 `archived_tasks`」不成立——react-agent **没有看板**
  （`crates/host/src/web/api/` 只有 config/misc/skills，无 board.rs，也没有 `scripts/board.py`）。审计报告 §3.1 把
  rsi-agent 的看板误记为两仓共用。因此本仓无归档同源改动。
- 内核依赖 tag `v0.1.8 → v0.1.9`（否则 react-agent 消费的内核不含 CapabilityGate）。下游只用 `matches!`，
  不穷举 `KernelError`，新增变体安全。
- 验证：agent-kernel 发出 v0.1.9 后 `cargo test`（tag 不存在时 cargo 无法解析，构建验证必须排在内核发版之后）。

## 4. 版本与发布

| 仓 | 当前最新 tag | 本次 | 发布内容 |
|---|---|---|---|
| rsi-agent | v0.1.22 | **v0.1.23** | S1 + S4 |
| agent-kernel | v0.1.8 | **v0.1.9** | S2 |
| react-agent | v0.1.28 | **v0.1.29** | S3 |

注：rsi-agent `runtime/Cargo.toml` 的 `0.1.23` 是内嵌运行时的上游序号快照，不是本仓发行号，不动。

## 5. 迭代记录

### 5.1 S1 看板归档（rsi-agent，待发 v0.1.23）

**目标**：看板 200/200 满，`task-upsert` 被 LIMIT 拒绝；补归档而非取消上限。

**方案**：§1 契约原样落地。`scripts/board.py`：`empty_board()` 加 `archived_tasks`；`load()` 循环键含归档；
`all_tasks(board)`（归档+热区）用于 ID 候选集 / `digest` / `resolve` / `show` / `link`；新增 `task-archive <id|--all-done>`
（非 done/cancelled ⇒ `NOT_FINISHED`，写 `archived_at`）与 `task-unarchive <id>`（受 MAX_TASKS 限制）；
对已归档 ID upsert ⇒ `BoardError(code="ARCHIVED")`（不悄悄复活）；`stats` 加 `archived`；LIMIT 文案指向 `task-archive`。

**Rust host（核心区，走外挂补丁）**：`scripts/patches/sa1-archived-empty.json`（`empty_board` 加键）、
`sa2-archived-load.json`（`load_board` 循环键加 `"archived_tasks"`）。先 `--dry-run`（各命中 1 处）再 apply，
备份 `board.rs.patchbak`。`agent-loop/src/board_ctx.rs` 的在办摘要本就过滤 done/cancelled，未改。

**验收结果**：`tests/test_board_contract.py` 30 条全过（新增 3 条 + 常量断言两侧源码都含 `archived_tasks`）；
`cargo test -p react-agent-host board` 11 条过（隔离 target）。真实账本：归档 177 条，热区 200 → 23，
`stats.archived=177`，随后 `T-20261127-01` 登记成功。

**过程教训（工具层，非代码）**：`edit_file` 模糊匹配两次造成 `board.py` 损坏——一次把文件尾复制三份（SyntaxError），
手工修复后**之前已报成功的多处 edit 被静默回滚**（`all_tasks` 的 upsert/digest/show/link 改动、解析器子命令、stats 字段），
靠 `grep all_tasks\(board\)` 逐处核对重做。纪律：edit 成功后必须 grep 复核仍在；同文件再修尾部后全量复核。
另：`board.py` 里有一段本任务之前就存在的未提交修复（`validate_checks` 透传 grep 的 `scope`/`pattern`），与归档改动
同文件无法拆分，提交说明里如实注明。

**未验证**：前端读 `/api/board` 的位置未定位（压缩文件），归档任务在 UI 的呈现未验证——数据层契约已保证
`archived_tasks` 不被 host 写回抹掉，UI 是否显示归档不影响正确性。

### 5.2 S2 agent-kernel CapabilityGate（待发 v0.1.9）

见 §2。与原计划的差异：原计划把闸接在 `call_capability_as`（无调用方身份，接不上）→ 改为新增带身份的
`Kernel::call_capability`；`Verdict` 枚举 → 直接返回 `KernelResult`（与内核既有错误风格一致）。

### 5.3 S3 react-agent（待发 v0.1.29）

见 §3。差异：归档同源改动因前提不成立而取消（该仓无看板）；多了一项内核依赖 tag 升级。
