# Tasks

- [x] T1 方案与配置档：新增 `config.magpie.json`（base_url / 模型占位 / `retry_attempts: 1`）。
- [x] T2 Phase 0 硬门脚本：`scripts/magpie_check.py`
  - [x] endpoint（`GET /v1/models` 可达且非空）
  - [x] loopback（只监听 127.0.0.1）
  - [x] admin_face（`/api/providers` 不可达，强制 `magpie serve`）
  - [x] isolation（当前账户读不到 `.config/magpie/providers.json`，支持 `--magpie-user` 复核）
- [x] T3 冒烟（R3/R4/R5）：chat / stream / tools / usage / abort（网关不可达时明确 blocked，退出码 2）。
- [x] T4 账本溯源（R1）：`policies/ledger.schema.json` + `scripts/ledger.py` 增 `llm` 段。
- [x] T5 评测溯源（R1）：`scripts/run_evals.py` 记录回答模型、漂移判定、拒绝写漂移基线。
- [x] T6 启动探测（R2 配套）：`run.cmd` 检测配置中的 3425，不可达只提示。
- [x] T7 文档：README 增"可选：magpie 免费模型上游"（账户拓扑、serve、检查、禁忌）。
- [ ] T8 Phase 0 外部前置（需人工，创建资源后执行）
  - [x] 安装 magpie 0.1.2586（sha256 `eec510…` 校验通过）→ `%USERPROFILE%\.local\bin\magpie.exe`
  - [x] 配置免密钥免费 provider（`opencode-zen` 被上游 429；`kilo` 可用）
  - [x] 安装 Bun 1.4.2（npmmirror 镜像，sha256 校验）→ `~\.cache\magpie\bun\1.4.2\magpie-bun.exe`
  - [x] 社区插件：`@magpie-community/opencode-workbuddy-auth`（workbuddy 已登录 zh2673，5000 附加积分）、`@magpie-community/opencode-trae-auth`（trae-cn 已登录行知日记，每日签到 100 积分）
  - [x] 未登录可选：`workbuddy-ai`（国际版）、`trae-global`
  - [ ] 创建本地标准用户 `magpie-run` 并首次登录
  - [ ] 在该账户配 provider+插件，计划任务常驻 `magpie serve`（无 `--addr`，默认 127.0.0.1:3425）
  - [ ] 账户 B 下 `python scripts/magpie_check.py --magpie-user magpie-run` 退出码 0（含 isolation）
- [x] T9 真实冒烟（同账户跑通；隔离门按 T8 待办）
  - [x] `magpie_check.py`：endpoint / loopback / admin_face / chat / stream / tools / usage / abort 全过
  - [x] Kilo：`run.cmd "1+1"` → `2`（`kilo/cohere/north-mini-code:free`，cost 0）
  - [x] Trae CN：`run.cmd "3+4"` → `7`；工具循环 `r1:list_dir(5ms)`（`trae-cn/glm-5.3-flash`）
  - [x] WorkBuddy：`run.cmd "8+9"` → `17`；工具循环 `r1:list_dir(3ms)`（`workbuddy/glm-5.3-flash`）
- [x] T10 magpie 集成进自带 web 前端（超纲新增，替代早先独立控制台方案）
  - [x] presets.py 加「magpie 本地网关（免费额度）」站点预设（key_hint 预填任意令牌）；applySite 支持 key_hint
  - [x] llm-adapter `upstream.status` op：探活 `{base_url}/models` + magpie 扩展 `/v1/magpie/quotas`、`/v1/magpie/usage?period=30d`（失败静默）
  - [x] host 端点 `GET /api/upstream/status`（转发）与 `POST /api/upstream/start`（幂等 spawn `magpie serve`，CREATE_NO_WINDOW，日志落 `.magpie-serve.log`，仅放行回环 base_url）
  - [x] 前端 LLM 卡片：本地网关状态灯 + 一键启动按钮 + 按账户积分行（剩余百分比/display/重置日）；非回环 base_url 自动隐藏
  - [x] 实测：status（84 模型、WorkBuddy zh2673 + Trae CN 行知日记 quota）、start 幂等（started:false）、浏览器渲染截图核对
  - [x] 早先独立控制台（scripts/console.py / console.html / web.cmd，3426）已删除下线，README 章节改写为集成说明

# Task Dependencies

- T3/T9 依赖 T2
- T8 依赖人工创建账户与额度
- T9 依赖 T8
