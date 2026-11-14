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

const PACK = {
  transitions: ['hard-cut', 'smash-cut', 'dissolve', 'whip-pan', 'slide'],
} as unknown as StylePack;
/** 窄词表：只允许硬切/叠化（用于验证「词表外报错」） */
const NARROW_PACK = { transitions: ['hard-cut', 'dissolve'] } as unknown as StylePack;

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
    // 2026-11-15 no-zoom：幅度不再体现在 scale（恒为 SCALE_HOLD），改看横向行程。
    const span = (p: typeof wide) => Math.abs(p.segments.at(-1)!.to.xPercent - p.segments[0]!.from.xPercent);
    expect(span(close)).toBeGreaterThan(span(wide));
    // 全片禁止变焦：任何分段两端 scale 必须相等，且等于恒定过扫值
    for (const seg of [...wide.segments, ...close.segments]) {
      expect(seg.from.scale).toBe(1.06);
      expect(seg.to.scale).toBe(1.06);
    }
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
    // 2026-11-15 no-zoom：幅度差异体现在位移，不再体现在 scale
    const sweep = (p: typeof gentle) => Math.abs(p.segments.at(-1)!.to.xPercent - p.segments[0]!.from.xPercent);
    expect(sweep(gentle)).toBeLessThan(sweep(full));
    expect(gentle.segments.at(-1)!.to.scale).toBe(full.segments.at(-1)!.to.scale);
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
    // 2026-11-15 no-zoom：换机位不再靠放大，改由位移/旋转表达（scale 全片恒定）。
    expect(after.from.scale).toBe(before.to.scale);
    expect(after.from.scale).toBe(1.06);
    expect(buildRigScript(plan)).toContain('tl.set(SEL');
  });

  it('主语焦点读 .subject 定位，缺省回落画面中部', () => {
    expect(pickSubjectFocus('.subject{left:72%;top:26%}')).toEqual({ x: 74, y: 26 });
    expect(pickSubjectFocus('.subject{left:8%;top:17%}')).toEqual({ x: 26, y: 26 });
    expect(pickSubjectFocus('<div>无主语</div>')).toEqual({ x: 50, y: 48 });
  });

  it('单镜多条覆盖切不叠成变焦：coverage 的 scale 一律折成 1（no-zoom）', () => {
    // 真实事故（2026-11-13）：分镜期每镜给两条 punch-in/reframe（1.12 × 1.30），
    // 连乘顶到 1.456 被夹在 1.28，16 镜全部被推到满幅放大，成片读作「每镜都在
    // 刻意放大 + 段间硬阶跃」。2026-11-15 用户进一步裁决「放大缩小的动效不要」，
    // 于是 coverage 的 scale 不再参与机位轨——位移该继续累加（换构图），放大彻底退出。
    const plan = planCameraRig({
      shotId: 's03a',
      durationMs: 8000,
      zoom: 'CU',
      camera: 'static',
      focus: { x: 50, y: 50 },
      coverage: [
        { atMs: 1200, kind: 'reframe', scale: 1.12, xPercent: 5, yPercent: 4, rotation: 1, motivation: 'emphasis' },
        { atMs: 5000, kind: 'punch-in', scale: 1.3, xPercent: -5, yPercent: 0, rotation: 0, motivation: 'emphasis' },
      ],
    });
    for (const s of plan.segments) {
      expect(s.to.scale, `${s.atS}s 段尾出现了缩放（no-zoom 违规）`).toBe(1.06);
      expect(s.from.scale, `${s.atS}s 段首出现了缩放（no-zoom 违规）`).toBe(1.06);
    }
    // 第二条切点仍要换到新构图：位移照常累加，不被缩放规则牵连。
    // 判据取「切点后的第一段起点」（xPercent 从 +5 叠 -5 归零是位移本身的结果，
    // 真正要钉的是 yPercent 与 rotation 这类构图量仍在累加）。
    const afterCut = plan.segments.find((s) => s.atS >= 4.999)!;
    expect(afterCut.from.yPercent).toBeGreaterThan(1);
    expect(afterCut.from.rotation).toBeCloseTo(1, 5);
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

  it('锚点匹配只补当前镜动机，不改写上一镜（否则 V-RHY-011 被掩盖）', () => {
    // 回归：adjudicateCuts 曾在锚点分支里把上一镜 motivation 也写成 match-cut。
    // motivation 语义是「切入本镜的动机」，改写上一镜等于替它那个切点伪造了动机，
    // 于是「s01a→s01b 无动机」这条 warn 永远报不出来（cut-audit 里是空、校验器看到非空）。
    const p = makeProject();
    p.shots[0]!.motivation = '';
    p.shots[0]!.exitAnchor = 'silhouette-frame';
    p.shots[1]!.enterAnchor = 'silhouette-frame';
    p.shots[1]!.motivation = '';
    const tl = computeTimeline(p);
    const decisions = adjudicateCuts(p, tl, PACK);
    expect(decisions[1]!.motivation).toBe('match-cut');
    expect(tl.shots[0]!.motivation).toBe('');
    expect(tl.shots[1]!.motivation).toBe('match-cut');
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
    p.shots[1]!.transition = 'auto';
    const tl = computeTimeline(p);
    const d = adjudicateCuts(p, tl, PACK);
    expect(d[1]!.motivation).toBe('zoom-jump');
    expect(d[1]!.motiveSource).toBe('relation');
    expect(d[2]!.motiveSource).toBe('none');
    // P10 B1：景别跨两档 → 甩镜（旧实现三选一只能给 hard-cut，动线永远不出现）
    expect(d[1]!.plan.kind).toBe('whip-pan');
  });

  it('P10：动机写枚举规范值（match-cut）能被读懂，不再记 none', () => {
    const p = makeProject();
    p.shots[1]!.motivation = 'match-cut';
    p.shots[1]!.transition = 'auto';
    const tl = computeTimeline(p);
    const d = adjudicateCuts(p, tl, PACK);
    expect(d[1]!.motiveSource).toBe('text');
    expect(d[1]!.motivation).toBe('match-cut');
    expect(d[1]!.plan.kind).toBe('hard-cut');
    // 视线横移 → 整幅横推（有动线）
    p.shots[1]!.motivation = 'eye-line';
    expect(adjudicateCuts(p, computeTimeline(p), PACK)[1]!.plan.kind).toBe('slide');
  });

  it('P10：词表外的显式转场直接报错，不再静默回退', () => {
    const p = makeProject();
    p.shots[1]!.transition = 'whip-pan';
    // NARROW_PACK 词表 = [hard-cut, dissolve]，不含 whip-pan
    expect(() => adjudicateCuts(p, computeTimeline(p), NARROW_PACK)).toThrow(/不在风格包词表/);
    // 词表里加了就放行
    expect(adjudicateCuts(p, computeTimeline(p), PACK)[1]!.plan.kind).toBe('whip-pan');
    // 未确认的历史项目走兼容路径（不报错，回退词表首项）
    const loose = adjudicateCuts(p, computeTimeline(p), NARROW_PACK, { strict: false });
    expect(loose[1]!.plan.kind).toBe('hard-cut');
  });

  it('P10：拼错的转场词是声明错误，与词表无关，一律报错', () => {
    const p = makeProject();
    p.shots[1]!.transition = 'whip-pann';
    expect(() => adjudicateCuts(p, computeTimeline(p), PACK, { strict: false })).toThrow(/未知转场词/);
  });

  it('P10：auto 映射的结果同样受词表约束（词表不够宽时也报错，不静默降级）', () => {
    const p = makeProject();
    // 景别跨两档 → auto 裁决 whip-pan；NARROW_PACK 不含它
    p.shots[0]!.zoom = 'ELS';
    p.shots[1]!.zoom = 'CU';
    p.shots[1]!.transition = 'auto';
    expect(() => adjudicateCuts(p, computeTimeline(p), NARROW_PACK)).toThrow(/不在风格包词表/);
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
