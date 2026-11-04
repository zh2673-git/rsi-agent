# make-video — 代码绘制优先的视频编译器

输入主题/讲稿/素材，按**电影部门制流水线**产出由代码绘制的动态视频成片（mp4）。
这不是"AI 画图拼接"，而是一台会拍电影的编译器：`project.json` 是唯一状态真源，
七个部门、十四份工件在流水线间交接，LLM 只按表格填空，翻译损耗由此管理。

## 宣传片

[![《工具理性的牢笼》宣传片](docs/media/poster.jpg)](https://zh2673-git.github.io/make-video/showcase.html)

《工具理性的牢笼：文明越强大，人越容易被手段吞噬》——26 镜、2 分 21 秒，全片由 make-video 代码逐镜绘制。
[▶ 在线观看](https://zh2673-git.github.io/make-video/showcase.html)

## 实战案例：DataDone

[![《DataDone · 纪检监察数据分析》实战案例](docs/media/datadone-poster.jpg)](https://zh2673-git.github.io/make-video/datadone.html)

给真实产品拍的介绍片——18 镜、1 分 57 秒，真实界面截图与代码绘制画面混合，
卡通头像出镜讲解，旁白为本人克隆音色。
[▶ 在线观看](https://zh2673-git.github.io/make-video/datadone.html)

## 特性

- **电影部门制**：编剧 → 导演 → 美术摄影 → 采购 → 声音 → 剪辑 → 工程，七部门 14 工件
  （A1-A14）逐段交接；每一镜都有导演批注、景别机位、对位策略与色温标注
- **风格三层**：规范笼子（50+ 条 V-* 不变量，"不许做什么"）× 风格包（palette/字级/
  运动/节奏/部门指令集，16 个 registered 风格：周星驰、Kurzgesagt、苹果发布会……）
  × 类型配方（八类场景组装结构）
- **风格决定素材，不只是配色**：风格包新增 `visuals` 素材语言契约——视觉维度
  （2D / CSS 3D / 混合）、签名母题、偏好形态（前置候选池）、禁用形态（直接剔除）
  与质感词。分镜只能从风格筛过的池里选，场景按声明长成同一派画材；V-STYLE-008
  逐镜审计「2D 包混进 3D」「声明立体却全程平面」这类漂移
- **真 3D 素材原语**：`MV.depth`（按 `data-depth` 分层景深）、`MV.orbit`（转台）、
  `MV.tilt3d`（透视倾斜）、`MV.card3d`（翻面）、`MV.spin3d`（两轴复合），
  全部是逐帧可复现的 GSAP 补间（非 rAF）；配 `iso-stage` 等距舞台与
  `depth-layers` 三层纵深模板，零 WebGL 依赖
- **逐镜原创铁律**：配音后合成前，agent 必须**逐镜亲手作画**（HTML + MV.* 动效原语），
  逐镜过质量闸门；模板轮转只是无 agent 时的兜底
- **时间真源**：旁白 TTS 实测时长驱动时间线，一秒不虚报
- **字幕策略**：`full` 整句条（关键词内联高亮）/ `keyword` 关键词梗卡（感知画面排版、
  避让主体、微倾角错位）/ `off`，风格包声明默认、项目级可覆写
- **电影级转场**：硬切 / 冲击切（闪白+回弹）/ 交叉溶解 / 甩镜 / 擦除 / 横推 /
  黑场过渡，按风格包 `transitions` 词表裁决，词表外自动回退并记审计；溶解、擦除、
  横推走**视觉轨重叠**（两镜同时在画面里交叠，不再"淡到黑再亮起"），音频仍严格按原
  剪切点入
- **切点由动机裁决**：导演写清这一刀为什么切（match-cut / 动作 / 视线 / 情绪 / 节拍 /
  景别跳），转场类型跟着动机走（情绪→溶解、动作·节拍→冲击切、其余硬切）；导演没写清时，
  剪辑部按客观关系反推（景别跨两档→跳切、同场方位反转→接视线、笑点落镜→接节拍）；
  相邻镜声明同一形状锚点即自动判 match-cut 硬切。动机来源与缺失比例审计落
  `logs/cut-audit.json`
- **镜内机位轨**：外层机位是**可选**的导演选择——`static` 即真静止（定帧 + 镜内表演，
  不再假装推轨）；动起来时按景别 × 镜长给行程、按 `.subject` 找焦点、按构图定方向，
  末段**减速落定**（切点前收住运动），急推收势要显式 `cameraPunchOut` 才开；逐镜可用
  `cameraAmp`/`cameraDir` 覆写。长镜可用 `coverage` 声明镜内换机位（重音词自动派生默认关闭），
  轨迹落 `logs/camera-rig.json`
- **J-cut / L-cut**：软转场默认让旁白提前 90ms 入（声音先到、画面后到），只移音频
  clip 落点，不动时间线时长——音画同步不变量照旧成立
- **真实素材可选接入（三档纪律）**：默认零配置、零网络、零付费，全片代码绘制；用户点名要
  真实素材时，`material-plan` 先出**逐镜需求单**（找什么/图片还是视频/必须含/必须避/为什么），
  agent 用自己的检索工具在互联网找，不绑定固定图库；候选**先给用户确认**再
  `add-material --tags --url --license` 入库，入库即校验（宽 <1280 拒绝，宽 <1920、
  比例偏离 16:9、视频过短只告警）。视频素材走**帧序列真实播放**（ffmpeg 抽帧 + GSAP
  帧驱动，帧索引是合成时间的纯函数），不再退回首帧静图；图片/视频统一套风格包
  `visuals.media` 的调色、颗粒、暗角、遮幅与运镜。AI 生图是付费能力，**调用前必须问用户**，
  授权后 `confirm --allow-ai` 才放行（`V-AI-001` 闸门）
- **断点续跑**：全部状态落 IR，单镜重试、阶段回拨、局部重生成

## 快速开始

```bash
npm install
npm run doctor                                  # 环境体检
npm run dev -- init "你的主题" --genre science-explainer --style comedy-pop
npm run dev -- run                              # 全自动（确认点暂停）
```

真实素材是可选路径（默认全代码绘制，用户点名才会走）：

```bash
npm run dev -- material-plan --project <id>      # 逐镜需求单 → gen/material-plan.json
# agent 按需求单自行检索 → 候选先给用户确认 → 入库（带语义标签与溯源）
npm run dev -- add-material D:\pics\pingjiang.jpg --project <id> --shot s05 \
              --tags 平江路,老街 --url <来源页> --license CC0
npm run dev -- compose --project <id>            # 该镜改走满幅真实素材合成
```

视频素材同样入库，compose 时按镜头时长抽帧补足（`MV_MEDIA_FPS` 默认 24，可 8-30）。
AI 生图默认禁用：确需云端生成时先征得用户同意，再 `confirm --allow-ai` 授权。

## LLM 拿到这个 skill 后怎么跑（端到端流程）

1. **读规范**：本 README → `SKILL.md`（创作规范与自检清单）→ `project-development-prompt.md`
   （工程纪律：四层架构、优化模式、验证三维）。skill 只负责"怎么拍"，所有状态写进 `project.json`。
2. **三步接稿**（固定顺序，不可并行、不可颠倒）：判档（时长档/类型）→ 选主题
   （`style list` / `style show <id>`）→ 选载体（8 类场景 + 场景池）。三步各有独立闸位。
3. **建工程**：`init "<主题>" [--genre ...] [--style ...]` 落 `meta` 与分镜骨架。
4. **出分镜**：`storyboard` 让 LLM **按表格填空**（景别/运镜/切点动机/转场/覆盖/
   对位/色温），产物过 E2 与 V-STE 校验；`confirm` 是人工确认点——确认后才往下走。
5. **全自动或分段跑**：`run` 把「分镜 → 素材 → 场景 → 配音 → 合成 → 渲染」串起来，
   每个确认点暂停，任何一步失败都能断点续跑。若用户点名要真实素材，先
   `material-plan` → agent 检索 → 用户确认候选 → `add-material` 绑镜，再往下跑。
6. **逐镜作画**：agent 写 `scenes/Scene_sNN.html`（HTML + `MV.*` 动效原语），
   `scene --shot sNN --from <file>` 过校验后落盘；模板轮转只是没有 agent 时的兜底。
7. **配音**：`voice` 走 TTS 或采用真人录音，ffprobe 实测时长写回 `shot.voice`——
   这是全片唯一的时间真源。
8. **合成**：`compose` 计算时间线、切点动机与转场、机位轨、字幕、混音计划，产出
   渲染工程并落审计：`logs/cut-audit.json`（切点动机与来源）、`logs/camera-rig.json`
   （每镜运镜/行程/覆盖切）。
9. **渲染**：`render` 调 HyperFrames 出 mp4，校验时长/分辨率/双流，落 `out/`。
10. **自检与重生**：`status` 看阶段与闸位；不过闸用 `retry` / `scene` **局部重生**，
    不整片重来。改稿只改 IR，改完从对应阶段续跑。

每一步的产物都是下一部的输入，LLM 不直接"写视频"，只负责把表格填对、
把场景画对——翻译损耗由此管理。

## 自定义声音（三条路，从快到慢）

1. **换内置声线（最快）**：`voice --project <id> --voice zh-CN-YunxiNeural`，
   加 `--shot s05` 可只换一镜（多角色片就是这样逐镜配的）。
   列出可用声线：`python -m edge_tts --list-voices`。
2. **用你自己的真人录音**：逐镜录音后
   `voice --project <id> --shot s05 --from D:\vo\s05.wav`；采用后 `source=recording`，
   时长以实测为准，重跑 `compose` + `render` 即可。音色完全是你自己的，代价是每镜一条录音。
3. **克隆音色（Zero-shot，Qwen3-TTS，当前定档）**：内置 `MV_TTS=qwen3` provider，经常驻
   worker 调本地 Qwen3-TTS-0.6B——只要一段 3-10 秒参考音频 + 该音频的逐字稿，不用训练模型。
   模型只加载一次，逐镜复用：

   ```bash
   node scripts/run-voice.mjs <project-id>   # 已定档配置一键入口：模型/参考音频/语速全固化
   npm run dev -- compose --project <id>     # 旁白换新后时间线自动作废，重排即可
   ```

   环境变量：`MAKEVIDEO_QWEN3_PYTHON`（venv 解释器）、`MAKEVIDEO_QWEN3_MODEL`（模型目录）、
   `MAKEVIDEO_QWEN3_REF_AUDIO`（参考音频，存个人文档不入库）、`MAKEVIDEO_QWEN3_PROMPT_TEXT`
   （该音频逐字稿）、`MAKEVIDEO_QWEN3_LANG`。

   - 换声验收：合成后用本地 ASR（FunASR）逐字校验，全对才采纳——同参考音频下
     Qwen3-TTS 6/6 全对，GPT-SoVITS 5/6，故定档 Qwen3（`MV_TTS=sovits` 适配器仍保留，
     自行部署 `api_v2.py` 服务即可用）。
   - `voice` 的 `--voice` 传文件路径时视为**本镜专用参考音频**（多角色片可逐镜换音色）。
   - 接别的克隆服务同样只需实现 `TtsClient` 并注册 provider，时序对齐与校验逻辑不用改。

> 旁白时长会驱动整条时间线，所以无论哪条路，都要让 `voice` 重新测一遍时长，
> 再 `compose`——不要手工改 `durationMs`，那是音画同步不变量（V-CMP-001）。

## Demo（Release 附件）

**《导演，再来一条》**（2 分 56 秒，1920×1080 / 30fps，H.264 + AAC）——
本编译器以自身为主题拍的周星驰式无厘头介绍片，见 Release `v1.0.1` 附件。

> 该片 **37 个镜头全部逐镜手写代码纯画**（HTML + `MV.*` 动效原语），不依赖任何
> 第三方图像/视频生成服务；配乐为程序化编写的交响化 BGM，旁白为三条不同声线。
> v1.0.1 相对首版的改动：配乐电平上调约 5dB、转场音效按转场类型分流（不再全片
> "嗖"一声）、37 镜转场逐镜编排（12 硬切 / 9 溶解 / 7 冲击切 / 3 甩镜 / 3 横推 /
> 2 擦除），并放开运镜硬约束——末段改为减速落定、镜内覆盖切默认不再自动派生、
> `static` 成为真静止。

## 文档

- `SKILL.md` — skill 入口与工作规则
- `docs/01-项目方案.md` … `docs/12-架构总览.md` — 七部门设计与 V-* 不变量登记处

## License

MIT
