# Spec：工具层缺陷收敛（tool-improvements）

状态：待批准
日期：2026-11-03
来源：本轮会话实测（非推断）。三条缺陷均在本轮被**直接触发**并留下可复现证据。

## 1. 背景

### D1（P0，静默数据丢失）bash 多行命令只执行第一行

实测（本会话，同一工具、同一环境）：

| 输入 | 实际输出 | 期望 |
|---|---|---|
| `echo A\n echo B` | `A` | `A` `B` |
| `echo A && echo B` | `A` `B` | ✅ 正常 |
| `python -c "print(1)\nprint(2)"` | （空） | `1` `2` |
| `python -c "import sys;print('A');print('B')"` | `A` `B` | ✅ 正常 |

根因链（代码核查，非推断）：

1. `bash.py:223` `[helper, "exec", str(timeout_ms), command]` —— 整个 command 作**单个 argv** 传入；
2. `sandbox-run.rs:22` `args[2..].join(" ")` —— 换行在 argv 内被完整保留；
3. `sandbox-run.rs:96` `format!("cmd.exe /c {command}")` —— 拼成命令行 `cmd.exe /c echo A⏎echo B`；
4. **`cmd.exe /c` 只取首行**（换行即命令终止，且不尊重引号）。验证：`subprocess.run(['cmd','/c','echo A\necho B'])` → `'A\n'`。
5. 直跑路径 `bash.py:201` `shell=True` 同样落到 cmd，行为一致（验证同上）。

危害等级最高的一点：**exit_code = 0**。模型看到「成功」但实际只跑了第一行，会基于虚假成功继续推理。
本会话 trace 实测：bash 调用 216 次，其中**含换行 34 次**（15.7%）——全部是这种静默截断的候选。

### D2（P1，反复复发）成因 A：产物目录被当成草稿盘

现象：每次重启后，模型又开始往 `outputs/` 写 `_scratch_*.py` / `_probe_*.py` 探针脚本。

**为什么重启就复发**：这不是记忆问题，是**提示词层的结构性缺口**——每次 chat 都重新拼 system prompt，
而拼出来的内容只有正向约定、没有反向禁止：

| 来源 | 原文 | 问题 |
|---|---|---|
| `skills.rs:80-83`（Rust 核心，每轮注入） | "Files produced for the user … must be written into `outputs`" | **只定义「成品去哪」，没定义「中间物去哪」** |
| `SYSTEM.md`（本工作区，改前） | "给用户的成品文件写入产物目录" | 同上，同样缺反向约束 |

模型手里有「写文件」这个工具、又被告知「产物统一进 outputs」，最省力的解释就是「我要写的都算产物」。
`outputs/` 同时还在 `bash.py:86` 的**快照排除区**——写进去连 undo 留痕都没有，于是这条路径既顺手又无成本。

本会话实测：`file_change` 事件 16 条，**16 条全部在 `outputs/`**；write_file 22 次，17 次是 `_scratch_*`。

### D3（P2，文档与实现不符）L2 自扩展通道在本布局下不可达

`SYSTEM.md` 宣称「Python 工具 → `plugins/tools/` 顶层放新 `.py` 模块」是四条合法途径之一，
`files.py:53-54` 的注释也这么写。**但在 rsi-agent 布局下这条路是死的**：

- `files.py:43` `_CORE_BLOCKLIST` 第一项是 `"runtime"`，整树禁写；
- 本工作区 `WORKSPACE_ROOT` = 仓库根，所有 `plugins/` 都在 `runtime/` 下；
- 实测 `write_file runtime/plugins/tools/probe_l2.py` → `CORE_PROTECTED`。

即：`files.py:84-87` 的「plugins/tools 顶层豁免」只在 `plugins/` 位于工作区根的旧布局（react-agent 快照）
里成立。rsi-agent 布局下实际可用的自扩展通道**只剩 skills 目录**。

### D4（P2）设置面板挡住 `max_rounds=2000`

`web-dist/index.html:122` `<input id="agent-max-rounds" type="number" min="1" max="64">`。
默认值已改 2000（`config.example.json`），但面板输入框 `max=64` 会在浏览器侧拦下，用户无法在 UI 里保存。

## 2. 目标与非目标

目标：
- D1：把**静默截断**变成**显式报错**（fail-loud），并在提示词层给正确用法；
- D2：补上「中间物去哪」的反向约定，并把「写脚本查 trace」这个**驱动力本身**消掉；
- D3：修正文档表述，让「合法途径」清单与实现一致；
- D4：放宽面板上界。

非目标（明确不做）：
- **不自动改写换行**（把 `\n` 替成 `&`）——`python -c "…\n…"` 这类引号内换行会被破坏成语法错误，
  比截断更难诊断。宁可报错让人改写，不做魔法转换。
- 不新增事件类型（沿用既有 `error` / `file_change`）。
- 不改 `outputs/` 的硬边界（越界拦截与产物目录语义保持不变，只补提示词）。

## 3. 方案

### 阶段 A：提示词层（**可自改**，已落地）

`SYSTEM.md`「工具与编辑纪律」新增两条：

- **bash 单行铁律**：command 里不出现换行符；多步串联用 `&&` / `&` 或拆多次调用；写文件用
  write_file，不用 `echo >` / `python -c "open().write()"`。
- **中间物不进产物目录**：探针/一次性 dump 一律不落盘，先用 grep / read_file / symbols_search
  拿事实；确需脚本时落 `.scratch/`（点目录，不入库、不占 bash 快照）；`outputs/` 只放成品。

配套：`.gitignore` 增 `.scratch/`（仅此一项；**不**忽略 `outputs/`，交付物要入库）。

### 阶段 B：技能层（**可自改**，已落地）——消掉「必须写脚本」的驱动力

D2 的真正驱动力不是「模型爱写脚本」，而是**没有现成的 trace 查询手段**。本会话 17 个探针脚本
全在做同一件事：从 `memory/data/traces/*.jsonl` 里数工具分布、找空输出、定位 file_change。

新增技能 `skills/trace-analysis/`：
- `trace_query.py`：**已提交**的固定查询脚本（subcommand 式），一次覆盖本会话用到的全部查询；
- `SKILL.md`：说明何时用、怎么用（bash 单行调用）、每个子命令输出什么。

模型只需 `python skills/trace-analysis/trace_query.py toolmix --session <id>` 一条单行命令，
不再需要「写脚本 → 跑 → 删」三步，也不需要往 `outputs/` 落盘。
**不带 `tools.json`**（刻意）：用户技能工具需界面启用（`tools_plugin.py:533` 的 `TOOL_DISABLED` 闸），
而 bash 调用无此摩擦，改完即生效、无需重启。

### 阶段 C：核心层（**需用户授权**，本轮只给补丁不落地）

#### C1 `bash.py` 多行 fail-loud（D1）

`_run_bash` 入口（`bash.py:272` 之后）加 8 行：

```python
if "\n" in command or "\r" in command:
    raise ToolError(
        "bash command 含换行符：cmd.exe /c 只执行首行，其余行会被静默丢弃（exit_code 仍为 0）。"
        "请改用单行 + `&&` / `&` 串联，或拆成多次调用；python 多语句用 `;`。",
        code="MULTILINE_UNSUPPORTED",
        field="command",
    )
```

理由：报错比截断安全——截断会污染模型的推理链（它以为成功了）。

#### C2 `skills.rs` 产物段补反向约定（D2）

`skills.rs:80-83` 的 `lines.push(format!(...))` 后追加一行：

```rust
lines.push(format!(
    "- Intermediate files (probe/scratch/one-off analysis scripts) are NOT artifacts: do not write \
     them into `{}`. Prefer reading files with the dedicated tools; if a script is unavoidable, put it \
     under `.scratch/` and delete it when done.", cfg.output_dir
));
```

#### C3 `index.html:122` 上界（D4）

`max="64"` → `max="10000"`（与 `config.rs` 的 `env_num` 无上界约束对齐）。

#### C4 文档一致性（D3）

`SYSTEM.md` 自扩展表格里「Python 工具 → `plugins/tools/` 顶层」加注：
「（仅当 `plugins/` 位于工作区根时可用；rsi-agent 布局下 `runtime/` 整树禁写，此路不可达）」。
—— 该条在阶段 A 已改到 `SYSTEM.md`，但**当前表述仍不完整**，见 §5 待办。

## 4. 验收（P/Q/I）

**P（确定性）**
- `python -m pytest tests/ -q` 全绿（当前基线 18 passed）。
- `python scripts/conformance_gate.py --skill skills/trace-analysis --smoke` → `ok: true`
  （技能 frontmatter/结构合规）。
- `trace_query.py` 每个子命令对**空文件 / 非法 session / 正常 trace** 三种输入都不崩（返回 `ok:false` 而非 traceback）。

**Q（实测，可复现）**
- D1：`bash` 传 `"echo A\necho B"` → 得到 `MULTILINE_UNSUPPORTED` 字段级错误（**不是** `exit_code:0` + 只有 A）。
- D2：本会话新起的 chat 里，`file_change` 事件中 `outputs/` 路径占比为 0（中间物进 `.scratch/` 或根本不落盘）。
- D2'：问「统计本次会话工具分布」时，模型调用 `trace_query.py` 而非 `write_file` 新建脚本。
- D3：`SYSTEM.md` 的四途径表格与 `files.py` 实际拦截行为一致（人工核对，无自动断言）。
- D4：面板填 `2000` 能保存并回显 `2000`。

**I（不变量）**
- 既有 64 项 Rust 测试全绿（C1/C2 落地后）。
- 不新增事件类型；`FROZEN_EVENT_TYPES` 不变。
- `outputs/` 的越界拦截语义不变（`files.py:_guard` 未改）。
- `.scratch/` 不被 git 跟踪，但**仍受 bash 快照之外的 write_file undo 保护**。

## 5. 生效条件

| 改动 | 生效方式 |
|---|---|
| `SYSTEM.md`（阶段 A） | **下一个 chat 即生效**（`resolve_system_prompt` 每次 chat 重读 `WORKSPACE_ROOT/SYSTEM.md`，`skills.rs:19-24`） |
| `.gitignore` | 立即 |
| `skills/trace-analysis/`（阶段 B） | **下一个 chat 目录重扫即出现在技能清单**（`assets_plugin.py:125` 每次 `skills.list` 重扫），无需重启 |
| `bash.py`（C1） | **需重启宿主**（Python 插件进程重载） |
| `skills.rs`（C2）/ `index.html`（C3） | **需重启 + 重编译/重打包前端** |

注意：C 类改动若只改源码不重启，等于测旧二进制（call-efficiency §E2 的教训）。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| C1 让 `python -c "多行"` 从「截断」变「报错」，短期看像退化 | 报错信息直接给替代写法；截断是更坏的退化（虚假成功） |
| 提示词约束非硬边界，模型仍可能往 outputs 写脚本 | 阶段 B 的 `trace_query.py` 才是主修复：把「需要脚本」的场景变成「调现成脚本」 |
| `trace_query.py` 与 trace 格式漂移 | 子命令全部容忍字段缺失（`.get()` + 默认值），格式变更只影响统计精度不抛异常 |
| `.scratch/` 成为新的垃圾堆 | 明确「用完删除」；且它是点目录，git 与 bash 快照都看不到，不污染交付 |

## 7. 第二轮：bash 收敛与工具选择纪律（2026-11-03 用户追加）

### 7.1 外部调研结论（四家编码 agent 的工具层，均有原文出处）

| 项目 | 工具面 | 「何时用 bash」的引导 | bash/Windows 实现 |
|---|---|---|---|
| opencode（anomalyco/opencode v1.19.5） | read/write/edit + **grep/glob（ripgrep）** + bash/task/webfetch/lsp | 写死在 **bash 工具描述**：`DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools`；grep 描述有反向细则「统计匹配数反而用 bash 跑 rg」 | pwsh → powershell → git-bash → cmd，tool ID 仍叫 bash |
| Codex CLI（openai/codex） | **极简：exec_command（PTY shell）+ apply_patch**（按需另加 plan/web_search） | 不指导「读文件用什么」——它没有专用读工具；仅指名 rg 更快、apply_patch 适用边界 | Rust 手写 PTY 运行时 |
| pi（earendil-works/pi，TS） | 默认 read/bash/edit/write；grep/find/ls **默认缺席** | **按启用工具集动态生成**：grep/find/ls 都不在场时才注入 `Use bash for file operations like ls, rg, find`（system-prompt.ts L108-116） | `bash -c` argv 原样传（多行整体可用）；Windows 只找 bash.exe 不碰 cmd；legacy WSL 改 stdin |
| DeepSeek harness（deepseek-ai/deepseek-harness） | read/write/edit + **glob/grep（内置 rg）** + bash（Windows 换 pwsh）+ job_* 等 | 无通用引导（personaPrefix 为空），引导按插件 prompt section 注入 | bash/pwsh 平台二选一 |

**共同规律**：① 有专用工具时，bash 纪律写在**离调用点最近的地方**（工具描述），措辞用 DO NOT；
② 没有一家「有专用工具还让 bash 干文件活」——codex 全走 shell 只因为它没有专用读工具；
③ pi 是反向证明：工具缺席时纪律必须反过来（让 bash 承担检索）。

### 7.2 本仓库量化事实（`trace_query.py substitutability`，本会话 trace 实测）

bash 449 次中 **379 次（84.4%）可由内置工具替代**：python -c 探针 155、chcp 62、dir 59、
powershell 53、findstr 38、echo 7、type 4、ls 1（`python -m` 模块运行已豁免口径——那是 bash 本职）。

### 7.3 本地化方案（吸收 ①③，不抄 ②）

- `SYSTEM.md` 增「专用工具优先」纪律——替代映射按**本仓库**工具名逐项写死；
- bash 工具描述加引导（P4 补丁，opencode 式）——随 schema 注入，离调用点比 system prompt 更近；
- `trace-analysis` 增加 `substitutability` 子命令（把 84.4% 这个数字变成可复现查询），
  并升级为**带配套工具的技能**（tools.json + exec_query.py + skill_install）——
  D2' 验收（问统计时调工具而非写脚本）从「靠自觉」变成「工具在场」。

**不抄 codex 极简路线**：删掉专用工具会退回「全走 bash + 多行截断」的现状，方向相反。

### 7.4 补丁交付物位置修正（2026-11-03 用户指正）

- 补丁脚本原放 `outputs/`（用户成品目录）——错误；工程资产归 `scripts/`，
  与 conformance_gate 等运维脚本同列 → 迁至 `scripts/apply-tool-patches.py`，outputs 清空。
- 顺带清理：根目录 262KB 的 `ocpaths.json`（pi 逆向时的路径 dump，中间物散落）已删。
- 自查：若核心区可写，补丁脚本本不应存在（直接改源码 + cargo test 即可）；
  它是 CORE_PROTECTED 约束下的产物，故幂等/可预演/可回滚（--dry-run / .patchbak）是硬要求。
- 探查确认（影响「设置好之后是否要重启」的答案）：
  - `SYSTEM.md` 走 `resolve_system_prompt`（skills.rs:20 `fs::read_to_string`）**每轮现读磁盘** →
    纪律条目改完下轮对话即生效，无需重启；
  - 用户技能工具启用：设置面板勾选 = `tools.configure` 热应用 + 落盘 `config.json tools.enabled`，
    重启后经 `TOOLS_ENABLED → _DEFERRED_ENABLED` 装载时自动恢复 → **启用不重启**，
    但**装载**（skill_install）需要该技能所在会话 load_skill 或重启后由技能扫描触发；
  - C 类补丁改 Rust/前端 → 必须 cargo build + 前端重打包 + 重启宿主才生效。

## §8 架构裁决：rsi-agent 与 react-agent 的关系（2026-11-03 用户发起，按 project-dev 优化模式）

**问题**：从长远看是否该改 react-agent 工具层？rsi-agent 长自 react-agent，是否该按自身
发展修改自身？整体好但部分条框需反思修正——底座不动、大部分不动、该调的调。

**裁决规则（一句话）**：rsi-agent 不是 fork，是「上游快照 + 显式差异集」（README §快照
契约：4 处适配 + 重放约定）。差异集合法且已存在，问题只是**哪些差异该长出来**：
agent 为「外部任务」设计的部分照搬上游，为「自我演化」设计的部分必须长自己的。

**四层审视结论**：

| 层 | 裁决 | 理由 |
|---|---|---|
| agent-kernel | 零改动 | 契约即如此；本次问题与内核无关 |
| agent-loop/host 骨架（ReAct 循环/事件/P·Q·I） | 照搬，不分叉 | 上游活跃演进，同步税必须继续交 |
| 闸的**存在** | 保留 | 自我不能无闸改自我，语义正确 |
| 闸的**粒度** | **改**（A） | 布尔全有全无连 config.json（密钥）/memory 都解锁；RSI 形态需高频小粒度自改+验证回路，粒度错配是本次全部摩擦的根 |
| 死途径文案 | **改**（B） | 「plugins/tools/ 顶层放 .py」在 RSI 布局不可达（plugins/ 在 runtime/ 下被禁写）——四途径自相矛盾，收口为指向技能 tools.json |
| bash P1/P4 | **改**（C） | 上游真缺陷（多行静默截断三次实测复现），rsi-agent 重度用 bash 先撞上；这是缺陷修复不是条框 |
| 适配重放 | **机制化**（D） | 「4 处适配」从 README 人肉清单升级为 scripts/ 可重放补丁集；README:153 自认漏重放只能靠测试变红被动发现 |

**关键反转（自我修正）**：§7.4 曾裁「授权后补丁脚本失去意义、直接删」——按 project-dev
重审后推翻：**改源码之后 P1/P4 即成为适配第 5、6 处，下次上游同步必被覆盖，除非可重放**。
`apply-tool-patches.py` 的正确身份不是绕闸救火脚本，是 D 项（适配重放机制）的雏形：
改 = 当前态，脚本 = 下次同步后的还原态，二者是同一件事的两半。

**RSI 的体现位置**：不是「改得多」，是 organism 长在边缘组织层（skills/specs/SYSTEM.md/
scripts——本会话 37 次落盘的分布即证），核心改动少而闸门化，且走「差异集登记（README
契约）→ 授权 → pytest/cargo 验证 → 重启 → 稳定后反哺上游」的有验证回路。rsi-agent 已长出
自己的东西（trace-analysis、本 spec、纪律条目），缺的只是闸粒度（A）与重放机制（D）。

**执行顺序**（跨模块节奏）：C（缺陷修复，立即可做，等 allow_core_write）→ A、B
（闸与文案，授权窗口内一并）→ D（重放机制，纳入 apply-tool-patches.py 扩展）。
A/B/D 涉及核心区（files.py / 文案 / 脚本扩展），同样需要授权或入差异集。
