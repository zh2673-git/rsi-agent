import { describe, expect, it } from 'vitest';
import { applyStyleVisualPool, pickTemplateBySemantics } from '../src/domain/scene-semantics.js';
import { TemplateLlmClient } from '../src/infrastructure/llm-client.js';
import { V } from '../src/core/index.js';
import type { Project, Shot, StylePack, StyleVisual } from '../src/core/schema.js';

// ---------- 风格→素材池（V-STYLE-008 的数据侧） ----------

const BASE_POOL = ['typography', 'chart', 'flow', 'comparison', 'iso-stage', 'depth-layers'];

function visuals(partial: Partial<StyleVisual>): StyleVisual {
  return {
    dimension: '2d',
    motifs: [],
    sceneBias: [],
    sceneDeny: [],
    texture: [],
    note: '',
    ...partial,
  };
}

describe('风格决定素材池', () => {
  it('sceneDeny 把形态从池里剔除，sceneBias 前置到池首', () => {
    const pool = applyStyleVisualPool(
      BASE_POOL,
      visuals({ sceneBias: ['iso-stage'], sceneDeny: ['depth-layers'] }),
    );
    expect(pool).not.toContain('depth-layers');
    expect(pool[0]).toBe('iso-stage');
    expect(pool).toContain('typography');
  });

  it('bias 里出现池外模板也会被带进池（风格新增专属素材）', () => {
    const pool = applyStyleVisualPool(['typography'], visuals({ sceneBias: ['comic-symbol'] }));
    expect(pool).toEqual(['comic-symbol', 'typography']);
  });

  it('deny 剔完为空时回退到剔除前的原池，不把风格锁死成无素材可用', () => {
    const pool = applyStyleVisualPool(['image'], visuals({ sceneDeny: ['image'] }));
    expect(pool).toEqual(['image']);
  });

  it('未声明 visuals 时保持原池不动（存量配方不受影响）', () => {
    expect(applyStyleVisualPool(BASE_POOL, undefined)).toEqual(BASE_POOL);
  });

  it('bias 参与语义选择：同分时优先风格偏好，无线索时取 bias 首项', () => {
    // 「组织成一套结构」命中 iso-stage 的结构线索，无 bias 时也可能选中它；
    // 这里验证无线索句在有 bias 时落到风格偏好形态，而不是默认 typography
    expect(pickTemplateBySemantics('这是一个定义性的陈述。', BASE_POOL, ['iso-stage'])).toBe('iso-stage');
    expect(pickTemplateBySemantics('这是一个定义性的陈述。', BASE_POOL, [])).toBe('typography');
  });

  it('离线分镜拿到风格池后只出池内形态', async () => {
    const llm = new TemplateLlmClient();
    const raw = (await llm.generate({
      kind: 'storyboard',
      payload: {
        segments: [
          { id: 'seg-1', text: '这是一句没有任何线索的陈述。' },
          { id: 'seg-2', text: '接下来把它组织成一套结构。' },
        ],
        directorNotes: [],
        templates: applyStyleVisualPool(BASE_POOL, visuals({ sceneBias: ['iso-stage'], sceneDeny: ['depth-layers'] })),
        styleVisual: visuals({ dimension: 'css3d', sceneBias: ['iso-stage'] }),
        shotScaleBias: ['MS'],
        materialDecisions: [],
      },
    })) as Array<{ visual: { template: string } }>;
    for (const shot of raw) expect(BASE_POOL.includes(shot.visual.template)).toBe(true);
    expect(raw[0]!.visual.template).toBe('iso-stage');
  });
});

// ---------- V-STYLE-008 配置自洽 + 场景侧维度一致 ----------

function fakePack(v: StyleVisual): StylePack {
  return {
    id: 'test-pack',
    palette: { primary: '#123456', accent: '#abcdef', neutral: ['#111'] },
    type: { families: ['sans-serif'], scale: { title: 0.11, body: 0.05 } },
    motion: { easing: 'power2.out', staggerMs: 120, spring: { stiffness: 170, damping: 14 } },
    layout: { maxElementsPerShot: 4, whitespace: 8 },
    effects: {},
    visuals: v,
    transitions: ['dissolve'],
    shotScaleBias: ['MS'],
    anatomy: { art: '', camera: '', performance: '' },
  } as unknown as StylePack;
}

const SHOT_3D = `<!doctype html><html><head><style>.stage{perspective:1200px;transform-style:preserve-3d}</style></head>
<body><div class="stage" data-scene-id="s01"><div class="deck"><div class="subject">◎</div></div></div>
<script src="../motion/motion-lib.js"></script>
<script>document.addEventListener('DOMContentLoaded',function(){
MV.enter('.subject',{easing:'power2.out',duration:600});
MV.orbit('.deck',{step:18});
MV.camera('.stage',{move:'push-in',zoom:'MS'});});</script></body></html>`;

const SHOT_2D = `<!doctype html><html><head><style>.stage{position:relative;width:100%;height:100%}
.subject{font-size:80px}</style></head>
<body><div class="stage" data-scene-id="s01"><div class="subject">◎</div></div>
<script src="../motion/motion-lib.js"></script>
<script>document.addEventListener('DOMContentLoaded',function(){
MV.enter('.subject',{easing:'power2.out',duration:600});
MV.camera('.stage',{move:'push-in',zoom:'MS'});});</script></body></html>`;

describe('V-STYLE-008 风格-素材一致性', () => {
  it('识别 3D 痕迹：透视/三轴旋转/3D 原语', () => {
    expect(V.uses3d(SHOT_3D)).toBe(true);
    expect(V.uses3d(SHOT_2D)).toBe(false);
    expect(V.uses3d('<div style="transform: rotateY(20deg)">')).toBe(true);
  });

  it('2D 风格用了 3D 素材 → warn（素材语言漂移）', () => {
    const issues = V.validateSceneFile(SHOT_3D, { narration: '测试旁白。', dimension: '2d' });
    expect(issues.some((i) => i.id === 'V-STYLE-008' && i.level === 'warn')).toBe(true);
  });

  it('css3d 风格全程平面 → warn（立体语言未落地）', () => {
    const issues = V.validateSceneFile(SHOT_2D, { narration: '测试旁白。', dimension: 'css3d' });
    expect(issues.some((i) => i.id === 'V-STYLE-008' && i.level === 'warn')).toBe(true);
  });

  it('维度对得上时不出告警', () => {
    expect(V.validateSceneFile(SHOT_3D, { narration: '测试旁白。', dimension: 'css3d' })
      .some((i) => i.id === 'V-STYLE-008')).toBe(false);
    expect(V.validateSceneFile(SHOT_2D, { narration: '测试旁白。', dimension: '2d' })
      .some((i) => i.id === 'V-STYLE-008')).toBe(false);
  });

  it('配置自洽：bias 与 deny 撞车报错；css3d 无母题告警', () => {
    const project = { shots: [] } as unknown as Project;
    const bad = V.validateStyleVisual(
      project,
      fakePack(visuals({ dimension: 'css3d', sceneBias: ['iso-stage'], sceneDeny: ['iso-stage'] })),
    );
    expect(bad.some((i) => i.id === 'V-STYLE-008' && i.level === 'error')).toBe(true);
    expect(bad.some((i) => i.level === 'warn')).toBe(true); // css3d 未登记母题

    const clean = V.validateStyleVisual(
      project,
      fakePack(visuals({ dimension: 'css3d', motifs: ['iso-stage'], sceneBias: ['iso-stage'] })),
    );
    expect(clean).toHaveLength(0);
  });

  it('镜头用了被风格禁用的形态 → warn（可审计地漂移）', () => {
    const shot = { id: 's01', visual: { template: 'depth-layers' } } as unknown as Shot;
    const issues = V.validateStyleVisual(
      { shots: [shot] } as unknown as Project,
      fakePack(visuals({ sceneDeny: ['depth-layers'] })),
    );
    expect(issues.some((i) => i.id === 'V-STYLE-008' && i.level === 'warn')).toBe(true);
  });

  it('未声明 visuals 的旧包直接放行（不误伤存量）', () => {
    const pack = fakePack(visuals({}));
    delete (pack as { visuals?: StyleVisual }).visuals;
    expect(V.validateStyleVisual({ shots: [] } as unknown as Project, pack)).toHaveLength(0);
  });
});
