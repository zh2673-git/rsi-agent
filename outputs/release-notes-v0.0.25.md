# rsi-agent v0.0.25

本版覆盖 `v0.0.24..v0.0.25` 的 3 个文件 / +76 −8（运行体代码，均在 `runtime/`）。

一句话主题：**修掉「选了模型被回退」「偶发空答案」「auto 组不识别平台别名」三个可用性问题**。

## 1. 选模型被后台同步回退
- `app-settings.js`：`mpickSelect()` 与自定义模型输入现在同步 `lastSyncedModel`。此前 `autoSyncModels()` 用旧的 `lastSyncedModel` 回写 `select.value`，会把用户未保存的选择静默改回服务端旧模型；现在后台同步保留当前选择。

## 2. 偶发空答案
- `openai_compat.py`：
  - 非流式：HTTP 200 但正文全空（且无工具调用/思考）判为瞬时错误并重试，不再 `ok:true` 空答案。
  - 流式：正文/思考/工具调用全空时返回 `LLM_EMPTY` 错误，不再 `ok:None`。
  - 正常回复、纯工具调用、仅思考回复均不误伤（离线测试验证）。
  - 空答案经 agent-loop 转为可见错误事件，前端不再静默丢弃成空白。

## 3. auto 路由组识别平台别名（gfmodel / gmodel…）
同一真实模型在各平台 id 不同（`glm-5.3-flash` / `gfmodel` / `gmodel`…），但网关 `/v1/models` 的 `display_name` 相同。此前一键建组只按尾段匹配，漏掉别名，导致 auto 组覆盖不全。
- `routegroups.rs`：`/api/routegroups/options` 新增回传 `models_meta`（name → display_name 映射）；adapter 未回传时为空数组，软降级。
- `app-settings.js`：`rgMembersForTarget()` 优先按 `display_name` 归并别名成员，meta 缺失时回退尾段匹配。

网关侧已按 display_name 补全 15 个 auto 组的别名成员（如 `auto/glm-5.3-flash` 含 workbuddy / trae-cn / qwenwork / qoder / qoder-cn），`routing=smart`、`stays=auto`。

## 验证
| 项 | 结果 |
|---|---|
| `py_compile openai_compat.py` / `node --check app-settings.js` | 通过 |
| `cargo test -p react-agent-host --lib` | 99 passed, 0 failed |
| 前端别名归并离线测试 | `glm-5.3-flash` 归出 5 成员（含 qoder 别名），回退路径 3 成员，通过 |
| 空答案判定离线测试 | 空正文触发错误，正常/工具/思考回复不误伤，通过 |

## 升级注意
- 前端静态资源由 Host 运行时 serve，刷新即生效；Python 插件与 Rust 改动需**重启 Host** 才加载。
- crate 版本 `0.1.23` 与 release tag `v0.0.x` 是两套独立编号，本版不改 Cargo.toml。
