import { describe, expect, it } from 'vitest';
import type { Project, StyleMedia, StylePack } from '../src/core/schema.js';
import { StyleVisualSchema, ProjectMetaSchema } from '../src/core/schema.js';
import { V } from '../src/core/index.js';
import { bindMaterial, checkMaterial } from '../src/domain/asset-sourcing.js';
import { planMaterials } from '../src/domain/material-plan.js';
import { buildMediaComposition, validateReadiness } from '../src/domain/composer.js';
import { TemplateLlmClient, type LlmClient, type LlmTask } from '../src/infrastructure/llm-client.js';
import type { MaterialIndexItem } from '../src/domain/storyboard.js';

function item(over: Partial<MaterialIndexItem> = {}): MaterialIndexItem {
  return { path: 'materials/a.jpg', type: 'image', tags: [], ...over };
}

function makeProject(): Project {
  const shot = (id: string, narration: string) => ({
    id,
    segmentId: `seg-${id}`,
    narration,
    visual: { kind: 'code-scene' as const, prompt: '', params: { scene: `scene-${id}` } },
    zoom: 'MS' as const,
    camera: 'push-in' as const,
    motivation: '',
    counterpoint: 'metaphor' as const,
    gag: false,
    transition: '',
    coverage: [],
    enterAnchor: '',
    exitAnchor: '',
    audioShiftMs: 0,
    state: 'voiced' as const,
    asset: { kind: 'code-scene' as const, path: `/tmp/${id}.html`, meta: {} },
    voice: { file: `/tmp/${id}.wav`, durationMs: 2000, voice: 'silent', rate: 1, source: 'tts' as const, estimated: false },
  });
  return {
    schemaVersion: 1,
    meta: {
      id: 'p1',
      title: 't',
      topic: '苏州平江路',
      aspect: '16:9',
      durationTier: '0-5',
      fps: 30,
      genre: 'documentary-mood',
      assetPolicy: 'auto',
      aiConsent: false,
    },
    stage: 'storyboard',
    script: {
      fullText: '他走过苏州平江路的老街。我们把数据拆成三步。',
      segments: [
        { id: 'seg-s01', text: '他走过苏州平江路的老街。', function: 'hook', emphasis: ['平江路'] },
        { id: 'seg-s02', text: '我们把数据拆成三步。', function: 'inform' },
      ],
    },
    directorNotes: [],
    shots: [shot('s01', '他走过苏州平江路的老街。'), shot('s02', '我们把数据拆成三步。')],
    materialDecisions: {},
    confirmed: false,
  };
}

const PACK = {
  visuals: { dimension: '2d', sceneBias: [], sceneDeny: [], motifs: [], texture: 'paper' },
} as unknown as StylePack;

describe('素材契约（P5-A V-AST-006）', () => {
  it('宽度不足 1280 直接拒绝，1280-1920 只告警', () => {
    expect(V.hasError(checkMaterial(item({ width: 800, height: 450 })))).toBe(true);
    const mid = checkMaterial(item({ width: 1600, height: 900 }));
    expect(V.hasError(mid)).toBe(false);
    expect(mid.some((i) => i.id === 'V-AST-006')).toBe(true);
  });

  it('比例偏离 16:9 与非满幅只告警（竖构图人物照合法）', () => {
    const tall = checkMaterial(item({ width: 1920, height: 1440 }));
    expect(V.hasError(tall)).toBe(false);
    expect(tall.some((i) => i.message.includes('比例'))).toBe(true);
  });

  it('过短视频、音频与无法探测尺寸的处理', () => {
    const short = checkMaterial(item({ type: 'video', width: 1920, height: 1080, durationMs: 900 }));
    expect(V.hasError(short)).toBe(false);
    expect(short.some((i) => i.message.includes('1.5s'))).toBe(true);
    expect(checkMaterial(item({ type: 'audio' }))).toEqual([]);
    expect(V.hasError(checkMaterial(item({ width: undefined, height: undefined })))).toBe(false);
  });
});

describe('素材绑定（P5 数据流转）', () => {
  it('改视觉类型、写溯源、作废时间线，缺镜报错', () => {
    const p = makeProject();
    p.timeline = { shots: [], subtitles: [], sfx: [] };
    bindMaterial(p, 's01', item({ width: 1920, height: 1080, sourceUrl: 'https://x', license: 'CC0' }), '测试');
    const s = p.shots[0]!;
    expect(s.visual.kind).toBe('user-material');
    expect(s.visual.source).toBe('materials/a.jpg');
    expect(s.asset?.kind).toBe('user-material');
    expect(s.asset?.path).toBe('materials/a.jpg');
    expect(s.asset?.meta?.['license']).toBe('CC0');
    expect(s.state).toBe('sourced');
    expect(p.materialDecisions['s01']?.reason).toBe('测试');
    expect(p.timeline).toBeUndefined();
    expect(() => bindMaterial(p, 'nope', item(), 'x')).toThrow();
  });
});

describe('素材需求单（P5-B）', () => {
  it('规则兜底：具体地点要真实素材，论述段强制代码绘制', async () => {
    const p = makeProject();
    const briefs = await planMaterials(p, PACK, new TemplateLlmClient());
    expect(briefs.map((b) => b.shotId)).toEqual(['s01', 's02']);
    expect(briefs[0]!.need).toBe('place');
    expect(briefs[0]!.type).toBe('video'); // 走过 = 过程，要动态
    expect(briefs[0]!.query.length).toBeGreaterThan(0);
    expect(briefs[1]!.need).toBe('none');
    expect(briefs[1]!.query).toBe('');
  });

  it('LLM 漏镜/写错 shotId 时逐镜对齐，不串镜', async () => {
    const p = makeProject();
    const wrong: LlmClient = {
      name: 'stub',
      async generate(_task: LlmTask) {
        return { briefs: [{ shotId: 's02', need: 'object', query: 'old street', type: 'image' }] };
      },
    };
    const briefs = await planMaterials(p, PACK, wrong);
    expect(briefs[0]!.shotId).toBe('s01');
    expect(briefs[0]!.need).toBe('none');
    expect(briefs[1]!.need).toBe('object');
  });
});

describe('AI 生图闸门（P5-E V-AI-001）', () => {
  it('未授权云端生成必失败，confirm 授权后放行', () => {
    const p = makeProject();
    p.shots[0]!.visual.kind = 'cloud';
    expect(validateReadiness(p).some((i) => i.id === 'V-AI-001')).toBe(true);
    p.meta.aiConsent = true;
    expect(validateReadiness(p).some((i) => i.id === 'V-AI-001')).toBe(false);
  });
});

describe('素材镜呈现（P5-C/D 真实播放）', () => {
  const style: StyleMedia = {
    grade: 'warm',
    grain: 0.13,
    vignette: 0.62,
    letterbox: false,
    motion: 'auto',
    fit: 'cover',
  };

  it('视频镜走帧序列：首帧预置、帧索引是时间的纯函数、无 video 标签', () => {
    const html = buildMediaComposition(
      's01',
      { src: '../media/s01/frames/f%05d.jpg', frames: { count: 48, fps: 24 } },
      { w: 1920, h: 1080 },
      2,
      '',
      style,
    );
    expect(html).toContain('00001.jpg');
    expect(html).toContain('var COUNT = 48');
    expect(html).toContain("ease: 'none'");
    expect(html).toContain('Math.round(st.i)');
    expect(html).not.toContain('<video');
  });

  it('图片镜无帧驱动；风格包控制调色/暗角/遮幅/裁切', () => {
    const plain = buildMediaComposition('s02', { src: '../media/s02/a.jpg' }, { w: 1920, h: 1080 }, 3, '', style);
    expect(plain).not.toContain('var COUNT');
    expect(plain).toContain('object-fit: cover');
    expect(plain).toContain('<div class="grade grade-warm">');
    const film = buildMediaComposition('s02', { src: '../media/s02/a.jpg' }, { w: 1920, h: 1080 }, 3, '', {
      ...style,
      grade: 'none',
      letterbox: true,
      fit: 'contain',
    });
    expect(film).not.toContain('<div class="grade');
    expect(film).toContain('bar-top');
    expect(film).toContain('object-fit: contain');
  });
});

describe('风格包缺省值（P5-C 存量零迁移）', () => {
  it('visuals.media 缺省等于当前写死值，meta.aiConsent 缺省 false', () => {
    const visuals = StyleVisualSchema.parse({
      dimension: '2d',
      sceneBias: [],
      sceneDeny: [],
      motifs: [],
      texture: [],
    });
    expect(visuals.media).toEqual({
      grade: 'warm',
      grain: 0.13,
      vignette: 0.62,
      letterbox: false,
      motion: 'auto',
      fit: 'cover',
    });
    expect(ProjectMetaSchema.parse({ id: 'p', title: 't', topic: 'x' }).aiConsent).toBe(false);
  });
});
