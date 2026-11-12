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

## 常用命令（bash 单行，勿带换行）

```
git status --porcelain                      # 脏文件清单（配套工具 repo_query 亦可）
git diff --stat HEAD                        # 将提交内容的统计（含已暂存）
git add <路径...> && git commit -m "<信息>"  # 显式暂存 + 提交
git push origin main                        # 推送
gh pr create --title "<标题>" --body "<正文>"  # 建 PR（base 按用户指定，默认上游主分支）
gh release create v0.1.0 --title "<标题>" --notes "<要点>"  # 建 release
gh release list && gh pr status             # 查看
```

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
stdout JSON，子命令白名单：status / diff_stat / log / remote / branch，无任何写操作）。
经 `skill_install` 安装后进入工具池，**用户技能工具需在设置界面（Skills 页）批准启用**；
bash 直调 `python skills/git-ops/repo_query.py status` 始终可用，两者等价。

## 验收标准

一次提交/推送合格，当且仅当：

1. **暂存即所想**：`git status --porcelain` 与 `git diff --stat HEAD` 逐文件核对过，暂存清单里没有意外文件。**未使用 `git add -A` / `git add .`**（用了即不合格，哪怕结果碰巧对）。
2. **无密钥**：`git diff --cached` 全文搜 `api[_-]?key|token|password|secret` 零命中；命中即停手报告，不提交。
3. **一笔一事**：提交信息首行符合 `type(scope): 中文摘要` 且 ≤72 字符；正文要点与 `git show --stat` 的文件清单能对上。
4. **push 可核**：`git log origin/main..HEAD` 为空（该推的都推了），且推送后 `gh release list` / `git ls-remote --tags origin` 能查到对应 tag。

反例（一律判不合格）：`git add -A` 后直接 commit；把多个主题塞进一笔提交；release 未给用户过目就创建；force push 到 main。
