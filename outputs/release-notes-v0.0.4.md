# v0.0.4 — 第二轮自迭代（N1-N4）

## 本轮主题：以 trace 实证数据驱动的可靠性修补

| # | 项 | 改动 | 效果 |
|---|---|---|---|
| N1 | 空答案自愈 | 主循环空答案出口：`finish_reason=length` → 定向 K502（`reason=length`，可行动文案）；其余空内容（切网瞬断/上游异常）→ nudge 续跑一轮（仅一次，防持续故障空转），仍空才 K502 | 切网瞬断从「整轮白跑」变为「自动续跑自愈」 |
| N2 | 停实例杀进程树 | `taskkill` 补 `/T` | 面板停实例不再留 python/node 孤儿进程占端口占内存 |
| N3 | bash 输出解码 | `_decode_output()`：UTF-8 优先，按首字节定长切分（ASCII 直出；C2-DF/E0-EF/F0-F4 成段试解码；非法/截断字节 backslash-x 转义保留，零信息丢失）；沙箱/直跑两路 + 描述 + docstring 同步 | 消除中文 Windows 下 GBK 乱码与 `chcp 65001` 仪式（实测 46 会话 62 次）；新增 6 例回归单测 |
| N4 | 版本双轨口径 | Cargo `0.1.21` = 上游 react-agent 快照版本号（**不动**）；git tag `v0.0.x` = rsi-agent 发版线（随功能发布 +1） | 消除「版本漂移」误判，后续发版只动 tag 与 release |

## 质量门

- Python 39/39（含解码 6 例）· agent-loop 66/66 · host lib 23/23 · cargo check 干净
- 补丁层幂等稳态：61 OK / 0 FAIL（`python scripts/apply-tool-patches.py --dry-run` 可复核）

## 附带加固（验证期发现，随本轮入库）

- `apply-tool-patches.py` apply/revert 增加 **ROOT 包含护栏**：测试以假 ROOT 运行时不再误写真实文件
  （根因：内置补丁路径在模块加载时烘焙为真实路径，`patch.object(ROOT, fake)` 拦不住）。
- 清除 15 个 stale `.patchbak`（首补丁时代快照滞留树中曾导致回灌污染）。
- P4a/P4b/E7-C2A 三补丁按 P5b 先例退役（锚点被后到补丁拆散，终态内容已在位）。
- E7 画像断言随 N1a 自愈语义更新（失败路径 rounds/llm_calls 1→2，自愈成本如实上报）。

## 诚实边界

- `_decode_output` 对 GBK 输出呈现为 `backslash-x-NN` 转义混合流（不假装解码成功）；
  模型可按转义反推原始编码。
- host 全量链接测试未跑（运行中的宿主进程锁 exe），以 `cargo check` + `--lib` 测试覆盖；
  N2 taskkill /T 的活体验证随下次面板停实例。
