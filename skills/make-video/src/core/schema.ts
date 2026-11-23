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

// ── 元素/动作可见性改造（方案 §5.1/§5.2）：两清单都是一等工件 ──
// 全部字段可缺省/可空数组，旧项目零回归；时间由 timeline 回填而非生成时写死。
export const ElementRoleSchema = z.enum(['subject', 'env', 'deco', 'caption']);
export type ElementRole = z.infer<typeof ElementRoleSchema>;

export const ElementKindSchema = z.enum(['shape', 'text', 'image', 'video', 'particle', 'container']);
export type ElementKind = z.infer<typeof ElementKindSchema>;

export const ElementSourceSchema = z.enum(['code', 'user-material', 'imported', 'cloud']);
export type ElementSource = z.infer<typeof ElementSourceSchema>;

/** 元素清单条目（每镜一份）：画面上「有什么」 */
export const ElementEntrySchema = z.object({
  id: z.string(),
  kind: ElementKindSchema,
  role: ElementRoleSchema,
  source: ElementSourceSchema.default('code'),
  /** CSS 选择器 / 素材路径 / 文案，给预览热区与定位用 */
  visual: z.object({
    selector: z.string().default(''),
    text: z.string().default(''),
    src: z.string().default(''),
    color: z.string().default(''),
  }).default({}),
  /** 由时间线回填；不填表示全程可见 */
  visibility: z.object({
    startMs: z.number().nonnegative().optional(),
    endMs: z.number().nonnegative().optional(),
  }).default({}),
});
export type ElementEntry = z.infer<typeof ElementEntrySchema>;

export const ActionLayerSchema = z.enum(['subject', 'ambient', 'camera', 'emphasis']);
export type ActionLayer = z.infer<typeof ActionLayerSchema>;

/** 动作清单条目（每镜一份）：画面「怎么动」，通过 target 关联元素 id，非元素属性 */
export const ActionEntrySchema = z.object({
  id: z.string(),
  target: z.string(),
  layer: ActionLayerSchema,
  /** MV.* 原语名（如 MV.strokeDraw），复用现有 28 原语，不新增 */
  primitive: z.string(),
  params: z.record(z.unknown()).default({}),
  /** 由时间线回填；durMs 可缺省表示跟随镜头时长 */
  timing: z.object({
    atMs: z.number().nonnegative().optional(),
    durMs: z.number().nonnegative().optional(),
  }).default({}),
});
export type ActionEntry = z.infer<typeof ActionEntrySchema>;

export const StageSchema = z.enum([
  'init',
  'script',
  'storyboard',
  'materialize',
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
//
// P12 阶段3（M1 合并）：**词表的唯一事实源在 `validators/scene.ts` 的 CAMERA_MOVES**
//（那是校验器真正把关的表）。此处只保留别名表——它回答的是
// 「用户/模型写的这个词，要不要认成词表里的哪个值」，与「哪些词合法」是两件事。
// 此前两张表各写一遍，漂移过一次（`pan-right` 只在别名表里，词表里没有）。
import { CAMERA_MOVES as CAMERA_MOVE_TOKENS } from './validators/scene.js';

/** 合法机位词（不含 static/none —— 那两个是合法选择，不是运动） */
export const CAMERA_MOVES = CAMERA_MOVE_TOKENS.filter(
  (m) => m !== 'static' && m !== 'none',
);

export type CameraMove = (typeof CAMERA_MOVE_TOKENS)[number];

const CAMERA_ALIASES: Record<string, CameraMove> = {
  'push-in': 'push-in',
  pushin: 'push-in',
  'pull-out': 'pull-out',
  pullout: 'pull-out',
  pan: 'pan',
  'pan-left': 'pan-left',
  panleft: 'pan-left',
  // pan-right 在 8 词表里没有独立词位：motion-lib 的 'pan' 分支本身就是向右平推
  //（xPercent -3 → +3），所以 pan-right 归一到 pan 是语义等价，不是凑数。
  // 模型按"左/右"直觉命名运镜很常见（v1.1.2 实测 s02/s08/s10/s17/s22/s26 全写 pan-right），
  // 缺别名会让整份分镜被 V-CAM-002 打回、片子根本出不来。
  'pan-right': 'pan',
  panright: 'pan',
  'tilt-up': 'tilt-up',
  tiltup: 'tilt-up',
  'tilt-down': 'tilt-down',
  tiltdown: 'tilt-down',
  'dolly-in': 'dolly-in',
  dollyin: 'dolly-in',
  'dolly-out': 'dolly-out',
  dollyout: 'dolly-out',
  'crane-up': 'crane-up',
  craneup: 'crane-up',
  'crane-down': 'crane-down',
  cranedown: 'crane-down',
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

// P13 阶段1 扩枚举（并集，不替换）：旧四值全部保留为合法旧档，新四值对应提案
// §1.A 的对位细分。理由见执行记录——storyboard 默认值 'metaphor'、7 个 recipe
// 与 8 个测试文件全用旧值，替换会让旧项目直接解析失败。
export const COUNTERPOINTS = [
  'metaphor',
  'evidence',
  'emotion',
  'parody',
  'literal',
  'complementary',
  'ironic',
  'atmospheric',
] as const;
export const CounterpointSchema = z.enum(COUNTERPOINTS);
export type Counterpoint = z.infer<typeof CounterpointSchema>;

export const SegmentFunctionSchema = z.enum(['advance', 'inform', 'emotion']);

/** 素材诉求（提案 §1.A/§1.E）：证据型段落宜真实素材，情绪段宜抽象 */
export const ASSET_NEEDS = ['evidence', 'mood', 'none'] as const;
export const AssetNeedSchema = z.enum(ASSET_NEEDS);
export type AssetNeed = z.infer<typeof AssetNeedSchema>;

export const ScriptSegmentSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  function: SegmentFunctionSchema,
  beat: z.string().optional(),
  // docs/03：表演/剪辑联动字段（情绪基调 / 重音词 / 停顿标记 ms）
  mood: z.enum(['neutral', 'curious', 'tense', 'awe', 'warm', 'urgent']).optional(),
  emphasis: z.array(z.string()).optional(),
  pausesMs: z.array(z.number().int().nonnegative()).optional(),
  // P13 阶段1（A2 声明接线）：以下四字段**全可缺省**，缺省即「本段未声明」，
  // 与旧项目零差异；声明了才被下游消费（storyboard 写导演笔记 / 对位 / 素材需求单）。
  subtext: z.string().optional(),
  emotion: z.string().optional(),
  assetNeed: AssetNeedSchema.optional(),
  counterpoint: CounterpointSchema.optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const ScriptSchema = z.object({
  fullText: z.string().min(1),
  segments: z.array(ScriptSegmentSchema).min(1),
});
export type Script = z.infer<typeof ScriptSchema>;

export const ZoomSchema = z.enum(['ELS', 'LS', 'MLS', 'MS', 'MCU', 'CU', 'ECU']);

/**
 * 机位动机（P13 阶段1 · 提案 §1.C）：导演部在开拍前回答「这一镜的机位为什么动/为什么不动」。
 *
 * 为什么必须是一个枚举而不是自由文本：`motivation` 已经能写理由，但它描述的是**切点**
 * （为什么从上一镜切到这一镜）；机位自己为什么动、动成什么样，此前完全没有字段——
 * 于是「所有东西同时在动」成为默认，静也从来不是决策。
 *
 * hold = 定帧不动，是**合法决策**（Lumet：没有理由就不动机位）。
 */
export const CAMERA_INTENTS = ['follow', 'reveal', 'hold', 'emotion', 'setup'] as const;
export const CameraIntentSchema = z.enum(CAMERA_INTENTS);
export type CameraIntent = z.infer<typeof CameraIntentSchema>;

/** 调度表单轨：动/静 + 做什么 + 为什么（三样缺一，这一轨就等于没决策） */
export const StagingTrackSchema = z.object({
  motion: z.enum(['move', 'still']),
  what: z.string().default(''),
  why: z.string().default(''),
});
export type StagingTrack = z.infer<typeof StagingTrackSchema>;

/**
 * 调度表（A3 扩展，提案 §1.C）：五轨各一行——机位/主体/配角/环境/字幕。
 *
 * 机位轨必填 `intent`（其余四轨可缺省）：机位是唯一「动不动都需要理由」的轨，
 * 主体/配角/环境/字幕的缺省含义是「本轨未单独调度」，由语法与场景自行决定，
 * 不硬塞默认值（否则「未调度」与「调度为静」不可分）。
 */
export const StagingSchema = z.object({
  camera: StagingTrackSchema.extend({ intent: CameraIntentSchema }),
  subject: StagingTrackSchema.optional(),
  supporting: StagingTrackSchema.optional(),
  environment: StagingTrackSchema.optional(),
  subtitle: StagingTrackSchema.optional(),
});
export type Staging = z.infer<typeof StagingSchema>;


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
  // A5 调度表（P13 阶段1）：机位动机 + 五轨动/静决策。全可缺省 —— 旧项目零回归。
  intent: CameraIntentSchema.optional(),
  staging: StagingSchema.optional(),
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
  /** 元素/动作清单：materialize 阶段产出，optional 保证旧项目零回归 */
  elements: z.array(ElementEntrySchema).optional(),
  actions: z.array(ActionEntrySchema).optional(),
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
// word=逐词卡拉OK（词按字位比例换算的时间戳逐词点亮，vibe 知识大赏签名形式）；
// off=不出画面字幕（srt 工件仍全量导出）。风格包声明默认，project 顶层可覆写。
export const SubtitlePolicySchema = z.enum(['full', 'keyword', 'word', 'off']);
export type SubtitlePolicy = z.infer<typeof SubtitlePolicySchema>;

// 场（scene）：共享空间 + 元素接力的镜头编组（P13 表达层，提案 §1.B）。
// 全可缺省 —— 旧项目零回归；存在时语义为「这些镜共用同一物理空间」，
// viewportWindows 描述共享 canvas 内的多视口取景（主画布之外嵌入的取景窗）。
// 缺省 scenes[] = 全片单场，所有消费方行为与旧版完全一致。
export const ViewportWindowSchema = z.object({
  shotId: z.string(),
  x: z.number().min(0).max(100).default(50),
  y: z.number().min(0).max(100).default(50),
  zoom: z.number().min(0.2).max(3).default(1),
  motion: z.string().default(''),
});
export type ViewportWindow = z.infer<typeof ViewportWindowSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  canvas: z.string(),
  shotIds: z.array(z.string()).min(1),
  viewportWindows: z.array(ViewportWindowSchema).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const TimelineSchema = z.object({
  shots: z.array(
    z.object({
      shotId: z.string(),
      startMs: z.number(),
      durationMs: z.number(),
      transition: z.string(),
      // P13 阶段2 场域口径（单一计算点）：computeTimeline 派生（同 segment = intra），
      // 切点校验器与 cut-audit 审计共用这一个来源，不再各算一份。
      // optional 而非 default：default 会把输出类型变必填，测试手写的 Timeline 字面量会全体报错；
      // 消费方一律 `?? 'inter'` 兜底，语义 = 缺省即场间（保守，不收紧旧片的切点自由度）。
      sceneScope: z.enum(['intra', 'inter']).optional(),
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

/**
 * 音频方案（开工确认门写进 IR）：配乐/音效不再全片固定，而是随主题/风格/元素/动效变化。
 * 字段是可读字符串 + 可选数值，合成器侧按名字做枚举兜底，未知值退到默认而不是报错。
 * 见 SKILL.md 工作规则 0 / 9。
 */
export const AudioPlanSchema = z.object({
  /** 主题/情绪一句话，写清为什么这样配（进确认表给用户看） */
  rationale: z.string().default(''),
  /** 配乐气质枚举：warm-curious（好奇科普）/ mysterious（悬疑）/ bright-pulse（明快）/ epic（宏大）/ calm（沉静）/ playful（俏皮）/ tense（紧张） */
  mood: z.string().default('warm-curious'),
  /** BPM；0 = 用风格默认 */
  bpm: z.number().min(0).max(220).default(0),
  /** 和弦进行名：warm-jazzy / epic-minor / bright-major / minimal-drone / tense-sus / playful-pluck */
  progression: z.string().default('warm-jazzy'),
  /** 织体名：pluck-pad / pad-only / arp-drive / bell-air / drone-pulse / full-band */
  texture: z.string().default('pluck-pad'),
  /** 音色亮度 0..1，影响拨弦泛音与空气感 */
  brightness: z.number().min(0).max(1).default(0.5),
  /** 转场/重音音效音色：glassy / woody / metallic / soft / punchy */
  sfxPalette: z.string().default('glassy'),
});
export type AudioPlan = z.infer<typeof AudioPlanSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.number().default(SCHEMA_VERSION),
  meta: ProjectMetaSchema,
  stage: StageSchema.default('init'),
  script: ScriptSchema.optional(),
  directorNotes: z.array(DirectorNoteSchema).default([]),
  shots: z.array(ShotSchema).default([]),
  materialDecisions: z.record(MaterialDecisionSchema).default({}),
  // P13 阶段2：场编组（optional 而非 default，理由同 sceneScope——旧字面量零报错；
  // 缺省 = 全片单场，行为同旧）
  scenes: z.array(SceneSchema).optional(),
  style: StyleDecisionSchema.optional(),
  /** 应用的 TemplatePack id（跨维度打包来源，方案 §4.4）；旧项目无此字段 */
  templateId: z.string().optional(),
  timeline: TimelineSchema.optional(),
  continuity: ContinuityReportSchema.optional(),
  mixPlan: MixPlanSchema.optional(),
  /** 开工确认门定下的配乐/音效方案；compose 据此参数化合成 */
  audioPlan: AudioPlanSchema.optional(),
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
  /**
   * P13 阶段3：情绪→视觉参数的偏好层词典。可缺省、可被 StyleDecision.overrides 整体覆写。
   * 键为情绪名（calm/tension/joy/melancholy/…），值为该情绪下的默认视觉倾向。
   * 只给默认值，不预设「某情绪必配某机位/动作」——组合仍归调度表。
   */
  emotionMap: z.record(z.string(), z.object({
    temperature: z.enum(['warm', 'neutral', 'cool']).optional(),
    light: z.enum(['soft', 'hard', 'high-key', 'low-key']).optional(),
    pace: z.enum(['slow', 'medium', 'fast']).optional(),
    note: z.string().optional(),
  })).optional(),
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
  /** 风格默认音频方案（无项目 audioPlan 时用它；字段与 AudioPlanSchema 同源但可选） */
  audio: AudioPlanSchema.partial().optional(),
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
  /**
   * P13 阶段4：公共笼阈值的「默认 + 可覆写」下沉点。
   * 只放已有 V-* 规则的可调阈值，不新增规则编号（V-* 笼子只减不增）。
   */
  constraints: z.object({
    /** V-CAM-005 急推全片上限，缺省 2（沿用原硬编码） */
    maxPunchOut: z.number().int().min(0).max(10).default(2),
  }).default({}),
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
    /** P13 阶段4：V-RHY-010 静止镜占比上限，缺省 0.6（沿用原硬编码，不新增规则编号） */
    maxStaticRatio: z.number().min(0).max(1).default(0.6),
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
