# v1.1.0 — make-video P8：动作谱变约束 + 语法前移 + GPU 治理

> 第四轮 make-video 专项迭代（P8）。手法来源：`adunext/adu-motion-video`（阿杜）+
> `alchaincyf/huashu-art-motion`（花叔）。四句话方针：**动作谱是施工图不是参考、
> 语法在分镜期定、母题必须肉眼可见、GPU 不许挂机泄漏。**

## 六项交付

### T0 GPU 治理（真实痛点）
Qwen3 TTS worker 此前合成完常驻显存。现在：空闲超时自动退出（`MV_QWEN3_IDLE_EXIT`，
默认 300s，每次请求重置计时）+ stdin EOF 父死即退；`TtsClient.close()` 三段优雅关停
（关 stdin → 3s 宽限 → kill）；`StateEngine.destroy()` / CLI `run`、`voice` 收尾 /
`voice-multi`、`voice-all` 挂机脚本全部接上释放。

### T1 三块新模板 + 覆盖矩阵
`compare-stage`（中线划下+胜负翻转）、`process-track`（轨道游标推进+站点点亮）、
`hierarchy-stack`（3D 卡叠逐层点亮），各 8–9 原语；8 个 recipe 池接入。
`check-templates` 从哑值校验升级为**模板×原语覆盖矩阵**（≥6 原语或豁免）+
motifLoop amp 可见性预检，15 模板全 OK。

### T2 语法前移（11 种）
新增 `y6_mechanism` 机制拆解 / `y7_system_map` 系统地图；`pickGrammar` 从 compose 期
**前移到分镜期**落 `actionSheet`——确认点的人工改判不再被覆盖。y5 文字主导超 40% 配额
后硬排除（重音是稀缺资源）。

### T3/T4 母题可见度 + 口径修正
V-MOT-022：amp 折算位移 <3px / 过半镜无母题 → warn（渲染实测 amp 0.3 = 静止）。
`hasMainAction` 口径修正：真素材镜（camera≠none）与 b_roll 镜不再误报「无主动作」。

### T5 动作谱变约束（V-MOT-023）
动作谱新增第十字段 `requiredPrimitives`（语法→必选原语，全语法必含 motifLoop）。
**仅在 LLM 施工路径强制**——端到端实测证明 forge 模板选型与语法选型是两条链，
硬套会把整条流水线打回（28 镜全 failed 的教训），模板编舞由 V-MOT-021 把关。

### T6 节奏治理
超长镜（>36 字 ≈8s 且 ≥2 句）分镜期按句界拆 a/b 两镜，后半镜景别进一档
（ZOOM_LADDER 全阶梯）；V-RHY-007 口径同步为 segmentId 覆盖。

## 实战揪出的真缺陷（fix）

LLM 场景把系统提示的教学注释原样抄进 HTML，`wrapComposition` 的裸
`includes('data-composition-id')` 防重判断被**注释文本**骗过 → 跳过合成根注入 →
hyperframes 编译 26 镜全灭。修复：防重判断改认属性/赋值形态正则，注释与选择器
文本不再误命中。**教训：防重判断永远不要用裸 includes——只认语义形态。**

## 实战案例验收（口径更正，见 v1.1.1）

「CPU 流水线如何让你以为电脑很快」（science-explainer / code-first）：
**122.4s / 1080p / 30 镜全 voiced**，stage=done，motion-audit 0 warn 0 error。
语法分布实测：y5×12、b_roll×7、y2×4、y1×4、**y7_system_map×3（新语法进真实选型）**。
案例成片不入库（本地产物）。

> ⚠️ **v1.1.1 更正**：上段的「验收通过」只证明了**形式**（时长/分辨率/镜数/动效审计）——
> 那一次的真实情况是 LLM 端点因缺 `LLM_API_KEY` 被静默降级到离线模板引擎，
> 讲稿来自 8 条套话按 `i % 8` 轮转，30 镜其实是同一批画面循环 3.75 遍。
> 也就是说：**当时所有质量门全绿，成片却是一张图反复放。**
> 这是验收体系的失效，不是案例的失效——详见 v1.1.1 的内容门与协议修复。

## 质量门

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit` | 干净 |
| `npx vitest run` | **124/124**（基线 110 不回归 + 新增 14） |
| `check-templates` 矩阵 | 15 模板全 OK |
| 端到端真实管线 | LLM 编剧→TTS 配音→渲染 122s 成片 ✓ |
