# v0.1.8 — P6 契约显式化：deadline/priority 绑定透传

> rsi-agent（真实外部下游）活体迭代沉淀的契约澄清，回灌内核正式版。commit `0bc4720` + `d9a6658`（docs）。

## 契约文档（`schema/kernel.proto`）
- `deadline_ms` 注释显式化：**相对时长的毫秒数**（非绝对时间戳）
- `priority` 注释显式化：沿用内核调度枚举语义

## 跨语言绑定透传（此前被静默丢弃）
- **Python**（`bindings/python`）：`GuestEnvelope` → gRPC Envelope 携带 `deadline_ms` / `priority`
- **TypeScript**（`bindings/typescript`）：`GuestEnvelope` 同步透传

wire format 零变化（既有字段，仅填充此前缺省的字段位）；下游按需填写，不填行为同旧版。

## 文档
- README「跨语言 L3 绑定」行补充 v0.1.8 透传说明；后续路线第 2 条更新为「外部下游路径已实证（react-agent / rsi-agent）」

## 验证
cargo 29 suites 全绿（含 conformance P2/P5）· python `import` OK · TypeScript `--check` OK
