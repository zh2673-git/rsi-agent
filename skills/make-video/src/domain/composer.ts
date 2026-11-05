import path from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  ContinuityReport,
  Project,
  StyleMedia,
  StylePack,
  SubtitlePolicy,
  Timeline,
} from '../core/schema.js';
import { normalizeCameraToken } from '../core/schema.js';
import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import { TEMPLATES_DIR } from '../core/constants.js';
import type { ProjectStore } from '../infrastructure/project-store.js';
import { atomicWriteText, copyFile, ensureDir, exists } from '../infrastructure/fs-utils.js';
import { extractKeywords } from '../core/validators/scene.js';
import { copyDir } from './composer-utils.js';
import { escapeHtml } from './scene-forge.js';
import { buildVoTrack, buildBgm, duckBgm, buildSfx, planMix, exportSrt, checkMixAudibility } from './audiomix.js';
import { DUCK_RATIO } from '../core/constants.js';
import {
  planTransition,
  cutMotivation,
  deriveRelationMotivation,
  motivationTransition,
  type TransitionPlan,
} from './transitions.js';
import { extractFrameSequence } from '../infrastructure/ffmpeg-utils.js';
import {
  buildRigScript,
  deriveCoverage,
  parseCameraOptions,
  pickSubjectFocus,
  planCameraRig,
  type RigPlan,
} from './camera.js';
import {
  actionSheet,
  auditMotionMix,
  auditOpening,
  pickGrammar,
  type GrammarId,
  type MotionShotFact,
} from './motion-grammar.js';

/**
 * 由时间线 + 场景事实拼出混剪审计的输入（V-MOT-013~020）。
 * 构图 key = 景别 + 主体侧位：相邻镜一样就是「没换构图」——
 * 花叔的「相邻两镜换构图，不换画风」，判据必须是画面结构，不是语法名。
 */
function toMotionFact(
  t: Timeline['shots'][number],
  project: Project,
  facts: Map<string, { accents: string[]; hasMain: boolean; textLed: boolean }>,
  grammarByShot: Map<string, string>,
): MotionShotFact {
  const shot = project.shots.find((s) => s.id === t.shotId);
  const f = facts.get(t.shotId) ?? { accents: [], hasMain: false, textLed: false };
  const side = String(shot?.visual.params['side'] ?? 'center');
  return {
    shotId: t.shotId,
    durationMs: t.durationMs,
    camera: normalizeCameraToken(t.camera) ?? 'static',
    textLed: f.textLed,
    accents: f.accents,
    hasMainAction: f.hasMain,
    compositionKey: `${shot?.zoom ?? 'MS'}:${side}`,
    ...(grammarByShot.get(t.shotId) ? { grammar: grammarByShot.get(t.shotId) } : {}),
  };
}

export function validateReadiness(project: Project): V.Issue[] {
  const issues: V.Issue[] = [];
  if (!project.style) issues.push(V.err('V-STYLE-001', '缺少风格决策'));
  for (const shot of project.shots) {
    // V-AI-001：云端生成是付费能力，必须由用户显式授权，禁止静默消耗额度
    if (shot.visual.kind === 'cloud' && !project.meta.aiConsent) {
      issues.push(
        V.err(
          'V-AI-001',
          `镜头 ${shot.id} 走云端生成但项目未获 AI 生图授权：先征得用户同意并执行 confirm --allow-ai`,
        ),
      );
    }
    if (!shot.asset) {
      issues.push(V.err('V-AST-005', `镜头 ${shot.id} 缺少素材资产`));
    } else if (!exists(shot.asset.path)) {
      issues.push(V.err('V-AST-005', `镜头 ${shot.id} 素材文件不存在: ${shot.asset.path}`));
    }
    if (!shot.voice) {
      issues.push(V.err('V-SND-002', `镜头 ${shot.id} 缺少旁白（无实测时长）`));
    }
  }
  if (project.timeline) {
    issues.push(...V.validateTimelineSync(project.shots, project.timeline));
    issues.push(...V.validateSfxLanding(project.timeline));
  }
  issues.push(...V.validateContinuity(project.shots));
  return issues;
}

export function continuityReport(project: Project): ContinuityReport {
  const items: ContinuityReport['items'] = [];
  const byScene = new Map<string, Project['shots']>();
  for (const s of project.shots) {
    const scene = String(s.visual.params['scene'] ?? s.id);
    byScene.set(scene, [...(byScene.get(scene) ?? []), s]);
  }
  for (const [scene, list] of byScene) {
    if (list.length < 2) continue;
    const dirs = new Set(list.map((s) => String(s.visual.params['side'] ?? 'center')));
    const allGag = list.every((s) => s.gag);
    if (dirs.size > 1) {
      items.push({
        rule: 'V-CON-001',
        status: allGag ? 'declared-gag' : 'violation',
        detail: `场景「${scene}」方位 ${[...dirs].join('/')}`,
      });
    } else {
      items.push({ rule: 'V-CON-001', status: 'ok', detail: `场景「${scene}」方位一致` });
    }
  }
  const zooms = project.shots.map((s) => s.zoom);
  if (new Set(zooms).size < 2 && project.shots.length > 3) {
    items.push({
      rule: 'V-COMP-008',
      status: 'violation',
      detail: '全片景别无变化（缺少景别序列）',
    });
  }
  return { generatedAt: new Date().toISOString(), items };
}

export function computeTimeline(project: Project): Timeline {
  const shots: Timeline['shots'] = [];
  const subtitles: Timeline['subtitles'] = [];
  let acc = 0;
  for (const shot of project.shots) {
    const durationMs = shot.voice?.durationMs ?? 0;
    const segment = project.script?.segments.find((x) => x.id === shot.segmentId);
    shots.push({
      shotId: shot.id,
      startMs: acc,
      durationMs,
      transition: shot.transition,
      // 剪辑部：覆盖切点在此换算为镜头内绝对毫秒（导演声明始终生效；重音词自动派生需逐镜 opt-in）
      coverage: deriveCoverage(
        shot,
        segment?.emphasis ?? [],
        durationMs,
        shot.visual.params['autoCoverage'] === true,
      ),
      camera: shot.camera,
      motivation: '',
      audioShiftMs: 0,
    });
    // V-SND-004：按句读切分 cue，句内各 cue 时长按字符数比例分配（标点等分的句子级实现）
    const sentences = splitSentences(shot.narration);
    const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;
    let cueStart = acc;
    for (const sentence of sentences) {
      const cueMs = Math.max(800, Math.round((sentence.length / totalChars) * durationMs));
      const endMs = Math.min(acc + durationMs, cueStart + cueMs);
      // V-SND-004 词边界优先：编剧声明的重音词优先于前缀截取
      const emphasisHits = (segment?.emphasis ?? []).filter((w) => sentence.includes(w));
      const keywords = [...new Set([...emphasisHits, ...extractKeywords(sentence)])].slice(0, 3);
      subtitles.push({
        shotId: shot.id,
        startMs: cueStart,
        endMs,
        text: sentence,
        keywords,
        emphasis: emphasisHits,
      });
      cueStart = endMs;
    }
    acc += durationMs;
  }
  return { shots, subtitles, bgm: undefined, sfx: [] };
}

const SENTENCE_SPLIT_RE = /(?<=[。！？；!?;])/;
export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface CutDecision {
  plan: TransitionPlan;
  /** 归一化切点动机（match-cut/action/eye-line/emotion/beat/zoom-jump） */
  motivation: string;
  /** 动机来源：导演文案 / match-cut 锚点 / 客观关系反推 / 无 */
  motiveSource: 'text' | 'anchor' | 'relation' | 'none';
  /** match-cut 锚点对（形如 A→A） */
  anchors: string;
  /** 导演声明与动机冲突时的审计提示（不改声明，只记录） */
  note: string;
}

/**
 * 剪辑部切点裁决（docs/08 ④）：
 * - 相邻镜 exitAnchor/enterAnchor 相同 → match-cut，硬切（形状在观众眼里接成一根线）；
 * - 动机先取导演文案，取不到再用客观关系反推（景别跳/视线反转/笑点落镜）；
 * - 转场词为 auto/空 → 由切点动机决定（情绪→溶解 / 动作·节拍→冲击切 / 其余硬切）；
 * - 显式声明的转场词仍按风格包词表裁决，动机只做一致性审计。
 */
export function adjudicateCuts(
  project: Project,
  timeline: Timeline,
  pack: StylePack,
): Array<CutDecision | null> {
  return timeline.shots.map((t, i) => {
    if (i === 0) return null;
    const prev = project.shots[i - 1];
    const cur = project.shots[i];
    const prevT = timeline.shots[i - 1]!;
    const anchor =
      prev?.exitAnchor && cur?.enterAnchor ? `${prev.exitAnchor}→${cur.enterAnchor}` : '';
    if (prev?.exitAnchor && cur?.enterAnchor && prev.exitAnchor === cur.enterAnchor) {
      prevT.motivation = 'match-cut';
      t.motivation = 'match-cut';
      return {
        plan: { kind: 'hard-cut', durationMs: 0, overlapMs: 0 },
        motivation: 'match-cut',
        motiveSource: 'anchor',
        anchors: anchor,
        note: '',
      };
    }
    const textMotive = cutMotivation(cur?.motivation);
    const relationMotive = textMotive
      ? ''
      : deriveRelationMotivation(
          shotFacts(prev),
          shotFacts(cur),
        );
    const motive = textMotive || relationMotive;
    const motiveSource: CutDecision['motiveSource'] = textMotive
      ? 'text'
      : relationMotive
        ? 'relation'
        : 'none';
    const requested = (t.transition ?? '').trim();
    const auto = requested === '' || requested === 'auto';
    const plan = planTransition(auto ? motivationTransition(motive) : requested, pack.transitions);
    // 情绪切却声明了硬切：先按导演声明执行，把不一致留在审计里（不擅自改片）
    const note =
      !auto && motive === 'emotion' && plan.kind === 'hard-cut'
        ? `剪切点 ${prev?.id}→${cur?.id} 动机偏情绪但声明硬切（保留声明，可改 transition: dissolve）`
        : '';
    t.motivation = motive;
    return { plan, motivation: t.motivation, motiveSource, anchors: anchor, note };
  });
}

function shotFacts(shot: Project['shots'][number] | undefined) {
  return {
    zoom: shot?.zoom ?? 'MS',
    scene: String(shot?.visual.params['scene'] ?? shot?.id ?? ''),
    side: String(shot?.visual.params['side'] ?? 'center'),
    gag: Boolean(shot?.gag),
  };
}

/**
 * J-cut / L-cut（docs/07）：只移动旁白音频 clip 的落点，不动时间线时长（V-CMP-001 不变量）。
 * 软转场（溶解/擦除/甩镜）默认让声音先入 90ms；导演可用 shot.audioShiftMs 显式覆写（±200ms）。
 */
export function applyAudioShifts(
  project: Project,
  timeline: Timeline,
  decisions: Array<CutDecision | null>,
): void {
  const last = timeline.shots.at(-1);
  const totalMs = last ? last.startMs + last.durationMs : 0;
  timeline.shots.forEach((t, i) => {
    const shot = project.shots[i];
    const kind = decisions[i]?.plan.kind ?? 'hard-cut';
    const soft = kind !== 'hard-cut' && kind !== 'smash-cut';
    let shift = shot?.audioShiftMs ?? 0;
    if (shift === 0 && i > 0 && soft) shift = -90;
    if (t.startMs + shift < 0) shift = -t.startMs;
    if (i === timeline.shots.length - 1 && shift > 0) shift = 0;
    if (t.startMs + t.durationMs + shift > totalMs) shift = totalMs - (t.startMs + t.durationMs);
    t.audioShiftMs = Math.round(Math.max(-200, Math.min(200, shift)));
  });
}

export async function compose(
  store: ProjectStore,
  project: Project,
  pack: StylePack,
): Promise<Timeline> {
  const gate = validateReadiness(project);
  // V-STYLE-008：风格声明的素材语言必须真的落到素材上（禁用形态/偏好冲突/3D 母题缺失）
  gate.push(...V.validateStyleVisual(project, pack));
  if (V.hasError(gate)) {
    throw mvError(ERR.VALIDATION, `质量闸门未过:\n${V.formatIssues(gate)}`);
  }
  const report = continuityReport(project);
  const hasViolation = report.items.some((i) => i.status === 'violation');
  const timeline = computeTimeline(project);
  // 剪辑部裁决（docs/08 ④）：先定切点动机，再由动机/显式声明裁决转场（仍受风格包词表约束）
  const cutDecisions = adjudicateCuts(project, timeline, pack);
  const transitionPlans = cutDecisions.map((d) => d?.plan ?? null);
  applyAudioShifts(project, timeline, cutDecisions);

  const syncIssues = V.validateTimelineSync(project.shots, timeline);
  if (V.hasError(syncIssues)) {
    throw mvError(ERR.VALIDATION, `音画同步校验失败:\n${V.formatIssues(syncIssues)}`);
  }

  // 声音部混音执行（docs/07）：三层声音 + ducking + 音效落点
  const dir = store.projectDir(project.meta.id);
  const audioDir = path.join(dir, 'audio', 'mix');
  const voTrack = await buildVoTrack(project, timeline, audioDir);
  const bgmRaw = await buildBgm(
    timeline.shots.at(-1)!.startMs + timeline.shots.at(-1)!.durationMs,
    audioDir,
  );
  const bgm = await duckBgm(bgmRaw, voTrack, audioDir);
  const sfxFiles = await buildSfx(path.join(audioDir, 'sfx'));
  timeline.bgm = path.relative(dir, bgm).split(path.sep).join('/');
  timeline.sfx = planMix(project, timeline, audioDir, transitionPlans).sfxCues;

  // A9 混音计划工件
  project.mixPlan = {
    generatedAt: new Date().toISOString(),
    tracks: [
      { kind: 'vo', file: path.relative(dir, voTrack), gainDb: 0 },
      { kind: 'bgm', file: path.relative(dir, bgm), gainDb: 0 },
      { kind: 'sfx', file: path.relative(dir, sfxFiles.whoosh), gainDb: -6 },
    ],
    duckRatio: DUCK_RATIO,
    sfxCues: timeline.sfx.map((c) => ({ ...c, kind: c.kind === 'hit' ? 'hit' : 'whoosh' as const })),
  };

  // A8 剪切点审计报告（Rule of Six 候选集 + 切点动机 + 镜内覆盖切）
  const audit = timeline.shots.slice(1).map((t, idx) => {
    const i = idx + 1;
    const prev = timeline.shots[idx]!;
    const prevShot = project.shots[idx];
    const curShot = project.shots[i];
    const decision = cutDecisions[i];
    return {
      cut: `${prev.shotId}→${t.shotId}`,
      atMs: t.startMs,
      transition: decision?.plan.kind ?? 'hard-cut',
      motivation: decision?.motivation ?? '',
      motiveSource: decision?.motiveSource ?? 'none',
      anchors: decision?.anchors ?? '',
      audioShiftMs: t.audioShiftMs,
      // 前一镜内的覆盖切（换机位）：这些不是镜间切，但同样要能审计
      microCuts: prev.coverage.map((c) => ({
        atMs: prev.startMs + c.atMs,
        kind: c.kind,
        scale: c.scale,
        motivation: c.motivation,
      })),
      candidates: [
        prevShot && /[，。！？；.!?;]$/.test(prevShot.narration.trim()) ? '句读停顿' : null,
        prevShot && curShot && prevShot.zoom !== curShot.zoom ? '景别变化' : null,
        prevShot && curShot && prevShot.colorTemp !== curShot.colorTemp ? '色温变化' : null,
        decision?.motivation ? '切点动机' : null,
      ].filter(Boolean),
    };
  });
  // 审计工件是「本次装配的快照」，必须覆盖写（append 会让多次 compose 拼出非法 JSON）
  await atomicWriteText(
    path.join(dir, 'logs', 'cut-audit.json'),
    JSON.stringify(audit, null, 2),
  );

  // 剪辑节奏 + 声音部 error 级校验
  const sceneDir = path.join(dir, 'scenes');
  const scenePulse = new Map<string, boolean>();
  const sceneBeats = new Map<string, number>();
  const sceneFacts = new Map<string, { accents: string[]; hasMain: boolean; textLed: boolean }>();
  for (const shot of project.shots) {
    const file = path.join(sceneDir, `Scene_${shot.id}.html`);
    if (!exists(file)) continue;
    const html = await import('node:fs/promises').then((m) => m.readFile(file, 'utf8'));
    scenePulse.set(shot.id, /MV\.idle|MV\.performance|MV\.emphasis|pulse/.test(html));
    const beats = html.match(/data-beats="(\d+)"/);
    if (beats) {
      sceneBeats.set(shot.id, Number(beats[1]));
    } else {
      sceneBeats.set(shot.id, (html.match(/\.(to|from|fromTo)\(/g) ?? []).length);
    }
    // 混剪审计素材（V-MOT-013~020）：从场景实际调用里数，不信任声明。
    // 但模板可以声明「本镜不带标点」（data-accent="0"）——那样场景里的 slam 走的是 else 分支，
    // 没被真正调用。判据必须是「这一帧真的出现标点」，不是「源码里出现过 slam 这个词」。
    const accentOff = /data-accent="0"/.test(html);
    sceneFacts.set(shot.id, {
      accents: accentOff ? [] : V.ACCENT_PRIMITIVES.filter((p) => html.includes(p)),
      hasMain: /MV\.(enter|slam|staggeredIn|morphTo|counter|highlight|cards|punch|whip|maskReveal|bands|performance|emphasis|orbit|depth|tilt3d|spin3d|card3d)\(/.test(
        html,
      ),
      textLed:
        ((shot.visual.params['actionSheet'] as { grammar?: string } | undefined)?.grammar ?? '').startsWith('y5') ||
        /class="[^"]*\b(kinetic|kinetic-type)\b/.test(html),
    });
  }
  // 把动作谱与语法落到 shot.visual.params（供 scene 输出与审计复用）；
  // 已有声明者（人工精修/agent 指定）一律不覆盖——导演的镜头清单优先。
  const grammarByShot = new Map<string, string>();
  for (const shot of project.shots) {
    const declared = shot.visual.params['actionSheet'] as { grammar?: string } | undefined;
    if (declared?.grammar) {
      grammarByShot.set(shot.id, declared.grammar);
      continue;
    }
    const recent = [...grammarByShot.values()].slice(-2) as GrammarId[];
    const g = pickGrammar(shot.narration, {
      recent,
      hasRealMaterial: shot.visual.kind === 'user-material' || shot.visual.kind === 'imported',
      singleNumber: (shot.narration.match(/\d+/g) ?? []).length === 1,
    });
    grammarByShot.set(shot.id, g.id);
    shot.visual.params['actionSheet'] = actionSheet(shot, g);
  }
  const motionIssues = [
    ...auditOpening(
      timeline.shots.map((t) => toMotionFact(t, project, sceneFacts, grammarByShot)),
    ),
    ...auditMotionMix(
      timeline.shots.map((t) => toMotionFact(t, project, sceneFacts, grammarByShot)),
      (() => {
        const lastShot = timeline.shots.at(-1);
        return lastShot ? lastShot.startMs + lastShot.durationMs : 0;
      })(),
    ),
  ];
  const motionErrors = motionIssues.filter((i) => i.level === 'error');
  if (motionErrors.length > 0) {
    throw mvError(
      ERR.VALIDATION,
      `动效语法校验失败（V-MOT-013~020）:\n${motionErrors.map((i) => `${i.rule}: ${i.message}`).join('\n')}`,
    );
  }
  await atomicWriteText(
    path.join(dir, 'logs', 'motion-audit.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), issues: motionIssues, grammarByShot: [...grammarByShot] }, null, 2),
  );

  const gateIssues = [
    ...V.validateCutCandidates(project.shots, timeline),
    ...V.validateEmphasisTriangle(project.shots, timeline, scenePulse),
    ...V.validateMixPlan(project.mixPlan),
    // V-SND-006 可听性：BGM 不许盖人声、低频不许只堆在小扬声器放不出的频段
    ...(await checkMixAudibility(audioDir)),
  ];
  if (V.hasError(gateIssues)) {
    throw mvError(ERR.VALIDATION, `剪辑/声音部校验失败:\n${V.formatIssues(gateIssues)}`);
  }
  const warnIssues = [
    ...V.validateCutPoints(project.shots, timeline),
    ...V.validateDensity(timeline, pack.pacing.shotLenMs[0], pack.pacing.shotLenMs[1]),
    ...V.validateBreath(timeline, pack.pacing.breathEvery),
    ...V.validateVisualChange(timeline, sceneBeats),
    ...V.validateIntraShotMotion(timeline),
    ...V.validateCutMotivation(timeline),
  ];
  const transitionWarnings = transitionPlans
    .filter((p): p is TransitionPlan => Boolean(p?.warning))
    .map((p) => `[warn] TRANSITION: ${p.warning}`);
  const cutNotes = cutDecisions
    .filter((d): d is CutDecision => Boolean(d?.note))
    .map((d) => `[warn] CUT-MOTIVATION: ${d.note}`);
  await appendLog(
    store,
    project,
    'validation.log',
    [...warnIssues.map((i) => `[warn] ${i.id}: ${i.message}`), ...transitionWarnings, ...cutNotes].join('\n'),
  );

  project.timeline = timeline;
  project.continuity = { ...report, items: hasViolation ? report.items : report.items };
  if (hasViolation) {
    const violations = report.items.filter((i) => i.status === 'violation');
    throw mvError(
      ERR.VALIDATION,
      `连续性报告存在违规:\n${violations.map((v) => `${v.rule}: ${v.detail}`).join('\n')}`,
    );
  }
  project.stage = 'compose';
  // 字幕工件（srt）
  const outDir = path.join(dir, 'out');
  await ensureDir(outDir);
  await exportSrt(timeline, path.join(outDir, 'subtitles.srt'));
  await emitHyperframesProject(store, project, pack, timeline, transitionPlans);
  await store.save(project);
  return timeline;
}

async function emitHyperframesProject(
  store: ProjectStore,
  project: Project,
  pack: StylePack,
  timeline: Timeline,
  transitionPlans: Array<TransitionPlan | null>,
): Promise<void> {
  const dir = store.projectDir(project.meta.id);
  const hfDir = path.join(dir, 'remotion');
  const compDir = path.join(hfDir, 'compositions');
  await ensureDir(compDir);
  await copyDir(path.join(store.root, TEMPLATES_DIR, 'motion'), path.join(hfDir, 'motion'));
  await copyDir(path.join(store.root, TEMPLATES_DIR, 'canvas'), path.join(hfDir, 'canvas'));
  // 项目专属画布叠加在预置之上：projects/<id>/canvas 与项目同生共死，不污染 templates
  await copyDir(path.join(dir, 'canvas'), path.join(hfDir, 'canvas'));

  // 旁白音频复制进渲染项目根（音频引用不得 ../ 越界，否则文件服务器拒绝 → 成片无声）
  const voDir = path.join(hfDir, 'audio', 'vo');
  await ensureDir(voDir);
  for (const shot of project.shots) {
    if (shot.voice && exists(shot.voice.file)) {
      await copyFile(shot.voice.file, path.join(voDir, path.basename(shot.voice.file)));
    }
  }

  const size = project.meta.aspect === '9:16' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  const presenter = readPresenter(dir);
  if (presenter) {
    // 头像必须进 canvas/ 才能被文件服务器读到（../ 越界路径会被拒）
    await ensureDir(path.join(hfDir, 'canvas'));
    await copyFile(presenter.image, path.join(hfDir, 'canvas', path.basename(presenter.image)));
  }
  // 字幕策略：project 覆写 > 风格包声明 > full（docs/07）
  const policy: SubtitlePolicy = project.subtitlePolicy ?? (pack as { subtitlePolicy?: SubtitlePolicy }).subtitlePolicy ?? 'full';

  // 感知画面排版：读场景 CSS 里主语（.subject）的纵向位置，字幕放对侧（V-CAP-001）
  const sideByShot = new Map<string, 'top' | 'bottom'>();
  // 机位轨审计：每镜外层机位（分段/覆盖切）落成工件，便于逐镜核验"画面真的在动"
  const rigAudit: Array<Record<string, unknown>> = [];
  for (const shot of project.shots) {
    const src = path.join(dir, 'scenes', `Scene_${shot.id}.html`);
    const t = timeline.shots.find((x) => x.shotId === shot.id);
    const durMs = t?.durationMs ?? 20000;
    // 真实素材镜（用户提供 / stock 下载）：直接出满幅电影化画面，不再走代码绘制场景
    const mediaAsset =
      shot.visual.kind === 'user-material' || shot.visual.kind === 'imported' ? shot.asset : undefined;
    if (mediaAsset && exists(mediaAsset.path)) {
      sideByShot.set(shot.id, 'bottom');
      const mediaStyle = pack.visuals.media;
      const staged = await stageMedia(hfDir, shot.id, mediaAsset.path, {
        durationMs: durMs,
        style: mediaStyle,
      });
      // 运镜策略由风格包裁决：static 真静止 / ken-burns 必须动起来 / auto 听导演
      const mediaCamera =
        mediaStyle.motion === 'static'
          ? 'static'
          : mediaStyle.motion === 'ken-burns' && shot.camera === 'static'
            ? 'push-in'
            : shot.camera;
      const rig = planCameraRig({
        shotId: shot.id,
        durationMs: durMs,
        zoom: shot.zoom,
        camera: mediaCamera,
        focus: { x: 50, y: 50 },
        coverage: t?.coverage ?? [],
        options: parseCameraOptions(shot.visual.params),
      });
      rigAudit.push(rigSummary(rig));
      await atomicWriteText(
        path.join(compDir, `Scene_${shot.id}.html`),
        presenter
          ? buildMediaComposition(
              shot.id,
              staged,
              size,
              durMs / 1000,
              buildRigScript(rig),
              mediaStyle,
              presenterMarkup(presenter, size) +
                presenterScript(presenter, shot.id, durMs / 1000, project.shots.findIndex((s) => s.id === shot.id)),
            )
          : buildMediaComposition(
              shot.id,
              staged,
              size,
              durMs / 1000,
              buildRigScript(rig),
              mediaStyle,
            ),
      );
      continue;
    }
    if (!exists(src)) {
      throw mvError(ERR.VALIDATION, `镜头 ${shot.id} 场景文件缺失（请先 draw）`);
    }
    const fs = await import('node:fs/promises');
    const sceneHtml = await fs.readFile(src, 'utf8');
    sideByShot.set(shot.id, pickCaptionSide(sceneHtml));
    // 摄影部：主语做机位锚点 + 三段式外层机位 + 覆盖切（同一场景换机位）
    const rig = planCameraRig({
      shotId: shot.id,
      durationMs: durMs,
      zoom: shot.zoom,
      camera: shot.camera,
      focus: pickSubjectFocus(sceneHtml),
      coverage: t?.coverage ?? [],
      options: parseCameraOptions(shot.visual.params),
    });
    rigAudit.push(rigSummary(rig));
    const wrapped = wrapComposition(
      sceneHtml,
      shot.id,
      size,
      durMs / 1000,
      buildRigScript(rig),
      presenter,
      project.shots.findIndex((s) => s.id === shot.id),
    );
    await atomicWriteText(path.join(compDir, `Scene_${shot.id}.html`), wrapped);
  }
  await atomicWriteText(
    path.join(dir, 'logs', 'camera-rig.json'),
    JSON.stringify(rigAudit, null, 2),
  );

  const captions = timeline.subtitles.map((c) => ({
    start: +(c.startMs / 1000).toFixed(3),
    duration: +((c.endMs - c.startMs) / 1000).toFixed(3),
    text: c.text,
    keywords: c.keywords,
    shotId: c.shotId,
  }));

  const tracks: string[] = [];
  timeline.shots.forEach((t, i) => {
    const start = (t.startMs / 1000).toFixed(3);
    const dur = (t.durationMs / 1000).toFixed(3);
    // 视觉轨与音频轨分离：溶解/擦除把前后两镜在时间上重叠，声音仍按原剪切点入
    const overlapIn = transitionPlans[i]?.overlapMs ?? 0;
    const overlapOut = transitionPlans[i + 1]?.overlapMs ?? 0;
    const clipStart = (Math.max(0, t.startMs - overlapIn) / 1000).toFixed(3);
    const clipDur = ((t.durationMs + overlapIn + overlapOut) / 1000).toFixed(3);
    // 官方 lint 契约：composition-src 宿主必须带 data-composition-id（渲染器据此挂载并驱动子合成时间线）
    tracks.push(
      `  <div class="clip scene" id="clip-${t.shotId}" data-composition-id="scene-${t.shotId}" data-composition-src="compositions/Scene_${t.shotId}.html" data-track-index="0" data-start="${clipStart}" data-duration="${clipDur}"></div>`,
    );
    // smash-cut 闪白：叠在画面之上、字幕之下（DOM 顺序保证），剪辑点当帧给一次冲击
    if (i > 0 && transitionPlans[i]?.kind === 'smash-cut') {
      tracks.push(
        `  <div class="clip flash" id="flash-${t.shotId}" data-track-index="2" data-start="${(t.startMs / 1000 - 0.05).toFixed(3)}" data-duration="0.35"></div>`,
      );
    }
    const shot = project.shots[i];
    if (shot?.voice) {
      // 音频必须位于渲染项目根内（../ 越界路径会被文件服务器拒绝导致无声）
      const rel = `audio/vo/${path.basename(shot.voice.file)}`;
      // J-cut/L-cut：只挪音频落点，不动片长（V-CMP-001 不变量）
      const aStart = (Math.max(0, t.startMs + (t.audioShiftMs ?? 0)) / 1000).toFixed(3);
      tracks.push(
        `  <audio class="clip" id="aud-${t.shotId}" data-track-index="1" data-start="${aStart}" data-duration="${dur}" src="${rel}"></audio>`,
      );
    }
    // 字幕策略落地（V-CAP-001/002）：off 不出画面字幕；keyword 出关键词梗卡（避让主体+错位摆动）；
    // full 出整句条（关键词内联高亮，不再叠加独立黄词条）。srt 工件三种策略下都全量导出（无障碍）。
    const side = sideByShot.get(t.shotId) ?? 'bottom';
    if (policy !== 'off') {
      for (const cue of timeline.subtitles.filter((c) => c.shotId === t.shotId)) {
        const cs = (cue.startMs / 1000).toFixed(3);
        const cd = ((cue.endMs - cue.startMs) / 1000).toFixed(3);
        if (policy === 'keyword') {
          // 卡词只用编剧声明的重音词（可信来源）；声明缺失时退回 ≤6 字的切分词，宁缺毋滥
          const declared = cleanKeywords(cue.emphasis ?? [], 2);
          const kws = declared.length > 0 ? declared : cleanKeywords(cue.keywords.filter((k) => k.length <= 6), 1);
          if (kws.length === 0) continue;
          const j = hashJitter(`${cue.shotId}:${cue.startMs}`);
          const h = ['cap-h-c', 'cap-h-l', 'cap-h-r'][j % 3];
          const tilt = ((j % 7) - 3) * 0.8;
          const inner = kws.map((k) => `<em>${escapeHtml(k)}</em>`).join('');
          tracks.push(
            `  <div class="clip kwcard cap-${side} ${h}" data-track-index="2" data-start="${cs}" data-duration="${cd}"><span class="kw-stack" style="--tilt:${tilt.toFixed(1)}deg">${inner}</span></div>`,
          );
        } else {
          tracks.push(
            `  <div class="clip caption cap-${side}" data-track-index="2" data-start="${cs}" data-duration="${cd}"><span class="caption-text">${highlightSentence(cue.text, cue.keywords)}</span></div>`,
          );
        }
      }
    }
  });

  // 三层声音轨：BGM（已 ducking）+ 音效落点（V-SND-001/003）
  // 必须无条件覆盖拷贝：音效/BGM 重做后如果沿用旧文件（"存在就跳过"），
  // 重新 compose 也会播出上一版的声音，等于返工失效。
  const totalDurS = ((timeline.shots.at(-1)?.startMs ?? 0) + (timeline.shots.at(-1)?.durationMs ?? 0)) / 1000;
  if (timeline.bgm && exists(path.join(dir, timeline.bgm))) {
    const bgmDest = path.join(hfDir, 'audio', 'bgm.wav');
    await ensureDir(path.dirname(bgmDest));
    await copyFile(path.join(dir, timeline.bgm), bgmDest);
    tracks.push(
      `  <audio class="clip" id="aud-bgm" data-track-index="1" data-start="0" data-duration="${totalDurS.toFixed(3)}" src="audio/bgm.wav"></audio>`,
    );
  }
  for (const [i, cue] of timeline.sfx.entries()) {
    await ensureDir(path.join(hfDir, 'audio', 'sfx'));
    const base = path.basename(cue.file);
    const src = path.join(dir, 'audio', 'mix', 'sfx', base);
    const dest = path.join(hfDir, 'audio', 'sfx', base);
    if (exists(src)) await copyFile(src, dest);  // 同上：音效返工后必须覆盖
    if (exists(dest)) {
      // leadMs 负值 = 声音早于画面入点（whoosh 需要在剪切点前起势，峰值才落在切点）
      const cs = (Math.max(0, cue.atMs + (cue.leadMs ?? 0)) / 1000).toFixed(3);
      tracks.push(
        `  <audio class="clip" id="aud-sfx-${i}" data-track-index="1" data-start="${cs}" data-duration="0.7" src="audio/sfx/${base}"></audio>`,
      );
    }
  }

  // 转场：按风格包词表裁决后生成真正的叠化/擦除/甩镜/闪白（硬切不出动画）
  const transitionsScript = buildTransitionsScript(timeline, transitionPlans);

  const totalS = (((timeline.shots.at(-1)?.startMs ?? 0) + (timeline.shots.at(-1)?.durationMs ?? 0)) / 1000).toFixed(3);
  // 字幕配色由风格包 caption 段裁决（亮调风格需要同量级对比，缺省沿用暗调默认）
  const packCaption = (pack as { caption?: { plate?: string; text?: string; accent?: string } }).caption ?? {};
  const captionStyle = {
    plate: packCaption.plate ?? 'rgba(10,10,14,0.55)',
    text: packCaption.text ?? '#f5f5f4',
    accent: packCaption.accent ?? pack.palette.accent,
  };
  const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.meta.title)}</title>
<style>
  :root { --primary: ${pack.palette.primary}; --accent: ${pack.palette.accent}; }
  html, body { margin: 0; padding: 0; background: ${pack.palette.neutral[4]}; font-family: ${pack.type.families[0]}; }
  /* 字幕必须绝对定位满屏：clip div 在文档流中无高度，否则文字堆在页面顶部 */
  /* V-CAP-001 排版感知：cap-top/cap-bottom 由场景主语位置决定，字幕放对侧 */
  .clip.caption { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; }
  .caption.cap-bottom { justify-content: flex-end; padding-bottom: 6%; }
  .caption.cap-top { justify-content: flex-start; padding-top: 5.5%; }
  /* 电影风字幕：细黑衬底 + 白字，关键词内联高亮（不再叠加独立黄词条） */
  .caption-text { font-size: ${Math.round(pack.type.scale.body * size.h * 0.9)}px; color: ${captionStyle.text}; background: ${captionStyle.plate}; padding: 0.25em 0.9em; border-radius: 0.18em; letter-spacing: 0.04em; text-shadow: 0 1px 6px rgba(0,0,0,0.35); }
  .caption-text em { font-style: normal; color: ${captionStyle.accent}; font-weight: 700; }
  /* V-CAP-002 关键词梗卡：贴纸式卡片，微倾角+水平错位，避让主体，只落关键词 */
  .clip.kwcard { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 9%; }
  .kwcard.cap-top { align-items: flex-start; padding-top: 6.5%; padding-bottom: 0; }
  .kwcard.cap-h-l { justify-content: flex-start; padding-left: 9%; }
  .kwcard.cap-h-r { justify-content: flex-end; padding-right: 9%; }
  /* smash-cut 闪白层：不参与布局，只做剪辑点冲击（字幕元素在其后渲染，自然压在闪白之上） */
  .clip.flash { position: absolute; inset: 0; background: #fff; pointer-events: none; }
  .kw-stack { display: inline-flex; gap: 0.6em; background: ${captionStyle.plate}; border: 2px solid ${captionStyle.accent}; border-radius: 0.35em; padding: 0.3em 0.9em; transform: rotate(var(--tilt, 0deg)); box-shadow: 0 6px 24px rgba(0,0,0,0.32); }
  .kw-stack em { font-style: normal; color: ${captionStyle.accent}; font-weight: 800; font-size: ${Math.round(pack.type.scale.body * size.h * 1.15)}px; letter-spacing: 0.08em; text-shadow: 0 1px 6px rgba(0,0,0,0.35); }
</style>
</head>
<body>
<div data-composition-id="root" data-width="${size.w}" data-height="${size.h}" data-duration="${totalS}" data-fps="${project.meta.fps}">
${tracks.join('\n')}
</div>
<script>window.__captions = ${JSON.stringify(captions, null, 2)};</script>
<script src="motion/gsap.min.js"></script>
<script src="motion/motion-lib.js"></script>
<script>
window.__timelines = window.__timelines || {};
window.__timelines['root'] = window.gsap ? gsap.timeline({ paused: true }) : null;
${transitionsScript}
</script>
</body>
</html>
`;
  await atomicWriteText(path.join(hfDir, 'index.html'), indexHtml);
}

// 悬浮卡通主讲头像（"实时有人在讲"）：小尺寸角标，不遮挡主体，靠画外留白呼吸
// 由 project 目录下的 presenter.json 声明（缺省不出现）：
//   { "image": "canvas/avatar.png", "corner": "br", "width": 196, "mode": "corner|hero-to-corner" }
// mode=hero-to-corner（阿杜「人物是一条主线」）：同一元素在开场镜以大窗出现，
// 再**改变尺寸/位置/圆角**收到角标——不是换一个头像，也不是永远一个角标。
interface PresenterSpec {
  image: string;
  corner: 'bl' | 'br' | 'tl' | 'tr';
  width: number;
  fps: number;
  /** corner = 恒定角标；hero-to-corner = 开场大窗 → 收到角标（人物主线） */
  mode: 'corner' | 'hero-to-corner';
  /** 大窗锚点（hero-to-corner 的首镜用），百分比 */
  heroAnchor: { x: number; y: number; width: number };
}

const PRESENTER_CSS = `
  .mv-presenter-stage { position: absolute; inset: 0; z-index: 6; pointer-events: none; }
  .mv-presenter { position: absolute; will-change: transform, opacity; }
  .mv-presenter.br { right: 3.2%; bottom: 11.6%; }
  .mv-presenter.bl { left: 3.2%; bottom: 11.6%; }
  .mv-presenter.tr { right: 3.2%; top: 11.6%; }
  .mv-presenter.tl { left: 3.2%; top: 11.6%; }
  /* 大窗锚点：由 presenterScript 用内联样式落位（centered，圆心为锚点） */
  .mv-presenter.hero-mode { transform: translate(-50%, -50%); }
  .mv-presenter .plate { position: relative; border-radius: 25%; overflow: hidden;
    background: #f7f4ec;
    box-shadow: 0 18px 34px rgba(58,44,24,0.30), 0 3px 8px rgba(58,44,24,0.20),
      0 0 0 3px rgba(255,255,255,0.85), 0 0 0 6px rgba(15,123,150,0.30); }
  .mv-presenter img { display: block; width: 100%; height: auto; }
  .mv-presenter .talk { position: absolute; left: 50%; bottom: -7%; width: 64%; height: 10%;
    transform: translateX(-50%); border-radius: 999px;
    background: radial-gradient(ellipse at 50% 50%, rgba(15,123,150,0.42), rgba(15,123,150,0) 72%); }
`;

function presenterMarkup(spec: PresenterSpec, size: { w: number; h: number }): string {
  const w = Math.round(Math.min(spec.width, size.w * 0.13));
  return `<div class="mv-presenter-stage">
  <div class="mv-presenter ${spec.corner}" data-mv-presenter style="width:${w}px">
    <div class="plate"><img src="../canvas/${path.basename(spec.image)}" alt=""><span class="talk"></span></div>
  </div>
</div>`;
}

// 主讲头像的时间线：在场恒定 + 有界呼吸浮动（不逐镜淡入淡出——那会在快切里闪）
// hero-to-corner 模式（阿杜人物主线）：首镜从大窗收到角标，
// 位移/尺寸/圆角**同一条补间**完成（位置与尺寸同步变化，不是先缩再挪）。
function presenterScript(spec: PresenterSpec, shotId: string, durationS: number, shotIndex = -1): string {
  const heroFirst = spec.mode === 'hero-to-corner' && shotIndex === 0;
  const heroBlock = heroFirst
    ? `
    // 人物主线：大窗 → 角标（同一元素改尺寸/位置/圆角）
    var startW = Math.round(window.innerWidth * ${(spec.heroAnchor.width / 100).toFixed(4)});
    el.classList.remove('${spec.corner}');
    el.classList.add('hero-mode');
    el.style.left = '${spec.heroAnchor.x}%';
    el.style.top = '${spec.heroAnchor.y}%';
    el.style.width = startW + 'px';
    el.style.zIndex = '8';
    var plate = el.querySelector('.plate');
    var enterS = Math.min(1.2, ${durationS.toFixed(3)} * 0.32);
    tl.fromTo(el, { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 0.42, ease: 'power3.out' }, 0.06);
    if (plate) tl.fromTo(plate, { borderRadius: '34%' }, { borderRadius: '25%', duration: enterS, ease: 'power2.inOut' }, 0.06);
    // 收小：宽 100% → 13%（与场景里的角标同宽），位置回到角标锚点
    tl.to(el, { width: Math.round(window.innerWidth * 0.13) + 'px', duration: Math.max(0.5, ${durationS.toFixed(3)} * 0.3), ease: 'power2.inOut' },
      Math.max(0.9, ${durationS.toFixed(3)} * 0.55));
    tl.to(el, { left: '${spec.corner.includes('l') ? '6.5%' : '93.5%'}', top: '${spec.corner.includes('t') ? '18%' : '82%'}',
      duration: Math.max(0.5, ${durationS.toFixed(3)} * 0.3), ease: 'power2.inOut' },
      Math.max(0.9, ${durationS.toFixed(3)} * 0.55));`
    : '';
  const settleBlock = heroFirst
    ? `
    // 首镜收完即接管角标几何，后续镜直接沿用（不重复动画）
    tl.call(function () {
      el.classList.remove('hero-mode');
      el.classList.add('${spec.corner}');
      el.style.left = ''; el.style.top = ''; el.style.width = ''; el.style.zIndex = '';
    }, null, Math.max(1.4, ${durationS.toFixed(3)} * 0.86));`
    : '';
  return `<script data-mv-presenter-rig="1">
(function () {
  function boot() {
    var tl = window.__timelines && window.__timelines['scene-${shotId}'];
    var el = document.querySelector('[data-mv-presenter]');
    if (!tl || !el) return;
    var talk = el.querySelector('.talk');
    el.style.opacity = '1';
    // 呼吸浮动：有界循环，覆盖整镜（时间纯函数，渲染器逐帧 seek 可复现）
    var bob = 0.9;
    var reps = Math.max(1, Math.floor(${durationS.toFixed(3)} / (bob * 2)));
    tl.fromTo(el, { y: 3 }, { y: -5, duration: bob, ease: 'sine.inOut', repeat: reps, yoyo: true }, 0);
    if (talk) {
      tl.fromTo(talk, { opacity: 0.3, scaleX: 0.72 },
        { opacity: 0.95, scaleX: 1.06, duration: 0.42, ease: 'sine.inOut', repeat: reps * 2, yoyo: true }, 0);
    }${heroBlock}${settleBlock}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
</script>`;
}

function readPresenter(dir: string): PresenterSpec | null {
  const file = path.join(dir, 'presenter.json');
  if (!exists(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PresenterSpec>;
    if (!raw.image) return null;
    const abs = path.resolve(dir, raw.image);
    if (!exists(abs)) return null;
    const corner = ['bl', 'br', 'tl', 'tr'].includes(String(raw.corner)) ? (raw.corner as PresenterSpec['corner']) : 'br';
    const anchor = (raw.heroAnchor ?? {}) as Partial<PresenterSpec['heroAnchor']>;
    return {
      image: abs,
      corner,
      width: Number(raw.width ?? 196),
      fps: Number(raw.fps ?? 30),
      mode: raw.mode === 'hero-to-corner' ? 'hero-to-corner' : 'corner',
      heroAnchor: {
        x: Number(anchor.x ?? 50),
        y: Number(anchor.y ?? 46),
        width: Number(anchor.width ?? 30),
      },
    };
  } catch {
    return null;
  }
}

// 真实素材进渲染工程：图片直接拷贝；视频转帧序列（逐帧 seek 下内嵌 video 的时钟不可控）
interface StagedMedia {
  src: string;
  frames?: { count: number; fps: number };
}

async function stageMedia(
  hfDir: string,
  shotId: string,
  assetPath: string,
  opts: { durationMs: number; style: StyleMedia },
): Promise<StagedMedia> {
  const outDir = path.join(hfDir, 'media', shotId);
  await ensureDir(outDir);
  const ext = path.extname(assetPath).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
    // 帧率可调：默认 24fps 足够顺滑，帧数 = 时长×帧率（循环补足），磁盘可控
    const raw = Number(process.env['MV_MEDIA_FPS'] ?? 24);
    const fps = Number.isFinite(raw) ? Math.min(30, Math.max(8, Math.round(raw))) : 24;
    const framesDir = path.join(outDir, 'frames');
    const fs = await import('node:fs/promises');
    await fs.rm(framesDir, { recursive: true, force: true });
    const { count } = await extractFrameSequence(
      assetPath,
      framesDir,
      fps,
      1920,
      opts.durationMs / 1000 + 0.35,
    );
    return { src: `../media/${shotId}/frames/f%05d.jpg`, frames: { count, fps } };
  }
  const base = path.basename(assetPath);
  await copyFile(assetPath, path.join(outDir, base));
  return { src: `../media/${shotId}/${encodeURIComponent(base)}` };
}

// 真实素材镜的合成：满幅画面 + 风格包调色（P5-C），与代码场景共用同一套转场与字幕
export function buildMediaComposition(
  shotId: string,
  media: StagedMedia,
  size: { w: number; h: number },
  durationS: number,
  rigScript = '',
  style: StyleMedia = {
    grade: 'warm',
    grain: 0.13,
    vignette: 0.62,
    letterbox: false,
    motion: 'auto',
    fit: 'cover',
  },
  presenterHtml = '',
): string {
  const filmFilter =
    style.grade === 'bleach'
      ? 'saturate(0.55) contrast(1.18) brightness(1.03)'
      : style.grade === 'cool'
        ? 'saturate(0.86) contrast(1.06) brightness(0.94)'
        : style.grade === 'neutral'
          ? 'saturate(1) contrast(1.04) brightness(0.99)'
          : 'saturate(0.88) contrast(1.07) brightness(0.96)';
  const gradeLayer =
    style.grade === 'none'
      ? ''
      : `<div class="grade grade-${style.grade}"></div>`;
  const letterbox = style.letterbox
    ? `<div class="bar bar-top"></div><div class="bar bar-bottom"></div>`
    : '';
  // 首帧先落第一张，避免 seek 到第 0 帧前出现空图
  const firstSrc = media.frames ? media.src.replace('%05d', '00001') : media.src;
  const frameDriver = media.frames
    ? `<script>
(function () {
  var ID = 'scene-${shotId}';
  var PATTERN = ${JSON.stringify(media.src)};
  var COUNT = ${media.frames.count};
  var DUR = ${durationS.toFixed(3)};
  function pad(n) { return ('00000' + n).slice(-5); }
  function boot() {
    var tl = window.__timelines && window.__timelines[ID];
    var img = document.querySelector('[data-mv-film]');
    if (!tl || !img) return;
    var st = { i: 0 };
    var cur = 0;
    tl.to(st, {
      i: COUNT - 1,
      duration: DUR,
      ease: 'none',
      onUpdate: function () {
        var idx = Math.max(0, Math.min(COUNT - 1, Math.round(st.i)));
        if (idx !== cur) {
          cur = idx;
          img.src = PATTERN.replace('%05d', pad(idx + 1));
        }
      }
    }, 0);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
</script>`
    : '';
  const kenBurns =
    style.motion === 'static'
      ? ''
      : `window.__timelines['scene-${shotId}'].fromTo('.frame', { scale: 1.09 }, { scale: 1.0, duration: ${durationS.toFixed(3)}, ease: 'none' }, 0);`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #050505; }
  .stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: #050505; }
  .frame { position: absolute; inset: 0; overflow: hidden; transform-origin: 50% 50%; }
  .film { display: block; width: 100%; height: 100%; object-fit: ${style.fit}; filter: ${filmFilter}; }
  .grade { position: absolute; inset: 0; mix-blend-mode: soft-light; }
  .grade-warm { background: linear-gradient(180deg, rgba(255,236,190,0.06), transparent 42%, rgba(6,8,14,0.32)); }
  .grade-cool { background: linear-gradient(180deg, rgba(176,206,255,0.07), transparent 40%, rgba(3,7,16,0.38)); }
  .grade-neutral { background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent 45%, rgba(0,0,0,0.26)); }
  .grade-bleach { background: linear-gradient(180deg, rgba(255,255,255,0.10), transparent 55%, rgba(0,0,0,0.20)); }
  .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 50%, transparent 44%, rgba(0,0,0,${style.vignette}) 100%); }
  .grain { position: absolute; inset: 0; opacity: ${style.grain}; mix-blend-mode: overlay; background-image: repeating-radial-gradient(circle at 30% 40%, rgba(255,255,255,0.10) 0 0.5px, transparent 0.6px 2.2px), repeating-radial-gradient(circle at 70% 60%, rgba(255,255,255,0.08) 0 0.4px, transparent 0.5px 1.8px); background-size: 3px 3px, 5px 5px; }
  .bar { position: absolute; left: 0; right: 0; height: 5.5%; background: #000; z-index: 3; }
  .bar-top { top: 0; }
  .bar-bottom { bottom: 0; }
${PRESENTER_CSS}
</style>
<script src="../motion/gsap.min.js"></script>
</head>
<body>
<div data-composition-id="scene-${shotId}" data-width="${size.w}" data-height="${size.h}" data-duration="${durationS.toFixed(3)}" style="width:100%;height:100%">
  <div class="stage">
    <div class="frame"><img class="film" data-mv-film src="${firstSrc}" alt=""></div>
    ${gradeLayer}
    <div class="vignette"></div>
    <div class="grain"></div>
    ${letterbox}
  </div>
  ${presenterHtml ? presenterHtml.split('<script')[0] : ''}
</div>
<script>
window.__timelines = window.__timelines || {};
window.__timelines['scene-${shotId}'] = window.gsap ? gsap.timeline({ paused: true }) : null;
if (window.__timelines['scene-${shotId}']) {
  ${kenBurns}
}
</script>
${frameDriver}
${presenterHtml.includes('<script') ? '<script' + presenterHtml.split('<script')[1] : ''}
${rigScript}
</body>
</html>
`;
}

// V-CAP-001 排版感知：从场景 CSS 的 .subject 块读主语纵向位置，字幕落到对侧。
// 读不出来（无 .subject / calc 等无法静态判定）时保守落底部。
export function pickCaptionSide(sceneHtml: string): 'top' | 'bottom' {
  const block = sceneHtml.match(/\.subject\s*\{([^}]*)\}/)?.[1];
  if (block) {
    const top = block.match(/(?:^|[;\s])top:\s*([\d.]+)%/);
    if (top) return parseFloat(top[1] ?? '0') > 55 ? 'top' : 'bottom';
    const bottom = block.match(/(?:^|[;\s])bottom:\s*([\d.]+)%/);
    if (bottom) return parseFloat(bottom[1] ?? '0') < 30 ? 'top' : 'bottom';
  }
  return 'bottom';
}

// 关键词梗卡用：去标点空白、限长、限量（编剧重音词优先级已在 cue.keywords 保序）
export function cleanKeywords(keywords: string[], max: number): string[] {
  const out: string[] = [];
  for (const raw of keywords) {
    const k = raw.replace(/[，。！？、；：""''（）\s,.!?;:()\-]/g, '');
    if (k.length < 2 || k.length > 12) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

// full 模式：关键词在句内以 <em> 高亮（转义后按转义词切分，避免 XSS/标签注入）
export function highlightSentence(text: string, keywords: string[]): string {
  let html = escapeHtml(text);
  for (const kw of cleanKeywords(keywords, 3)) {
    const esc = escapeHtml(kw);
    if (html.includes(esc)) {
      html = html.replace(esc, `<em>${esc}</em>`);
    }
  }
  return html;
}

// 确定性抖动（同一 cue 永远同一结果）：梗卡的倾角与水平位置按 seed 哈希错位，去机械感
function hashJitter(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// 转场生成：每个词对应一种真正的画面处理，不再"一律淡到黑再亮起"。
// 时长/重叠来自 transitions.ts（V-MOT-008：300-600ms）；硬切不产生任何动画。
function buildTransitionsScript(
  timeline: Timeline,
  plans: Array<TransitionPlan | null>,
): string {
  const lines: string[] = [];
  for (let i = 1; i < timeline.shots.length; i += 1) {
    const plan = plans[i];
    const cur = timeline.shots[i];
    const prev = timeline.shots[i - 1];
    if (!plan || !cur || !prev || plan.kind === 'hard-cut') continue;
    const att = +(cur.startMs / 1000).toFixed(3);
    const dur = +(plan.durationMs / 1000).toFixed(3);
    const t0 = +(att - plan.overlapMs / 1000).toFixed(3);
    const inn = `#clip-${cur.shotId}`;
    const out = `#clip-${prev.shotId}`;
    if (plan.kind === 'dissolve') {
      // 真交叉溶解：后镜在重叠窗内 0→1 盖在前镜上，前镜保持原亮度直到被完全覆盖
      lines.push(`  tl.set('${inn}', { opacity: 0 }, ${t0});`);
      lines.push(`  tl.to('${inn}', { opacity: 1, duration: ${dur}, ease: 'power2.inOut' }, ${t0});`);
    } else if (plan.kind === 'wipe') {
      lines.push(`  tl.set('${inn}', { clipPath: 'inset(0 100% 0 0)' }, ${t0});`);
      lines.push(`  tl.to('${inn}', { clipPath: 'inset(0 0% 0 0)', duration: ${dur}, ease: 'power2.inOut' }, ${t0});`);
    } else if (plan.kind === 'whip-pan') {
      // 甩镜：方向按剪切序号交替，两侧同时位移+运动模糊，避免单侧拖影
      const dir = i % 2 === 0 ? 1 : -1;
      lines.push(`  tl.set('${inn}', { opacity: 0.25, xPercent: ${dir * 12}, filter: 'blur(14px)' }, ${t0});`);
      lines.push(`  tl.to('${inn}', { opacity: 1, xPercent: 0, filter: 'blur(0px)', duration: ${dur}, ease: 'power2.out' }, ${t0});`);
      lines.push(`  tl.to('${out}', { xPercent: ${-dir * 7}, filter: 'blur(10px)', duration: ${dur}, ease: 'power2.in' }, ${t0});`);
    } else if (plan.kind === 'slide') {
      // 横推：后镜从右侧整幅推入，遮住前镜；前镜不淡出，避免中间发黑
      lines.push(`  tl.set('${inn}', { xPercent: 100 }, ${t0});`);
      lines.push(`  tl.to('${inn}', { xPercent: 0, duration: ${dur}, ease: 'power3.inOut' }, ${t0});`);
    } else if (plan.kind === 'fade-black') {
      // 黑场过渡：仅风格包显式声明时使用（前镜先黑，后镜再从黑里浮出）
      lines.push(`  tl.set('${inn}', { opacity: 0 }, ${t0});`);
      lines.push(`  tl.to('${out}', { opacity: 0, duration: ${dur / 2}, ease: 'power2.in' }, ${t0});`);
      lines.push(`  tl.to('${inn}', { opacity: 1, duration: ${dur / 2}, ease: 'power2.out' }, ${att});`);
    } else if (plan.kind === 'smash-cut') {
      // 冲击切：当帧闪白 + 后镜 6% 回弹，制造"啪"一下的喜剧落点
      lines.push(`  tl.fromTo('${inn}', { scale: 1.06 }, { scale: 1, duration: ${dur}, ease: 'power2.out' }, ${att});`);
      lines.push(`  tl.fromTo('#flash-${cur.shotId}', { opacity: 0 }, { opacity: 0.9, duration: 0.06, ease: 'power1.out' }, ${+(att - 0.02).toFixed(3)});`);
      lines.push(`  tl.to('#flash-${cur.shotId}', { opacity: 0, duration: 0.22, ease: 'power1.in' }, ${+(att + 0.05).toFixed(3)});`);
    }
  }
  if (lines.length === 0) return '';
  return `(function () {
  var tl = window.__timelines && window.__timelines['root'];
  if (!tl) return;
${lines.join('\n')}
})();`;
}

function wrapComposition(
  sceneHtml: string,
  shotId: string,
  size: { w: number; h: number },
  durationS: number,
  rigScript = '',
  presenter: PresenterSpec | null = null,
  shotIndex = -1,
): string {
  let out = sceneHtml;
  // HyperFrames 契约：GSAP 必须先于 motion-lib 加载；时间线注册到 window.__timelines[compositionId]
  if (!out.includes('gsap.min.js')) {
    out = out.replace('</head>', '<script src="../motion/gsap.min.js"></script>\n</head>');
  }
  if (!out.includes('data-composition-id')) {
    // 子合成根：独立包装元素承载 data-composition-id + data-width/height（官方 card.html 同款）。
    // 根元素不得靠 class 取样式（lint: subcomposition_root_styled_by_class——作用域改写后丢失），
    // 因此根用内联尺寸样式，原 .stage 作为内层元素照常被作用域规则命中。
    out = out.replace(
      /(<body[^>]*>)(\s*)(<[\s\S]*>)([\s\S]*)(<\/body>)/,
      (_m, body: string, ws: string, firstTag: string, rest: string, close: string) =>
        `${body}${ws}<div data-composition-id="scene-${shotId}" data-width="${size.w}" data-height="${size.h}" style="width:100%;height:100%">${firstTag}${rest}</div>${close}`,
    );
  }
  if (!out.includes('window.__timelines')) {
    out = out.replace(
      '</body>',
      `<script>window.__timelines = window.__timelines || {}; if (window.gsap && !window.__timelines['scene-${shotId}']) { window.__timelines['scene-${shotId}'] = gsap.timeline({ paused: true }); }</script>
</body>`,
    );
  }
  // 内联合并（swap）后多场景共存：动画入口必须先绑定本场景，否则全部动画错挂到根时间线
  out = out.replace(
    /DOMContentLoaded',\s*function\s*\(\)\s*\{/,
    `DOMContentLoaded', function () {
      window.__shotDurationS = ${durationS.toFixed(3)};
      MV.use('scene-${shotId}');`,
  );
  // 外层机位轨：放在所有场景脚本之后，确保它的 DOMContentLoaded 监听最后注册、rAF 最后执行
  if (rigScript && !out.includes('data-mv-rig')) {
    out = out.replace(
      '</body>',
      `${rigScript.replace('<script>', '<script data-mv-rig="1">')}\n</body>`,
    );
  }
  // 悬浮主讲头像：叠在场景之上、字幕之下（z-index:6 由 CSS 给），机位轨之后注册以覆盖全镜
  if (presenter) {
    if (!out.includes('mv-presenter')) {
      out = out.replace('</style>', `${PRESENTER_CSS}\n</style>`);
      out = out.replace(
        /(<div data-composition-id="scene-[^"]*"[^>]*>)/,
        `$1\n${presenterMarkup(presenter, size)}`,
      );
    }
    if (!out.includes('data-mv-presenter-rig')) {
      out = out.replace('</body>', `${presenterScript(presenter, shotId, durationS, shotIndex)}\n</body>`);
    }
  }
  return out;
}

// 机位审计摘要（logs/camera-rig.json）：分段首尾构图足够定位问题，不必存整份 plan
function rigSummary(rig: RigPlan): Record<string, unknown> {
  return {
    shotId: rig.shotId,
    move: rig.move,
    zoom: rig.zoom,
    durationS: rig.durationS,
    amp: rig.amp,
    sign: rig.sign,
    focus: rig.focus,
    coverage: rig.coverage,
    segments: rig.segments.map((s) => ({
      atS: s.atS,
      durationS: s.durationS,
      from: s.from,
      to: s.to,
      ease: s.ease,
    })),
  };
}

async function appendLog(
  store: ProjectStore,
  project: Project,
  name: string,
  text: string,
): Promise<void> {
  if (!text.trim()) return;
  const fs = await import('node:fs/promises');
  await ensureDir(path.join(store.projectDir(project.meta.id), 'logs'));
  await fs.appendFile(path.join(store.projectDir(project.meta.id), 'logs', name), `${text}\n`);
}
