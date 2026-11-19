// models.list
{"op":"models.list","provider"?} → {"ok":true,"models":[str],"models_meta"?}
// models_meta 为可选扩展，与 models 同序、按需带键：[{"name","platform"?,"display_name"?,"ctx_limit"?,"route"?}]
//  - platform：模型所属平台。openai 兼容端点取 /v1/models 每项的 owned_by（聚合成网关时即来源平台，
//    如 trae-cn / qoder / opencode-zen），缺省退化为 id 前缀；前端「按平台分组折叠」只靠它，零硬编码。
//  - ctx_limit：原生上下文窗口（ollama 取 /api/show 的 <family>.context_length；openai 兼容端取
//    context_length / context_window），取不到省略键。
//  - display_name：人类可读名（openai 兼容端的 display_name），与 id 相同则省略。
//  - route：值为 "auto" 时表示网关路由组模型（auto/<slug>），仅供 UI 打 badge，不改变分组归属。
// 无任何可补充字段的 provider（mock / anthropic 静态清单）整个键省略，前端按「无 meta」降级。
