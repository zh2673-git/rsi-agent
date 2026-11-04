---
name: make-video
description: 自动生成视频 skill：输入主题/讲稿/素材，按电影部门制流水线（编剧→导演→美术摄影→采购→声音→剪辑→渲染）产出代码绘制的动态视频成片。支持既有风格选用、参考素材风格沉淀、用户素材同权混合、断点续跑与单镜重试。
---

# make-video — 代码绘制优先的视频编译器

## 何时触发本 skill

- 用户要做视频（科普/故事/广告/教程/新闻/观点/纪录/儿童教育……），给主题、讲稿或素材；
- 用户说"用 XX 风格/感觉做"（周星驰、教父、苹果发布会、Kurzgesagt……）；
- 用户给参考视频/图片说"想要这种"；
- 对已有项目改稿、换素材、重渲染、续跑。

## 核心心智模型（先读这三句）

1. **这是编译器，不是黑盒**：`project.json` 是唯一状态真源，一切决策（素材/风格/
   对位/状态）落 IR；人工精修改 IR 后局部重生。
2. **电影部门制**：7 个部门（编剧/导演/美术摄影/采购/声音/剪辑/工程）+ 14 份工件
   （A1-A14）在部门间交接；LLM 只按表格填空，不自由发挥——翻译损耗由此管理。
3. **风格三层**：规范笼子（10，不许做什么）/ 风格包（11，参数+部门指令集）/
   类型配方（11，八类场景组装）。**registered 风格按登记指令执行，禁止逐镜
   重新解释**（V-STYLE-007）。
4. **字幕策略**（V-CAP-001/002）：风格包可声明 `subtitlePolicy`——
   `full`=整句条（关键词句内高亮，不再叠加独立黄词条）；`keyword`=关键词梗卡
   （贴纸式卡片、微倾角+水平错位、按场景主语位置放对侧避让主体）；`off`=无画面
   字幕（srt 仍全量导出）。project.json 顶层 `"subtitlePolicy"` 可覆写。
5. **转场按词表裁决，不默认设置**（docs/08 ④ + V-MOT-008）：`hard-cut` /
   `smash-cut` / `dissolve` / `whip-pan` / `wipe` / `slide` / `fade-black` 七类；
   除硬切外均为 300-600ms，溶解/擦除/横推通过**视觉轨重叠**实现（两镜同框交叠），
   **禁止淡到黑再亮起**；`fade-black` 只给显式声明它的风格包用；音频仍按原剪切点入。
   风格包 `transitions` 之外的词一律回退并写审计日志。
   **转场由切点动机裁决**：每镜 `motivation` 写清这一刀为什么切（match-cut / 动作 /
   视线 / 情绪 / 节拍 / 景别跳）；`transition` 留空或写 `auto` 时按动机自动选型
   （情绪→溶解，动作·节拍→冲击切，其余硬切）；相邻镜 `exitAnchor == enterAnchor`
   自动判 match-cut 硬切。动机来源三级：导演文案 > match-cut 锚点 > 结构关系反推
   （景别跨两档/同场方位反转/笑点落镜）；审计落 `logs/cut-audit.json`（含
   `motiveSource` 与缺失比例，V-RHY-011）。
6. **一镜可以是一张图，也可以是一次机位运动**（docs/05 camera-rig + V-CAM-002/010）：
   动不动由你决定——`static/none` 是真静止（定帧 + 镜内表演，Lumet「没有理由就不动机位」），
   不是漏填。要动时外层机位按景别 × 镜长给行程、`.subject` 给焦点、构图定方向，三段式
   「进入 settle → 主体漂移 → **减速落定**」；急推收势（`cameraPunchOut`）是标点，
   全片 ≤2 次。逐镜可用 `cameraAmp`（0-2.5）调行程、`cameraDir` 定方向。
   长镜可用 `coverage` 声明镜内换机位点（重音词自动派生默认关闭，需 `autoCoverage: true`），
   切点硬跳不插值——同场景换机位是「覆盖」，整场换画布才是「转场」。
   轨迹落 `logs/camera-rig.json`。软转场默认 J-cut：旁白提前 90ms 入（`audioShiftMs`），
   只移音频 clip 落点，不动时间线时长（V-CMP-001 不破）。
7. **素材三档：默认全画 → 用户点名才找 → 生图必须先问**（P5）。
   - 用户没说「找素材/真实照片/真实场景」时，`assetPolicy=auto` 全片代码绘制，不联网、不调生图；
   - 用户点名要真实素材时，先跑 `material-plan` 出逐镜需求单（`need/query/type/mustHave/avoid/reason`），
     agent 用自己的检索工具按需求单在互联网找，**不绑定固定图库**；抽象概念与数据段一律 `none`，
     继续代码绘制；
   - 找回来的候选**先给用户确认**再入库（`add-material --tags --url --license` 带上语义标签与溯源），
     入库即校验 V-AST-006：宽 <1280 拒绝，宽 <1920 / 比例偏离 16:9 / 视频 <1.5s 只告警；
   - AI 生图是付费能力，**调用前必须问用户**，非必要不用；用户同意后 `confirm --allow-ai` 写
     `meta.aiConsent`，未授权时 `compose` 直接以 V-AI-001 拦下。
   视频素材走帧序列真实播放（抽帧 + GSAP 帧驱动，`MV_MEDIA_FPS` 默认 24），不允许退回首帧静图。
8. **风格决定素材，不只是配色**（docs/11 `visuals` + V-STYLE-008）：风格包声明
   `dimension`（2d / css3d / mixed）、签名母题、偏好与禁用形态；分镜候选池先按
   `sceneDeny` 剔除、`sceneBias` 前置，LLM 只能在池内选。`css3d` 风格用
   `MV.depth/orbit/tilt3d/card3d/spin3d` 做真透视（父级必须 `perspective` +
   `preserve-3d`），2D 风格不得混入 3D 痕迹——漂移会被 V-STYLE-008 记录。

## 风格菜单（用户叫法 → 风格包）

用户说不出参数，只会说名字和感觉。命中即用；未命中走沉淀（见下）。

| 用户可能说 | style id | 一句话气质 | 适合 | 分级 |
|---|---|---|---|---|
| 苹果发布会/极简/高级感 | `keynote-minimal` | 纯黑舞台，一屏一事，大字留白 | promo/tutorial | A |
| Kurzgesagt/科普/扁平插画 | `kurzgesagt-explainer` | 鲜艳矢量，复杂系统可视化 | science-explainer | A |
| Vox/解释类/图表风 | `vox-explainer` | 干净扁平，排版驱动 | science-explainer | A |
| 片头风/图形字/Saul Bass | `bass-graphic` | 网格化字体运动，高对比 | news/opinion | A |
| 韦斯·安德森/对称/童话感 | `anderson-symmetry` | 完美居中，pastel，玩具盒 | story/kids | A |
| 黑色电影/noir/暗调悬疑 | `noir-contrast` | 低 key 明暗，百叶窗阴影 | story/opinion | A |
| 赛博朋克/霓虹/科技感 | `cyber-neon` | 霓虹网格，品红×青，辉光 | news/promo | A |
| 周星驰/无厘头/星爷 | `comedy-pop` | 庄重形式×trivial 内容，破功有真心 | comedy/科普(辅) | A |
| 新海诚/动漫/氛围感 | `shinkai-atmosphere` | 体积云天空，镜头光晕（照片级背景不可） | story/mood | B |
| 吉卜力/手绘/温暖 | `ghibli-painterly` | 纸感暖色，田园慢节奏（手绘工艺不可） | story/kids | B |
| 皮克斯/卡通/儿童向 | `pixar-2d` | 形体语言，圆=友善（3D 不可） | kids | B |
| 塔可夫斯基/极慢/文艺 | `tarkovsky-pacing` | 仅 pacing 模板，无画面包 | mood | C |
| 电影感/正统/纪录片式 | `classical-continuity` | 隐形风格，匹配剪辑，暖调人像（v1.5） | story/口播 | A |
| 口播/大字幕/梗图 | `talking-head-punch` | 关键词大字幕+梗图插入，网感节奏（v1.5） | 口播/科普 | A |
| 王家卫/文艺/抽帧 | `wongkar-wai` | 抽帧拖影，霓虹夜雨，孤独构图（规划） | story/mood | B |
| 卡点/MV/混剪 | `mtv-beat` | 节拍剪辑+速度斜坡（规划，依赖 beats） | promo/news | C |

菜单未命中 → 先按六轴找最近 recipe+style（匹配优先），差异大才走沉淀。
**素材语言速查**：`comedy-pop`=css3d（立体字/转台卡阵只在梗落点）；`cinematic-dark`=mixed
（纵深合成）；`keynote-minimal`/`kurzgesagt-explainer`/`anderson-symmetry`/`noir-contrast`/
`bass-graphic`=2d，并禁用立体舞台/纵深模板。用户点名「要 3D/立体/空间感」而所选风格是 2d 时，
先建议换到 css3d/mixed 包或走风格沉淀，不要私自越维。
**新需求组装公式：成品 = recipe（结构）× style（部门指令）× override（参数覆写）**
（示例：迪士尼童话 = story-narrative × pixar-2d + 借 ghibli 纸感 override）。

**风格选择纪律**：无默认风格；决策必须带 source + rationale 写 IR；无法论证
必须问用户。组合三级：recipe 预绑（常规）→ 参数 override（过校验器）→ 自由组合
（必须用户确认）。

## 新风格沉淀（用户给了参考视频/图片/口述）

五步：**① 输入解析**（ffmpeg 抽帧 + agent 视觉分析，不可用则用户口述）→
**② 匹配优先**（像既有包就建议 override，不像才新建）→ **③ 解剖填空**
（按 anatomy 部门键生成草稿包，展示解剖卡给用户确认）→ **④ 小样对拍**
（草稿包渲染测试片 vs 参考帧并排 review）→ **⑤ 上架**（registered + grade +
provenance 归档）。

铁律：提取**语法**（构图/色彩关系/节奏结构），不提取素材；参考帧禁止进入成片。
`make-video style absorb --from <源>` 触发。

## 类型菜单（八类 recipe）

science-explainer / story-narrative / product-promo / tutorial-howto /
news-brief / opinion-essay / documentary-mood / kids-education。
归不上类按六轴（信息密度/叙事强度/意图极性/情感基调/受众专业度/时长档位）
找最近 recipe + 覆写；还不行就问用户（给 2 个候选）。

## CLI 速查

```
make-video init <主题> [--aspect 16:9|9:16] [--duration-tier 0-5|5-10|10+]
                    [--genre <id>] [--style <id>] [--script <file>]
                    [--materials <dir>] [--asset-policy auto|ask|code-first|real-first]
make-video doctor                              # 环境体检（动手前先跑）
make-video add-material <文件|目录> [--shot sXX] [--tags a,b] [--url <来源页>]
                    [--license <许可>] [--credit <署名>] [--strict]   # 入库即校验 V-AST-006
make-video material-plan [--project <id>] [--style <id>]   # 逐镜素材需求单（给 agent 检索）
make-video storyboard                          # 导演批注+分镜+确认表（一次确认）
make-video draw [--shot sXX]                   # 场景代码生成（模板兜底）
make-video scene --shot sXX --from <html>      # agent/人工原创场景接入（默认工作方式）
make-video import --shot sXX --from <源>       # 素材导入（外部视频抽帧/他项目资产）
make-video stock <关键词> [--project <id>] [--type image|video] [--count N]
                    [--download] [--shot sXX]     # 真实素材检索/下载（需 key，默认关闭）
make-video voice [--shot sXX] [--from <文件>]  # 旁白（TTS 或用户录音，实测时长=时间真源）
                    # MV_TTS=qwen3|edge-py|edge|silent|sovits；qwen3 为定档克隆音色
                    # （配置固化在 scripts/run-voice.mjs，参考音频存个人文档不入库；
                    #   sovits 走 GPT-SoVITS 零样本，MAKEVIDEO_SOVITS_URL/REF_AUDIO/PROMPT_TEXT 三件套）
make-video compose                             # 质量闸门+时间线+合成项目
make-video render [-o out.mp4]                 # 渲染（doctor+锁+输出校验）
make-video run                                 # 全自动（确认点暂停）
make-video status                              # 阶段/镜头/素材缺口/风格决策/验收门
make-video retry [--shot sXX] [--stage XX]     # 局部重跑
make-video clean                               # 回收中间产物（保留成片与 IR）
make-video style list | show <id> | absorb --from <源> | promote <id>
make-video confirm [--allow-ai]                # 确认分镜表，放行采购；--allow-ai 授权云端生图
# recipe-save（好项目沉淀为新配方）为 P2 规划，尚未实现
```

## 工作规则（每次必守）

1. **先 `doctor` 后动手**；环境不全直接报告，不硬跑。
2. **云端生成前每次重新 `connect_cloud_service` 取凭证**，禁缓存复用。
3. **分镜前一次确认**：素材决策 + 风格决策 + 导演批注摘要合成一张表；
   确认事件未到，不进入采购。
4. **素材按项目目录隔离**；用户素材复制入库，禁引用原路径、禁写共享目录。
   项目专属代码同理：画布库/逐镜程序放 `projects/<id>/canvas`（compose 时叠加到 `remotion/canvas`），
   生成器与一次性工具放 `projects/<id>/tools`；`templates/` 只放通用预置，`scripts/` 只放跨项目工具。
5. **长命令落脚本文件执行**（Windows/PowerShell 内联变量会被剥离）。
6. **全程中文交互**；进度到 stderr，结果 JSON 到 stdout。
7. **禁止伪造结果**：生成/渲染失败必须报明确错误，保留现场路径。
8. **逐镜原创是默认（铁律）**：配音完成后、合成前，agent 必须**逐镜亲手作画**——
   读该镜旁白 + 导演批注，为每一镜设计专属构图与动效（HTML + MV.* 原语），
   经 `make-video scene --shot sXX --from <html>` 过校验器落盘；不过闸就按反馈改。
   `draw` 的模板 forge 与语义轮转只是**无 agent 时的兜底**，禁止拿它交差——
   镜头画面的意义对位（"根据剧本拍电影"）不可外包给轮转模板。
   已落盘场景受幂等保护，重生成须显式 `make-video clean`。
9. **切点与机位自检**：合成后看 `logs/cut-audit.json`——每个切点必须带动机或落的候选集，
   全片动机不得只剩一种；看 `logs/camera-rig.json`——末段应减速落定（`power2.out`），
   静止镜应是 `segments: []`（真静止），全片静止占比 ≤60%、运动式 ≥2 种。
   任一条不满足，先改分镜/动机，不要靠换转场词糊过去。
10. **素材自检**：合成前确认每镜模板在风格池内（`visuals.sceneDeny` 未命中），
    `css3d` 风格的场景真的调用了 3D 原语、`2d` 风格没混进 3D；V-STYLE-008 的
    warn 要么修画面，要么改风格声明，不允许「配色像、素材不像」的混搭交差。
    真实素材镜另查三件：入库时 V-AST-006 无 error、视频帧序列已落
    `remotion/media/<shotId>/frames/`、成片抽帧画面在变（不是首帧定格）；
    素材溯源（sourceUrl/license/credit）随索引保存，报告里不得留空。
11. **克隆换声验收**：换参考音频或换克隆引擎后，必须用本地 ASR（FunASR）对合成旁白
    逐句转写，与讲稿逐字比对**全对才采纳**（语速档位同样过这道闸，防变速压字）；
    不过闸就换参考音频或换引擎，禁止带错音出片。

## 方案文档树（深入设计与理论锚点）

```
program.md                    制片人工件：目标/P/Q/I/约束/时空契约
docs/01-项目方案.md           总纲：本质+双视角+部门划分+工件链
docs/02-职能分工总论.md       11 角色谱系/职责矩阵/工件登记表/反模式组织
docs/03-编剧部.md … 09-工程部.md   七个部门的模块四层+工件+校验域
docs/10-视觉与剪辑规范.md      V-* 不变量（公共法律，唯一权威登记处）
docs/11-风格库与类型配方.md    风格包 schema/沉淀流水线/八类配方/分类轴
docs/12-架构总览.md           分层/数据流/技术选型/ADR-1~11/CLI/测试
```
