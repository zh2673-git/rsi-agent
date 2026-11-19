// models.list
{"op":"models.list","provider"?} → {"ok":true,"models":[str],"models_meta"?}
// models_meta 为可选扩展（ollama 独有）：[{"name","ctx_limit"?}]，ctx_limit 来自 native
// /api/show 的 <family>.context_length（模型原生上下文窗口），取不到省略键；其他 provider 不带。
