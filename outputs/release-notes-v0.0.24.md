# rsi-agent v0.0.24

本版覆盖 `v0.0.23..v0.0.24` 区间的**改动 2 笔 / 47 个文件 / +841 −55**
（若把本发行说明也计入，共 48 个文件）：

- 功能：模型三区选择器 + adapter 平台归属回传（P7 链）
- 性能：启动 / 开窗 / 设置页卡顿的针对性优化（详见 §7）
- 运行体代码 8 个文件 / +378 −55（`runtime/`）
- 补丁链 39 个文件 / +463（`scripts/patches/`：13 个 JSON + 26 个 block）
- 本发行说明 1 个文件（`outputs/release-notes-v0.0.24.md`）

一句话主题：**把「152 个模型平铺成一个下拉」换成三区选择器，并把平台归属这件事从
「前端猜」改成「adapter 回传」**。

之前 Magpie 网关的 LLM 设置页只有一个原生 `<select id="llm-model">`，实测网关
`GET /api/models` 返回 **152 个模型**，全部平铺在一个下拉里：没有分组、没有搜索、
每次都要滚动找。本版把它换成「当前生效 / 常用模型 / 全部模型」三块，平台分组折叠、
常用清单持久化，且**不静默换模型**。

---

## 1. 症状：152 项平铺，且前端无从知道平台

改造之前有两个硬约束摆在那里：

1. **152 项平铺下拉**——Magpie 网关是多平台聚合入口，`/v1/models` 里同时有
   `trae-cn/*`、`qoder/*`、`opencode-zen/*`、`kilo/*`……以及 21 个 `auto/*`。
   用户要找一个模型得滚动半个页面。
2. **前端不知道「平台」是什么**——原生 `/v1/models` 每项只带 `owned_by`，
   而 `owned_by` 的语义是**这个模型默认落到哪个平台**，不是**分组归属**。
   照 `owned_by` 分组，`auto/*` 会被拆散到各个平台组里，路由组这一层就丢了。

所以本版的核心判断是：**分组归属必须由 adapter 显式回传，不能让前端去解析原始接口**。

## 2. `models_meta` 契约扩展

`llm_adapter` 的 `models.list` 原本只有一个可选扩展 `models_meta`（ollama 独有，
只带 `ctx_limit`）。本版把它扩成**与 `models` 同序、按需带键**的通用契约：

```json
{"op":"models.list","provider"?} → {"ok":true,"models":[str],"models_meta"?}
```

每项可带：

| 键 | 含义 | 来源 |
|---|---|---|
| `name` | 模型 id（与 `models` 同序） | `/v1/models[].id` |
| `platform` | 所属平台 | `/v1/models[].owned_by`，缺省退化为 id 前缀 |
| `display_name` | 人类可读名（与 id 相同则省略） | `/v1/models[].display_name` |
| `ctx_limit` | 原生上下文窗口 | `context_length` / `context_window`（ollama 仍走 `/api/show`） |
| `route` | 值为 `"auto"` 表示网关路由组模型 | id 以 `auto/` 开头时置位 |

无任何可补充字段的 provider（mock / anthropic 静态清单）整个 `models_meta` 键省略，
前端按「无 meta」降级——**降级路径必须存在**，否则换一个站点整个设置页就空掉。

`runtime/plugins/llm_adapter/providers/openai_compat.py` 的 `models()` 改成
逐项构造 meta 条目；`runtime/plugins/llm_adapter/README.md` 同步契约文本。

## 3. `auto/*` 单列「auto（路由组）」栏

`route="auto"` 的 **21 个** `auto/<slug>` 模型在 UI 里**单列一个「auto（路由组）」栏**，
不与任何平台组混列。理由写进了注释和 README：`owned_by` 只表示它**默认落到的平台**，
把它按 `owned_by` 拆开，路由组这一层语义就没了。

- 路由组栏位**置顶**（网关特有的选择面），其余平台按模型数降序；
- 默认展开规则：搜索时全展开；平台组 ≤4 时全展开；否则只展开**路由组**与**当前模型所在平台**；
- 前端在 `models_meta` 缺失（adapter 未重启）时按 id 前缀 `auto/` 兜底，
  **保证降级态下路由组栏仍不与平台栏混在一起**。

实测网关返回（`GET /api/models`，152 模型 / 152 meta / 21 个 `route="auto"`）的分组结构：

| 组 | 数量 | 组 | 数量 |
|---|---|---|---|
| trae-cn | 30 | qoder-cn | 13 |
| opencode-zen | 24 | qwenwork | 13 |
| **auto（路由组）** | **21** | kilo | 13 |
| qoder | 17 | kiro | 5 |
| workbuddy | 16 | | |

合计 152，即 **8 个平台组 + 1 个路由组 = 9 组**。

## 4. 三区选择器（前端）

`runtime/crates/host/web-dist/index.html` 的 LLM 页把原来一行
`<select id="llm-model">` 拆成三块：

1. **当前生效**——一个状态条，显示模型名 + 平台 + 上下文窗口 + 「路由组」标记；
2. **常用模型**——chips，点一下就切换，☆ 加入 / ✕ 移出；
3. **全部模型**——按平台分组、可折叠、带搜索框。

样式在 `runtime/crates/host/web-dist/style.css`（`.mpick-*`），逻辑在
`runtime/crates/host/web-dist/vendor/app-settings.js` 的 mpick 模块。

### 唯一真值仍然是原生 `<select id="llm-model">`

原生 select **没有移除**，只是被 CSS 隐藏（`#tab-llm #llm-model { display:none !important }`）。
原因写进了代码注释：模型选择在既有代码里有**六处**读它——`curModelName()` /
`rgCatalogHas()` / `MutationObserver` / `keepCurrentAsCustom` / 保存流程 / 自动同步。
换成自定义 DOM 就要牵动六处，判定会漂。所以：

- 「选一个模型」只做一件事：**写 `select.value` 后派发 `change`**；
  `modelPicked`、`syncModelField`、`updateCtxHint`、`rgRenderMissing` 全挂在 `change` 上，
  mpick 不重复实现。
- mpick 模块对老页面做了兼容判断：`#mpick-all` / `#mpick-pins` 不存在就整个跳过，
  不影响既有下拉。

### 安全回退：当前模型不在目录里不得静默换模型

`applyModelCatalog(models, meta, cur)` 的三分支保持原契约：

| 情形 | 行为 |
|---|---|
| `cur` 在目录里 | 选中 `cur` |
| `cur` 不在目录里 | 选中 `__custom__`，自定义输入框填 `cur`，**不改第一个模型** |
| 无 `cur` | 选第一个 |

这条在上一版就立下了，本版原样保留并扩展到 UI：状态条给 `warn` 边框 +
「不在当前目录」标签，chip 也标成 `miss`（**仍可点选**，不因为缺失就消失）。

「拉取模型」按钮的成功提示也改了——旧文案让用户「点 model 下拉」，
而下拉已经隐藏了，改成「在下方『全部模型』里挑，或点 ☆ 加进『常用模型』」。

### 自动同步契约不变

自动同步仍调 `GET /api/models`（**不带 `?provider=`**），按服务端已保存的
provider/base_url 拉目录；手动「拉取模型」才按 UI 里的 provider 取（用户可能正在试
一个尚未保存的站点）。这条区分没有动。

## 5. 常用模型持久化 / 搜索 / 折叠态

| 能力 | 键 / 规则 |
|---|---|
| 常用模型清单 | `localStorage["rsi.llm.pinnedModels"]`，最多 **24** 个 |
| 分组折叠态 | `localStorage["rsi.llm.openGroups"]` |
| 搜索覆盖 | 模型 id、平台名、`display_name` |
| 搜索时分组 | 全部展开（搜到了还要点开一层是反人类） |
| 隐私模式 | `localStorage` 写不进去时静默降级为内存态，不报错 |

常用清单存在**本机浏览器**，刷新与重启 host 都还在。

## 6. 补丁链：为什么改核心区要走 P7A–P7M

`runtime/` 属核心写保护区，只能通过 `scripts/apply-tool-patches.py` 走外挂补丁通道。
本轮补丁链共 **13 条**（`scripts/patches/p7a-*` … `p7m-*`），每条含
JSON 描述 + anchor block + patch block：

| 补丁 | 内容 |
|---|---|
| P7A | `openai_compat.models()` 回传 `models_meta` |
| P7B | `index.html` 三区结构 |
| P7C | `app-settings.js` mpick 模块 |
| P7D | `style.css` `.mpick-*` 样式 |
| P7E | README 的 `models_meta` 契约 |
| P7F–P7J | 路由组常量 / 分组判定 / 排序 / 默认展开 / 降级兜底 |
| P7K | 「拉取模型」提示文案改写 |
| P7L | adapter 注释修正 `route=auto` 的 UI 语义 |
| P7M | README 修正 `route` 契约（auto/* 单列，owned_by 只是默认落点） |

P7L/P7M 是**措辞修正**，应用在 P7A/P7E 之上——这是有意的链式设计：
P7A/P7E 保留从旧基线出发的原始措辞，P7L/P7M 在其上把最终措辞改对。
直接改 P7A/P7E 会让 P7L/P7M 的锚点失效，整条链就不可重放了。

**重放一致性已核对**：从 HEAD 起重放整条 P7 链，6 个相关文件
（`index.html` / `style.css` / `app-settings.js` / `README.md` /
`openai_compat.py` / `runtime/plugins/tools/PLAN.md`）与工作区最终文件**逐字节一致**
（`PLAN.md` 那条属更早提交 `p7-tools-plan-stats-1`，重放时命中即幂等跳过）。

## 验证

| 项 | 结果 |
|---|---|
| `python -m pytest -q` | **441 passed** |
| `tests/test_patch_idempotency.py` | **6 passed** |
| `python scripts/apply-tool-patches.py --dry-run` | P7A–P7M 全部「已应用，幂等跳过」，**0 FAIL** |
| 从 HEAD 重放 P7 链 | 6 个相关文件与工作区**逐字节一致** |
| `node --check runtime/crates/host/web-dist/vendor/app-settings.js` | 通过 |
| `py_compile runtime/plugins/llm_adapter/providers/openai_compat.py` | 通过 |
| 离线 mpick harness（Node 脚本，本次验证用，未入库） | **26 PASS / 0 FAIL** |
| 真实网关 `GET /api/models` | `models=152`、`models_meta=152`、`route="auto"` 21 个、9 组结构 |
| 运行中的 Host（`127.0.0.1:8710`） | 静态资源已含 `mpick-pins` / `mpickPaintGroups` / `MPICK_ROUTE_GROUP`；`/api/models` 实测返回 152 条 `models_meta` |

离线 harness 覆盖：152 模型与同长 `models_meta`、21 个 `auto/*` 的路由组归属、
9 组结构、平台搜索、常用模型持久化与 24 个上限、星标加入/移出、折叠态持久化、
写入原生 select 并派发 `change`、缺失模型落 `__custom__`、「不在当前目录」警告。

### 验证边界（请如实理解）

- **没有真实浏览器点击式 E2E。** 本环境没有 jsdom / playwright，也没有人工点击记录。
  上述 harness 验证的是 **mpick 的逻辑**（分组、搜索、持久化、选中态回落），
  **不是浏览器里的渲染与点击**。上线后首次使用请人工确认一次交互手感。
- 真实网关数据是**只读观测**（`GET /api/models`），未做任何写操作。


---

## 7. 性能优化：启动 / 开窗 / 设置页卡顿

三区选择器上线后实测发现三处卡顿，本版一并修掉（远程 `v0.0.23` 无此问题，均为本地 P7 改动引入或放大的耗时）：

### 7.1 设置页：`change` 不再全量重建 152 项 DOM
- `app-settings.js`：原来每次选模型 / 自动同步回显都触发 `mpickPaintGroups()` 全量重建整棵目录树（约 450 个节点）；现在 `change` 只调 `mpickHighlight()` 切 `.on` class，结构仅在 `mpickRender()`（目录真变了）时重建。
- `applyModelCatalog()` 用 `DocumentFragment` + `replaceChildren()` 一次性换 option：原来逐次 `appendChild` 152 个 option 会让 `childList` MutationObserver 收到 N 次回调、反复触发 `rgRenderMissing()`；现在只产生 1 次变更。
- 搜索框 `mpick-q` 输入加 120ms 防抖，连续敲键只在停手后重绘一次。

### 7.2 启动：LLM 探测 120s → 8s，技能预热串行 → 并发
- `assemble.rs`：LLM 启动探测是软依赖，网关不可达时旧值 120s 会让启动 / 开窗干等两分钟；降到 8s 即降级放行（真正的 chat 请求自带超时与重试）。
- 技能工具池预热重写：`skills.list` 直接回传 `tools_manifest_path`，省掉每技能一次 `skills.load` 往返（18 技能从 36 次串行 gRPC 降到 1 次 list + 并发 install）；`tools.install` 由 `for` 串行改为 `join_all` 并发。
- `assets_plugin.py`：加目录指纹缓存（目录 mtime + 各 `SKILL.md` 的 mtime/size），指纹未变直接复用扫描结果；写盘后 stat 立即变化，故「Web CRUD / 自扩展写盘即时可见」语义不变。`skills.list/load/validate/state` 全部走缓存入口。

### 7.3 新窗口：就绪判定从纯 TCP 改为身份校验
- `instances.rs`：开窗就绪等待原来用 `port_alive`（TCP 连通即返回），既可能探到端口复用后的「别人家」，也不代表子实例装配完成；改为 `identity_alive`（校验 `/api/config` 回显的 `instance_name` 与期望一致），轮询间隔 200ms → 100ms，就绪即退出。删除不再使用的 `port_alive`。

### 7.4 验证
| 项 | 结果 |
|---|---|
| `node --check app-settings.js` | 通过 |
| `python -m py_compile assets_plugin.py` | 通过 |
| `cargo check -p react-agent-host` | 通过 |
| `cargo test -p react-agent-host --lib` | **99 passed, 0 failed** |
| assets 缓存逻辑验证（注入 stub，覆盖内容变更 / 新增目录触发重扫、`skills.list` 带工具路径） | 通过 |

## 升级注意

- 前端静态资源由 Host 直接提供，**刷新页面即生效，无需重编 Rust**；
- `llm_adapter` 是 Host 进程内的 Python 插件，**运行中的实例不会自动重载改过的 Python 模块**：
  已启动的 Host 若要吃到新的 `models_meta` 逻辑，需**重启 Host**（或让 adapter 重新加载模块）；
  实测本次运行中的 Host 已经直接返回 152 条 `models_meta`，说明新逻辑已经在生效；
- 未生效（adapter 尚未重新加载）时前端按「无 meta」降级——平台退化为 id 前缀，
  路由组仍单列（不与平台混列），设置页不会空掉；
- 常见模型清单存在浏览器 `localStorage`，**不随配置同步**，换浏览器/换机器要重新 ☆ 一遍；
- 原生 `<select id="llm-model">` 仍在 DOM 里且仍是唯一真值——外部脚本若直接读它，行为不变；
- 本版**不改** `runtime/Cargo.toml` 的版本号，release 线走 git tag `v0.0.x`；
- `v1.4.x` 是 **make-video 技能**的独立发布线，与本应用线 `v0.0.x` 并行，本版不涉及。
