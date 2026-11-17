# MiniMax vs DeepSeek 性能对比（实测 + 公开基准）

> 实测日期：2026-11-15 ｜ 机器：本机 Windows，走本地代理 `http://127.0.0.1:3425/v1`
> 实测脚本：`.scratch/cmp4.py` / `cmp5.py` / `cmp6.py` / `cmp9.py`（跑完已清理）

---

## 零、先纠正一个型号问题

**不存在「MiniMax H3.1」这个文本模型。**

| 你可能想问的 | 实际是什么 |
|---|---|
| MiniMax **H3** | **视频生成模型**（omni-modal，2K / 15s / 24fps / 32kHz 立体声，11 种语言）。另有 H3-Image。**与 DeepSeek V4.1 不同赛道，不可直接对比。** |
| MiniMax **M3.1 Flash** | **文本模型**，MiniMax 文本侧最新。你本地 `config.json` 正在用的就是这个（`workbuddy/minimax-m3.1-flash`）。 |
| DeepSeek **V4.1 Flash** | 文本模型，CED 架构稀疏 MoE，552B 总参 / 输入激活 8B / 输出激活 16B。 |

本报告按 **M3.1 Flash vs V4.1 Flash** 对比。两者在你的本地代理里都能调通：

```
workbuddy/minimax-m3.1-flash   ctx 1,000,000  out 128,000
auto/deepseek-v4.1-flash       ctx 1,000,000  out 384,000
```
（`opencode-zen/deepseek-v4.1-flash` 直连会 401「OpenCode Zen: Missing API key」，`auto/` 路由组可用。）

---

## 一、本机实测结果

同一代理、同一批题、每题 3 次取中位数。**两模型都是推理模型**（思维链在 `reasoning_content`，答案在 `content`）。

| 测试项 | MiniMax M3.1 Flash | DeepSeek V4.1 Flash | 胜 |
|---|---|---|---|
| 枚举题：求**全部**解（4 个） | **1/5** | **4/5** | DeepSeek |
| 枚举题：答案无假解 | 5/5 | 5/5 | 平 |
| 代码修 bug | 3/3 | 3/3 | 平 |
| 生成代码→真跑→断言全对 | 3/3 | 3/3 | 平 |
| 严格 JSON（无代码块+可 json.loads） | 5/5 | 5/5 | 平 |
| 长上下文 needle 检索（~30k 字） | 3/3 | 3/3 | 平 |
| 指令遵循（只回两个字） | 3/3 | 3/3 | 平 |
| 工具调用（function calling） | 3/3 | 3/3 | 平 |
| **幻觉探测：拒答/存疑** | **4/6** | **6/6** | **DeepSeek** |

### 关键差异 1：完整性 vs 速度

枚举题（求所有解）最能拉开差距，因为**漏解比答错更隐蔽**：

- MiniMax：`hits=[1, 4, 1, 1, 1]` —— **4/5 次只给 1 个解**（"390"），漏掉另外 3 个
- DeepSeek：`hits=[4, 4, 4, 1, 4]` —— 4/5 次给全 4 个解

两个都**没有编造假解**（假解检测 5/5），差别在于 DeepSeek 更愿意把枚举跑到底。

代价是速度：中位延迟 **6.7s vs 13.0s**（DeepSeek 慢约 2 倍），思维链 **870 tok vs 2209 tok**。

### 关键差异 2：幻觉倾向

问三个不存在的东西（虚构法规条文 / 虚构 Python 库 API / 虚构诺奖得主论文），明确告知「不确定就说不知道，不要编造」：

- **DeepSeek 6/6 明确拒答或标注不确定**，0 次编造
- **MiniMax 4/6 拒答，2 次在「虚构 API 签名」上编造**（`pandas_flux_core.merge_quantum()`），且一次返回空内容

对法律条文、类名、API 这类**必须准确引用**的场景，这条比推理分更重要。

### 关键差异 3：输出截断风险

DeepSeek 的思维链明显更长，在 `max_tokens=2000` 时枚举题 **3/3 被截断**（`finish_reason=length`）；MiniMax 同条件 0 次截断。
**给 DeepSeek 配 agent 时，max_tokens 要留够**（本地代理上限 384000，实测给到 8000 才稳）。

---

## 二、公开基准交叉对照

数据源：Artificial Analysis / Vals AI（经 OpenRouter 模型页，2026-11 更新）。

| 基准 | MiniMax M3.1 Flash | DeepSeek V4.1 Flash 1017 | 说明 |
|---|---|---|---|
| Intelligence Index | **29.1**（#28/59） | 28.6（#29） | 基本持平，MiniMax 微高 |
| GPQA Diamond | 86.5–89.3% | 90.4–92.8% | DeepSeek 高 |
| HLE（Humanity's Last Exam） | **48.0%** | 39.2% | MiniMax 明显高 |
| AA-LCR（长上下文推理） | 79.7% | **84.0%** | DeepSeek 高 |
| CritPt（研究级物理） | **22.3%** | 14.3% | MiniMax 高 |
| SciCode | **53.4%** | 51.9% | 持平 |
| Terminal-Bench 4.0 | 25.3% | **26.8%** | 持平（DeepSeek 略高） |
| Vals Index | **55.9%** | 51.3% | MiniMax 高 |
| Vals Legal Index | 67.1% | **71.9%** | DeepSeek 高 |
| Vibe Code Bench v1.1 | 73.9% | **84.7%** | DeepSeek 高 |
| Vals Finance Index | **55.9%** | 57.1% | 持平 |

**第三方基准和实测的结论一致**：两者综合推理能力接近（29.1 vs 28.6），但**风格不同**——MiniMax 在知识/学术类（HLE、CritPt）更强，DeepSeek 在**长上下文、代码实战、严谨性**上更强。

### 架构与规格

| | MiniMax M3.1 Flash | DeepSeek V4.1 Flash |
|---|---|---|
| 总参 / 激活 | 428B / 23B MoE | 552B / 输入 8B、输出 16B（**非对称**） |
| 架构 | MSA（MiniMax Sparse Attention） | **CED**（首个 Causal Encoder-Decoder），视觉文本联合预训练 |
| 上下文 | 1M | 1M |
| 最大输出 | 128k | 384k |
| KV cache | — | 压缩后约为上代 Flash 的 **1/4** |
| 开源权重 | 是 | 是 |
| 官方定价（OpenRouter 列表价） | $0.075 / $0.30 per 1M | $0.0507 / $0.2028 per 1M（83% off 档） |
| 实际均价（加权） | in $0.021 / out $0.503 | in $0.029 / out $0.671 |

---

## 三、给你的结论

### 谁更强

**没有绝对赢家，分场景：**

- **要「不漏」**（枚举、穷举、多约束求解、一次问全）→ **DeepSeek V4.1 Flash**
- **要「不编」**（引用法条、类名、API、事实）→ **DeepSeek V4.1 Flash**（6/6 拒答 vs 4/6）
- **要快、要省 token** → **MiniMax M3.1 Flash**（快 2 倍，思维链 1/2.5 长）
- **要知识密度/学术深度**（HLE 48% vs 39%）→ **MiniMax M3.1 Flash**
- **长上下文、代码实战**（AA-LCR 84% vs 79.7%，Vibe Code 84.7% vs 73.9%）→ **DeepSeek V4.1 Flash**

### 对你这个仓库的实际建议

你的工作负载是 **Agent + 多步工具调用 + 长文档 + 中文法律/视频工程**，据此：

1. **默认仍用 MiniMax M3.1 Flash**（当前配置）——工具调用 3/3、长上下文 3/3、代码 3/3 都过，且快一倍。
2. **但加一道「引用型」任务路由到 DeepSeek**：凡是输出要带法条编号、类名签名、外部 API 名、具体数字的活，走 `auto/deepseek-v4.1-flash`。MiniMax 那 2 次编造正好发生在这个类别。
3. **枚举/穷举类问题**（如「所有满足条件的解」「列出全部例外」）走 DeepSeek——MiniMax 漏解率 4/5，这在做工程时会直接变成 bug。
4. **配 DeepSeek 时把 `max_tokens` 提到 8000 以上**，否则思维链会被截断成空答案。

### 一个可操作的探测建议

你本机代理里这两个都在，可以直接开两个会话对照。或者更省事——用 `auto/beam-free` 路由组，让代理自己挑；不过从上面数据看，**你自己指定模型比让路由挑更可控**，尤其在需要「不许编造」的场景。

---

## 四、复现

```bash
# 列出本地代理可用型号
curl -s http://127.0.0.1:3425/v1/models | python -c "import sys,json;[print(m['id'],m.get('context_length')) for m in json.load(sys.stdin)['data']]"

# 单次调用
curl -s http://127.0.0.1:3425/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" -d '{"model":"auto/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

**注意**：两个模型都是推理模型，思维链在 `reasoning_content` 字段，`content` 只有最终答案。做输出判定时只查 `content`，用 `usage.completion_tokens_details.reasoning_tokens` 单独看思维链开销——本次测试中我一开始把两者混在一起判分，导致 4 项假阴性，修正后才有上面这组数。
