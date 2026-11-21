# IM 通道配置实施 PLAN（T-20261121-08）

## 模式判定
优化模式（既有 IM 网关 + 宿主设置面板的产品化迭代）。

## 四层契约
- UI：设置抽屉新增「IM 通道」tab；密码字段留空不改、只显尾 4 位。
- API：`GET/PUT /api/config` 新增 `external_channels` 段（通用外部通道配置）。
- 持久化：host `config.json` 增 `external_channels`；字段级 merge；secret 脱敏回显。
- 网关：`im-gateway` 配置优先级 env > host config > local > default。

## P/Q/I
- P：host 配置 API 补丁 + UI 补丁 + 网关适配 + react-agent 通用能力回灌 + 双仓发布。
- Q：im-gateway 15+ 测试、主仓 444、node --check、补丁 dry-run、react-agent 测试、真实 IM E2E（用户凭据）。
- I：面板可填凭据；网关读 host 配置；同会话不返回旧答案；通用能力进入上游。

## 迭代记录
- R1 2026-11-21：修 correctness blocker（SSE cursor gate），15 passed。
- R2 待办：host external_channels GET/PUT + IM tab + 网关读取。
- R3 待办：补丁验证 + react-agent 回灌。
- R4 待办：双仓 commit/push/tag/release。

## 回退点
- 补丁：`.patchbak` / `apply-tool-patches.py --revert`。
- 已发布版本不可变；修复出新版本。
