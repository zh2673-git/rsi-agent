// 剪辑部转场处理器（docs/08 ④ + docs/10 V-MOT-008）：
// 风格包 transitions 词表 → 可渲染的转场方案。
//
// P10「取消静默退化」：旧实现在词表外**静默回退**到 allowed[0] 并只留一条 warning，
// 片子照样出——实测 16 个切点攒了 15 条「smash-cut 不在词表 → dissolve」，导演要的
// 冲击切全变成 420ms 慢叠化而没人看见。现在改为**显式失败**：翻不了就报错，不蒙过去。
import { ERR, mvError } from '../core/errors.js';

export type TransitionKind =
  | 'hard-cut'
  | 'smash-cut'
  | 'dissolve'
  | 'whip-pan'
  | 'wipe'
  | 'slide'
  | 'fade-black'
  /** T3a 一镜到底（2026-11-14）：相邻镜声明为同一连续长镜的节拍段——无操作转场，
   *  机位接力由 continuity-audit / rig 负责。不进风格包词表校验（它不是「怎么接」的选择）。 */
  | 'continuity';

export interface TransitionPlan {
  kind: TransitionKind;
  /** 转场总时长（V-MOT-008：转场 300-600ms） */
  durationMs: number;
  /** 与前一镜重叠的时长；0 表示真正硬切、无重叠 */
  overlapMs: number;
}

const ALIASES: Record<string, TransitionKind> = {
  'hard-cut': 'hard-cut',
  hardcut: 'hard-cut',
  cut: 'hard-cut',
  none: 'hard-cut',
  'smash-cut': 'smash-cut',
  smashcut: 'smash-cut',
  dissolve: 'dissolve',
  crossfade: 'dissolve',
  'whip-pan': 'whip-pan',
  whippan: 'whip-pan',
  whip: 'whip-pan',
  wipe: 'wipe',
  slide: 'slide',
  push: 'slide',
  'fade-black': 'fade-black',
  fadeblack: 'fade-black',
  'fade-to-black': 'fade-black',
  ftb: 'fade-black',
  // T3a 一镜到底：oneshot/连续 声明 → continuity（无操作转场）
  continuity: 'continuity',
  oneshot: 'continuity',
};

// 每个转场的时长与重叠：溶解/擦除必须重叠才不会出现"淡到黑再亮起"的翻页感
const TIMING: Record<TransitionKind, { durationMs: number; overlapMs: number }> = {
  'hard-cut': { durationMs: 0, overlapMs: 0 },
  'smash-cut': { durationMs: 320, overlapMs: 0 },
  dissolve: { durationMs: 420, overlapMs: 420 },
  'whip-pan': { durationMs: 360, overlapMs: 300 },
  wipe: { durationMs: 420, overlapMs: 420 },
  slide: { durationMs: 420, overlapMs: 420 },
  // 只有明确声明 fade-black 的风格包才走"黑场过渡"；默认风格词表里没有它
  'fade-black': { durationMs: 600, overlapMs: 300 },
  // continuity 是无操作转场：不重叠、不渲染过渡效果（两镜在时间线上直接相接）
  continuity: { durationMs: 0, overlapMs: 0 },
};

export function normalizeTransition(word: string | undefined): TransitionKind | null {
  if (!word) return null;
  return ALIASES[word.trim().toLowerCase()] ?? null;
}

/** 词表归一化：只保留能识别成 TransitionKind 的项（拼错的词表项不该当成"允许"） */
export function normalizeAllowed(allowed: string[]): TransitionKind[] {
  return allowed
    .map((w) => normalizeTransition(w))
    .filter((k): k is TransitionKind => k !== null);
}

export interface PlanTransitionOptions {
  /**
   * 严格模式（默认 true）：请求词不在词表内 → 抛 ERR_ILLEGAL_TRANSITION。
   * 这是「取消静默退化」的开关——不再有「回退了但告诉你」这种中间态。
   *
   * false 仅用于兼容**未确认的历史项目**（confirmed=false，作者已不在场，
   * 报错也无人可改）；由 composer 按 project.confirmed 传值。
   */
  strict?: boolean;
}

/**
 * 按风格包词表裁决转场。
 *
 * - 词表为空 → 任何请求都放行（老项目/无词表风格包，不误伤）；
 * - 请求词在词表内 → 用它；
 * - 请求词不在词表内 → **抛错**（strict，默认）或回退到词表首项（strict:false）。
 *
 * 抛错消息必须自带修法：读者拿到的是「改哪里」而不是「哪里错了」。
 */
export function planTransition(
  word: string | undefined,
  allowed: string[],
  opts: PlanTransitionOptions = {},
): TransitionPlan {
  const strict = opts.strict ?? true;
  const allowKinds = normalizeAllowed(allowed);
  const wanted = normalizeTransition(word);
  if (!wanted) {
    // 连词都认不出（拼错/没实现）：这是声明错误，不是词表问题
    throw mvError(
      ERR.ILLEGAL_TRANSITION,
      `未知转场词「${word ?? '(空)'}」：可识别的是 ${Object.keys(ALIASES).join('/')}。` +
        `请改分镜的 transition 字段，或在风格包 transitions 里登记。`,
    );
  }
  // continuity（一镜到底节拍段）不受词表约束：它不是「怎么接」的选项，
  // 是「这两镜是一面」的结构声明——老项目词表里没有它，词表校验会把它误杀。
  if (wanted === 'continuity') {
    return { kind: wanted, ...TIMING.continuity };
  }
  if (allowKinds.length === 0 || allowKinds.includes(wanted)) {
    return { kind: wanted, ...TIMING[wanted] };
  }
  if (!strict) {
    const fallback = allowKinds[0]!;
    return { kind: fallback, ...TIMING[fallback] };
  }
  throw mvError(
    ERR.ILLEGAL_TRANSITION,
    `转场「${wanted}」不在风格包词表 [${allowKinds.join(', ')}]。` +
      `二选一：① 在 project.style.overrides.transitions 里加入「${wanted}」；` +
      `② 把该镜 transition 改成词表内的值。` +
      `（不再静默回退——回退会让导演的声明失效而片子照出，这正是 P10 取消的机制）`,
  );
}

// 切点动机（docs/08）：动机不是文案标签——它决定这一刀该硬切还是该溶解。
export type CutMotivation =
  | 'match-cut'
  | 'action'
  | 'eye-line'
  | 'emotion'
  | 'beat'
  | 'zoom-jump'
  | '';

/**
 * 动机的规范写法直查表（P10 消除「导演写了英文词却被判无动机」）。
 *
 * 旧实现只跑中文关键词正则：导演写 `motivation: "match-cut"` 时一条都不匹配，
 * 返回空串 → cut-audit 记 `motiveSource: none`，实测 16 个切点里 6 个被这样读丢。
 * 动机字段本来就是枚举，写枚举值是最正当的表达，读不懂是翻译器的缺陷。
 */
const MOTIVATION_ALIASES: Record<string, CutMotivation> = {
  'match-cut': 'match-cut',
  matchcut: 'match-cut',
  match: 'match-cut',
  同形: 'match-cut',
  接住: 'match-cut',
  action: 'action',
  动作: 'action',
  'eye-line': 'eye-line',
  eyeline: 'eye-line',
  'eye-contact': 'eye-line',
  视线: 'eye-line',
  emotion: 'emotion',
  情绪: 'emotion',
  beat: 'beat',
  节拍: 'beat',
  打点: 'beat',
  'zoom-jump': 'zoom-jump',
  zoomjump: 'zoom-jump',
  景别跳: 'zoom-jump',
};

const MOTIVATION_RULES: Array<[RegExp, CutMotivation]> = [
  [/同形|同构|接住|呼应|对齐|无缝/, 'match-cut'],
  [/动作|冲|甩|撞|砸|打断|爆发|抢|跑|追|落|掀|推倒/, 'action'],
  [/视线|目光|看向|对视|回头|眼神|注视/, 'eye-line'],
  [/情绪|沉默|停顿|回忆|怅惘|温柔|悲|温暖|顿悟|感慨|安静|留白|余味/, 'emotion'],
  [/节拍|打点|包袱|反转|梗|抖|停一拍|冷场/, 'beat'],
  [/景别|推近|拉远|跳切|特写|机位|zoom/i, 'zoom-jump'],
];

/**
 * 从导演写的动机话里判定切点动机类型。
 * 先按枚举规范写法直查（`match-cut` / `zoom-jump` / 中文名），再走关键词正则；
 * 判不出返回空（不拿"有文案"冒充动机）。
 */
export function cutMotivation(text: string | undefined): CutMotivation {
  const t = (text ?? '').trim();
  if (!t) return '';
  const direct = MOTIVATION_ALIASES[t.toLowerCase()];
  if (direct) return direct;
  for (const [re, kind] of MOTIVATION_RULES) if (re.test(t)) return kind;
  return '';
}

const ZOOM_ORDER: Record<string, number> = { ELS: 0, LS: 1, MS: 2, CU: 3, ECU: 4 };

/** 结构性关系（不依赖文案关键词）：景别跳、同场视线反转、笑点落镜 */
export interface RelationFacts {
  zoom: string;
  scene: string;
  side: string;
  gag: boolean;
}

/**
 * 导演没写清理由时，剪辑部从两镜的客观关系反推动机（docs/08）：
 * 景别跨两档以上→跳切；同场主体方位反转→接视线；落点镜突然切进笑点→接节拍。
 */
export function deriveRelationMotivation(
  prev: RelationFacts,
  cur: RelationFacts,
): CutMotivation {
  const gap = Math.abs((ZOOM_ORDER[prev.zoom] ?? 2) - (ZOOM_ORDER[cur.zoom] ?? 2));
  if (gap >= 2) return 'zoom-jump';
  if (prev.scene === cur.scene && prev.side !== cur.side) return 'eye-line';
  if (cur.gag && !prev.gag) return 'beat';
  return '';
}

/**
 * 动机 → 默认转场（P10 B1：从三选一扩成全表）。
 *
 * 旧实现只有 emotion→dissolve / action·beat→smash-cut / 其余 hard-cut，
 * 于是 whip-pan / slide / wipe / fade-black 在 auto 路径**机制上不可达**——
 * 全片 16 镜都写 auto，等于动线型转场永远不出现，这是「镜头没有动线」的根因。
 *
 * 关键一行 `zoom-jump → whip-pan`：景别跨两档本就是「镜头跟不过去、干脆甩过去」，
 * 阿杜最典型的动线。`eye-line → slide`：视线横移配整幅横推，观众的眼睛跟着推。
 */
const MOTIVE_TRANSITION: Record<Exclude<CutMotivation, ''>, TransitionKind> = {
  'match-cut': 'hard-cut', // 形状接住 → 硬切才是接住
  action: 'smash-cut', // 动作/冲击
  'eye-line': 'slide', // 视线横移 → 整幅横推
  emotion: 'dissolve',
  beat: 'smash-cut',
  'zoom-jump': 'whip-pan', // 景别跳 → 甩镜
};

/** 转场词未显式声明（auto/空）时，由动机给出默认裁决 */
export function motivationTransition(m: CutMotivation): TransitionKind {
  if (!m) return 'hard-cut';
  return MOTIVE_TRANSITION[m];
}
