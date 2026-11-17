# vibe 首条对拍差距清单 v1（2026-11-14）

> 对象：`outputs/vibe首条-时间为什么越感觉越快-1080x1920.mp4`（63.4s / 1080×1920 / 30fps / h264+aac）
> 基线：Vibe 知识大赏赛道参数（话题播放 12 亿、头部单条 138 万赞的公开拆解）
> 状态：**客观指标全达标**；逐帧对拍爆款需人工看片，本清单先记下已知的工程差距。

## 一、达标项（本片已验证）

| 赛道参数 | 本片实测 |
|---|---|
| 60-90s 时长 | 63.4s ✅ |
| 竖屏 1080×1920 | ✅（canvas 程序与合成全链 9:16） |
| 第一帧不黑屏 | ✅（frame 10 YAVG≈31，深空底非黑场） |
| 逐词卡拉OK字幕 | ✅（19 cue 词级点亮，重音词金色脉冲） |
| 深底金线粒子风格 | ✅（vibe-cosmos：#0A0A12 底 + #FFD75E 金） |
| 五拍结构 | ✅（钩子→立概念→转折→收束→开放问题） |
| BPM 网格 | ✅（logs/bgm-grid.json：84BPM/24 小节 sidecar） |
| 音频响度 | ✅（集成 ≈-16 LUFS 区间，ducking 生效） |

## 二、已知差距（下一轮迭代项，按影响排序）

1. **切点未实际吸附小节线**：V-RHY-012 目前是审计（warn 记账），不改时间线。
   镜起点被 V-CMP-001（音画同步 <100ms）钉死是正确约束，但覆盖切点与音效
   落点的「吸附器」还没写——需要 compose 期把声明切点吸到最近拍/小节线。
2. **词级时间戳是估算**：逐词点亮按「字位比例 × 句时长」换算（与重音卡点同口径），
   TTS 只给句级时长。快语速下词亮与语音会有 100-300ms 漂移；接 STT 对齐可消。
3. **MV 模板系未做竖屏构图适配**：canvas 程序（s01-s12）已按 W/H 相对量重排，
   但 kinetic-type / deep-stage 等 HTML 模板的版式仍按横屏习惯写——本片镜如果
   分到 MV 模板，竖屏下构图密度会偏。需逐模板过一遍 9:16。
4. **配音未用克隆音色**：本片走 auto 声线；正式发布片应走 `scripts/run-voice.mjs`
   克隆音色入口（v1.3.0 修正过的正确入口）。
5. **vibe-cosmos 仍是 grade B**：V-STYLE-005 未对拍不上架——等人工逐帧对拍爆款
   （构图/字幕密度/切镜频率/色彩）后 `style promote --review` 升 A。
6. **BGM 单一**：只有 84BPM 合成床；`--bpm` 参数已通但缺「按情绪选 BPM/风格弧」
   的配方联动（short-vibe 配方声明了 bgmArc 但合成器还没消费它）。
7. **转场词表偏保守**：dissolve 为主；赛道爆款常用 whip-pan/smash-cut 密集卡点，
   需要在 short-vibe 的 directorialNotes 里按拍位显式声明转场。

## 三、复跑命令

```bash
cd skills/make-video
node dist/interfaces/cli.js run --project 为什么时间会越感觉越快-mwgcjfsp   # 断点续跑
node dist/interfaces/cli.js init <主题> --aspect 9:16 --duration-tier short-60 --genre short-vibe --style vibe-cosmos
```
