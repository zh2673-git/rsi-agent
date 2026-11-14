# PLAN.md — project-dev 演进轨迹

模块级演进档案（优化模式纪律：方案随代码走；`README.md`/SKILL.md 记对外契约，本文件只记轨迹）。

## v0.2.0（基线，2026-10-31 导入 rsi-agent）
- 来源：tool/project-dev-skill 导入，补 RSI 发行件（skill.json / state.json / evals）。
- evals 六案例（c1–c6）建基线：正向契约闸 / 逆向六步 / PLAN 纪律 / P·Q·I / 体量分诊 / 不猜原则。

## 审计结论（2026-11-14，agent 时代调用面）
- 初衷「开发、读懂、理解任何软件」在 agent 时代的延伸：**读懂 = 还原内部设计 + 知道外部可调用面**
  （agent 消费软件靠调用而非阅读）。
- 四层模型早已容纳（数据接口层），缺的是三个检查位：
  1. 正向 program.md 无「主要消费者」确认项；agent 消费时缺调用面契约（CLI / `--json` / 退出码 / 无 TTY）。
  2. 逆向六步审计不含可调用面检查（agent 能否驱动该软件）。
  3. evals 无对应案例。

## v0.3.0 路线（本轮）
1. SKILL.md §4：program.md 草稿增加「主要消费者」；判为 agent 时 interfaces/ 层按调用面契约设计。
2. SKILL.md §5 + repo-explorer 档二第2步：第0级分层审计含可调用面检查（归数据接口层，不改六步框架）。
3. references 新增 §3.6「Agent-First 调用面」：CLI 优先 / `--json` / 退出码表 / 幂等 / 无 TTY /
   schema 版本化 / CLI→MCP 演进路径；§0.2 草稿清单与 §2.3 方案模板同步。
4. skill.json 0.3.0 + acceptance a4/a5；evals 补 c7/c8；run_evals 全绿后更新基线。
5. 同步 project-dev-skill 仓库（含 repo-explorer），两仓库 commit+push，release 版本号顺延。

## 已评估不做（防重复评估）
- **新建独立 skill**：无独立生产线（角色/工件/验收），当前只是设计约定；先验证有效，
  日后若需要脚手架/模板交付物，再按 rsi-steward 流程沉淀。
- **引入 MCP 作为第四种模式**：宿主无 MCP 支持；CLI 是 agent 调用最低公约数，
  MCP 可日后薄封装 CLI 得到，两者不冲突。
- **把「六步审计」改成「七步」**：调用面属数据接口层既有审计位，加步骤会破坏既有引用与案例（c2）。

## 回退点
- 本轮全部改动为文档/案例增量，无运行时代码；回退 = revert 本轮提交即回 v0.2.0 形态。

## 迭代记录
### v0.3.0（2026-11-14）
- 改动：SKILL.md（description / §4 / §5 / §9 / 验收）；references（§0.2 / §2.3 / 新增 §3.6）；
  repo-explorer（档二第2步 / 验收）；skill.json（0.3.0 + a4/a5）；evals（+c7/c8）。
- 验证：见 results/0.3.0.json（旧案例零退化 + 新案例通过）。
- 同步：project-dev-skill 仓库同版本发布（首个 release，版本号对齐技能版本）。
