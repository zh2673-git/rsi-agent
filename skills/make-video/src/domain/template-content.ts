/**
 * 模板内容绑定（L4 模板「换个文案就能再做一遍」的兑现层）。
 *
 * 背景（2026-11-16，P12 阶段1 的实测发现）：
 *
 * 15 个场景模板里有 6 个（kinetic-type / compare-stage / deep-stage /
 * hierarchy-stack / paper-stage / process-track）写着内容占位符
 * （`{{HERO_WORD}}` / `{{STOP1}}` / `{{LEFT_NUM}}` …），
 * 但**渲染期根本没人填它们**。后果有两层：
 *
 *   ① HTML 文本里出现字面量 `{{HERO_WORD}}`；
 *   ② `<script>` 里的 `MV.counter('.figure', { to: {{FIGURE_TO}} })` 是
 *      **非法 JS**（对象字面量里没有键名），整个 script 块抛 SyntaxError →
 *      **这一镜的所有动画都不发生**。画面只剩一堆静态文字，
 *      而且所有校验器全绿（它们查的是「调用了哪些原语」，不是「JS 能不能跑」）。
 *
 * 这正是用户描述的现象的根源之一：模型（或模板）只会照顾单个词，
 * 因为**没有任何一层负责把「这一镜要讲的内容」落到画面的具体位置**。
 *
 * ── 本模块的两条硬纪律 ──
 *
 * **纪律1：内容必须是「术语」，不是「旁白原文」。**
 * V-SCENE-005（对位铁律）禁止画面复述旁白：旁白里任何连续 4 个汉字
 * 出现在画面上就判 error。所以内容槽装的应该是**名词/术语**
 * （「取指」「译码」「坍缩」），不是句子片段。
 *
 * **纪律2：派生层不得产出会被校验器打回的值。**
 * 确定性派生没有 LLM 的语义理解，硬切句子会切出「核心坍缩」这种
 * 4 字词组——它就在旁白里，直接撞 V-SCENE-005。
 * 因此本模块用 `safeLabel()` 保证：**派生出的标签与旁白不共享任何 4 字窗口**，
 * 超长就逐字裁到不共享为止，裁到不足 2 字就放弃（留空）。
 * 这样派生层**在构造上**就不会制造校验错误。
 *
 * 派生的取值优先级：
 *   1. `shot.visual.params` 里的显式参数（导演/LLM 写的术语标签）；
 *   2. 讲稿段落的 `emphasis` 重音词（编剧声明的「这一句要重读的词」）；
 *   3. 旁白的结构性切分（对比词 / 步骤词 / 层级词）——裁成安全短标签；
 *   4. 数字槽：直接取旁白里的数字（数字不是汉字，不受 V-SCENE-005 约束）。
 *
 * 为什么不用 LLM 做这一层：它跑在**每一镜**上，且必须在离线模板模式下也能工作
 * （`TemplateLlmClient` 没有内容能力）。派生必须是纯函数——同一输入永远同一结果，
 * 否则重跑分镜会得到不同的画面，破坏「逐帧确定性渲染」这条铁律。
 * LLM 参与的位置是**分镜期**（它把术语写进 `visual.params`），派生层只做兜底与安全化。
 */

import type { Project, Shot } from '../core/schema.js';

export interface ContentContext {
  /** 本镜旁白 */
  narration: string;
  /** 导演视觉意图（visual.prompt）——只作上下文，不上屏（V-CP-001） */
  prompt: string;
  /** 本镜的显式参数覆盖（最高优先级） */
  params: Record<string, unknown>;
  /** 讲稿段落声明的重音词 */
  emphasis: string[];
  /** 本镜 id（用于确定性抖动） */
  shotId: string;
}

export type ContentValues = Record<string, string | number>;

/** 容量兜底：模板契约没给 maxChars 时用的保守上限 */
const DEFAULT_MAX_CHARS = 24;

/** 去掉标点与空白，只留可读内容 */
function strip(text: string): string {
  return text
    .replace(/[，。！？、；：""''（）()《》…—\-.!?;:'",]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 与 V-SCENE-005 同样口径的旁白清洗（去掉标点后取 4 字窗口） */
function cleanedNarration(narration: string): string {
  return narration.replace(/[，。！？、；：""''（）\s,.!?;:()]/g, '');
}

const CJK = /[\u4e00-\u9fff]/;

/**
 * 标签是否与旁白共享 4 字窗口（V-SCENE-005 的判据）。
 *
 * 判据与校验器等价：校验器遍历**旁白**的每个 4 字窗口问「它出现在 HTML 吗」，
 * 等价于「标签的每个 4 字窗口出现在旁白里吗」——后者更好算，且是同一条约束。
 */
export function sharesRunWithNarration(label: string, narration: string): boolean {
  const clean = strippedCjk(label);
  const narr = cleanedNarration(narration);
  if (clean.length < 4 || narr.length < 4) return false;
  for (let i = 0; i + 4 <= clean.length; i += 1) {
    if (narr.includes(clean.slice(i, i + 4))) return true;
  }
  return false;
}

/** 标签里连续的汉字串（HTML 转义不会改变汉字，所以可以先算再比） */
function strippedCjk(label: string): string {
  return label.replace(/[^\u4e00-\u9fff]/g, '');
}

/**
 * 安全标签：既短，又保证不与旁白共享 4 字窗口。
 *
 * 两条分支的差别很重要：
 *   - 标签本身 ≤3 个汉字 → **一定安全**（V-SCENE-005 只查 4 字窗口），直接用。
 *   - 标签 ≥4 个汉字且整段出现在旁白里 → **裁剪或放弃**。
 *     逐字裁到不共享为止，但裁到不足 4 字说明裁进了词中间（「同步执行」→「同步执」）
 *     ——半个词比空着更糟，所以这种情况直接放弃（返回空串）。
 */
export function safeLabel(candidate: string, narration: string, maxChars = 12): string {
  const out = strip(candidate).slice(0, maxChars).trim();
  if (out.length === 0) return '';
  if (!sharesRunWithNarration(out, narration)) return out;
  // 整段与旁白重叠：逐字裁，但裁出的残词要判废
  let trimmed = out;
  while (trimmed.length > 0 && sharesRunWithNarration(trimmed, narration)) {
    trimmed = trimmed.slice(0, -1);
  }
  const cjkLen = strippedCjk(trimmed).length;
  if (cjkLen === 0) return trimmed.length > 0 ? trimmed : '';
  // 原本 ≥4 字（必须裁）但裁到 <4 字 → 裁进了词中间，判废
  if (strippedCjk(out).length >= 4 && cjkLen < 4) return '';
  return cjkLen >= 2 ? trimmed : '';
}

/** 从旁白里抽第一个数字（带后缀与小数位）。返回 null 表示没有数字。 */
export function extractFigure(
  narration: string,
): { display: string; value: number; decimals: number; suffix: string } | null {
  const m = narration.match(/(-?\d+(?:\.\d+)?)\s*(%|％|倍|年|月|天|秒|分钟|小时|万|亿|千|百)?/);
  if (!m) return null;
  const raw = m[1]!;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const decimals = raw.includes('.') ? raw.split('.')[1]!.length : 0;
  const suffix = m[2] ?? '';
  return { display: `${raw}${suffix}`, value, decimals, suffix };
}

/**
 * 终止标记：术语与修饰成分的分界。
 *
 * 例：「上层是控制单元」→ 在「是」处断 → 术语「上层」；
 *     「取指单元把地址送上总线」→ 在「把」处断 → 术语「取指单元」。
 */
const TERM_BOUNDARY =
  /(是|为|把|将|被|的|地|得|负责|进行|实现|形成|产生|导致|包括|包含|相当于|等于|超过|达到|相比|相较|对比|不同于|而|但|却|反而|让|使|给|向|从|到|与|和|及|或|并|并且|因为|所以|如果|虽然|但是|可以|能够|需要|通过|基于|关于|针对|以及|等等|，|,|。|；|;|、)/;

/**
 * 开头要剥掉的前置词（它们不是术语的一部分）。
 *
 * 注意这里既包含连接词（相比/首先…），也包含谓语动词（是/负责/进行…）——
 * 因为「上层是控制单元」里的「是」不是术语的一部分，
 * 而「顶层负责调度」里的「负责」也不是。
 */
const TERM_PREFIX =
  /^(相比|相较|对比|不同于|反而|而|但|却|首先|然后|接着|随后|最后|最终|这|那|它|其|该|我们|你们|他们|其实|当然|因此|所以|同时|另外|此外|于是|是|为|把|将|被|负责|进行|实现|形成|产生|导致|包括|包含|相当于|等于|超过|达到|让|使|给|向|从|到|与|和|及|或|并|并且|因为|所以|如果|虽然|但是|可以|能够|需要|通过|基于|关于|针对|以及|等等|，|,|。|；|;|、)/;

/**
 * 从一段话里抽出**术语**（名词性短语），而不是句子碎片。
 *
 * 为什么不能直接取句子碎片：实测「顶层负责调度」切出「负责调」——
 * 这是半个动词，观众读不出信息。术语必须在**谓语边界**之前断开：
 * 「上层是控制单元」→「上层」（名词在前）、「取指单元把地址…」→「取指单元」。
 *
 * 长度上限 6 个汉字：术语标签本来就是短词，超过就该换更精确的词。
 */
export function extractTerm(chunk: string): string {
  let s = strip(chunk);
  // 剥前置词（可反复剥：「相比同步执行」→「同步执行」→「执行」）
  for (let guard = 0; guard < 8; guard += 1) {
    const next = s.replace(TERM_PREFIX, '').trim();
    if (next === s || next.length === 0) break;
    s = next;
  }
  // 在第一个谓语边界处断开。边界在开头（index=0）时取它**后面**的部分：
  // 「是控制单元」→「控制单元」。
  const m = TERM_BOUNDARY.exec(s);
  if (m) {
    const cut = m.index > 0 ? s.slice(0, m.index) : s.slice(m.index + m[0].length);
    s = cut.trim();
  }
  // 断开后可能又露出前置词，再剥一轮
  for (let guard = 0; guard < 4; guard += 1) {
    const next = s.replace(TERM_PREFIX, '').trim();
    if (next === s || next.length === 0) break;
    s = next;
  }
  if (s.length === 0) return '';
  return s.length > 6 ? s.slice(0, 6) : s;
}

/**
 * 抽关键词（主语槽）。
 * 优先：显式 emphasis 里的词 → 导演视觉意图里的引号内容 → 旁白首个语义块的术语。
 * 全部经过 safeLabel 安全化。
 */
export function extractHeroWord(ctx: ContentContext): string {
  // ① 显式 emphasis：编剧声明的「这一句要重读的词」——最可能就是术语，
  //    而且是**声明式**的（V-SCENE-005 对它豁免，可以直接上屏）。
  const emph = ctx.emphasis.filter((w) => w && w.length >= 2 && ctx.narration.includes(w));
  if (emph.length > 0) {
    const best = emph.sort((a, b) => b.length - a.length)[0]!;
    return strip(best).slice(0, 12);
  }
  // ② 导演视觉意图里的书名号/引号内容——导演常把术语写在这里
  const quoted = ctx.prompt.match(/[「『""]([^」』""]+)[」』""]/);
  if (quoted?.[1]) {
    const safe = safeLabel(quoted[1], ctx.narration, 12);
    if (safe) return safe;
  }
  // ③ 旁白首个语义块里的术语（启发式，不豁免 → 要过 safeLabel）
  const head = strip(ctx.narration).split(' ').filter(Boolean);
  if (head.length === 0) return '';
  return safeLabel(extractTerm(head[0]!), ctx.narration, 12);
}

/** 对比切分：先按标点切，再按对比词切——前者更准（「相比A，B」本就是两半） */
export function splitContrast(narration: string): [string, string] {
  const parts = strip(narration)
    .split(/[，,；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) return [parts[0]!, parts.slice(1).join('，')];
  const m = narration.match(/(相比|相较|对比|不同于|而|但|却|反而|vs|VS|versus)(.+)/);
  if (m && m.index !== undefined && m.index > 0) {
    return [narration.slice(0, m.index), narration.slice(m.index + m[1]!.length)];
  }
  return [narration, ''];
}

/** 步骤切分：按顺序词把旁白切成若干步 */
export function splitSteps(narration: string, maxSteps = 4): string[] {
  const parts = narration
    .split(/(?:首先|然后|接着|随后|最后|最终|第一[步点]|第二[步点]|第三[步点]|第四[步点]|→|->|，|,)/)
    .map((s) => strip(s))
    .filter(Boolean);
  if (parts.length === 0) return [strip(narration)];
  return parts.slice(0, maxSteps);
}

/**
 * 层级切分：按「上/中/下/顶层/底层」或序数切三层。
 *
 * **保留层级名**（「上层」「中层」「底层」），因为层级标签的价值就在于
 * 它指明了「这一层是第几层」——把「上层是控制单元」切成「控制单元」
 * 就丢掉了层级信息，画面上三张卡就没法区分上下。
 *
 * 所以切分点落在**层级名之后**（下一层名出现之前），
 * 每段再由 extractTerm 抽出该层的对象名（可为空——空了就只显示层级名）。
 */

/**
 * 层级名（用于**切分点**：在层级名之前断开，每段 = 「层级名 + 该层的内容」）。
 *
 * 必须用**非捕获组**：split() 会把捕获组的内容也放进结果数组，
 * 用捕获组会多出 ["上层","中层","底层"] 这些碎段（实测 2026-11-16）。
 */
const TIER_SPLIT_SOURCE = '(?:底层|中层|上层|顶层|第一层|第二层|第三层|基础层|核心层|表层)';
/** 层级名（用于**识别**：段首是否就是层级名） */
const TIER_NAME_RE = new RegExp(`^${TIER_SPLIT_SOURCE}`);

export function splitTiers(narration: string): string[] {
  // ① 按层级名切开，每段 = 「层级名 + 该层的内容」
  const parts = narration
    .split(new RegExp(`(?=${TIER_SPLIT_SOURCE})`))
    .map((s) => strip(s))
    .filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 3);
  // ② 没有层级名 → 按序数/步骤切
  const numbered = narration
    .split(/(?:[①②③]|[123][\.、])/)
    .map((s) => strip(s))
    .filter(Boolean);
  if (numbered.length >= 2) return numbered.slice(0, 3);
  return splitSteps(narration, 3);
}

/**
 * 从一段层级描述里拆出「层级名」与「该层的对象名」。
 *
 * 「上层是控制单元」→ 层级名「上层」+ 对象名「控制单元」。
 *
 * 为什么必须拆开：层级标签的价值在于它指明「第几层」，
 * 而卡面正文要说的是「这一层是什么」。两者塞进同一个槽，
 * 画面上就只能显示其中一个——显示层级名就丢了内容，显示内容就分不清上下。
 */
export function splitTierPair(segment: string): { tier: string; object: string } {
  const s = strip(segment);
  const m = TIER_NAME_RE.exec(s);
  if (!m || m.index !== 0) return { tier: '', object: extractTerm(s) };
  const tier = m[0];
  const rest = s.slice(tier.length);
  return { tier, object: extractTerm(rest) };
}

/**
 * 层级的兜底名：旁白里没有「上层/中层/底层」时，用序号名。
 *
 * 「首先…然后…最后…」的旁白切不出层级名，但画面上三张卡还是要有区分——
 * 否则三张卡标题全空，观众根本不知道它们是三个不同的东西。
 * 序号名（第一层/第二层/第三层）是最保守也最诚实的兜底：
 * 它不编造内容，只说明顺序。
 */
const ORDINAL_TIER_NAMES = ['第一层', '第二层', '第三层'];

/** 层级名（带兜底） */
export function tierName(segment: string, index: number): string {
  const pair = splitTierPair(segment);
  if (pair.tier) return pair.tier;
  return ORDINAL_TIER_NAMES[index] ?? '';
}

/**
 * 把重音词按旁白里的位置分成两组（对比模板用）。
 *
 * 「相比同步执行，并行流水线的吞吐是它的四倍」，emphasis=['同步执行','并行','吞吐']
 * → 左组 ['同步执行']（在对比点之前）、右组 ['并行','吞吐']（在对比点之后）。
 *
 * 为什么按位置分而不是取前两个：对比模板的左右两栏必须**各自对应旁白的一侧**，
 * 否则左栏显示右栏的内容，画面就在说反话。
 */
export function splitEmphasisByPosition(
  narration: string,
  emphasis: string[],
  contrastAt: number,
): [string[], string[]] {
  const left: string[] = [];
  const right: string[] = [];
  for (const w of emphasis) {
    if (!w) continue;
    const idx = narration.indexOf(w);
    if (idx < 0) continue;
    if (idx < contrastAt) left.push(w);
    else right.push(w);
  }
  return [left, right];
}

/**
 * 从旁白里抽一组数字（图表模板用）。
 *
 * 返回的数字**必须来自旁白**——图表镜的数字是内容的一部分，
 * 编造数字就是编造事实（V-CHT-002 禁编造数据）。
 * 旁白里数字不足时，返回的数组短于需要的柱数，
 * 由调用方决定用「相对高度」（按相对比例补齐）还是留空。
 */
export function extractNumbers(narration: string, max = 4): number[] {
  const out: number[] = [];
  for (const m of narration.matchAll(/(-?\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 内容派生主入口。
 *
 * @param templateId 模板 id（决定切分规则）
 * @param ctx 本镜上下文
 */
export function deriveContent(templateId: string, ctx: ContentContext): ContentValues {
  const out: ContentValues = {};
  const set = (k: string, v: string | number): void => {
    out[k] = v;
  };
  const narr = ctx.narration;
  const fig = extractFigure(narr);
  /**
   * 安全标签：优先用导演显式给的（可长，因为它是自己选的术语），否则走派生。
   *
   * 派生来源的优先级：**编剧声明的重音词 > 术语抽取**。
   * 重音词是编剧从原文里摘的词，是术语（「取指」「译码」）而不是句子碎片，
   * 而且它**声明式**——V-SCENE-005 对声明的术语有豁免（见 scene.ts 的 exemptTerms），
   * 所以它可以上屏而不被判「看图说话」。
   *
   * 术语抽取的结果没有豁免，所以仍要过 safeLabel（不与旁白共享 4 字窗口）。
   */
  const label = (explicit: string | undefined, fallback: string, max = 12): string => {
    if (explicit !== undefined && explicit !== '') return strip(explicit).slice(0, max);
    return safeLabel(fallback, narr, max);
  };
  /** 编剧声明的重音词里最长的一个（优先上屏） */
  const emphFirst = ctx.emphasis.find((w) => w && ctx.narration.includes(w)) ?? '';
  /** 声明式重音词可直接上屏（V-SCENE-005 豁免） */
  const emphLabel = (explicit: string | undefined, fallback: string, max = 12): string => {
    if (explicit !== undefined && explicit !== '') return strip(explicit).slice(0, max);
    if (emphFirst) return strip(emphFirst).slice(0, max);
    return safeLabel(fallback, narr, max);
  };

  switch (templateId) {
    case 'kinetic-type': {
      set('HERO_WORD', extractHeroWord(ctx));
      set('FIGURE', fig ? fig.display : '');
      set('FIGURE_TO', fig ? fig.value : 0);
      set('FIGURE_DEC', fig ? fig.decimals : 0);
      set('FIGURE_SUFFIX', fig ? fig.suffix : '');
      set('FIGURE_AT', 600);
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, emphFirst, 28));
      break;
    }
    case 'compare-stage': {
      const [left, right] = splitContrast(narr);
      const lf = extractFigure(left);
      const rf = extractFigure(right);
      // 对比两侧的标签：**优先用编剧声明的重音词**（按位置分到左右两侧）——
      // 重音词是编剧从原文里摘的「要重读的词」，是术语而不是句子碎片，
      // 且它由编剧判断、模型可读，是「整体兼容」的第一现场。
      // 没有重音词时退回术语抽取。
      const contrastAt = narr.search(/相比|相较|对比|不同于|反而|vs|VS|versus/);
      const [leftEmph, rightEmph] =
        contrastAt >= 0
          ? splitEmphasisByPosition(narr, ctx.emphasis, contrastAt)
          : [[], []];
      const leftTerm = leftEmph[0] ?? extractTerm(left.replace(/^(相比|相较|对比|不同于|反而)/, ''));
      const rightTerm = rightEmph[0] ?? extractTerm(right);
      set('LEFT_TAG', label(ctx.params['LEFT_TAG'] as string | undefined, leftTerm, 10));
      set('LEFT_NUM', lf ? lf.display : '');
      set('LEFT_NOTE', label(ctx.params['LEFT_NOTE'] as string | undefined, leftEmph[1] ?? emphFirst, 24));
      set('RIGHT_TAG', label(ctx.params['RIGHT_TAG'] as string | undefined, rightTerm, 10));
      set('RIGHT_NUM', rf ? rf.display : '');
      set('RIGHT_NOTE', label(ctx.params['RIGHT_NOTE'] as string | undefined, rightEmph[1] ?? '', 24));
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, '', 28));
      set('PUNCH_AT', 720);
      break;
    }
    case 'deep-stage': {
      const panels = splitTiers(narr);
      set('HERO_WORD', extractHeroWord(ctx));
      for (let i = 0; i < 3; i += 1) {
        const pair = splitTierPair(panels[i] ?? '');
        const key = `PANEL${i + 1}` as const;
        // 卡面标签 = 层级名优先（上层/中层/底层），没有层级名就用对象名
        const value = pair.tier || pair.object;
        set(key, label(ctx.params[key] as string | undefined, value, 16));
      }
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, emphFirst, 28));
      set('PUNCH_AT', 720);
      break;
    }
    case 'hierarchy-stack': {
      const tiers = splitTiers(narr);
      for (let i = 0; i < 3; i += 1) {
        const pair = splitTierPair(tiers[i] ?? '');
        const key = `TIER${i + 1}` as const;
        const nameKey = `NAME${i + 1}` as const;
        const descKey = `DESC${i + 1}` as const;
        // 该层区间内的重音词 = 这一层的对象名（声明式，可上屏）
        const tierText = tiers[i] ?? '';
        const tierEmph = ctx.emphasis.find((w) => w && tierText.includes(w));
        // TIER = 层级名（「上层」，无层级名时兜底为「第一层」）
        set(key, label(ctx.params[key] as string | undefined, tierName(tierText, i), 12));
        // NAME = 该层的对象名（「控制单元」）；没有对象名时退回层级名
        set(nameKey, label(ctx.params[nameKey] as string | undefined, tierEmph ?? (pair.object || pair.tier), 12));
        set(descKey, label(ctx.params[descKey] as string | undefined, tierEmph ?? pair.object, 24));
      }
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, emphFirst, 28));
      set('PUNCH_AT', 720);
      break;
    }
    case 'paper-stage': {
      const cards = splitSteps(narr, 3);
      for (let i = 0; i < 3; i += 1) {
        const text = cards[i] ?? '';
        const tagKey = `CARD${i + 1}_TAG` as const;
        const bodyKey = `CARD${i + 1}_BODY` as const;
        // 卡名优先用落在该卡区间内的重音词（声明式，可上屏）
        const cardEmph = ctx.emphasis.find((w) => w && text.includes(w));
        set(tagKey, label(ctx.params[tagKey] as string | undefined, cardEmph ?? extractTerm(text), 10));
        set(bodyKey, label(ctx.params[bodyKey] as string | undefined, cardEmph ?? extractTerm(text), 24));
      }
      // HERO_CARD 是**序号**（第几张卡接管），不是文案——见 paper-stage.meta.json
      set('HERO_CARD', 1);
      set('HERO_CARD_N', 1);
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, '', 28));
      set('MORPH_AT', 640);
      set('PUNCH_AT', 720);
      break;
    }
    case 'process-track': {
      const stops = splitSteps(narr, 4);
      // 每个站点优先用**落在该站区间内的重音词**——编剧已经标好了
      // 「这一段要重读哪个词」，那就是站点的名字。
      for (let i = 0; i < 4; i += 1) {
        const key = `STOP${i + 1}` as const;
        const stepText = stops[i] ?? '';
        const stepEmph = ctx.emphasis.find((w) => w && stepText.includes(w));
        set(key, label(ctx.params[key] as string | undefined, stepEmph ?? extractTerm(stepText), 12));
      }
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, emphFirst, 28));
      set('PUNCH_AT', 720);
      break;
    }
    case 'chart': {
      // 图表镜的数字**必须来自旁白**（V-CHT-002 禁编造数据）。
      // 旁白里的数字不足 4 个时，按相对比例补齐柱高（形状成立），
      // 但数值槽（VAL*）留空——宁可柱子没有数字，也不要编一个假数字。
      const nums = extractNumbers(narr, 4);
      const maxVal = nums.length > 0 ? Math.max(...nums.map((v) => Math.abs(v))) : 0;
      const heights: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const v = nums[i];
        if (v === undefined) {
          heights.push(0);
          values.push(0);
          continue;
        }
        values.push(Math.abs(v));
        // 相对高度：最大值占 88%，其余按比例（留出顶部标签位）
        heights.push(maxVal > 0 ? Math.round((Math.abs(v) / maxVal) * 88) : 0);
      }
      for (let i = 0; i < 4; i += 1) {
        set(`BAR${i + 1}`, heights[i] ?? 0);
        set(`VAL${i + 1}`, values[i] ?? 0);
        // 横轴标签：优先用重音词，没有就留空（不编造年份/季度名）
        set(`LABEL${i + 1}`, '');
      }
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, emphFirst, 28));
      break;
    }
    default:
      // 通用模板（排版/氛围/图表…）：主语 + 辅助说明 + 章节标签
      set('HERO_WORD', extractHeroWord(ctx));
      set('KICKER', ctx.params['KICKER'] !== undefined ? String(ctx.params['KICKER']) : '');
      set('SUB_LINE', label(ctx.params['SUB_LINE'] as string | undefined, emphFirst, 28));
      break;
  }
  return out;
}

/** 从项目里取出本镜的上下文（讲稿段落的 emphasis 是编剧声明的重音词） */
export function contextForShot(project: Project, shot: Shot): ContentContext {
  const seg = project.script?.segments.find((s) => s.id === shot.segmentId);
  return {
    narration: shot.narration,
    prompt: shot.visual.prompt,
    params: (shot.visual.params ?? {}) as Record<string, unknown>,
    emphasis: seg?.emphasis ?? [],
    shotId: shot.id,
  };
}
