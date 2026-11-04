import { describe, expect, it } from 'vitest';
import type { Project, StylePack, Timeline } from '../src/core/schema.js';
import {
  adjudicateCuts,
  applyAudioShifts,
  cleanKeywords,
  computeTimeline,
  continuityReport,
  highlightSentence,
  pickCaptionSide,
  validateReadiness,
} from '../src/domain/composer.js';
import {
  buildRigScript,
  deriveCoverage,
  pickSubjectFocus,
  planCameraRig,
} from '../src/domain/camera.js';
import { V } from '../src/core/index.js';
import { deriveRelationMotivation } from '../src/domain/transitions.js';

const PACK = { transitions: ['hard-cut', 'smash-cut', 'dissolve'] } as unknown as StylePack;

function makeProject(): Project {
  const shot = (id: string, dur: number, scene: string, side = 'center') => ({
    id,
    segmentId: `seg-${id}`,
    narration: `第${id}段旁白，`,
    visual: {
      kind: 'code-scene' as const,
      prompt: '',
      params: { scene, side },
    },
    zoom: 'MS' as const,
    camera: 'none',
    motivation: 'static',
    counterpoint: 'metaphor' as const,
    gag: false,
    transition: 'dissolve',
    coverage: [],
    enterAnchor: '',
    exitAnchor: '',
    audioShiftMs: 0,
    state: 'voiced' as const,
    asset: { kind: 'code-scene' as const, path: `/tmp/${id}.html`, meta: {} },
    voice: { file: `/tmp/${id}.wav`, durationMs: dur, voice: 'silent', rate: 1, source: 'tts' as const, estimated: false },
  });
  return {
    schemaVersion: 1,
    meta: {
      id: 'p1',
      title: 't',
      topic: 'topic',
      aspect: '16:9',
      durationTier: '0-5',
      fps: 30,
      genre: 'science-explainer',
      assetPolicy: 'auto',
    },
    stage: 'compose',
    directorNotes: [],
    shots: [shot('s01', 2000, 'scene-1'), shot('s02', 3000, 'scene-1'), shot('s03', 2500, 'scene-2')],
    materialDecisions: {},
    confirmed: true,
  };
}

describe('composer', () => {
  it('时间线满足音画同步不变量', () => {
    const p = makeProject();
    const tl = computeTimeline(p);
    expect(tl.shots.map((s) => s.startMs)).toEqual([0, 2000, 5000]);
    expect(tl.shots.map((s) => s.durationMs)).toEqual([2000, 3000, 2500]);
    expect(V.hasError(V.validateTimelineSync(p.shots, tl))).toBe(false);
  });

  it('时长不齐被检出', () => {
    const p = makeProject();
    const tl = computeTimeline(p);
    const broken: Timeline = {
      ...tl,
      shots: tl.shots.map((s, i) => (i === 1 ? { ...s, startMs: 9999 } : s)),
    };
    const issues = V.validateTimelineSync(p.shots, broken);
    expect(V.hasError(issues)).toBe(true);
  });

  it('同场景跨镜跳轴被检出，声明 gag 后放行', () => {
    const p = makeProject();
    p.shots[1]!.visual.params['side'] = 'right';
    const report = continuityReport(p);
    expect(report.items.some((i) => i.status === 'violation')).toBe(true);
    p.shots.forEach((s) => (s.gag = true));
    const report2 = continuityReport(p);
    expect(report2.items.some((i) => i.status === 'violation')).toBe(false);
    expect(report2.items.some((i) => i.status === 'declared-gag')).toBe(true);
  });

  it('缺旁白/缺素材被 readiness 拦下', () => {
    const p = makeProject();
    delete p.shots[2]!.voice;
    delete p.shots[1]!.asset;
    const issues = validateReadiness(p);
    expect(V.hasError(issues)).toBe(true);
    expect(issues.some((i) => i.id === 'V-SND-002')).toBe(true);
    expect(issues.some((i) => i.id === 'V-AST-005')).toBe(true);
  });

  it('音效落点不对齐被检出', () => {
    const p = makeProject();
    const tl = computeTimeline(p);
    tl.sfx = [{ file: 'x.wav', atMs: 12345, kind: 'hit', leadMs: 0 }];
    expect(V.hasError(V.validateSfxLanding(tl))).toBe(true);
    tl.sfx = [{ file: 'x.wav', atMs: 2000, kind: 'hit', leadMs: 0 }];
    expect(V.hasError(V.validateSfxLanding(tl))).toBe(false);
  });

  it('V-CAP-001 排版感知：主语在下方则字幕落顶部，反之落底部，读不出保守落底', () => {
    const lowSubject = `.subject{position:absolute;left:50%;top:72%;width:20vmin}`;
    const highSubject = `.subject{position:absolute;left:50%;top:30%;width:20vmin}`;
    const bottomAnchored = `.subject{position:absolute;left:20%;bottom:12%;width:20vmin}`;
    expect(pickCaptionSide(lowSubject)).toBe('top');
    expect(pickCaptionSide(highSubject)).toBe('bottom');
    expect(pickCaptionSide(bottomAnchored)).toBe('top');
    expect(pickCaptionSide('<div class="foo">无主语</div>')).toBe('bottom');
    expect(pickCaptionSide(`.subject{top:calc(50% - 10vmin)}`)).toBe('bottom');
  });

  it('V-CAP-002 关键词清洗：去标点、限长、去重、限量', () => {
    expect(cleanKeywords(['曾经，有', '机会摆在', 'make-video', '机会摆在'], 2)).toEqual(['曾经有', '机会摆在']);
    expect(cleanKeywords(['让代码来', '机会'], 2)).toEqual(['让代码来', '机会']);
    expect(cleanKeywords(['这是一个远远超过十二个字上限的关键词'], 2)).toEqual([]);
    expect(cleanKeywords(['project.json', 'comedypop'], 2)).toEqual(['projectjson', 'comedypop']);
  });

  it('full 模式句内高亮：首个命中关键词包 em', () => {
    const html = highlightSentence('让代码来，让代码来。', ['让代码来']);
    expect(html).toBe('<em>让代码来</em>，让代码来。');
    expect(highlightSentence('没有命中。', ['让代码来'])).toBe('没有命中。');
  });
});

describe('机位轨与覆盖切（docs/05 摄影 / docs/08 剪辑）', () => {
  const shot = (over: Partial<Project['shots'][number]> = {}) =>
    ({
      ...makeProject().shots[0]!,
      ...over,
    }) as Project['shots'][number];

  it('长镜覆盖切默认关闭，逐镜 opt-in 后才按重音词派生；短镜不切', () => {
    const long = shot({ narration: '镜头切到主角，然后他停了一下。', coverage: [] });
    expect(deriveCoverage(long, ['他停了一下'], 6000)).toEqual([]);
    const cuts = deriveCoverage(long, ['他停了一下'], 6000, true);
    expect(cuts.length).toBe(1);
    expect(cuts[0]!.atMs).toBeGreaterThan(6000 * 0.2);
    expect(cuts[0]!.atMs).toBeLessThan(6000 * 0.85);
    expect(cuts[0]!.motivation).toBe('emphasis');
    expect(deriveCoverage(long, ['他停了一下'], 2500, true)).toEqual([]);
  });

  it('机位三段式：景别越大位移越大；末段默认减速落定，只有 punchOut 才加速收势', () => {
    const wide = planCameraRig({
      shotId: 's01',
      durationMs: 4000,
      zoom: 'ELS',
      camera: 'push-in',
      focus: { x: 50, y: 50 },
      coverage: [],
    });
    const close = planCameraRig({
      shotId: 's01',
      durationMs: 4000,
      zoom: 'ECU',
      camera: 'push-in',
      focus: { x: 50, y: 50 },
      coverage: [],
    });
    const span = (p: typeof wide) => p.keyframes.at(-1)!.scale;
    expect(span(close)).toBeGreaterThan(span(wide));
    expect(wide.segments.at(-1)!.ease).toBe('power2.out');
    const punch = planCameraRig({
      shotId: 's01',
      durationMs: 4000,
      zoom: 'ECU',
      camera: 'push-in',
      focus: { x: 50, y: 50 },
      coverage: [],
      options: { punchOut: true },
    });
    expect(punch.segments.at(-1)!.ease).toBe('power2.in');
  });

  it('静止镜是真静止：不生成机位分段，脚本为空；导演仍可显式覆写幅度与方向', () => {
    const still = planCameraRig({
      shotId: 's09',
      durationMs: 3000,
      zoom: 'MS',
      camera: 'static',
      focus: { x: 40, y: 50 },
      coverage: [],
    });
    expect(still.segments).toEqual([]);
    expect(buildRigScript(still)).toBe('');

    const gentle = planCameraRig({
      shotId: 's10',
      durationMs: 3000,
      zoom: 'MS',
      camera: 'push-in',
      focus: { x: 40, y: 50 },
      coverage: [],
      options: { amp: 0.5, dir: 'left' },
    });
    const full = planCameraRig({
      shotId: 's10',
      durationMs: 3000,
      zoom: 'MS',
      camera: 'push-in',
      focus: { x: 40, y: 50 },
      coverage: [],
    });
    expect(gentle.amp).toBeCloseTo(full.amp * 0.5, 5);
    expect(gentle.sign).toBe(-1);
    expect(full.sign).toBe(1); // 主体偏左 → 往右带，回中轴
    expect(gentle.segments.at(-1)!.to.scale).toBeLessThan(full.segments.at(-1)!.to.scale);
  });

  it('覆盖切在切点造成构图跳变（同场景换机位，而非平滑推镜）', () => {
    const plan = planCameraRig({
      shotId: 's02',
      durationMs: 4000,
      zoom: 'MS',
      camera: 'push-in',
      focus: { x: 60, y: 45 },
      coverage: [
        { atMs: 2000, kind: 'punch-in', scale: 1.16, xPercent: 0, yPercent: 0, rotation: 0, motivation: 'emphasis' },
      ],
    });
    const before = plan.segments.find((s) => s.atS + s.durationS <= 2.001)!;
    const after = plan.segments.find((s) => s.atS >= 1.999)!;
    expect(after.from.scale / before.to.scale).toBeGreaterThan(1.1);
    expect(buildRigScript(plan)).toContain('tl.set(SEL');
  });

  it('主语焦点读 .subject 定位，缺省回落画面中部', () => {
    expect(pickSubjectFocus('.subject{left:72%;top:26%}')).toEqual({ x: 74, y: 26 });
    expect(pickSubjectFocus('.subject{left:8%;top:17%}')).toEqual({ x: 26, y: 26 });
    expect(pickSubjectFocus('<div>无主语</div>')).toEqual({ x: 50, y: 48 });
  });

  it('match-cut 锚点相同即硬切；auto 转场按动机裁决；软转场声音先入 90ms', () => {
    const p = makeProject();
    p.shots[0]!.exitAnchor = 'silhouette-left';
    p.shots[1]!.enterAnchor = 'silhouette-left';
    const tl = computeTimeline(p);
    const decisions = adjudicateCuts(p, tl, PACK);
    expect(decisions[1]!.plan.kind).toBe('hard-cut');
    expect(decisions[1]!.motivation).toBe('match-cut');

    const p2 = makeProject();
    p2.shots[1]!.motivation = '情绪转场，安静下来';
    p2.shots[1]!.transition = 'auto';
    const tl2 = computeTimeline(p2);
    const d2 = adjudicateCuts(p2, tl2, PACK);
    expect(d2[1]!.motivation).toBe('emotion');
    expect(d2[1]!.plan.kind).toBe('dissolve');

    applyAudioShifts(p2, tl2, d2);
    expect(tl2.shots[0]!.audioShiftMs).toBe(0);
    expect(tl2.shots[1]!.audioShiftMs).toBe(-90);
    expect(tl2.shots[2]!.audioShiftMs).toBe(-90);
  });

  it('结构性动机：导演没写理由时，景别跳/视线反转/笑点落镜由客观关系反推', () => {
    expect(
      deriveRelationMotivation(
        { zoom: 'ELS', scene: 'a', side: 'center', gag: false },
        { zoom: 'CU', scene: 'b', side: 'center', gag: false },
      ),
    ).toBe('zoom-jump');
    expect(
      deriveRelationMotivation(
        { zoom: 'MS', scene: 'a', side: 'left', gag: false },
        { zoom: 'MS', scene: 'a', side: 'right', gag: false },
      ),
    ).toBe('eye-line');
    expect(
      deriveRelationMotivation(
        { zoom: 'MS', scene: 'a', side: 'center', gag: false },
        { zoom: 'MS', scene: 'b', side: 'center', gag: true },
      ),
    ).toBe('beat');
    expect(
      deriveRelationMotivation(
        { zoom: 'MS', scene: 'a', side: 'center', gag: false },
        { zoom: 'MS', scene: 'b', side: 'center', gag: false },
      ),
    ).toBe('');

    const p = makeProject();
    p.shots[0]!.zoom = 'ELS';
    p.shots[1]!.zoom = 'CU';
    const tl = computeTimeline(p);
    const d = adjudicateCuts(p, tl, PACK);
    expect(d[1]!.motivation).toBe('zoom-jump');
    expect(d[1]!.motiveSource).toBe('relation');
    expect(d[2]!.motiveSource).toBe('none');
  });

  it('V-RHY-010/011：无相机运动、切点无动机都会记 warn', () => {
    const tl = computeTimeline(makeProject());
    expect(V.validateIntraShotMotion(tl).length).toBeGreaterThan(0);
    expect(V.validateCutMotivation(tl).length).toBeGreaterThan(0);
    // 全片单一动机要够长才算「单一」（≥6 镜才判），这里补足镜数再验
    const long = {
      ...tl,
      shots: [...tl.shots, ...tl.shots.map((s, i) => ({ ...s, shotId: `${s.shotId}-b${i}` }))],
    };
    long.shots.forEach((s) => (s.motivation = 'beat'));
    expect(V.validateCutMotivation(long).some((i) => i.id === 'V-RHY-011')).toBe(true);
  });
});
