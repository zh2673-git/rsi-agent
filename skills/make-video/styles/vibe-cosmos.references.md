# Vibe 知识大赏（vibe-cosmos）· 参考档案

> 本文件由 P12 阶段3（2026-11-16）从风格包本体推导生成。
> 风格包是唯一事实源；本文件是它的**人类可读副本**，改了风格包请重新生成。

## 一句话

深黑底 + 金色线条 + 粒子聚字 + 逐词卡拉OK字幕；代码逐帧画出来的知识片

## 适用场景

- short-vibe
- science-explainer

## 用户会怎么叫它

- vibe
- 知识大赏
- 粒子聚字
- 金色线条
- 深空知识风
- 知识短视频

## 部门口径

- **script**：五拍：钩子/立概念/转折/收束/开放问题；一支片只讲透一个知识点，数据逐条核实
- **directing**：每拍一个视觉意图；转折词落点=覆盖切点=BGM 小节线；禁止信息倾倒
- **art**：深黑基底 #0A0A12 + 金色主光 #FFD75E + 紫青辅助；粒子与金线承担结构，光晕承担情绪
- **camera**：缓推与金线引导为主（no-zoom 硬规则内），覆盖切承担转折；相机层与元素层分离
- **performance**：重音词 pulse；粒子聚字定格即重音；禁死寂长镜
- **sourcing**：assetPolicy=auto 全代码绘制；60 秒片不值得找素材
- **sound**：84BPM 合成 bed；转折对齐小节线；旁白区间 sidechain ducking
- **editing**：句读剪切；切点吸附 BGM 网格（±0.5 拍）；60-90s 片约 15-20 切

## 视觉参数

| 项 | 值 |
|---|---|
| 主色 | #FFD75E |
| 强调色 | #7C6CFF |
| 中性色 | #E8E8F0 / #8A8AA0 / #3DD6C3 / #14141E / #0A0A12 |
| 色彩弧 | 黑场粒子微光 → 金线展开 → 转折紫青爆点 → 金字定格 → 开放问题留白 |
| 标题字号 | 0.095 |
| 正文字号 | 0.042 |
| 信息密度 | 0.35 |
| 每镜最多元素 | 3 |
| 留白 | 0.45 |
| 缓动 | sine.inOut |
| 运动强度 | 0.6 |
| 错峰 | 95ms |
| 弹性 | stiffness 150 / damping 19 |
| 节奏曲线 | beat-grid |
| 镜头长度 | 2600-5600ms |
| 素材维度 | 2d |
| 偏好场景 | kinetic-type / deep-stage / typography / atmosphere |
| 禁用场景 | comic-symbol / paper-stage / iso-stage / depth-layers |
| 母题 | particle-converge / golden-line / glow-title / karaoke-subtitle |
| 纹理 | grain / vignette / glow |
| 转场 | dissolve / whip-pan / smash-cut |
| 景别偏好 | MS / CU |

## 来历

- 来源：manual
- 依据：Vibe 知识大赏赛道爆款关键帧参数化（话题播放 12 亿；信息论单条 138 万赞）
- 版本：1.0
- 沉淀时间：2026-11-14
- 验收结论：未对拍：试产 grade B，产出首条成片对拍爆款后按 V-STYLE-005 结论升级
