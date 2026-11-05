# PLAN v3：12 文档全量对齐（电影级完备 skill）

> 依据 2026-10-24 全量审计：99 条 V-* 条款 → 完整实现 24 / 部分 20 / 缺失 43 / 错标 8。
> 验收样例：黑洞是怎么形成的-mvmb1dqz（56 镜 / 196.7s / 端到端无人工救场）✓
>
> 下方 P0-P4 为 2026-10-24 的历史快照；后续迭代记录接在本节之后。

## 2026-10-25 运镜自由度与硬约束降级 ✓（代码/测试完成，待确认后重渲）

**问题（用户反馈）**：每一镜结尾都像"突然放大一下"；运镜与动效不够自由、盲重复。

**取证结论**：确实来自项目硬约束，而非模型风格。

1. `planCameraRig` 末段 ease 强制 `power2.in`（加速收势），且 push-in 终值是
   `1 + amp*1.16`（最大）——每镜都在最高速时切走。
2. `deriveCoverage` 对 ≥3.8s 且含重音词的镜头**自动**插 `punch-in 1.16` 硬跳；
   本片 37 镜派生 29 刀，与 V-CAM-005「急推全片≤2 次」自相矛盾。
3. `camera:'none'/'static'` 是**假静止**：default 分支仍从 `amp*0.10` 推到 `amp*0.54`。
4. 幅度只由景别决定（与镜头长短无关），方向由 `shotId` 哈希决定（与构图无关）。
5. V-CAM-002（error）与 V-RHY-010（逐镜 warn）把"每镜必有外层机位"写成铁律。

**理论依据与项目文档的对照**

| 结论 | 依据 | 项目文档现状 |
|---|---|---|
| 运动要有动机，静止也是选择 | Lumet《Making Movies》：没有理由就别动机位；Bordwell《电影艺术》：静止构图 + 镜内表演是成熟语言（小津/北野武/死板喜剧） | V-CAM-002/V-RHY-010 把"无外层机位"等同于幻灯片，误判 |
| Ken Burns 只用于静态图 | Ken Burns 是为**静态照片**注入运动的纪录片手法 | V-CAM-006 已正确限定"静态用户图片"；V-RHY-010 却引用它要求每镜必动，属越界扩写 |
| 切点前应收住运动 | Murch《眨眼之间》Rule of Six：情绪 51% > 眼位 7%；切在视线静止处最不刺眼 | 引擎反其道而行：末段加速到切点 |
| 急推是标点不是常态 | 韦斯·安德森式 snap zoom / 港片急推是低频强调 | V-CAM-005 写"全片≤2 次"，自动派生却造了 29 次 |
| 覆盖是开机前的导演决策 | 镜头清单（master/单人/插入）在拍摄前定，不能由后期代剪 | docs/04 把 coverage 写成导演可选字段，代码却默认自动派生 |
| 表演语汇自带静止 | comedy-pop 风格包 `performance` 写"定格+内心独白" | 与"每镜必动"直接冲突 |

**方案（保留不可例外的安全边界，降级创作类约束）**

- 末段 ease 默认 `power2.out`（减速落定）；`punchOut` 显式开启才 `power2.in`。
- `deriveCoverage` 自动派生默认关闭，逐镜 `visual.params.autoCoverage=true` 才开；
  导演声明的 `coverage` 始终生效（那是导演的镜头清单）。
- `static/none` 变成真静止：不生成机位分段，`buildRigScript` 返回空串。
- 行程随镜长缩放（`clamp(镜长/3.5, 0.45, 1)`）：短节拍镜不给满幅位移。
- 方向改由构图推导（主体偏左就往右带，回到中轴），哈希只做正中的平局裁决。
- 新增逐镜覆写 `cameraAmp`（0-2.5）/ `cameraPunchOut` / `cameraDir`（读 `visual.params`）。
- V-CAM-002 改为**词表校验**（未登记词报 error，static 合法）；V-RHY-010 改为
  **全片配比统计**（静止占比 >60% 或运动式 <2 种才 warn）；V-RHY-004 由"三路全中"
  改为"三路至少两路"（静止镜的机位腿由主体 pulse 承担）。

**替代选项与取舍**

- 只改默认值、保留"每镜必动"：不解决 V-CAM-002 的 error 级拦截，用户仍无法写静止镜。
- 完全删掉 V-CAM-002/V-RHY-010：失去"全片全是静止"的兜底报警，且拼错运镜词会静默退化。
- 选当前方案：**安全边界（词表/同步/重叠/累积上限）不动，创作自由度（动不动、多快、往哪、切不切）交还导演**。
  静止镜仍有 60% 配比闸、重音仍有 ≥2 路载体闸，画面不会退化成真幻灯片。

**验收**

- 71/71 单元测试通过（新增：覆盖切默认关、末段 settle/punchOut、真静止、amp/dir 覆写）。
- 存量工程：`--only` 重合成后 `logs/camera-rig.json` 应出现 `segments: []` 的静止镜、
  末段 `ease` 全为 `power2.out`（除显式 punchOut）；`cut-audit.json` 的 microCuts 归零。
- **重渲待用户确认后执行**（本方案只出代码，不出片）。

## 2026-10-25 风格素材语言 + 3D 原语 ✓（全部完成）

**审计结论**：风格包此前只管配色/字体/节奏，场景按旁白语义独立选型，两条链路正交——
结果可能是"配色像这一派、画材不像"；引擎也没有真正的 3D 能力，纵深只能靠缩放糊弄。

**方案与取舍**

- 风格包新增 `visuals` 素材语言契约（`dimension` / `motifs` / `sceneBias` / `sceneDeny` /
  `texture` / `note`）。为什么这么做：风格是"画什么 + 怎么画"的统一约束，配色只是其中一层。
  替代选项：只在 prompt 里写风格描述（不可校验、每次漂移）／维护固定模板表（无风格自由度）。
  为什么这样选：契约可 schema 校验、路由确定性可测，LLM 链与离线链共用同一份约束。
- 分镜候选池路由：`sceneDeny` 剔除、`sceneBias` 同分前置、全禁用回退原池；
  LLM 选到池外形态强制回退，漂移由 V-STYLE-008 记录。
- 5 个 CSS 3D 原语（orbit / depth / tilt3d 等）+ 2 个 3D 场景模板（iso-stage / depth-layers）。
  替代选项：WebGL/three.js（新增依赖、快照不稳定）／只写 prompt（不可复现）。
  为什么这样选：零依赖、GSAP 有界补间、逐帧 seek 纯函数可复现。
- V-STYLE-008 一致性校验（场景侧 + compose 闸门）：bias/deny 冲突报错；镜头用禁用形态、
  2d 场景混 3D、css3d 场景无 3D/无母题逐镜告警。
- 7 个风格包全部登记 `visuals`（周星驰式 css3d / 电影感暗调 mixed / 苹果发布会 2d …）。

**完成情况**：代码、7 个风格包配置、文档（docs/05、docs/10、docs/11、SKILL.md、README.md）全部落地。

**验收**

- 70/70 单元测试通过（含 tests/style-visual.test.ts 13 条）。
- 真实 Chromium 逐帧 seek：同一 t 两次截图 SHA256 完全一致（3D 可复现）；不同 t 画面确实变化。
- 两个 3D 模板在 css3d 风格下过校验、在 2d 风格下正确触发 V-STYLE-008 告警。
- 演示片（12s / 1920×1080 / 30fps，无音轨，验收后随 demos 目录清理）：
  ① 周星驰式 css3d 等距舞台 ② 电影感暗调 mixed 三层纵深 ③ 苹果发布会 2d 平面排版，
  三镜帧间像素变化均确认（3D 转台/景深推进/排版进入各自生效）。

**附带修复**：`MV.camera` 的 `fromTo/set` 未传 position，被 GSAP 追加到时间线末尾
（实测 camera 起点排到 47s，整镜推轨等于没发生）→ 全部显式传 `0`，全片机位运动恢复。

## P0 错标与失效修复 ✓（全部完成）

- [x] V-SCENE-005 ID 冲突归位；V-RHY-002 warn→error；V-STYLE-004 warn→error
- [x] V-RHY-007 借号修正；V-SCP-001 去架空（缺功能即 error）；render.log ensureDir

## P1 电影级密度核心 ✓（全部完成）

- [x] W1 编剧密度：TARGET_SEGMENTS 按密度推导（30/90/144）；Script IR 补 mood/emphasis/pausesMs；
  V-SCP-004 钩子前置（error）+ V-SCP-005 字数档位（warn）；--script 注入同过校验（堵豁免通道）
- [x] W2 剪辑节奏：V-RHY-001 剪切点候选集（error）+ A8 cut-audit.json；
  V-RHY-004 重音三联动（error，compose 联合检查）；V-RHY-006 节拍密度（warn，data-beats）
- [x] W3 分层画面引擎：canvas 程序时长自适应缩放（K 系数）；主体 pulse 节拍；
  V-CAM-006 分镜层默认运镜（none 禁止）；V-COMP-005 排版律下限扫描（error）
- [x] W4 镜头库：canvas:s01~s08 程序族轮转 + beat 章节名 kicker + 色温三循环

## P2 声音部完备 ✓（全部完成）

- [x] MixPlan schema + 工件入 IR（A9）；DUCK_RATIO 死代码激活（sidechaincompress ducking）
- [x] 程序化 BGM（三正弦 pad + tremolo + lowpass）；whoosh@甩镜/擦除/横推 / hit@冲击切与重音镜（硬切、溶解不出音效）
- [x] timeline.sfx 真数据（V-CMP-005 校验器停止空转）；BGM/音效 clip 进渲染工程
- [x] subtitles.srt 导出（emphasis 词优先高亮）；V-SND-001 三层混音校验（error）

## P3 导演/美术工件（部分完成，余项见"遗留"）

- [x] 色彩脚本：Shot.colorTemp 字段 + V-COL-002（error）/ V-COL-003（warn）
- [x] A6 摄影计划 / A7 表演设计工件（logs/artifacts/*.json）
- [x] V-MOT-008 时长 token 纪律（warn）；V-SCENE-005 复述旁白归位
- [x] 场景扫描族（2026-10-24）：V-MOT-001 缓动白名单 / V-MOT-004 staging 透明度 / V-MOT-005+V-ACT-004 位移急停 /
  V-MOT-008 时长档位(error) / V-MOT-010+011 并发约束 / V-COMP-001 主语唯一 / V-ACT-005 长镜微动（warn）；
  模板实修：comparison 运动目标 5→3（V-MOT-010）、comic-symbol 强调 900→1200（V-MOT-008）、
  atmosphere 云层 4000→2000、hint 0.85→0.7（V-MOT-004）；scripts/check-templates.ts 消除 {{token}} 盲区
- [x] V-STYLE-003 组合确认门（error：流程门）：agent 自由组合（lineage/overrides 非空且非 user-specified）
  即使 --yes 也停在 storyboard，须 make-video confirm 显式放行；3 条单测
- [x] 「根据剧本拍电影」两层落地（2026-10-24）：
  ① 语义分镜确定性层 src/domain/scene-semantics.ts——templateStoryboard 禁止索引轮转（凑镜头数根源），
  按旁白关键词选 MV 模板（流程/对比/数据/氛围）与 canvas 程序主题（s01 引力钩子…s08 终幕）；
  零命中走全历史 LRU，8 程序全片均匀覆盖、相邻不重复；scripts/semantics-report.ts 用参考片 56 段实测
  （分布 s01:11/s02:7/s03:6/s04:9/s05:6/s06:5/s07:7/s08:5，恒星死亡章节集中命中 s04、EHT 章节命中 s07）
  ② LLM scene 个性化接线 + 带反馈重试——drawScene 先走 LLM 生成（SCENE_SYSTEM_PROMPT 硬性契约），
  校验器意见回传重试 SCENE_LLM_RETRIES=2 次，耗尽/无 scene 能力回退 forge 兜底；工件记 origin=llm/forge；
  ensureAssets/state-engine 贯穿 llm；tests/semantics.test.ts 8 条
- [x] agent 场景接入面（2026-10-24）：CLI `scene --shot <id> --from <html>`（adoptSceneFile）校验+落盘+时间线作废，
  未过校验返回逐条反馈；drawScene 幂等化——Scene_*.html 已存在则校验后沿用（agent/人工精修受保护），
  违规精修带反馈报错；canvas+MV 混合评分（强语义 ≥2 线索切异质形式，cosmos 配方混入 chart/comparison/flow；
  flow/comparison 卡片去裸色 #fff→token）；跨阶段自动重试修复（failed 只许→pending，runBatch 回退上游
  sourcing 幂等重做并返回回退标志）；验收片3：黑洞是怎么形成的-mvmdcr9y（56镜/5900帧/196.7s，
  chart 落位 s39）；【渲染铁律】长渲染必须台前进程跑，Start-Process 后台链路会被环境回收
  （render_cancelled_parent_exited 两次复现）
- [x] 逐镜原创成为默认（SKILL.md 工作规则第 8 条铁律）：配音完成后、合成前，agent 必须逐镜亲手作画
  （读旁白+导演批注 → 专属构图与动效 → make-video scene 过闸落盘，不过闸按反馈改）；
  模板 forge/语义轮转仅为无 agent 兜底；已落盘场景受幂等保护
- [x] 端到端实证：黑洞是怎么形成的-mvmffyrf——agent 逐镜手写 56 幕原创场景（projects/黑洞是怎么形成的-mvmffyrf/tools/legacy/scenes-a/b/c.cjs，
  美术方向「观测者之眼」，每镜独立构图：命名环/问号/拔河/点云坍缩/双钟/漏斗/天平/暂停符/秒表/
  分叉图/条形对比/旋臂星系/质量阶梯/银心/数字读出/轨迹追踪/噪声显影金环/对勾纸页/瞳孔/双联画/
  帷幕揭示/心轨/书页掀角），56/56 过 V-* 闸门，196.7s 1080p h264+aac；
  scripts/adopt-all.mts 批量接入 + scripts/reset-stage.mts 阶段回拨（done→compose 重合成）
- [ ] 遗留：V-MOT-002/003/006/007/012、V-ACT-001~003/006、V-COMP-003/004/006/007、
  V-CHT-002/003/004、template-gallery 索引 + SceneProps zod、LLM scene 个性化接线 + 带反馈重试、
  V-COL-005 色板家族、V-STYLE-002 弱项补齐/003 组合确认门/007 漂移检测

## P4 工程完备（部分完成，余项见"遗留"）

- [x] V-RND-002 渲染锁；V-RND-003 补分辨率校验；doctor 补 chrome 检查
- [x] V-STE-002 逐镜先持久化（并发 save 原子写按文件串行化 + EPERM 退避重试）；
  V-STE-005 destroy 逆序（stop→释放副本；clean 只回收中间产物，out/与 project.json 永不回收）；
  logs/run.log append-only JSONL 事件日志（emit 统一出口，带 ts）；tests/engineering.test.ts 3 条
- [x] 新配方 cosmos-cinematic（canvas 模板族）+ 风格包 cinematic-dark
- [ ] 遗留：CLI ChangeStyle/ReplaceMaterial、recipe-save、v1.5 两风格包、
  测试矩阵（每 V-* 一条单测；当前 35 条测试）

## 验收记录（2026-10-24）

- 参考片：projects/黑洞是怎么形成的-mvmb1dqz/out/*.mp4 — 196.67s（3:16），56 镜，
  全流程 `init --script → storyboard → confirm → run --yes` 一次通过，零人工救场。
- 触发并拦截过的真实违规（证明闸门有效）：beat 名不匹配（V-SCP-003）、注入讲稿缺功能（V-SCP-001）、
  运镜缺失（V-RHY-004）、模板表演缺位（flow.html 静默失配被三联动暴露）。
- 交付物：mp4 + subtitles.srt + cut-audit.json + mixPlan（IR）+ photography/performance 工件。
- 测试：29/29 通过（tsc 0 错误）。

## P5 素材猎取 + 真实播放 + GPT-SoVITS 接入（2026-10-25）

### 目标

1. 用户说「按主题/风格找素材」时，agent 用自身检索工具在互联网找与讲稿内容对应的真实素材（人物/风景/物体/年代背景），代码只提供需求单、入库校验、风格化呈现、真实播放；不绑定任何固定图库。
2. 用户不说找素材时，维持 `assetPolicy=auto` 的全代码绘制，不联网、不调用生图。
3. AI 生图必须经用户显式授权，代码级闸门拦截，禁止静默消耗额度。
4. 视频素材真实播放，不再退化为首帧静图。
5. GPT-SoVITS 作为新的 TTS provider 接入，支持参考音频 + 逐字稿的零样本音色。

### 本质定义与时空契约

本质：**素材的「检索」交给 agent（外部时间流），引擎只做「契约 + 呈现」**。引擎不预测互联网内容，只保证素材进入后时空可控。

- 空间归属：素材文件由 `materials/` 独占（复制入库，不引用外部路径）；镜头级副本在 `assets/<shotId>/`；渲染工程内的帧序列在 `remotion/media/<shotId>/frames/`，随 `clean` 回收。
- 时间流形态：`material-plan → 检索(agent) → add-material → storyboard/confirm → compose → render` 顺序管道；播放时间轴由 GSAP 补间驱动，帧索引是合成时间的纯函数，保证逐帧 seek 可复现。
- 规则拦截：素材合格性在入库时校验（分辨率/比例/时长）；AI 生图在 compose 前由 `meta.aiConsent` 拦截；视频帧数在 compose 时按镜头时长封闭计算。

### 分层落点

| 时空层 | 文件 | 改动 |
|---|---|---|
| 数据规范 | `src/core/schema.ts` | `StyleMediaSchema`（grade/grain/vignette/letterbox/motion/fit）、`visuals.media`、`ProjectMeta.aiConsent` |
| 数据存储 | `src/domain/asset-sourcing.ts`、`src/infrastructure/ffmpeg-utils.ts` | 素材索引扩展（width/height/来源/授权/显式 tags）、入库校验、帧序列抽取 |
| 数据流转 | `src/infrastructure/llm-client.ts`、`src/domain/material-plan.ts`（新）、`src/domain/composer.ts` | `material-plan` 任务与规则兜底；视频镜改帧序列播放；调色读风格包 |
| 数据接口 | `src/interfaces/cli.ts` | `material-plan`、`add-material --shot/--tags/--url/--license`、`confirm --allow-ai`、`ttsProvider` 接受 `sovits` |
| 数据存储（音频） | `src/infrastructure/tts-client.ts` | `GptSovitsTtsClient` + provider 注册 |

### 阶段与验收

- **A 素材契约**：schema + 索引扩展 + 入库校验（V-AST-006）。Q：宽度<1280 必须拒绝（err），宽度<1920 与比例偏差>12% 只告警（warn，竖构图人物照允许，由 `fit: contain` 兜底）；I：存量 `add-material <files...>` 行为不变。
- **B 需求单**：`material-plan` 输出每镜 `{shotId, need, query, type, mustHave, avoid, reason}`；抽象概念/数据段强制 `code-scene`。Q：无 LLM 时规则兜底产出同样的 schema；I：不改 storyboard 现有决策。
- **C 风格化呈现**：`buildMediaComposition` 读 `visuals.media`；缺省值等于当前写死值。Q：未配置风格包时像素等价；I：素材内容不重绘。
- **D 真实播放**：`stageMedia` 视频抽帧（默认 24fps、1920 宽、循环补足镜头时长），GSAP 补间按合成时间换帧。Q：成片抽帧核对画面在变；I：时间线时长不变，音画仍同步。
- **E AI 闸门**：`visual.kind='cloud'` 且 `aiConsent=false` → compose 报错。Q：未授权必失败；I：授权后原云端路径可用。
- **F GPT-SoVITS**：`MV_TTS=sovits` 走 `/tts`，参考音频+逐字稿零样本；输出 WAV 用 ffprobe 量时长。Q：缺 env 时给出可操作报错；I：默认 provider 不变，存量工程不受影响。

### 已评估不做

- 在引擎内内置 Pexels/Unsplash 多源检索：与「agent 自行探索、不绑定来源」冲突，且要维护各家 key 与授权字段。
- 素材镜改走独立 ffmpeg 合成再拼接：会丢掉溶解/擦除转场与统一字幕层，破坏现有剪辑契约。
- 内嵌 `<video>` 逐帧播放：HyperFrames 逐帧 seek，video 解码时钟与截图时刻不可严格对齐（已在 `composer.ts` 注释中记录）。

### 大范围改动合理性说明

- 改动约 600 行、8 个文件。必要性：现有链路只支持「手写单条 query + 手动绑镜 + 文件名标签 + 首帧 + 写死调色」，无法满足「按稿子自动找素材、风格化、真实播放」；分散的小补丁会让素材逻辑散落在 CLI 与 composer 两处。
- 风险控制：所有新行为都有缺省值或开关（`visuals.media` 缺省=现状；`MV_MEDIA_FPS` 可调；`sovits` 需显式选 provider），存量工程零迁移。
- 验证方式：`npm run build` + `npm test` 全绿；素材入库用构造的超小图/超宽图验证拒绝路径；视频镜用 2 秒样片验证帧序列与成片抽帧。

### 执行记录（2026-10-25）

- 代码：`schema`（StyleMedia/aiConsent）、`asset-sourcing`（MaterialInput/checkMaterial/bindMaterial）、`ffmpeg-utils`（extractFrameSequence）、`composer`（素材分支/帧驱动/风格化/V-AI-001）、`material-plan`（新）、`llm-client`（material-plan 任务 + 离线兜底）、`tts-client`（GptSovitsTtsClient）、`cli`（material-plan / add-material 扩展 / confirm --allow-ai / sovits）。
- 测试：新增 `tests/material.test.ts` 10 条；全套 `build` 通过、`test` 81/81 通过。
- 等价性：`visuals.media` 缺省值等于旧写死值，未配置的风格包像素等价；默认 provider 未改。
- 实测：构造 640×360 小图入库 → 非 `--strict` 报 V-AST-006 error 但继续（exit 0），`--strict` 拦截（exit 1）；2 秒 640×360 视频按 24fps/1920 宽抽帧得 55 帧、单帧 1920×1080（循环补足到 2.3s）；`MV_TTS=sovits` 缺 env 时给出可操作报错（exit 1）；`material-plan` 在 30 镜工程产出逐镜需求单，抽象段全为 `none`。
- 待用户侧：GPT-SoVITS 本机服务 + 参考音频 + 逐字稿就绪后，配 env 跑 `voice` 实测真实克隆音色。

## P6 克隆音色定档：Qwen3-TTS（2026-10-26）✓

**为什么这么做**：GPT-SoVITS 实测暴露两类硬伤——参考音频码率低时克隆失真、合成偶发飘字
（同条件 6 句 ASR 只有 5/6 全对），且语速 >1.15 会压变形字音。音色"像"和念得"对"同时要，
需要换更强的克隆引擎。

**替代选项**：CosyVoice2/3、F5-TTS、IndexTTS2.5、VoxCPM2 同代开源克隆；或不换引擎，
继续调 GPT-SoVITS 参数 / 连生成多次取最优。

**为什么这样选**：Qwen3-TTS-0.6B（2026-01 开源）公开指标领先（多语种 WER 1.835%、
音色相似度 0.789 优于 ElevenLabs），0.6B 版仅需 4GB 显存本机可跑；实测同参考音频下
6/6 逐字全对，胜过 GPT-SoVITS 的 5/6，且按语义自适应语气节奏，接近自然说话。

### 执行记录（2026-10-26）

- 代码：`tts-client` 新增 `Qwen3TtsClient`（`MV_TTS=qwen3`，常驻 worker `scripts/qwen3_tts_worker.py`
  模型只加载一次，stdin/stdout 传 JSON 逐句合成）；`GptSovitsTtsClient` 保留为备选 provider。
- 定档配置固化：`scripts/run-voice.mjs`（模型目录/参考音频/逐字稿/语速一键入口），
  参考音频与原始录音、FunASR 校验脚本存个人文档 `c:\Users\LX\Documents\录音\make-video语音资产\`，不入库。
- 环境坑：onnxruntime 1.31 导入即崩（0xC0000005）须降 1.20.1；qwen_tts 依赖 SoX 可执行文件；
  独立 venv（`C:\Users\LX\.cache\qwen3tts-venv`）避免污染其他 torch 环境。
- 实测：6 句旁白 ASR 逐字全对（GPT-SoVITS 同条件 5/6）；用户听感验收通过；
  5 个存量工程全部用新音色重配重渲，成片时长与时间线误差 ≤27ms。
- 清理：GPT-SoVITS 整合包（~10GB）、语音实验中间产物、demos 目录一并移除；
  换声验收纪律写入 SKILL.md 工作规则第 11 条。

## P7 动效语法层：吸收阿杜 + 花叔（2026-11-05）

> 用户诉求：阿杜（`adunext/adu-motion-video`）的 motion 动效丰富且与文案高度契合、
> 花叔（`alchaincyf/huashu-art-motion`）的 vibe 知识大赏同样丰富——make-video 要能做出同级效果。

### 逆向结论：两家强在哪（差异即缺口）

**阿杜 · 动作谱 + 错峰 + 人物主线**

| 手法 | 他的做法 | 本 skill 原有 |
|---|---|---|
| 动作谱八字段 | 每镜写「口播→主体→准备动作→主动作→刹停收势→配角让位→相机路径→声音落点」 | 只有 `motivation` 一个字段 |
| 错峰 | 标题落→人物让位→主卡抬升→邻卡压后；**动作/落点/读字留白三段分开**；禁 `show(...,pop)` 一把梭 | `MV.enter` 只有统一 stagger |
| 连续形变 | 同一对象保留位置与身份，归拢/折叠/展开，1.5–3s | 无 |
| 人物是主线 | 同一个口播框改尺寸/位置/圆角（大窗→角标），不是多个头像 | presenter 恒定角标 + 呼吸 |
| 真实检查 | 表切换处取 `n,n+1,n+2`；正放/倒退/重载同帧比对 | 无 |

**花叔 · 语法选型 + 镜头标点 + 硬 lint**

| 手法 | 他的做法 | 本 skill 原有 |
|---|---|---|
| 9 种解说语法 | y1 扁平科普 / y2 拼贴 / y3 白板 / y4 故事 / y5 动态字 / t1 3b1b / t2 发布会 / t3 财经 | 只有「场景模板」，无「动效语法」层 |
| 按口播选语法 | 「这段在讲什么 → 选画法」对照表 + 两条兜底 | 只有 TEMPLATE_CUES 选模板 |
| 镜头动作表 | 停 / 缓推 0.6-1.5s / 拉远 0.8-2s / 横移 0.5-0.9s / 快推 0.25-0.35s 推 18-32% / 甩镜 0.26-0.3s / 砸入 0.17s 1.55→0.94→1.0 | camera 只有 push-in/pull-out/pan/tilt-* |
| 硬 lint | 快推+砸入+甩 ≤1/3；不连三镜往里推；推近/分钟 ≤8；文字镜 ≤30%；一镜 2-6s；开头 3 秒是具体小场景 | V-RHY-010 只统计静止占比 |
| 画要一直是活的 | 每幕 1 主动作 + 2 母题循环；禁「图片之间做转场」 | 无 |

**共同点（落成门禁）**：动效必须有语义动机（两家都点名批评「每镜慢推几个百分点 = PPT」）；
重音是稀缺资源；画面里一直有事发生（主体动作 × 环境母题分离）；审美判断全部落成能数的比例。

### 本质定义与时空契约

本质：**在美术（画什么）与剪辑（怎么接）之间补一层「动效语法」（怎么动），
让动效由语义决定而不是由模板轮转决定**。

- 空间归属：语法表 + 动作谱是**只读库**（`src/domain/motion-grammar.ts`）；每镜落成的
  动作谱写入 `project.json` 的 `shots[].visual.params.actionSheet`（项目独占，人工可改）。
- 时间执行流：`pickGrammar(narration, ctx)` 是纯函数（同一输入永远同一语法），
  在分镜阶段执行一次；`auditMotionMix` 在 compose 前作为闸门执行。
- 规则拦截：新不变量 V-MOT-013~020 在 compose 前阻断/告警；原语白名单在 scene 校验拦截。

### 方案（四块，按依赖顺序）

**① 原语增补（`templates/motion/motion-lib.js`）**

无 GSAP 时全部降级为静态终态；全部写成有界 repeat 的补间（时间纯函数，逐帧 seek 可复现）。

| 原语 | 语义 | 默认参数出处 |
|---|---|---|
| `MV.slam` | 砸入（大字/数字/盖章） | 花叔 0.17s，1.55→0.94→1.0 |
| `MV.staggeredIn` | 错峰入场（按 `data-rank` 分级） | 阿杜主卡先落、邻卡压后 |
| `MV.morphTo` | 连续形变（旧字退→变容器→新字进，三步串行） | 阿杜「文字与容器错时」 |
| `MV.counter` | 数字滚动（落定在口播时刻） | 花叔 t3/y5 |
| `MV.highlight` | 高亮扫过（荧光笔/红线） | 花叔 y2 |
| `MV.cards` | 卡片流转（抬升→邻卡压后→让位） | 阿杜错峰主次 |
| `MV.punch` | 快推标点 | 花叔 0.28s 推 22% 后停住 |
| `MV.whip` | 镜内甩镜 | 花叔 0.28s + 模糊 |
| `MV.drift` | 慢漂（氛围镜专用） | 花叔 1-4%/s |
| `MV.maskReveal` | 擦除揭示 | 花叔 y3 白板笔尖 |
| `MV.bands` | 色带过渡 | 花叔 y5 fillZoom |
| `MV.motifLoop` | 母题循环（画面一直是活的） | 阿杜「每幕 2 个母题循环」 |

**② 运镜词增补（schema + camera）**：`punch-in`（短推后停住，是标点不是慢推）、
`whip-pan`（甩镜 + 模糊）、`drift`（整镜匀速慢移）。三者进 `CAMERA_MOVES` 词表。
`planCameraRig` 为 `punch-in`/`whip-pan` 生成独立轨迹，并计入全片标点预算。

**③ 动效语法层（`src/domain/motion-grammar.ts` 新建）**

- `GRAMMARS`：9 种语法（y1-y5 / t1-t3 + `b_roll` 兜底），每种带 `cues`（语义线索）、
  `avoid`（不适用）、`motionBeats`（典型动作序列）、`cameraBias`、`textShare`（文字主导占比上限）。
- `pickGrammar(narration, ctx)`：按线索命中 + 结构关系（有数字→t3、有对比→y2…）选型，
  两条兜底（有真实截图→t2/y2；一段只有一个数→t2/y5 大数字）。
- `actionSheet(shot, grammar)`：产出八字段动作谱（prepare/main/settle/secondary/cameraPath/soundCue/…）。
- `auditMotionMix(timeline, grammarByShot)`：混剪审计（相邻重复/单一化/标点超预算/文字占比）。

**④ 场景模板重写 + 新增**

现有 9 个模板普遍是「标题 + 一个装饰圆」——这就是「素」的根因。新增三个富编排模板：
`kinetic-type.html`（动态字：整词砸入 + 色带 + 数字滚动）、
`paper-stage.html`（纸面透视：卡片流转 + 连续形变 + 高亮扫过）、
`deep-stage.html`（深色 3D：纵深舞台 + 快推 + 母题循环）。

**⑤ 新不变量（docs/10 登记）**

| id | 判据 | 级别 |
|---|---|---|
| V-MOT-013 | 快推+砸入+甩镜 ≤ 镜头数 1/3 | error |
| V-MOT-014 | 不连三镜往里推（push-in/punch-in） | error |
| V-MOT-015 | 推近次数/分钟 ≤ 8 | warn |
| V-MOT-016 | 文字主导镜 ≤ 30% | warn |
| V-MOT-017 | 单镜 2–6s（0-5 档位） | warn |
| V-MOT-018 | 开头 3 秒是具体小场景（非纯标题卡） | warn |
| V-MOT-019 | 每幕 ≥1 主动作；同动作族不连 ≥3 | warn |
| V-MOT-020 | 相邻两镜换构图（景别或构图 key 变化） | warn |

**⑥ 人物主线（阿杜 presenter 规则）**：`MV.presenterTrack` 让头像从大窗收到角标
（同一元素改尺寸/位置/圆角），不再恒定角标。落成 `presenterScript` 的可选 mode。

### 替代选项与取舍

- 直接抄两家的完整工程包 / 引入 MotionGit `.motion` 运行时：要新增依赖与另一套 IR，
  与本 skill「project.json 唯一状态真源」冲突，且两家包是「整片模板」不是「动效语法」。
- 只加原语不加语法层：能画得炫，但「与文案契合」无法保证——语法选型才是契合的来源。
- 只加 lint 不加原语：能约束「别做 PPT」，但做不出「丰富」。
- 选当前方案：**语法层（选型）→ 原语层（实现）→ 校验层（约束）**三层同时落地，
  缺一层就是「炫但不契合」或「稳但素」。

### 验收（P/Q/I）

- **P**：doctor 全绿；Qwen3-TTS venv+模型+参考音频可用（已冒烟：4.88s 输出）；numpy 可用。
- **Q**：3 支 30s 案例成片可解码、1920×1080；新校验器在案例上过闸；
  `npx vitest run` 全绿（基线 81 tests）；`logs/camera-rig.json` 可见 punch-in/whip-pan 轨迹。
- **I**：81 个既有测试不回归；schema 只加可选字段（向后兼容）；CLI 命令契约不变；
  motion-lib 无 GSAP 时仍降级静态终态（不空屏）。

### 执行记录（2026-11-05）

（实施后追加）
