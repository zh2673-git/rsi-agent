   ```python
   PROVIDER = {
       "name": "<name>", "chat": chat, "models": models,
       "requires_env": [...],
       # 可选：声明式能力表（{能力名: bool}），缺失 = 未知
       "capabilities": {"stream": True, "tools": True, "images": False, "embed": False, "models": True},
   }
   ```

   - `chat(payload) -> dict` 签名**必须只有一个参数**（`registry._validate` 会校验）。
   - 异常直接抛出，由分派层兜底成 `{"ok":false,...}`。
   - `capabilities`（可选）：`{能力名: bool}` 扁平 dict（值必须 bool，`registry._validate` 校验）；
     缺失 = 能力未知。仅供 UI/选路读，运行期分派仍看 chat/embed 可调用性。键：
     `stream` / `tools` / `images` / `embed` / `models`（ollama 另有 `num_ctx`）。
2. 缺 env 在 `chat` 内自行报错（`requires_env` 只是文档）。