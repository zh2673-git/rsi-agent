import { describe, expect, it } from 'vitest';
import {
  actionLayerOf,
  backfillVisibility,
  extractManifestsFromHtml,
  queryTimeSlice,
  validateManifests,
} from '../src/domain/manifest.js';
import { applyTemplate, TemplatePackSchema, type TemplatePack } from '../src/domain/template-pack.js';
import type { Project } from '../src/core/schema.js';

const HTML = `<html><body>
<div id="hero" class="subject big">主角</div>
<div class="bg-layer"></div>
<div class="caption">这是文案</div>
<script>MV.strokeDraw('#hero',{duration:0.5}); MV.motifLoop('.bg-layer',{amp:4}); MV.camera({duration:1});</script>
</body></html>`;

const makeProject = (): Project => {
  const m = extractManifestsFromHtml(HTML);
  return {
    meta: { id: 'p1', title: '测试', topic: 't', genre: 'science-explainer' },
    stage: 'materialize',
    shots: [{
      id: 's1',
      segmentId: 'seg-1',
      narration: '旁白',
      visual: { kind: 'code-scene', template: 'x', prompt: '', params: {} },
      zoom: 'MS',
      state: 'pending',
      elements: m.elements,
      actions: m.actions,
    }],
    timeline: {
      shots: [{ shotId: 's1', startMs: 0, durationMs: 2000, transition: 'none' }],
      subtitles: [],
    },
  } as unknown as Project;
};

describe('元素/动作两清单反向抽取（方案 P1）', () => {
  it('从 HTML 抽出元素：带 id/class 的可见标签，跳过 script/style', () => {
    const m = extractManifestsFromHtml(HTML);
    const selectors = m.elements.map((e) => e.visual.selector);
    expect(selectors).toContain('#hero');
    expect(selectors).toContain('.caption');
    expect(selectors).not.toContain('script');
    expect(m.elements.find((e) => e.visual.selector === '.caption')?.visual.text).toBe('这是文案');
  });

  it('从 MV.* 调用抽动作，target 关联到元素 id 或 scene', () => {
    const m = extractManifestsFromHtml(HTML);
    expect(m.actions.length).toBe(3);
    const hero = m.elements.find((e) => e.visual.selector === '#hero');
    const stroke = m.actions.find((a) => a.primitive === 'MV.strokeDraw');
    expect(stroke?.target).toBe(hero?.id);
    expect(stroke?.params.duration).toBe(0.5);
    expect(m.actions.find((a) => a.primitive === 'MV.camera')?.target).toBe('scene');
  });

  it('四层分类：主体/氛围/运镜/强调', () => {
    expect(actionLayerOf('MV.strokeDraw')).toBe('subject');
    expect(actionLayerOf('MV.motifLoop')).toBe('ambient');
    expect(actionLayerOf('MV.camera')).toBe('camera');
    expect(actionLayerOf('MV.emphasis')).toBe('emphasis');
  });
});

describe('两清单校验与时间回填（方案 P3/P5）', () => {
  it('target 引用不存在 → error', () => {
    const p = makeProject();
    p.shots[0]!.actions![0]!.target = 'el999';
    const issues = validateManifests(p);
    expect(issues.some((i) => i.code === 'V-MAN-001' && i.level === 'error')).toBe(true);
  });

  it('target=scene 不触发引用错误', () => {
    const p = makeProject();
    p.shots[0]!.actions!.forEach((a) => { a.target = 'scene'; });
    expect(validateManifests(p).filter((i) => i.code === 'V-MAN-001')).toEqual([]);
  });

  it('backfill 用 timeline 写 visibility/timing，不写死进条目', () => {
    const p = makeProject();
    const filled = backfillVisibility(p);
    expect(filled.shots[0]!.elements![0]!.visibility.startMs).toBe(0);
    expect(filled.shots[0]!.elements![0]!.visibility.endMs).toBe(2000);
    // 入参未被改
    expect(p.shots[0]!.elements![0]!.visibility.startMs).toBeUndefined();
  });

  it('时间切片只返回在窗口内的元素/动作', () => {
    const p = backfillVisibility(makeProject());
    expect(queryTimeSlice(p, 1000).elements.length).toBeGreaterThan(0);
    expect(queryTimeSlice(p, 5000).elements.length).toBe(0);
  });
});

describe('TemplatePack 整包（方案 P4）', () => {
  const pack: TemplatePack = TemplatePackSchema.parse({
    id: 'tp-hero',
    name: '英雄科普',
    recipe: 'science-explainer',
    style: 'flat-graphic',
    elementHints: [{ kind: 'shape', role: 'subject', hint: '主体几何体' }],
    actionHints: [{ layer: 'emphasis', hint: '关键处轻强调' }],
  });

  it('applyTemplate 注入 genre/style/templateId', () => {
    const p = makeProject();
    const r = applyTemplate(p, pack, { forceStyle: true });
    expect(r.filled).toContain('genre');
    expect(r.filled).toContain('style');
    expect(p.style?.source).toBe('user-specified');
    expect(p.style?.lineage?.template).toBe('tp-hero');
    expect(p.templateId).toBe('tp-hero');
  });

  it('用户已指定 style 时不覆盖（除非 forceStyle）', () => {
    const p = makeProject();
    p.style = { id: 'custom', source: 'user-specified', rationale: '用户选的', lineage: {}, overrides: {} };
    applyTemplate(p, pack);
    expect(p.style?.id).toBe('custom');
  });
});
