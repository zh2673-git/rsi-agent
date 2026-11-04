import { describe, expect, it } from 'vitest';
import { V } from '../src/core/index.js';
import { parseScript } from '../src/domain/scriptwriter.js';
import type { Project } from '../src/core/schema.js';

describe('V-STYLE-003 组合确认门', () => {
  const decision = {
    id: 'noir-contrast',
    source: 'agent-chosen' as const,
    rationale: '自由组合：base + noir effects',
    lineage: { base: 'keynote-minimal' },
    overrides: {},
  };
  const gate = (style: unknown, confirmed: boolean) =>
    V.validateStyleGate({ style, confirmed } as unknown as Project);

  it('agent 自由组合未确认 → error', () => {
    expect(V.hasError(gate(decision, false))).toBe(true);
  });
  it('用户显式确认后放行', () => {
    expect(V.hasError(gate(decision, true))).toBe(false);
  });
  it('user-specified 组合不需要二次确认；recipe 预绑不触发', () => {
    expect(V.hasError(gate({ ...decision, source: 'user-specified' }, false))).toBe(false);
    expect(
      V.hasError(gate({ ...decision, source: 'recipe-recommended', lineage: {} }, false)),
    ).toBe(false);
  });
});

describe('场景校验器', () => {
  const goodScene = `<body data-scene-id="s01"><div class="subject">hi</div>
<script>MV.enter('.subject', {duration: 600});</script></body>`;

  it('合法场景通过', () => {
    const issues = V.validateSceneFile(goodScene, { narration: '这是一段旁白。' });
    expect(V.hasError(issues)).toBe(false);
  });

  it('禁时间轴属性', () => {
    const bad = goodScene.replace('data-scene-id="s01"', 'data-scene-id="s01" data-start="0"');
    expect(V.hasError(V.validateSceneFile(bad, { narration: '旁白' }))).toBe(true);
  });

  it('禁非白名单原语', () => {
    const bad = goodScene.replace("MV.enter('.subject'", "MV.fly('.subject'");
    const issues = V.validateSceneFile(bad, { narration: '旁白' });
    expect(issues.some((i) => i.id === 'V-SCENE-003')).toBe(true);
  });

  it('对位铁律：画面复述旁白原文被拦', () => {
    const bad = goodScene.replace('hi', '黑洞的形成');
    const issues = V.validateSceneFile(bad, { narration: '今天讲讲黑洞的形成。' });
    expect(issues.some((i) => i.id === 'V-SCENE-005')).toBe(true);
  });

  it('对位铁律：仅两字巧合不误报', () => {
    const ok = goodScene.replace('hi', '黑洞');
    const issues = V.validateSceneFile(ok, { narration: '今天讲讲黑洞的形成。' });
    expect(issues.some((i) => i.id === 'V-SCENE-005')).toBe(false);
  });

  it('图表禁 3D 装饰（Tufte）', () => {
    const bad = '<div>立体饼图 3d 效果</div>';
    expect(V.hasError(V.validateChartScene(bad))).toBe(true);
  });
});

describe('风格校验器', () => {
  const pack = {
    id: 'p',
    name: 'n',
    grade: 'A' as const,
    status: 'registered' as const,
    userFacing: { name: 'n', aliases: [], vibe: 'v', bestFor: [] },
    anatomy: {
      script: 's', directing: 'd', art: 'a', camera: 'c',
      performance: 'p', sourcing: 'so', sound: 'sd', editing: 'e',
    },
    palette: { primary: '#111111', accent: '#222222', neutral: ['#1','#2','#3','#4','#5'], colorArc: 'x' },
    type: { families: ['sans'], scale: { title: 0.1, body: 0.03 }, tracking: {} },
    layout: { density: 0.3, maxElementsPerShot: 3, whitespace: 0.4 },
    motion: { easing: 'e', intensity: 0.5, staggerMs: 80, spring: { stiffness: 180, damping: 20 } },
    pacing: { curve: 'c', shotLenMs: [1500, 3000] as [number, number], breathEvery: 5 },
    effects: {},
    transitions: ['dissolve'],
    shotScaleBias: ['MS' as const],
    provenance: { source: 'manual' as const, from: 'x', version: '1.0' },
  };

  it('无 rationale 的风格决策被拦', () => {
    expect(V.hasError(V.validateStyleDecision({ id: 'p', source: 'agent-chosen', rationale: '' }))).toBe(true);
  });

  it('组合覆写未知参数组被拦', () => {
    const issues = V.validateCombination(pack, { bogus: 1 }, [pack]);
    expect(V.hasError(issues)).toBe(true);
  });

  it('合法覆写通过', () => {
    const issues = V.validateCombination(pack, { effects: { grain: 0.2 }, _lineage: [] }, [pack]);
    expect(V.hasError(issues)).toBe(false);
  });

  it('沉淀包缺 review 不许上架', () => {
    const absorbed = { ...pack, provenance: { ...pack.provenance, source: 'absorbed' as const, review: '' } };
    expect(V.hasError(V.validateProvenance(absorbed))).toBe(true);
    const reviewed = { ...absorbed, provenance: { ...absorbed.provenance, review: '对拍通过' } };
    expect(V.hasError(V.validateProvenance(reviewed))).toBe(false);
  });

  it('agent-chosen 风格缺谱系是 error（V-STYLE-004）', () => {
    const issues = V.validateStyleDecision({ id: 'p', source: 'agent-chosen', rationale: '理由充分' });
    const hit = issues.find((i) => i.id === 'V-STYLE-004');
    expect(hit?.level).toBe('error');
  });
});

describe('剪辑节奏校验器', () => {
  const mkShot = (id: string, narration: string) =>
    ({ id, narration, visual: { kind: 'code-scene', template: 'typography', params: {} }, state: 'ready', zoom: 'MS', camera: 'none', transition: 'dissolve', gag: false } as never);
  const mkTimeline = (narrations: string[]) => ({
    shots: narrations.map((_, i) => ({ shotId: `s${String(i + 1).padStart(2, '0')}`, startMs: i * 5000, durationMs: 5000, transition: 'dissolve' })),
    subtitles: [],
    sfx: [],
  } as never);

  it('句中切镜是 error（V-RHY-002，心理眨眼铁律）', () => {
    const shots = [mkShot('s01', '这是一句没有说完的旁白'), mkShot('s02', '第二句。')];
    const issues = V.validateCutPoints(shots, mkTimeline(['a', 'b']));
    const hit = issues.find((i) => i.id === 'V-RHY-002');
    expect(hit?.level).toBe('error');
  });

  it('句读边界切镜通过', () => {
    const shots = [mkShot('s01', '第一句完整。'), mkShot('s02', '第二句。')];
    expect(V.hasError(V.validateCutPoints(shots, mkTimeline(['a', 'b'])))).toBe(false);
  });

  it('段数≠镜数报 V-RHY-007（非借号）', () => {
    const p = {
      script: { fullText: '', segments: [{ id: 'seg-1', text: 'a', function: 'inform' }] },
      shots: [mkShot('s01', 'a'), mkShot('s02', 'b')],
    } as never;
    const issues = V.validateStoryboard(p);
    expect(issues.some((i) => i.id === 'V-RHY-007')).toBe(true);
    expect(issues.some((i) => i.id === 'V-STE-003')).toBe(false);
  });
});

describe('编剧校验器', () => {
  it('parseScript 缺功能直接报错（V-SCP-001 不被默认值架空）', () => {
    const raw = { fullText: '文本', segments: [{ id: 'seg-1', text: '无功能段' }] };
    expect(() => parseScript(raw)).toThrow(/V-SCP-001|未标功能/);
  });
});
