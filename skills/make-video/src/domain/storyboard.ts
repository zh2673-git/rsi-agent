import type { LlmClient } from '../infrastructure/llm-client.js';
import type {
  CameraIntent,
  Coverage,
  DirectorNote,
  MaterialDecision,
  Project,
  Recipe,
  Shot,
  Staging,
  StyleDecision,
  VisualKind,
} from '../core/schema.js';
import { CAMERA_INTENTS, StagingSchema } from '../core/schema.js';
import { V } from '../core/index.js';
import { PUSH_CAMERAS } from '../core/validators/scene.js';

/** 推镜族词集（V-MOT-014；唯一事实源在 core/validators/scene.ts） */
const PUSH_WORDS = new Set<string>(PUSH_CAMERAS);
import { mvError, ERR } from '../core/errors.js';
import type { ProjectStore } from '../infrastructure/project-store.js';
import type { StyleRegistry } from './style-registry.js';
import { applyStyleVisualPool, pickTemplateBySemantics } from './scene-semantics.js';
import {
  pickGrammar,
  actionSheet,
  defaultCameraFor,
  varyCameraFor,
  GRAMMARS,
  normalizeCameraBias,
} from './motion-grammar.js';
import { parseEnergyCurve, energyAt } from './continuity.js';

export interface MaterialIndexItem {
  path: string;
  type: 'image' | 'video' | 'audio' | 'other';
  durationMs?: number;
  tags: string[];
  /** 素材契约（P5）：尺寸用于入库校验与裁切决策 */
  width?: number;
  height?: number;
  /** 来源溯源：检索地址/作者/许可证，写进 shot.asset.meta 便于回溯 */
  sourceUrl?: string;
  credit?: string;
  license?: string;
}

export interface MaterialIndex {
  items: MaterialIndexItem[];
}

export async function writeDirectorNotes(
  project: Project,
  llm: LlmClient,
  recipe: Recipe,
): Promise<DirectorNote[]> {
  if (!project.script) throw mvError(ERR.SCHEMA, '缺少讲稿，无法写导演批注');
  const raw = await llm.generate({
    kind: 'director-notes',
    payload: {
      segments: project.script.segments,
      recipeNotes: recipe.directorialNotes,
      genre: recipe.id,
    },
  });
  const notes = (raw as unknown[]).map((n, i) => {
    const note = n as Partial<DirectorNote>;
    if (!note.segmentId || !note.visualIntent) {
      throw mvError(ERR.LLM_SCHEMA, `导演批注第 ${i + 1} 条缺字段`);
    }
    return {
      segmentId: note.segmentId,
      visualIntent: note.visualIntent,
      emotionGoal: note.emotionGoal ?? '稳定推进',
      referenceMood: note.referenceMood ?? '',
      counterpoint: note.counterpoint ?? 'metaphor',
    } satisfies DirectorNote;
  });
  project.directorNotes = notes;
  return notes;
}

export function decideMaterials(
  segments: Array<{ id: string; text: string; assetNeed?: string }>,
  index: MaterialIndex,
  policy: Project['meta']['assetPolicy'],
): MaterialDecision[] {
  return segments.map((seg) => {
    const hit = matchMaterial(index, seg.text);
    // A2 assetNeed（P13 阶段1 · 提案 §1.E）：剧本层已声明「这段值不值得用真实素材」。
    // 优先级：库存命中永远最高（有真素材就用，不因声明弃用）；
    // 其次看声明——evidence 段即使库存没命中也要去云端找，mood 段即使命中也要倾向代码绘制。
    if (seg.assetNeed === 'mood' && !hit) {
      return {
        kind: 'code-scene' as VisualKind,
        reason: '剧本声明 assetNeed=mood（情绪段）→ 代码绘制，抽象比实拍更贴',
      };
    }
    if (hit) {
      return {
        kind: 'user-material' as VisualKind,
        source: hit.path,
        reason:
          seg.assetNeed === 'mood'
            ? `具体指称物命中用户素材（${hit.tags.join('/') || hit.type}），虽为情绪段但有实物可用`
            : `具体指称物命中用户素材（${hit.tags.join('/') || hit.type}）`,
      };
    }
    if (seg.assetNeed === 'evidence') {
      // 证据段要的是**真素材**，不是 AI 生图——生图出来的是假证据，且会撞 V-AI-001 授权闸门。
      // 所以这里只把诉求写进 reason + 保持策略给的路，真正的「去找真素材」由 material-plan
      // 的需求单兑现（planMaterials 读 assetNeed 决定 need/query）。
      const base =
        policy === 'real-first'
          ? 'real-first 策略且库存无匹配 → 云端生成'
          : '剧本声明 assetNeed=evidence（证据段）：库存无匹配，需求单要求真素材检索';
      return { kind: (policy === 'real-first' ? 'cloud' : 'code-scene') as VisualKind, reason: base };
    }
    if (policy === 'code-first' || policy === 'auto') {
      return { kind: 'code-scene' as VisualKind, reason: '抽象概念/数据 → 代码绘制（默认）' };
    }
    if (policy === 'real-first') {
      return { kind: 'cloud' as VisualKind, reason: 'real-first 策略且库存无匹配 → 云端生成' };
    }
    return { kind: 'code-scene' as VisualKind, reason: 'ask 策略默认先画，确认表可改' };
  });
}

export function matchMaterial(index: MaterialIndex, text: string): MaterialIndexItem | null {
  const t = text.toLowerCase();
  let best: { item: MaterialIndexItem; score: number } | null = null;
  for (const item of index.items) {
    if (item.type === 'audio') continue;
    const score = item.tags.reduce((acc, tag) => (t.includes(tag.toLowerCase()) ? acc + 2 : acc), 0);
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

export function decideStyle(
  registry: StyleRegistry,
  recipe: Recipe,
  userStyleId?: string,
): StyleDecision {
  if (userStyleId) {
    const pack = registry.getStyle(userStyleId);
    return {
      id: pack.id,
      source: 'user-specified',
      rationale: `用户指定风格 ${pack.userFacing.name}（${pack.userFacing.vibe}）`,
      lineage: {},
      overrides: {},
    };
  }
  const recommended = recipe.style.recommended.find((id) => {
    try {
      registry.getStyle(id);
      return true;
    } catch {
      return false;
    }
  });
  if (recommended) {
    const pack = registry.getStyle(recommended);
    return {
      id: pack.id,
      source: 'recipe-recommended',
      rationale: `${recipe.name}配方推荐：${recipe.style.rationale}`,
      lineage: {},
      overrides: {},
    };
  }
  const fallback = registry.listStyles()[0];
  if (!fallback) throw mvError(ERR.STYLE_UNKNOWN, '风格库为空');
  return {
    id: fallback.id,
    source: 'agent-chosen',
    rationale: `配方推荐不可用，按分类轴选择最近包 ${fallback.id}`,
    lineage: { base: fallback.id },
    overrides: {},
  };
}

/** 静态机位族：这些值意味着「机位这一镜真的没动」，是 hold 动机的事实依据 */
const STILL_CAMERAS = new Set(['static', 'none', '']);

/**
 * 由已选语法派生机位动机（P13 阶段1 · A5 生产方）。
 *
 * 为什么按语法而不是按内容再判一次：语法选型（pickGrammar）已经把「这段口播在讲什么、
 * 观众要看什么」判过一遍（GRAMMARS[].when / cues），机位动机是那个判断的**机位结论**，
 * 再拿旁白判一次等于让两套标准互相打脸。所以这里的映射是 1:11 的确定表。
 *
 * 事实优先于声明：camera 已经落定（LLM 给的或兜底选的），若它其实是 static，
 * 动机就不该是 follow/reveal——那是给运动镜的动机。这一条同时让
 * motion-audit 的 multiTrackMotion（动轨计数）与 intent 自洽。
 */
export function deriveIntent(grammarId: string | undefined, index: number, camera?: string): CameraIntent {
  const still = STILL_CAMERAS.has(camera ?? '');
  // 首镜的任务是「这是哪儿」——即使它是空镜或静止，交代环境本身就是动机
  if (index === 0) return 'setup';
  if (still) return 'hold';
  switch (grammarId) {
    case 'y1_flat_explainer':
    case 'y6_mechanism':
    case 'y7_system_map':
    case 't1_3b1b':
      return 'reveal';
    case 'y2_collage':
    case 'y3_whiteboard':
    case 't3_finance':
      return 'follow';
    case 'y4_story':
      return 'emotion';
    case 'y5_kinetic_type':
    case 't2_keynote':
      return 'setup';
    case 'b_roll':
      return 'hold';
    default:
      // 语法缺失（旧项目 / 手写 IR）：机位在动就是在跟随内容，不动就是 hold
      return 'follow';
  }
}

/** 各意图对应的机位动作措辞（写进 staging.camera.what，供调度表读懂） */
const INTENT_WHAT: Record<CameraIntent, string> = {
  follow: '机位跟着观众要读的那个对象移动',
  reveal: '先给全貌，再推进到关键局部',
  hold: '机位定住不动，靠画面内部元素产生变化',
  emotion: '机位服务于表情与停顿，不动或极缓',
  setup: '机位一次到位交代「这是哪儿」，然后停住',
};

/**
 * 组装五轨调度表（P13 阶段1 · A5）。
 *
 * 机位轨必填（motion + what + why + intent）：机位是唯一「动不动都需要理由」的轨。
 * 其余四轨只在有实际调度内容时才写——schema 里 optional 的语义是「本轨未单独调度」，
 * 硬塞默认值会让「没调度」和「调度为静」变得不可分（提案 §1.C 的原始约束）。
 */
function buildStaging(
  shot: Shot,
  intent: CameraIntent,
  grammarId: string | undefined,
  declared: Partial<Staging>,
  holdConflict: boolean,
): Staging {
  const cameraMoving = !STILL_CAMERAS.has(shot.camera ?? '');
  const why = holdConflict
    ? `声明 hold 但机位为 ${shot.camera}（运动事实优先），按语法 ${grammarId ?? 'unknown'} 重判为 ${intent}`
    : declared.camera?.why || `语法 ${grammarId ?? 'unknown'}：${INTENT_WHAT[intent]}`;
  const staging: Staging = {
    camera: {
      motion: cameraMoving ? 'move' : 'still',
      what: declared.camera?.what || INTENT_WHAT[intent],
      why,
      intent,
    },
  };
  // 主体轨：动作谱已写明主体是什么（文字主导 or 具体物件）——有值就落，不另判
  const subjectWhat = (shot.visual.params['actionSheet'] as { subject?: string } | undefined)?.subject;
  if (declared.subject) staging.subject = declared.subject;
  else if (subjectWhat) staging.subject = { motion: cameraMoving ? 'move' : 'still', what: subjectWhat, why: '语法动作谱已指定主体' };
  if (declared.supporting) staging.supporting = declared.supporting;
  if (declared.environment) staging.environment = declared.environment;
  // 字幕轨：这一镜要念的重点词就是上字幕的内容（emphasis 已在剧本层声明）
  if (declared.subtitle) staging.subtitle = declared.subtitle;
  else if (shot.narration.trim()) {
    staging.subtitle = {
      motion: 'still',
      what: '与口播同步的字幕（关键词加重）',
      why: '口播类视频字幕是默认轨，不是可选项',
    };
  }
  return staging;
}

export async function storyboard(
  store: ProjectStore,
  project: Project,
  llm: LlmClient,
  recipe: Recipe,
  registry: StyleRegistry,
  materialIndex: MaterialIndex,
  userStyleId?: string,
): Promise<Shot[]> {
  if (!project.script) throw mvError(ERR.SCHEMA, '缺少讲稿，无法分镜');
  if (project.directorNotes.length === 0) {
    await writeDirectorNotes(project, llm, recipe);
  }
  // init --style 已经把用户指定写进 project.style；storyboard 不传 --style 时必须沿用它，
  // 否则 decideStyle 会退回 recipe 推荐，把用户在 init 时的显式选择静默覆盖掉。
  const styleDecision = decideStyle(registry, recipe, userStyleId ?? project.style?.id);
  if (project.style && project.style.id === styleDecision.id && project.style.source === 'user-specified') {
    styleDecision.source = 'user-specified';
    styleDecision.rationale = project.style.rationale;
  }
  const stylePack = registry.resolveStyle(styleDecision);
  const decisions = decideMaterials(
    project.script.segments.map((s) => ({ id: s.id, text: s.text, assetNeed: s.assetNeed })),
    materialIndex,
    project.meta.assetPolicy,
  );
  // 风格决定素材池：sceneDeny 剔除、sceneBias 前置（V-STYLE-008）
  const templatePool = applyStyleVisualPool(recipe.templates, stylePack.visuals);
  const raw = await llm.generate({
    kind: 'storyboard',
    payload: {
      segments: project.script.segments,
      directorNotes: project.directorNotes,
      templates: templatePool,
      styleVisual: stylePack.visuals,
      shotScaleBias: stylePack.shotScaleBias,
      materialDecisions: decisions,
    },
  });
  const shots: Shot[] = (raw as unknown[]).map((s, i) => {
    const shot = s as Partial<Shot>;
    if (!shot.narration || !shot.visual) {
      throw mvError(ERR.LLM_SCHEMA, `分镜第 ${i + 1} 条缺字段`);
    }
    // V-COL-002 色彩脚本：按 cool→neutral→warm 循环分配色温（三幕冷暖节奏）
    const colorTemp = (['cool', 'neutral', 'warm'] as const)[i % 3];
    const visual = { ...shot.visual, params: { ...(shot.visual.params ?? {}) } };
    // 风格素材池是硬边界：LLM 选了池外形态（含被 sceneDeny 的）就回退到池内语义选择，
    // 否则「风格决定素材」只是一句口号，画面仍可漂回风格之外
    if (!templatePool.includes(visual.template ?? '')) {
      visual.template = pickTemplateBySemantics(
        shot.narration,
        templatePool,
        stylePack.visuals?.sceneBias ?? [],
      );
    }
    // kicker = 该段 beat 的名称（观众可读的章节标签）。
    // P12 阶段1：不止 canvas 用它——普通场景模板的 KICKER 槽也需要它，
    // 否则「这一镜属于哪一章」这个信息在画面上完全没有体现。
    {
      const seg = project.script?.segments.find((x) => x.id === (shot.segmentId ?? project.script?.segments[i]?.id));
      const beatName = recipe.beats.find((b) => b.id === seg?.beat)?.name;
      visual.params['kicker'] = visual.params['kicker'] ?? beatName ?? '';
    }
    return {
      id: `s${String(i + 1).padStart(2, '0')}`,
      segmentId: shot.segmentId ?? project.script?.segments[i]?.id ?? `seg-${i + 1}`,
      narration: shot.narration,
      visual,
      zoom: shot.zoom ?? 'MS',
      // V-CAM-006：静态画面必须过相机运动——分镜层默认缓推，禁止 none 蒙混
      camera: shot.camera && shot.camera !== 'none' ? shot.camera : 'push-in',
      motivation: shot.motivation ?? '',
      counterpoint: shot.counterpoint ?? 'metaphor',
      gag: shot.counterpoint === 'parody' ? true : false,
      colorTemp,
      // 导演显式给了转场就尊重；留空 = auto，交给剪辑部按切点动机裁决
      transition: shot.transition ?? stylePack.transitions[i % stylePack.transitions.length] ?? 'dissolve',
      // docs/04 A5：镜头内覆盖 / match-cut 锚点 / J-L cut 音频偏移（LLM 可给，缺省由合成阶段派生）
      coverage: normalizeCoverage(shot.coverage),
      enterAnchor: shot.enterAnchor ?? '',
      exitAnchor: shot.exitAnchor ?? '',
      audioShiftMs: typeof shot.audioShiftMs === 'number' ? shot.audioShiftMs : 0,
      // P13 阶段1 · A5：LLM 声明的机位动机/调度表原样收下（枚举非法就丢，交给下方派生）。
      // 这里只做「收进来」，不做裁决——矛盾（如 hold + push-in）在派生循环里判，原因可追溯。
      ...(CAMERA_INTENTS.includes(shot.intent as CameraIntent)
        ? { intent: shot.intent as CameraIntent }
        : {}),
      ...(shot.staging ? { staging: shot.staging } : {}),
      state: 'pending' as const,
    } satisfies Shot;
  });
  // P8-T6 超长镜切分：旁白 >8s（花叔「一镜 2-6s」硬档 + V-MOT-017 上限 6.5s）的镜
  // 按句号/问号切成两镜以上——拆开的是「一镜装一段话」的 PPT 拍法；
  // 拆出的镜共用原 segmentId（配音按镜旁白合成，素材沿用由 narration 变化自然失效）。
  const LONG_SHOT_CHARS = 36; // 36 字 × 220ms ≈ 7.9s
  const splitShots: Shot[] = [];
  for (const shot of shots) {
    const sentences = shot.narration.split(/(?<=[。！？!?])/).filter((s) => s.trim().length > 0);
    if (shot.narration.length <= LONG_SHOT_CHARS || sentences.length < 2) {
      splitShots.push(shot);
      continue;
    }
    // 尽量均匀分给前半/后半（长句优先在前，与口播语序一致）
    const target = Math.ceil(shot.narration.length / 2);
    let acc = 0;
    let cut = 1;
    for (let k = 0; k < sentences.length - 1; k += 1) {
      acc += sentences[k]!.length;
      if (acc >= target) {
        cut = k + 1;
        break;
      }
      cut = k + 1;
    }
    const partA = sentences.slice(0, cut).join('');
    const partB = sentences.slice(cut).join('');
    if (!partA.trim() || !partB.trim()) {
      splitShots.push(shot);
      continue;
    }
    const mk = (narration: string, suffix: string, extraCoverage = false): Shot => ({
      ...shot,
      id: `${shot.id}${suffix}`,
      narration,
      // 拆出的两半必须是各自独立的 visual/params：直接 ...shot 会让 a/b 共用同一个对象引用，
      // 于是后面写 a 镜的 actionSheet 时 b 镜也「看起来已经有了」（declared.grammar 命中即跳过），
      // 结果是 b 镜动作谱与文案全部沿用 a 镜（实测 8 个 b 镜 actionSheet.line 都等于同段 a 镜旁白）。
      visual: { ...shot.visual, params: { ...shot.visual.params } },
      // 拆出的后半镜换构图（V-MOT-020）：景别进一档，后半比前半更近
      zoom: extraCoverage ? nextZoomIn(shot.zoom) : shot.zoom,
      coverage: extraCoverage ? shot.coverage : shot.coverage,
      // 死板清除 X1（2026-11-14）：b 镜机位不再照抄 a 镜——`...shot` 让 b 镜继承 camera，
      // 实测 8 对拆分镜 4 对机位全同（s01a/b 同 push-in…），观众看到同一动作播两遍。
      // 这里先置 none 交给下方兜底循环按「与 a 镜不同」的变奏规则重取。
      camera: extraCoverage ? 'none' : shot.camera,
    });
    splitShots.push(mk(partA, 'a'), mk(partB, 'b', true));
  }
  shots.length = 0;
  shots.push(...splitShots);
  // P8-T2 语法前移：动效语法在分镜期选定（而不是 compose 期补记录）——
  // 语法要约束 LLM 场景生成（payload 带动作谱）与模板语义归位，晚于分镜就失去约束力。
  // compose 期 composer 只沿用既有 actionSheet，不再重算（导演/人工可改，改了就算数）。
  const grammarRecent: string[] = [];
  let y5Count = 0;
  // T1c 能量曲线：风格包 pacing.curve（或项目 overrides）→ 每镜能量目标，喂给选型
  const energyCurve = parseEnergyCurve(stylePack.pacing?.curve);
  shots.forEach((shot, idx) => {
    shot.visual.params['energy'] = energyCurve ? energyAt(shots.length, idx, energyCurve) : undefined;
  });
  for (const shot of shots) {
    const declared = shot.visual.params['actionSheet'] as { grammar?: string } | undefined;
    if (declared?.grammar) {
      grammarRecent.push(declared.grammar);
      if (declared.grammar === 'y5_kinetic_type') y5Count += 1;
      continue;
    }
    // P8-T6 文字主导闸：前文 y5 已超 40% 配额 → 抑制 y5（重音是稀缺资源，全片都砸=没有重点）
    const suppress = y5Count / Math.max(1, grammarRecent.length) > 0.4 && grammarRecent.length >= 3;
    // 死板清除 X2：上一镜已落 b_roll → 本镜抑制 b_roll 兜底（成对氛围镜=默认不会选型）
    const lastGrammar = grammarRecent.at(-1);
    const g = pickGrammar(shot.narration, {
      recent: grammarRecent.slice(-2) as import('./motion-grammar.js').GrammarId[],
      hasRealMaterial: shot.visual.kind === 'user-material' || shot.visual.kind === 'imported',
      singleNumber: (shot.narration.match(/\d+/g) ?? []).length === 1,
      suppressTextLed: suppress,
      suppressBroll: lastGrammar === 'b_roll',
      energy: energyCurve ? energyAt(shots.length, shots.indexOf(shot), energyCurve) : undefined,
      // P12 阶段2：把「风格偏好」与「可用场景池」喂给语法选型。
      // 此前 styleBias 字段定义了但全仓 0 消费——语法选型完全不看风格，
      // 于是「科技风格」只换了配色，动效与镜头跟风格无关。
      styleBias: stylePack.visuals?.sceneBias ?? [],
      scenePool: templatePool,
    });
    grammarRecent.push(g.id);
    if (g.id === 'y5_kinetic_type') y5Count += 1;
    shot.visual.params['actionSheet'] = actionSheet(shot, g);
    // P12 阶段3：**模板对齐语法**——把「画面形态」也纳入语法的管辖。
    //
    // 此前语法与模板是两条独立的选型链：语法说「这一镜怎么动」，
    // 模板说「这一镜画成什么样」，两者各选各的 → 选出「语法 y5 动态文字 +
    // 画面氛围空镜」这种自相矛盾的组合（V-MOT-024 报的就是这个）。
    //
    // 现在：语法选定后，若当前模板不承载该语法，就换到**承载它的模板**里
    // 选语义最贴的那个（优先风格偏好，其次语义线索）。
    // 换不了（池里没有承载它的模板）就保留原模板——此时由 V-MOT-024 报不匹配，
    // 而不是静默出一个对不上的画面。
    if (!(shot.visual.template ?? '').startsWith('canvas:')) {
      const current = shot.visual.template ?? '';
      const carriers = g.sceneForms.filter((f) => templatePool.includes(f));
      if (carriers.length > 0 && !carriers.includes(current)) {
        const bias = stylePack.visuals?.sceneBias ?? [];
        const preferred = carriers.find((c) => bias.includes(c));
        shot.visual.template = preferred ?? pickTemplateBySemantics(shot.narration, carriers, bias);
      }
    }
  }
  // V-CAM-006 兜底修正（I-05）：缺省机位不再一律 push-in，按各镜语法取机位偏好
  // （b_roll→drift、y4→static、y2→pan…）。「static 是合法选择」的提示词承诺
  // 由兜底兑现，而不是只出现在文案里。导演显式给了机位的镜不受影响。
  // 死板清除 X1：同语法相邻镜（splitShots 的 a/b 对）机位变奏——b 镜在语法机位
  // 偏好里取一个与 a 镜不同的值，拆分镜不再「同一动作播两遍」。
  // P12 阶段2：机位兜底带上 **V-MOT-014 前瞻**——已连续两镜往里推时，
  // 本镜不再选推镜族（push-in/punch-in），否则整片在 compose 期被判 error。
  // 注意两条分支都要查：y5 的 cameraBias 首选就是 punch-in，
  // 「不同语法」那条分支同样会选出推镜。

  /** 已连续 pushRun 镜往里推时，本镜让位到第一个非推镜偏好 */
  const avoidPush = (grammarId: string | undefined, candidate: string): string => {
    if (pushRun < 2 || !PUSH_WORDS.has(candidate)) return candidate;
    const g = grammarId ? GRAMMARS.find((x) => x.id === grammarId) : undefined;
    const bias = (g?.cameraBias ?? ['static']).map(normalizeCameraBias);
    return bias.find((c) => !PUSH_WORDS.has(c)) ?? candidate;
  };
  let pushRun = 0;
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]!;
    const declared = shot.visual.params['actionSheet'] as { grammar?: string } | undefined;
    if (shot.camera && shot.camera !== 'none') {
      pushRun = PUSH_WORDS.has(shot.camera) ? pushRun + 1 : 0;
      continue;
    }
    const prev = shots[i - 1];
    const sameGrammar =
      prev &&
      (prev.visual.params['actionSheet'] as { grammar?: string } | undefined)?.grammar ===
        declared?.grammar;
    const candidate = sameGrammar
      ? varyCameraFor(declared?.grammar, prev!.camera)
      : defaultCameraFor(declared?.grammar);
    shot.camera = avoidPush(declared?.grammar, candidate) as Shot['camera'];
    // 不同语法的镜也可能选到推镜——同样纳入连续计数
    pushRun = PUSH_WORDS.has(shot.camera) ? pushRun + 1 : 0;
  }
  // P13 阶段1 · A5 生产方：机位动机 + 调度表。
  //
  // A5 先把 `intent`/`staging` 的**消费方**全接通（motion-audit 的 intentCoverage、
  // cut-audit 每条、continuity 的 V-CON-006、rigSummary），但全链路没有任何地方
  // **写**这两个字段——intentCoverage 恒为 0，「覆盖率 100%」永远不可能达成。
  // 这一段就是缺失的生产方：LLM 给了就收（枚举校验 + 矛盾裁决），没给按已选语法派生。
  //
  // 派生口径对齐 GRAMMARS 的 when / cameraBias / motionBeats，不是轮转：
  //   y1/y6/y7/t1 → reveal   这三条的动作谱都写「定场 → 推进放大 → 拉远」，机位承担揭示
  //   y2/y3/t3    → follow   材料/推导/数据是观众要跟读的对象，机位跟着它走
  //   y4          → emotion  情绪镜，机位服务于表情与停顿
  //   y5/t2       → setup    一屏一件事，机位到位就停
  //   b_roll      → hold     兜底氛围镜：没有理由就别动机位（Lumet）
  // 首镜一律 setup——全片第一镜的任务是交代「这是哪儿」，与它选了什么语法无关。
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]!;
    const grammarId = (shot.visual.params['actionSheet'] as { grammar?: string } | undefined)?.grammar;
    const derived = deriveIntent(grammarId, i, shot.camera);
    // LLM 声明的 staging 逐轨校验（整表 safeParse 会因缺 camera 轨而全丢，
    // 而缺省语义是「该轨未单独调度」，不该连带丢弃已声明的轨）。
    const parsed = StagingSchema.partial().safeParse(shot.staging);
    const declared = parsed.success ? parsed.data : {};
    const declaredIntent = declared.camera?.intent;
    // hold 与「机位在运动」是硬矛盾：camera 是运动事实，intent 是动机，事实优先。
    // 声明 hold 却给了 push-in 的镜按机位事实重派生，原因写进 camera.why（不静默改写）。
    const holdConflict = declaredIntent === 'hold' && !STILL_CAMERAS.has(shot.camera);
    const intent: CameraIntent = declaredIntent && !holdConflict ? declaredIntent : derived;
    shot.intent = intent;
    shot.staging = buildStaging(shot, intent, grammarId, declared, holdConflict);
  }
  // 重跑分镜不该无差别清空已完成产物：旁白原文没变的镜头照旧沿用配音与素材，
  // 否则每次 --script 微调或 storyboard 重进都要重配音（0.6B 模型几分钟起步）。
  const prevById = new Map(project.shots.map((s) => [s.id, s]));
  for (const shot of shots) {
    const prev = prevById.get(shot.id);
    if (!prev || prev.narration.trim() !== shot.narration.trim()) continue;
    if (prev.voice) {
      shot.voice = prev.voice;
      if (shot.state === 'pending') shot.state = 'voiced';
    }
    if (prev.asset) shot.asset = prev.asset;
  }
  project.shots = shots;
  project.style = styleDecision;
  project.materialDecisions = Object.fromEntries(
    shots.map((s, i) => [s.id, decisions[i] ?? { kind: 'code-scene', reason: '默认' }]),
  );
  project.stage = 'storyboard';
  const issues = [...V.validateStoryboard(project), ...V.validateRhythmPeriodicity(project)];
  if (V.hasError(issues)) {
    throw mvError(ERR.STORYBOARD_RULE, `分镜校验失败:\n${V.formatIssues(issues)}`);
  }
  await store.save(project);
  return shots;
}

// LLM 分镜里的覆盖条目是外部输入：只收 0-1 时间比、限 3 条，其余字段补默认
function normalizeCoverage(raw: Coverage[] | undefined): Coverage[] {
  return (raw ?? [])
    .filter((c) => c && Number.isFinite(c.at) && c.at >= 0 && c.at <= 1)
    .slice(0, 3)
    .map((c) => ({
      at: c.at,
      kind: c.kind === 'reframe' ? 'reframe' : 'punch-in',
      scale: Number.isFinite(c.scale) ? c.scale : 1.16,
      xPercent: Number.isFinite(c.xPercent) ? c.xPercent : 0,
      yPercent: Number.isFinite(c.yPercent) ? c.yPercent : 0,
      rotation: Number.isFinite(c.rotation) ? c.rotation : 0,
      motivation: c.motivation || 'emphasis',
    }));
}

/** 景别序列进一档（P8-T6 超长镜切分：后半镜比前半近，制造推近叙事） */
const ZOOM_LADDER = ['ELS', 'LS', 'MLS', 'MS', 'MCU', 'CU', 'ECU'] as const;
function nextZoomIn(zoom: string): (typeof ZOOM_LADDER)[number] {
  const i = ZOOM_LADDER.indexOf(zoom as (typeof ZOOM_LADDER)[number]);
  return ZOOM_LADDER[Math.min(ZOOM_LADDER.length - 1, i + 1)] ?? 'MS';
}

export function buildConfirmation(project: Project): string {
  const lines: string[] = [];
  lines.push('=== 开工前双向确认表（编剧结构 + 素材决策 + 风格 + 配乐/音效方案 + 导演批注摘要）===');
  lines.push('【请用户确认后再进入采购/写场景/合成音频；修改请编辑 project.json 或回复调整。】');
  // 编剧结构方案：结构由编剧按主题独创，钩子/beats 只是可选项。
  // V-SCP-003/004/007（beat 覆盖/钩子前置/连续 inform）已移除，不能在这里变相复活成模板。
  lines.push('【编剧结构方案（结构独创，不套钩子/八股）】');
  if (project.script?.segments?.length) {
    lines.push('  段落结构（段 id [功能/beat] 开头）：');
    for (const seg of project.script.segments) {
      const head = seg.text.replace(/\s+/g, '').slice(0, 24);
      lines.push(`    ${seg.id} [${seg.function}${seg.beat ? `/${seg.beat}` : ''}] ${head}`);
    }
    lines.push('  开头/展开/收束由编剧按主题定；钩子只是可选项，请确认此结构不是模板套壳。');
  } else {
    lines.push('  尚未写入讲稿（project.script）：结构须由编剧按主题独创——');
    lines.push('  怎么开头/展开/收束由编剧定；钩子只是可选项，不套 beats 检查表，不套八股结构。');
  }
  lines.push('');
  if (project.style) {
    lines.push(
      `风格：${project.style.id}（${project.style.source}）—— ${project.style.rationale}`,
    );
  }
  // 配乐/音效方案：用户确认的核心对象。没有 audioPlan 时提示需补，避免默认万能 bed 悄悄通过。
  if (project.audioPlan) {
    const a = project.audioPlan;
    lines.push('【配乐/音效方案】');
    lines.push(`  立意：${a.rationale || '（未写理由，需在 directorNotes 补充说明为何这样配）'}`);
    lines.push(`  气质=${a.mood} BPM=${a.bpm || '风格默认'} 和弦=${a.progression} 织体=${a.texture} 亮度=${a.brightness}`);
    lines.push(`  音效音色=${a.sfxPalette}（转场/重音按此音色生成，不是全片同一条 whoosh）`);
  } else {
    lines.push('【配乐/音效方案】⚠ 尚未写 project.audioPlan：将退化为风格默认/通用默认，可能听感生硬。请补充后再确认。');
  }
  lines.push('');
  lines.push('【逐镜素材与视觉提示词】');
  for (const shot of project.shots) {
    const dec = project.materialDecisions[shot.id];
    const note = project.directorNotes.find((n) => n.segmentId === shot.segmentId);
    lines.push(
      `  ${shot.id} [${shot.zoom}/${shot.camera}] ${dec?.kind ?? 'code-scene'}：${dec?.reason ?? ''}`,
    );
    lines.push(`      对位=${shot.counterpoint} 批注：${note?.visualIntent ?? '-'}`);
  }
  lines.push('确认后进入采购阶段；修改请直接编辑 project.json 或重跑 storyboard。');
  return lines.join('\n');
}
