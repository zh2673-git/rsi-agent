# rsi-agent v0.0.16 发行说明

> 主线：把 38 条发行侧改进回灌上游（补丁 240 → 202），并在 runtime 内正式集成 embedding 双通道。
> 发行日：2026-11-12

---

## 一、38 条补丁回灌上游 react-agent

上一轮盘点的补丁桶里，`GENERIC` 38 条是**发行形态的通用改进**（与 rsi-agent 的业务语义无关），
此前一直靠补丁挂在快照上。本轮把它们整体回灌到上游 react-agent v0.1.23，随后从本地补丁集中删除。

| 组 | 条数 | 内容 |
|---|---|---|
| defer | 12 | 按需装载工具（deferred schema 不进清单 + `load_tools` 报名后下发） |
| turn | 11 | 回合对象（turn_id / trace 游标 / paused 暂停态 / ask_user 暂停与接回） |
| tools | 8 | bash 单行纪律、trace 精读、web_read 预算、compaction pending |
| tests | 3 | `EnvGuard` RAII + 用它替换手动 env 还原 |
| （前置） | 4 | `tools_defer.rs` / `turn.rs` 新建 + `RESERVED_ASK_USER` + `ChatReq` 两字段 |

**为什么顺带修了 `G24`**：该补丁原锚点依赖 `pub resume: bool`，而上游 `contract.rs` 早已移除该字段
（`resume` 语义由 `turn_id` 取代）。锚点不匹配不是「补丁写错」，是**上游已经走到了补丁想去的终点**。
本轮把锚点对齐到 `ChatReq` 的 `attachments` 结尾，并刻意避开 `MemoryMsg` 的同形结尾——
两者都以 `pub attachments: Option<Vec<Attachment>>,` 收尾，锚点必须带上前一行的
「R3 用户附件」注释才能唯一定位（否则字段会插到错误的结构体上，实测会炸出 14 个 E0063）。

**验证**：`cargo test --workspace` 19 个 test binary 全绿，111 passed / 0 failed
（含 `react_mocks` 40 passed、host lib 25 passed、`e2e_web_gateway` 2 passed）。

---

## 二、runtime 集成 embedding 双通道

之前 embedding 只有上游 react-agent 有，rsi-agent 的 runtime 快照里没有。本轮补齐，且**不是将就的接法**——
两条通道都通，都有回落，都能离线测。

### A 通道：模型可调用（`embed` op）

```
{"op":"embed","provider":"openai","input":["文本1","文本2"]}
→ {"ok":true,"vectors":[[...],[...]],"dim":1536,"model":"text-embedding-3-small"}
```

- `llm_adapter` 增 `op == "embed"` 分派 → `_embed()`。**provider 未实现 embed 时给字段级 `K400`，不抛异常**
  （`provider ollama 不支持 embed（该 pack 未实现）`），编排层不会被一个可选能力拖垮。
- `openai_compat.embed()` 走独立的 `/embeddings` 端点，不碰 chat 的 `_build_body`（两者请求形状不同）。
- 响应 `data` 按 `index` 排序后再归一——OpenAI 规范保证顺序，但网关实现未必，排序是零成本的稳健化。
- `registry._validate` 允许**可选** `embed`：不声明合法，一旦声明就校验签名（`embed(payload) -> dict`），
  签名不对在装载期就报错，而不是运行期炸。

### B 通道：脚本直连 HTTP（`EMBEDDING_*` env）

技能脚本不经 agent loop，直接读 env 打端点：

- `passthrough_env()` 白名单加 `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_KEY` / `EMBEDDING_EXTRA_BODY`
- `apply_config_file_to_env()` 增 `embedding` 段映射，与既有 `media` 段**同构**：
  空串不覆盖（面板留空不会抹掉已有 env）、`extra` 对象整体序列化成 JSON env
- 与 `MCP_SERVERS` 同款持久通道语义——改后需重启 host

### 回落链：只配 LLM 也零配置可用

```
EMBEDDING_BASE_URL  → LLM_BASE_URL
EMBEDDING_KEY       → OPENAI_API_KEY
EMBEDDING_MODEL     → text-embedding-3-small
```

### 配置示例

```json
{
  "embedding": {
    "base_url": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "key": "",
    "extra": { "dimensions": 1024, "encoding_format": "float" }
  }
}
```

`extra` 是站点个性出口：部分网关要 `dimensions` / `encoding_format`，不同站点差异继续以配置适配，
不做代码级 provider。保存后重启 host 生效。

---

## 三、验证证据

| 项 | 结果 |
|---|---|
| `cargo test --workspace`（runtime） | 19 binary 全绿，host lib 47 → 49 |
| 新增单测 | `config_embedding_section_applies_to_env` / `config_embedding_empty_key_does_not_override` |
| A 通道 mock 冒烟（7 组） | 确定性、维度、批量一致、单字符串入参、K400 两类、失败注入、未声明能力 |
| 真实 HTTP 路径（9 项） | URL 拼接、请求体、extra 合并、鉴权头、乱序 index 排序、HTTP 400 归一化、缺省回落、显式 model 覆盖、坏 extra JSON 容错 |
| B 通道 | `passthrough_env` 白名单含 4 键 + 子进程实测可读（技能脚本视角） |

`openai_compat.embed()` 的验证用本地假端点跑真实 HTTP（不是 mock 掉 httpx）——URL 拼接、extra 合并、
index 排序、错误归一化这些恰恰是 mock provider 覆盖不到的真代码路径。

---

## 四、补丁集变化

| | 前 | 后 |
|---|---|---|
| 补丁总数 | 240 | 202 |
| 删除 | — | 38 条 GENERIC（已回灌上游 v0.1.23） |
| 新增 | — | 10 条 E1–E10（embedding 集成，可回灌上游） |

`E1`–`E10` 与 `G24` 都是**可回灌形态**（锚点/标记齐备、`--dry-run` 可预演、幂等）。
下一轮 react-agent 发版时可直接 `reflush` 过去。

---

## 五、升级注意

1. **重启 host**：`embedding` 段走持久通道，热改不可达已运行 guest。
2. **不配也能用**：`embedding` 段留空即回落 `LLM_*`，若你的网关同时提供 chat 与 embeddings 则无需任何配置。
3. **网关无 embedding 模型时**：`embed` op 会返回 `K400` 或上游 HTTP 错误，**不会**静默返回空向量。
   本机实测 `auto/deepseek-v4.1-flash` 所在网关的 `/v1/models` 里没有 embedding 模型——这类情况需要
   在 `embedding.base_url` 单独指向有 embedding 能力的端点（这正是双通道分开配置的意义）。
4. **`MOCK_EMBED_FAIL=1`** 是测试注入，生产不要设。
