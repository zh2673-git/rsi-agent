# rsi-agent v0.0.23

本版覆盖 `v0.0.22..v0.0.23` 区间 **2 笔提交 / 8 个文件 / +475 −37**：
代码 1 笔（`f56fcbd`，7 文件 / +320 −37），本说明 1 笔（`outputs/release-notes-v0.0.23.md`，155 行）。

一句话主题：**把「git 查询税」从纪律问题变成工具问题**。上一个发布会话 151 次工具调用里
52 次是 `python -c "subprocess.run(['git',...])"` 包装，本版让这类包装**失去存在理由**，
并把「不许包」写成可机检的契约测试。

区间构成（`git log --oneline v0.0.22..HEAD`，新→旧）：

| 类别 | 提交 | 说明 |
|---|---|---|
| git-ops | `f56fcbd` | quotepath 直出中文 + `state` 一次查全 + 13 条契约测试（7 文件 / +320 −37） |
| 发行说明 | 本笔 | `outputs/release-notes-v0.0.23.md`（1 文件 / +188） |

---

## 1. 症状：一个发布会话 151 次调用，52 次在重复解同一层编码

`skills/trace-analysis/trace_query.py substitutability` 在真实 trace
（`main.jsonl`，58,592 事件 / 11,495 次 bash 调用）上的口径：

| 桶 | 调用数 | 当时的处置建议 |
|---|---|---|
| `python` | **1,640** | 「改用 read_file / grep 拿事实」——空泛，没有可执行的替代路径 |

看单会话样本更刺眼：一次 tag + release 的会话里 **52/151** 次是
`python -c "subprocess.run(['git', ...], encoding='utf-8')"`。

**根因不是模型懒，是工具缺能力**：git 默认 `core.quotepath=true`，把非 ASCII 文件名转义成
`\350\275\254` 这类八进制串。本仓库文件名大量带中文（`outputs/黄仁勋辞职-字幕.srt`），
模型读到的是一串八进制，**无法判断这是哪个文件**——于是只能套一层 python 把输出重新解码。

关键观察：那层包装**根本没解决问题**。转义发生在 **git 侧**（输出时就把字节转成 `\nnn`），
`encoding='utf-8'` 只影响 python 怎么解码 git 已经吐出的 ASCII 转义串。也就是说，
52 次包装里的大部分，拿到的仍是八进制串——**付了成本，没换到信息**。

## 2. 修法：把 `-c core.quotepath=false` 钉进 argv 前缀

`skills/git-ops/repo_query.py` 引入唯一前缀常量，**所有**子命令复用它（不再各自手写 `git`）：

```python
GIT = ["git", "-c", "core.quotepath=false"]
COMMANDS = {
    "state":     GIT + ["status", "-sb", "--porcelain"],
    "diff_stat": GIT + ["diff", "--stat", "HEAD"],
    "ahead":     GIT + ["log", "--oneline", "@{u}..HEAD"],
    "tags":      GIT + ["tag", "--sort=-v:refname"],
    ...
}
```

这是本版的核心判断：**编码问题必须修在产生编码的那一侧**。修在消费侧（python 解一遍）
只会增加一层，永远不会消失；修在 argv 上则一次性消灭整类包装。

## 3. 症状之二：一次状态确认要问四遍

同一个会话的另一半开销是**往返**：`status` 一次、`diff --stat` 一次、`log` 一次、
`git log @{u}..HEAD` 一次——四次调用拿的是**同一份状态的四个视角**。

### 修法：`state` 子命令（四合一），并设为缺省

一次返回 `branch_line / dirty / dirty_count / clean / diff_stat / log / ahead / upstream`。
`exec_query.py` 的缺省子命令同步从 `status` 改为 `state`——**默认值就是最优路径**，
不指望调用方记得多问。

子命令从 5 个扩到 8 个（`state` / `status` / `diff_stat` / `log` / `ahead` / `branch` /
`remote` / `tags`），全部只读、零网络。

### 顺带修掉两个「正常状态被当成错误」

- **`ahead` 无上游时**：`git log @{u}..HEAD` 在未配置上游时 exit 128。首次推送前这就是
  正常状态，不该抛 `RuntimeError`。`_run(allow_fail=True)` 把它变成空列表。
- **`tags` 的排序**：`git tag` 默认按字典序，`v0.0.9` 会排在 `v0.0.10` **后面**。
  加 `--sort=-v:refname` 按版本序倒排——「最新的那个 tag 是哪个」是发布时的第一个问题。

## 4. 把「不许包」变成可机检：13 条契约测试

只写进 SKILL.md 的纪律会被下一次会话忘掉，所以新增 `tests/test_git_ops_contract.py`
（199 行 / 13 条 / 4 个测试类）：

| 测试类 | 条数 | 锁什么 |
|---|---|---|
| `QuotepathPrefixTest` | 2 | 每个 `COMMANDS` 项的 `argv[:3]` 必须是 `["git","-c","core.quotepath=false"]`；且必须复用 `GIT` 常量（防手写 `git` 漏掉 `-c`） |
| `ReadOnlyBoundaryTest` | 3 | 动词必须在只读白名单、不得在写动词黑名单；实参里不得夹写操作；**`tags` 子命令必须零位置实参**（`git tag` 无参=列举，`git tag <name>`=创建）；未知子命令报错带可选列表 |
| `EndToEndTest` | 4 | 临时 git 仓库里跑真 git：`state` 七键齐全（+`dirty_count` 共八键）、**中文路径原样且不含 `\35`**、无上游时 `ahead` 回空列表、造 bare remote 后能列出未推送提交、`tags` 版本序（`v0.0.10 > v0.0.9 > v0.0.2`） |
| `CliProtocolTest` | 4 | CLI 回单 JSON 含 `ok`；executor 从 stdin 读 `query`；**executor 缺省为 `state`**；`tools.json` 描述必须列全所有子命令（否则模型会用「猜的」名字） |

两个设计取舍值得记：

- **`tags` 单独一条测试**：第一版把 `tag` 放进 `WRITE_VERBS` 想「一刀切禁写」，测试立刻
  报 `['tag'] != []`——因为 `tags` 子命令本来就该用 `git tag`（无参=列举）。改成
  动词分 `READ_VERBS`/`WRITE_VERBS` 分列，再加一条**断言零位置实参**的测试兜住真正
  的风险（带名字就是创建）。**形状对，语义可能还是错的**——所以要用例证伪。
- **端到端不碰真实仓库**：真实仓库的 dirty 清单每天都在变，写成断言必然 flaky。
  用 `tempfile.mkdtemp()` + `monkeypatch repo_query.ROOT`，连 bare remote 都在临时目录里造。

## 5. 让下一轮自己能发现问题复发

`skills/trace-analysis/trace_query.py` 的 `REPLACEABLE["python"]` 原来给的 hint 是
「改用 read_file/grep 拿事实」——对 git 查询场景**指向错误**（读文件当然不要用 python，
但查仓库状态本来就该跑命令）。改为：

> git 查询用 `skills/git-ops/repo_query.py`（含 `-c core.quotepath=false`，中文不转义）；
> trace 分析用 trace-analysis；纯读文件用 read_file/grep

`trace-analysis/SKILL.md` 补上 `substitutability` 的用法示例与 **`python` 桶特别说明**：
该桶的实测数字（52/151）与成因写成正文，并留下一句判据——
**「这个桶重新长大，即说明又有人在绕开 repo_query」**。这是本版真正的回归信号：
不是等用户抱怨变慢，而是下次跑 `substitutability` 就能看见。

## 6. SKILL.md：发布链路收敛到两个查点

`skills/git-ops/SKILL.md`（+42 −8）新增三段：

- **反探针铁律**：git 查询一律 `repo_query`，不要 `python -c` 包；bash 里不要用
  `dir` / `findstr` / `type` / `more` 读仓库；**状态确认一次 `state`**。
- **发布链路：只有两个查点**——`commit → push → tag+push tag → gh release create`，
  查点①`repo_query state`（`ahead` 空）、查点②`gh release list`（Latest、非 draft）。
  中间的「再查一遍状态」全部是往返开销。
- **发行说明只能从 diff 写，不能从 commit title 写**。实例：照 `7edaee6` 标题里的
  「任务级路由粘性」写进 v0.0.22 说明，事后 grep 才发现那笔 9 个文件里没这段（标题笔误），
  只能回头重查重写。

验收标准从 4 条扩到 5 条，新增第 5 条**「无探针包装」**——发布链路的查询次数应在个位数；
反例补上「用 python 包装 git 反复确认同一份状态」。

## 验证

| 项 | 结果 |
|---|---|
| `python -m pytest tests -q` | **441 passed**（31.14s，含新增 13 条） |
| `pytest tests/test_git_ops_contract.py tests/test_static_structure.py tests/test_skill_sync.py -q` | **32 passed** |
| `repo_query state`（真实仓库） | 中文文件名原样（`?? outputs/黄仁勋辞职-字幕.srt`），无 `\350\275\254` |
| `repo_query ahead`（无未推送） | `{"ok":true,"sub":"ahead","output":"","list":[]}` |
| `exec_query.py` stdin 空参 | 缺省走 `state`，七键齐全 |
| `substitutability --latest` | `replaceable_ratio 0.177`（python 桶 1,640 / 11,495 bash 调用）——本版的基线，下次对比用 |

## 升级注意

- 本版**不改** `runtime/Cargo.toml` 的 `version = "0.1.23"`（自 2026-11-01 未变），
  release 线走 git tag `v0.0.x`；
- **纯技能侧改动**：只动 `skills/git-ops`、`skills/trace-analysis`、`tests/`，
  不涉及 Rust / 插件运行体。**无需重启 Host** 即可生效（`repo_query.py` 每次调用现读现跑），
  但技能工具的 `description` 变更若要让已在运行的 Host 重新加载，仍需在设置界面
  Skills 页重新确认，或重启 Host 一次；
- `repo_query` 的 `state` 是**新增**子命令，老调用 `status` 的行为完全未变；
  唯一行为变化是 **executor 缺省值** `status` → `state`（返回字段是超集，向后兼容）；
- 输出里的 `dirty` 清单现在带中文原名，若有脚本按八进制串匹配路径，需要跟着改。

## 与其他 Release 的关系

`v1.4.x` 是 **make-video 技能**的独立发布线，与本应用线 `v0.0.x` 并行，互不覆盖。
本版不涉及 make-video。
