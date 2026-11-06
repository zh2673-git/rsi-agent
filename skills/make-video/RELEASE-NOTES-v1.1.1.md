# v1.1.1 — make-video：修「就一张图片反复放」+ 补内容质量门

> 独立仓库：<https://github.com/zh2673-git/make-video>
>
> v1.1.0 交付了 124/124 全绿的质量门，成片却是**同一批画面循环 3.75 遍**。
> 这一版追根因，把「形式全绿而内容空转」这条验收漏洞堵上。

## 根因（三个 bug 叠加，任缺一个都不会出事故）

### 1. 本地 LLM 端点被静默降级

`llm-client.ts` 的客户端选择条件是 `if (baseUrl && apiKey)`。本地/内网端点
（`http://127.0.0.1:3425/v1`）不需要密钥，`LLM_API_KEY` 为空 → 条件不成立 →
**静默**退回 `TemplateLlmClient`。全程没有任何日志、没有任何校验报错。

修复：baseUrl 存在即走 API（key 允许为空）；未配端点时 `isOfflineTemplateMode()`
显式告知调用方「这是兜底模式」。

### 2. 离线模板用 8 条套话轮转填充

`templateSegmentText()` 按 `i % 8` 取模板，30 段只有 8 句唯一；
场景模板同样 8 镜一循环。**模板引擎没有内容能力，却产出了「看起来完整」的讲稿**，
把「没有内容」伪装成「内容不足」。

修复：删除 `templateSegmentText`，离线脚本每段显式标 `【离线占位】`，
由内容门 V-SCP-015 硬拒——没有 LLM 就不该产出成片，而不是拿套话冒充讲稿。

### 3. 关键任务没有系统提示词和 schema

`buildPrompt` 对 `script` 任务只给了一条通用兜底提示词（"你是视频编译器的 script
部门引擎"），模型不知道要输出什么字段。`director-notes` 同样缺字段说明——即使
真的调用了真实 LLM，也会因为字段名猜错而崩（本轮实测已复现：真实端点返回
`{"shots":[...]}`，下游 `raw.map` 直接 `TypeError`）。

修复：

- 补 `SCRIPT_SYSTEM_PROMPT`（内容纪律三条 + 分段纪律 + 输出 schema）；
- 补 `DIRECTOR_NOTES_SYSTEM_PROMPT`（visualIntent 必须具体、counterpoint 取值与分配）；
- `storyboard` / `director-notes` 的产物是**顶级 JSON 数组**，而
  `response_format: json_object` 只允许对象容器——放开这两个任务的容器形状，
  解析端加 `unwrapArray()` 兼容「对象包数组」。

## 新增内容质量门（`src/core/validators/content.ts`）

v1.1.0 的 124 条校验全在审形式：时长、分辨率、字段齐全、动效预算。
形式合规不等于有内容——所以补了这一组：

| ID | 判据 | 级别 |
|---|---|---|
| V-SCP-011 | 台词去重：唯一句占比 < 80% = 没有内容只有填充 | error |
| V-SCP-012 | 套话黑名单：命中 ≥2 段可套任意主题的空话 | error |
| V-SCP-013 | 主题落地：主题指纹（2 字滑窗）全片命中 < 30% 或零命中 | error |
| V-SCP-014 | 信息密度：全片没有数字或专有名词 | warn |
| V-SCP-015 | 离线占位讲稿（`【离线占位】` 标记） | error（硬闸） |
| V-RHY-012 | 节奏周期重复：画面形态单一或按周期轮转 ≥2 轮 | error |

接入点：`scriptwriter.ts`（讲稿）、`storyboard.ts`（分镜后）、`validators/index.ts`。
**编号更正**：节奏周期门最初误用 V-RHY-011，与既有「切点动机」撞号，已改 V-RHY-012，
文档 `docs/10` 同步登记。

## 顺带修掉的假警报与静默失效

### V-SCP-005 字数口径

拿 `wordsPerMin`（英文单词/分）当中文目标：2.5 分钟档目标 325「字」，而中文口播
真实容量是 60000/220 ≈ 273 字/分（≈682 字）。结果**几乎每一份正常中文讲稿都被报
「字数偏离」**——警告变噪音，门就废了。现口径：档位时长 ÷ `MS_PER_CHAR_CN`（220ms/字），
容差 ±20%。补双向回归测试（正常稿不告警 + 明显过短仍告警）。

### V-SCP-005 编号占用冲突

节奏周期门最初误用 V-RHY-011，与既有「切点动机」撞号，已改 **V-RHY-012**，
`docs/10` 同步登记。

### V-SCENE-006 运镜词静默失效（新增校验）

`motion-lib` 的 `MV.camera` 只认 `push-in/pull-out/pan/pan-left`，其余走 else 分支
「静默 set scale」——**声明了运镜、画面其实没动**。本轮实测到 s09 写 `move:'push'`，
整镜无相机腿，重音载体掉到 1 路，compose 被 V-RHY-004 打回，但根因藏在场景里。

两处修复：

- `motion-lib` 补齐 `tilt-up/tilt-down/punch-in/whip-pan/drift/static` 分支；
- 新增 **V-SCENE-006**：`MV.camera` 的 move 不在词表即报 error，在场景校验期就拦住。

### V-RHY-006 节拍口径

旧判据数 GSAP 裸调用 `.to|.from|.fromTo(`，但场景是通过 `MV.*` 原语封装的
（SKILL 铁律 8 的默认工作方式），源码里**一个裸调用都没有** → 每镜都算 0 节拍，
「每 2-3s 一次视觉变化」在 20/30 镜误报。改为数 `MV.*` 原语调用次数（`motifLoop` 除外，
它是持续循环不是一次变化），复算后 30 镜全部达标。

### emphasis 缺失兜底

`SCRIPT_SYSTEM_PROMPT` 原本没写 `emphasis` 字段，真实 LLM 30/30 段全空 →
字幕零高亮 → V-RHY-004 全片打回。两处补：

- 提示词补「重音纪律」（每段 1-3 个原样摘取的重读词，不得留空）+ schema 加 emphasis；
- `parseScript` 加 `normalizeEmphasis()`：模型没给或对不上原文时，从原文派生 1-3 个
  内容词兜底（跳过虚词开头、优先带数字/英文片段），保证有落点而不是判死。

## 测试

- `npx tsc --noEmit` 干净
- `npx vitest run` **133/133**（基线 124 不回归 + 新增 9 条内容门回归）
- 新测试直接复现 v1.1.0 事故：8 句循环填 30 段必报 V-SCP-011；
  8 模板循环 3.75 遍必报 V-RHY-012；真有内容的讲稿零 error

## 真实案例重跑（验收口径更正）

同一个主题「CPU 流水线如何让你以为电脑很快」，改用**真实 LLM 端点**（`doctor` 报 `llm: api`）
从头重跑，30 镜逐镜原创场景，最终出片：

### 内容

- 讲稿：30 段、**30 句唯一**（唯一率 100%），主题指纹命中 9/15（60%），套话 0 段
- 导演批注：30 条，counterpoint 分布 emotion×10 / evidence×14 / metaphor×5 / parody×1
- 分镜：30 镜、**9 种画面形态**（process-track / flow / comparison / atmosphere /
  typography / paper-stage / chart / kinetic-type / hierarchy-stack），
  景别 5 档全覆盖，机位 7 种
- 语法分布：b_roll×13 / y5_kinetic_type×6 / y4_story×3 / t3_finance×3 /
  y7_system_map×1 / y1×1 / y2×1 / y3×1（motion-audit 仅 1 条 warn：
  b_roll 连续 3 镜同动作家族）

### 成片实测（这是「一张图反复放」最直接的反证）

| 指标 | 数值 |
|---|---|
| 时长 / 分辨率 | 137.8s / 1920×1080 @30fps（4133 帧） |
| 30 镜各抽一帧（镜中后段，避开入场） | **30 张全部互不相同**（MD5 唯一率 100%） |
| 每秒抽帧画面指纹 | 138 秒中 **136 帧唯一（99%）** |
| 逐帧码流 | 每帧 8–24KB，无长段复用帧（画面持续在变） |
| 2fps 帧差均值 | 13.98（0–255 灰阶），静止帧仅 38/276 |

对比 v1.1.0 那一次「30 镜 = 8 模板循环 3.75 遍」：这一版**每一镜的旁白和画面都不同**。

验收产物：`outputs/make-video-cases/cpu-pipeline-v1.1.1-contact-sheet.png`（5×6 contact sheet）。
成片不入库（本地产物）。

## 教训

1. **降级必须显式**：任何"配不上就用兜底"的分支，都要么报错、要么在产物里留痕，
   绝不静默——静默降级是这次事故的总开关。
2. **兜底引擎不许伪造内容能力**：模板能拼结构，不能编内容。宁可不产出，不要假装产出。
3. **质量门要审内容，不只审形式**：124 条全绿那一刻，正是最危险的一刻。
4. **告警要有信噪比**：永远触发的警告等于没有警告，会让后来的人学会忽略它。
