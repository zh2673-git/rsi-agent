import { z } from 'zod';
import {
  ANATOMY_KEYS,
  ASPECTS,
  DURATION_TIERS,
  GENRES,
  SCHEMA_VERSION,
} from './constants.js';

export const ShotStateSchema = z.enum([
  'pending',
  'sourcing',
  'sourced',
  'voicing',
  'voiced',
  'ready',
  'failed',
]);
export type ShotState = z.infer<typeof ShotStateSchema>;

export const StageSchema = z.enum([
  'init',
  'script',
  'storyboard',
  'sourcing',
  'voice',
  'compose',
  'render',
  'done',
]);
export type Stage = z.infer<typeof StageSchema>;

export const VisualKindSchema = z.enum(['code-scene', 'user-material', 'imported', 'cloud']);
export type VisualKind = z.infer<typeof VisualKindSchema>;

// 运镜词表（docs/05 摄影 / docs/10 V-CAM-002）：
// static/none 是**导演的合法选择**（静止构图 + 镜内表演），不是"漏填"；
// 词表只负责拒绝没登记的词（dolly-zoom 这类会静默退化成静止的拼写漂移）。
// P7 增补三词（吸收阿杜 + 花叔）：
//   punch-in = 短推后停住（0.25-0.35s 推 18-32%），是**标点**不是慢推——受 V-MOT-013 预算约束；
//   whip-pan = 甩镜（0.26-0.30s expo.inOut + 运动模糊），视线突然转移；
//   drift    = 整镜匀速慢移（1-4%/s），**只给氛围镜/艺术镜**——解说片每镜都慢推就是 PPT。
export const CAMERA_MOVES = [
  'push-in',
  'pull-out',
  'pan',
  'pan-left',
  'tilt-up',
  'tilt-down',
  'punch-in',
  'whip-pan',
  'drift',
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number] | 'static';

const CAMERA_ALIASES: Record<string, CameraMove> = {
  'push-in': 'push-in',
  pushin: 'push-in',
  'pull-out': 'pull-out',
  pullout: 'pull-out',
  pan: 'pan',
  'pan-left': 'pan-left',
  panleft: 'pan-left',
  'tilt-up': 'tilt-up',
  tiltup: 'tilt-up',
  'tilt-down': 'tilt-down',
  tiltdown: 'tilt-down',
  'punch-in': 'punch-in',
  punchin: 'punch-in',
  punch: 'punch-in',
  'whip-pan': 'whip-pan',
  whippan: 'whip-pan',
  whip: 'whip-pan',
  drift: 'drift',
  slowdrift: 'drift',
  static: 'static',
  none: 'static',
};

/** 运镜词归一化：未登记词返回 undefined（由调用方决定是报错还是兜底） */
export function normalizeCameraToken(raw: string | undefined): CameraMove | undefined {
  return CAMERA_ALIASES[(raw ?? '').trim().toLowerCase()];
}

export function isCameraToken(raw: string | undefined): boolean {
  return normalizeCameraToken(raw) !== undefined;
}

export const CounterpointSchema = z.enum(['metaphor', 'evidence', 'emotion', 'parody']);
export type Counterpoint = z.infer<typeof CounterpointSchema>;

export const SegmentFunctionSchema = z.enum(['advance', 'inform', 'emotion']);

export const ScriptSegmentSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  function: SegmentFunctionSchema,
  beat: z.string().optional(),
  // docs/03：表演/剪辑联动字段（情绪基调 / 重音词 / 停顿标记 ms）
  mood: z.enum(['neutral', 'curious', 'tense', 'awe', 'warm', 'urgent']).optional(),
  emphasis: z.array(z.string()).optional(),
  pausesMs: z.array(z.number().int().nonnegative()).optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const ScriptSchema = z.object({
  fullText: z.string().min(1),
  segments: z.array(ScriptSegmentSchema).min(1),
});
export type Script = z.infer<typeof ScriptSchema>;

export const ZoomSchema = z.enum(['ELS', 'LS', 'MLS', 'MS', 'MCU', 'CU', 'ECU']);

export const VisualSpecSchema = z.object({
  kind: VisualKindSchema,
  prompt: z.string().default(''),
  template: z.string().optional(),
  source: z.string().optional(),
  params: z.record(z.unknown()).default({}),
});
export type VisualSpec = z.infer<typeof VisualSpecSchema>;

export const AssetRefSchema = z.object({
  kind: VisualKindSchema,
  path: z.string(),
  durationMs: z.number().nonnegative().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  meta: z.record(z.unknown()).default({}),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const VoiceRefSchema = z.object({
  file: z.string(),
  durationMs: z.number().nonnegative(),
  voice: z.string().default('default'),
  rate: z.number().default(1),
  source: z.enum(['tts', 'recording']),
  estimated: z.boolean().default(false),
});
export type VoiceRef = z.infer<typeof VoiceRefSchema>;

export const DirectorNoteSchema = z.object({
  segmentId: z.string(),
  visualIntent: z.string(),
  emotionGoal: z.string(),
  referenceMood: z.string().default(''),
  counterpoint: CounterpointSchema,
});
export type DirectorNote = z.infer<typeof DirectorNoteSchema>;

// 覆盖（coverage）：同一场景内的换机位硬切。at 为镜头内归一化时间（0-1），
// 由剪辑部在合成时换算成绝对毫秒并落到相机轨；scale 为相对当前机位的倍率。
export const CoverageSchema = z.object({
  at: z.number().min(0).max(1),
  kind: z.enum(['punch-in', 'reframe']).default('punch-in'),
  scale: z.number().min(0.8).max(1.6).default(1.16),
  xPercent: z.number().min(-12).max(12).default(0),
  yPercent: z.number().min(-12).max(12).default(0),
  rotation: z.number().min(-3).max(3).default(0),
  motivation: z.string().default('emphasis'),
});
export type Coverage = z.infer<typeof CoverageSchema>;

// 合成期落地后的覆盖切点（绝对毫秒，镜头内）
export const CoverageCutSchema = CoverageSchema.omit({ at: true }).extend({
  atMs: z.number().int().nonnegative(),
});
export type CoverageCut = z.infer<typeof CoverageCutSchema>;

export const ShotSchema = z.object({
  id: z.string(),
  segmentId: z.string(),
  narration: z.string().min(1),
  visual: VisualSpecSchema,
  zoom: ZoomSchema,
  camera: z.string().default('none'),
  motivation: z.string().default(''),
  counterpoint: CounterpointSchema,
  gag: z.boolean().default(false),
  // V-COL-002 色彩脚本：每镜色温标注（cool/neutral/warm）
  colorTemp: z.enum(['cool', 'neutral', 'warm']).optional(),
  transition: z.string().default('dissolve'),
  // docs/04 A5：镜头内覆盖 / match-cut 锚点 / J-L cut 音频偏移（±200ms）
  coverage: z.array(CoverageSchema).max(3).default([]),
  enterAnchor: z.string().default(''),
  exitAnchor: z.string().default(''),
  audioShiftMs: z.number().int().min(-200).max(200).default(0),
  state: ShotStateSchema.default('pending'),
  stage: z.string().optional(),
  asset: AssetRefSchema.optional(),
  voice: VoiceRefSchema.optional(),
  failReason: z.string().optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const MaterialDecisionSchema = z.object({
  kind: VisualKindSchema,
  source: z.string().optional(),
  reason: z.string(),
});
export type MaterialDecision = z.infer<typeof MaterialDecisionSchema>;

export const StyleDecisionSchema = z.object({
  id: z.string(),
  source: z.enum(['recipe-recommended', 'agent-chosen', 'user-specified']),
  rationale: z.string().min(1),
  lineage: z.record(z.unknown()).default({}),
  overrides: z.record(z.unknown()).default({}),
});
export type StyleDecision = z.infer<typeof StyleDecisionSchema>;

export const ProjectMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  topic: z.string(),
  aspect: z.enum(ASPECTS).default('16:9'),
  durationTier: z.enum(DURATION_TIERS).default('0-5'),
  fps: z.number().default(30),
  genre: z.enum(GENRES).default('science-explainer'),
  assetPolicy: z.enum(['auto', 'ask', 'code-first', 'real-first']).default('auto'),
  /** AI 生图授权位：只能由用户确认写入，compose 前强制校验（P5-E 闸门） */
  aiConsent: z.boolean().default(false),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export const SubtitleCueSchema = z.object({
  shotId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
  keywords: z.array(z.string()).default([]),
  // 编剧声明的重音词（命中本句者）：梗卡字幕的可信来源；keywords 则混有机械切分词（仅 srt/兜底）
  emphasis: z.array(z.string()).default([]),
});
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;

// 字幕策略（docs/07）：full=整句条（关键词内联高亮）；keyword=关键词梗卡（感知画面排版避让主体）；
// off=不出画面字幕（srt 工件仍全量导出）。风格包声明默认，project 顶层可覆写。
export const SubtitlePolicySchema = z.enum(['full', 'keyword', 'off']);
export type SubtitlePolicy = z.infer<typeof SubtitlePolicySchema>;

export const TimelineSchema = z.object({
  shots: z.array(
    z.object({
      shotId: z.string(),
      startMs: z.number(),
      durationMs: z.number(),
      transition: z.string(),
      // 剪辑部落地字段（docs/08）：镜头内覆盖切点 / 机位运动 / 切点动机 / J-L cut 音频偏移
      coverage: z.array(CoverageCutSchema).default([]),
      camera: z.string().default('none'),
      motivation: z.string().default(''),
      audioShiftMs: z.number().default(0),
    }),
  ),
  subtitles: z.array(SubtitleCueSchema).default([]),
  bgm: z.string().optional(),
  // leadMs：音效相对视觉剪切点的前置量（负值 = 声音先入，见 docs/07 J-cut）
  sfx: z
    .array(
      z.object({
        file: z.string(),
        atMs: z.number(),
        kind: z.string(),
        leadMs: z.number().default(0),
      }),
    )
    .default([]),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export const ContinuityReportSchema = z.object({
  generatedAt: z.string(),
  items: z.array(
    z.object({
      rule: z.string(),
      status: z.enum(['ok', 'declared-gag', 'violation']),
      detail: z.string(),
    }),
  ),
});
export type ContinuityReport = z.infer<typeof ContinuityReportSchema>;

// docs/07 混音计划（A9）：三层声音 + ducking 包络 + 音效落点
export const MixPlanSchema = z.object({
  generatedAt: z.string(),
  tracks: z.array(
    z.object({
      kind: z.enum(['vo', 'bgm', 'sfx']),
      file: z.string(),
      gainDb: z.number().default(0),
    }),
  ),
  duckRatio: z.number().min(0).max(1),
  sfxCues: z.array(
    z.object({
      file: z.string(),
      atMs: z.number().int().nonnegative(),
      kind: z.enum(['whoosh', 'hit', 'riser']),
      // 相对视觉切点的前置量（负值 = 声音先入；whoosh 需在切点前起势，峰值才落在切点）
      leadMs: z.number().default(0),
    }),
  ),
});
export type MixPlan = z.infer<typeof MixPlanSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.number().default(SCHEMA_VERSION),
  meta: ProjectMetaSchema,
  stage: StageSchema.default('init'),
  script: ScriptSchema.optional(),
  directorNotes: z.array(DirectorNoteSchema).default([]),
  shots: z.array(ShotSchema).default([]),
  materialDecisions: z.record(MaterialDecisionSchema).default({}),
  style: StyleDecisionSchema.optional(),
  timeline: TimelineSchema.optional(),
  continuity: ContinuityReportSchema.optional(),
  mixPlan: MixPlanSchema.optional(),
  subtitlePolicy: SubtitlePolicySchema.optional(),
  confirmed: z.boolean().default(false),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * 素材语言（风格 → 素材的一致性契约，docs/11 §二）：
 * 风格不只给颜色和字体，还要说清「这一派用什么材质、什么维度、什么母题、禁用什么」，
 * 场景选择与场景生成都必须读它，否则风格只剩调色、素材仍是随机配图。
 */
/** 真实素材的呈现契约：调色/颗粒/暗角/画幅/运镜，缺省值等于 P5 之前的写死值 */
export const StyleMediaSchema = z.object({
  grade: z.enum(['warm', 'neutral', 'cool', 'bleach', 'none']).default('warm'),
  grain: z.number().min(0).max(1).default(0.13),
  vignette: z.number().min(0).max(1).default(0.62),
  letterbox: z.boolean().default(false),
  /** auto：空镜横移、人物缓推、静物微推；static 才是真静止 */
  motion: z.enum(['auto', 'ken-burns', 'static']).default('auto'),
  fit: z.enum(['cover', 'contain']).default('cover'),
});
export type StyleMedia = z.infer<typeof StyleMediaSchema>;

export const StyleVisualSchema = z.object({
  /** 视觉维度：2d 平面 / css3d 立体（透视+旋转）/ mixed 混用 */
  dimension: z.enum(['2d', 'css3d', 'mixed']).default('2d'),
  /** 可渲染母题 id（对应 motion-lib 的 3D 原语与场景件） */
  motifs: z.array(z.string()).default([]),
  /** 场景类型偏好（模板名，不含 canvas: 前缀） */
  sceneBias: z.array(z.string()).default([]),
  /** 场景类型禁用（与偏好冲突时禁用优先） */
  sceneDeny: z.array(z.string()).default([]),
  /** 纹理/光效层：grain / halation / paper / scanline … 由场景模板按需铺 */
  texture: z.array(z.string()).default([]),
  /** 一句话素材语言（给 LLM 的风格指令，进 scene prompt） */
  note: z.string().default(''),
  /** 真实素材镜的呈现参数（代码绘制镜不读） */
  media: StyleMediaSchema.default({}),
});
export type StyleVisual = z.infer<typeof StyleVisualSchema>;

export const StylePackSchema = z.object({
  id: z.string(),
  name: z.string(),
  grade: z.enum(['A', 'B', 'C']),
  status: z.enum(['draft', 'candidate', 'registered']).default('registered'),
  userFacing: z.object({
    name: z.string(),
    aliases: z.array(z.string()).default([]),
    vibe: z.string(),
    bestFor: z.array(z.string()).default([]),
  }),
  anatomy: z.record(z.enum(ANATOMY_KEYS), z.string()),
  palette: z.object({
    primary: z.string(),
    accent: z.string(),
    neutral: z.array(z.string()).length(5),
    colorArc: z.string(),
  }),
  type: z.object({
    families: z.array(z.string()).max(2),
    scale: z.object({ title: z.number(), body: z.number() }),
    tracking: z.record(z.number()).default({}),
  }),
  layout: z.object({
    density: z.number().min(0).max(1),
    maxElementsPerShot: z.number().int().min(1).max(5),
    whitespace: z.number().min(0).max(1),
  }),
  motion: z.object({
    easing: z.string(),
    intensity: z.number().min(0).max(1),
    staggerMs: z.number(),
    spring: z.object({ stiffness: z.number(), damping: z.number() }),
  }),
  pacing: z.object({
    curve: z.string(),
    shotLenMs: z.tuple([z.number(), z.number()]),
    breathEvery: z.number().int().positive(),
  }),
  effects: z.record(z.union([z.number(), z.boolean()])),
  visuals: StyleVisualSchema.default({}),
  transitions: z.array(z.string()).min(1),
  shotScaleBias: z.array(ZoomSchema).min(1),
  provenance: z.object({
    source: z.enum(['absorbed', 'manual']),
    from: z.string(),
    version: z.string(),
    absorbedAt: z.string().default(''),
    review: z.string().default(''),
  }),
  references: z.string().default(''),
  antiPatterns: z.string().default(''),
  subtitlePolicy: SubtitlePolicySchema.default('full'),
  /** 字幕配色（亮调风格必须显式声明，否则暗底字幕在亮画面上糊掉） */
  caption: z
    .object({
      plate: z.string().default('rgba(10,10,14,0.55)'),
      text: z.string().default('#f5f5f4'),
      accent: z.string().default(''),
    })
    .optional(),
});
export type StylePack = z.infer<typeof StylePackSchema>;

export const RecipeSchema = z.object({
  id: z.enum(GENRES),
  name: z.string(),
  beats: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        note: z.string().default(''),
        function: SegmentFunctionSchema.optional(),
      }),
    )
    .min(1),
  directorialNotes: z
    .array(
      z.object({
        beatId: z.string(),
        visualIntent: z.string(),
        emotionGoal: z.string(),
        counterpoint: CounterpointSchema.default('emotion'),
      }),
    )
    .default([]),
  style: z.object({
    recommended: z.array(z.string()).min(1),
    rationale: z.string(),
  }),
  pacing: z.object({
    curve: z.string(),
    shotLenMs: z.tuple([z.number(), z.number()]),
    breathEvery: z.number().int().positive(),
    comedyBeat: z.boolean().default(false),
  }),
  density: z.enum(['low', 'medium', 'high']),
  subtitles: z.string(),
  headTail: z.object({ head: z.string(), tail: z.string() }),
  sound: z.object({ bgmArc: z.string(), sfxSet: z.array(z.string()).default([]) }),
  templates: z.array(z.string()).min(1),
  durationTiers: z.record(
    z.object({
      wordsPerMin: z.number(),
      structure: z.string(),
      chapters: z.number().int().nonnegative(),
    }),
  ),
});
export type Recipe = z.infer<typeof RecipeSchema>;
