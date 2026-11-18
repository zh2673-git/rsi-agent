ollama 另有传输通道开关 `OLLAMA_ENDPOINT`：`native`（缺省，走原生 `/api/chat`，
支持 per-request `options.num_ctx` 与 NDJSON 流式）| `v1`（回退 OpenAI 兼容层 `/v1`）。
## provider 能力（capabilities）

各 pack 在 `PROVIDER["capabilities"]` 声明能力表（可选，缺失 = 未知）：

| provider | stream | tools | images | embed | models | 额外 |
|---|---|---|---|---|---|---|
| openai | ✓ | ✓ | ✓ | ✓ | ✓ | |
| anthropic | ✗ | ✓ | ✓ | ✗ | ✓ | 单次 POST 无流式 |
| ollama | ✓ | ✓ | ✓ | ✗ | ✓ | `num_ctx`（原生窗口） |
| mock | ✓ | ✓ | ✗ | ✓ | ✓ | |

`registry._validate` 校验形状（dict，值为 bool）；`provider.capabilities` op 可只读查询。
声明只服务 UI / 选路，不改变运行期分派（仍看 chat / embed 是否可调用）。