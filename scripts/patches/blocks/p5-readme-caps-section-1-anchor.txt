ollama 另有传输通道开关 `OLLAMA_ENDPOINT`：`native`（缺省，走原生 `/api/chat`，
支持 per-request `options.num_ctx` 与 NDJSON 流式）| `v1`（回退 OpenAI 兼容层 `/v1`）。