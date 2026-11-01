// guest_sdk：指向内嵌内核 bindings/typescript 的唯一桥接 shim。
// rsi-agent 发行布局：从 plugins/memory/ 上溯 2 级到 runtime/，再进 kernel/。
// 裸说明符 @grpc/grpc-js / @grpc/proto-loader 从内核 index.ts 自身目录向上解析，
// 因此需在 runtime/kernel/bindings/typescript 下执行过一次 npm install。
export { serve, type Plugin, type PluginManifest } from "../../kernel/bindings/typescript/src/index.ts";
