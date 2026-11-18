// 记忆）→ 保存走 configure 热应用，零重启。增改站点 = 改 presets.py 数据。

// provider.capabilities（P5 能力声明，只读）
{"op":"provider.capabilities","provider"?} → {"ok":true,"provider":str,"capabilities":{能力名:bool}}
// 返回该 pack 声明的 capabilities（缺失回空 dict = 未知）；仅供 UI/选路读取，运行期分派仍看
// chat/embed 是否可调用。能力键：stream / tools / images / embed / models（ollama 另有 num_ctx）。
```