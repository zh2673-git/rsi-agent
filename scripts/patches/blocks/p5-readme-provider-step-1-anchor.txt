   ```python
   PROVIDER = {"name": "<name>", "chat": chat, "models": models, "requires_env": [...]}
   ```

   - `chat(payload) -> dict` 签名**必须只有一个参数**（`registry._validate` 会校验）。
   - 异常直接抛出，由分派层兜底成 `{"ok":false,...}`。
2. 缺 env 在 `chat` 内自行报错（`requires_env` 只是文档）。