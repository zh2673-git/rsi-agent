---
name: git-ops
description: GitHub/git operations for this repo (origin = rsi-agent): repo state queries, commit message drafting with repo conventions, push, PR (gh pr create), release (gh release create). Use when asked to 提交/推送/发 PR/建 release/看仓库状态/写 commit message, or before any git push to origin.
origin: user
---

# git-ops：本仓库的提交 / 推送 / PR / Release

目的：把 git/GitHub 操作收敛成**可核查的固定流程**——提交前必看真实 diff，提交信息按本仓库
行文（`type(scope): 中文摘要`），push / PR / release 全走 gh CLI（已登录 `zh2673-git`，
scopes 含 repo/workflow）。

## 何时用

- 「提交这些改动 / push / 发个 PR / 建 release」
- 「现在仓库什么状态 / 有没有没提交的东西」
- 写 commit message 时的行文基准（先看 `git log` 实际风格，不臆造）

## 铁律（先读再动）

1. **提交前必看 `status` + `diff_stat`**（配套 repo_query 工具或原生 git），逐文件核对：
   暂存的内容 = 你以为的内容。**禁止 `git add -A` 盲提**——用显式路径列表 `git add`。
2. **密钥检查**：`config.json` / `config.*.local.json` / `.env` 已被 .gitignore 覆盖且从未
   入库（2026-11-03 用 `git ls-files` 核查）；若 diff 里出现 token / api_key / password
   字样，停下报告用户，不提交。密钥永不出现在提交信息里。
3. **多主题拆多笔**：一笔提交只讲一件事。提交信息第一行 `type(scope): 中文摘要`
   （≤72 字符），正文列要点。本仓库实例：
   - `feat(efficiency): 预算 wrap-up 收敛轮 + trace-analysis 技能 + plan-completion 立项`
   - `fix(tools): 工具调用完整性——bash cwd 归一、run_tests 上界与口径、名称闸对齐`
   - `docs(spec): tool-improvements 补第五轮执行记录（闸升级闭环 + 重启复测清单）`
4. **push 纪律**：只 push 到 `origin`（rsi-agent）；不 force push；不动 main 以外的远端
   分支除非用户指名。push 前先 `status` 确认干净、`log` 确认要推的提交。
5. **release 是对外交付物**：tag 名 / 标题 / 要点正文先给用户过目，确认后执行。

## 反探针铁律（2026-11-19 实测沉淀，一个发布会话 151 次调用里 52 次是纯包装）

git 查询一律用 `repo_query`，**不要再用 `python -c "subprocess.run(['git',...])"` 包一层**。
那层包装存在的唯一历史理由是编码：git 默认 `core.quotepath=true`，中文文件名被转义成
`\350\275\254` 这类八进制串，模型读不出。现在 `repo_query` 每条命令都带
`-c core.quotepath=false`，中文原名直出——包装整类消失。

同样地，bash 里也不要用 `dir` / `findstr` / `type` / `more` 读仓库内容：
`list_dir` / `grep` / `read_file` 是本仓库的专用工具（`skills/trace-analysis/trace_query.py`
的 `substitutability` 子命令就是为量化这件事写的，口径见其 `REPLACEABLE` 表）。

**状态确认一次拿全**：用 `repo_query state`（status + diff_stat + log + ahead 四合一），
不要「查一句、想一想、再查一句」——那是轮次开销的第一大来源，且拿到的还是同一份状态。

## 常用命令（bash 单行，勿带换行）

```
python skills/git-ops/repo_query.py state   # 发布/提交前的标准第一查：脏文件+改动统计+近10笔+未推送
git add <路径...> && git commit -m "<信息>"  # 显式暂存 + 提交
git push origin main                        # 推送
gh pr create --title "<标题>" --body "<正文>"  # 建 PR（base 按用户指定，默认上游主分支）
gh release create v0.1.0 --title "<标题>" --notes-file <文件>  # 建 release（长正文用 --notes-file）
git tag v0.1.0 && git push origin v0.1.0      # 打 tag 并推（tag 是 git 的，不是 gh 的）
gh release list && gh pr status             # 查看
```

## 发布链路：只有两个查点，不要中间乱查

一次 tag + release 的最小必要序列（其余查询都是可省的往返）：

```
git add <显式路径> && git commit -m "..."     # 1 笔（或 N 笔，按主题拆）
git push origin main                          # 推提交
git tag vX.Y.Z && git push origin vX.Y.Z      # 打 tag 并推
gh release create vX.Y.Z --title "..." --notes-file <notes.md>
python skills/git-ops/repo_query.py state     # 查点①：ahead 空、dirty 只剩故意的（如 outputs/）
gh release list                               # 查点②：release 带 Latest 且非 draft
```

**发行说明只能从 diff 写，不能从 commit title 写。** 实测教训：照 `7edaee6` 标题里的
「任务级路由粘性」写进说明，事后 grep 才发现那笔 9 个文件里根本没这段（标题是笔误），
只能回头重查重写。标题是当时的人的说法，`git show --stat` 才是事实。


## PR / Release 正文结构

```
## 改动
- <要点 1>（文件/模块级）
## 验证
- <测试命令 + 结果，如 30/30 绿 / cargo check 过>
## 影响面
- <breaking? 兼容性? 需要用户做什么（如重启宿主）>
```

## 边界

- 只在本仓库（origin = rsi-agent）操作；跨仓库任务需用户明确指路。
- repo_query 只读；一切写操作（commit/push/pr/release）走 bash 原生命令并回显结果。
- gh 未登录 / 网络失败：如实报告，同因不重试超过一次。

## 配套工具（可选启用）

`tools.json` 声明了 `repo_query`（只读查询执行器 `exec_query.py`，协议 stdin JSON →
stdout JSON，子命令白名单：state / status / diff_stat / log / ahead / branch / remote /
tags，无任何写操作，全部带 `core.quotepath=false`）。
经 `skill_install` 安装后进入工具池，**用户技能工具需在设置界面（Skills 页）批准启用**；
bash 直调 `python skills/git-ops/repo_query.py state` 始终可用，两者等价。

## 验收标准

一次提交/推送合格，当且仅当：

1. **暂存即所想**：`repo_query state` 的 dirty 清单与 diff_stat 逐文件核对过，暂存清单里没有意外文件。**未使用 `git add -A` / `git add .`**（用了即不合格，哪怕结果碰巧对）。
2. **无密钥**：`git diff --cached` 全文搜 `api[_-]?key|token|password|secret` 零命中；命中即停手报告，不提交。
3. **一笔一事**：提交信息首行符合 `type(scope): 中文摘要` 且 ≤72 字符；正文要点与 `git show --stat` 的文件清单能对上。
4. **push 可核**：`repo_query state` 的 `ahead` 为空（该推的都推了），且推送后 `gh release list` / `git ls-remote --tags origin` 能查到对应 tag。
5. **无探针包装**：整个过程没有出现 `python -c "subprocess...git"` 这类包装，也没有用 `dir` / `findstr` / `type` 代替专用工具（发布链路的查询次数应在个位数）。

反例（一律判不合格）：`git add -A` 后直接 commit；把多个主题塞进一笔提交；release 未给用户过目就创建；force push 到 main；用 python 包装 git 反复确认同一份状态。
