import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pickCanvasProgram, pickTemplateBySemantics } from '../src/domain/scene-semantics.js';
import { TemplateLlmClient } from '../src/infrastructure/llm-client.js';
import type { LlmClient, LlmTask } from '../src/infrastructure/llm-client.js';
import { drawScene } from '../src/domain/scene-forge.js';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import type { Project, Shot, StylePack } from '../src/core/schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('场景语义分配（根据剧本拍电影）', () => {
  const MV = ['typography', 'chart', 'flow', 'comparison', 'atmosphere'];
  const CANVAS = ['s01', 's02', 's03', 's04', 's05', 's06', 's07', 's08'];

  it('叙事形式→模板：流程词→flow、对比词→comparison、数量词→chart、无线索→typography', () => {
    expect(pickTemplateBySemantics('首先核心坍缩，然后形成激波，最终留下黑洞。', MV)).toBe('flow');
    expect(pickTemplateBySemantics('相比太阳，它的密度截然不同。', MV)).toBe('comparison');
    expect(pickTemplateBySemantics('它的质量相当于数百万个太阳。', MV)).toBe('chart');
    expect(pickTemplateBySemantics('这是一个定义性的陈述。', MV)).toBe('typography');
  });

  it('内容主题→canvas 程序：引力→s01、视界→s02、弯曲→s03、燃料→s04、坍缩→s05', () => {
    expect(pickCanvasProgram('连光都无法逃脱它的引力。', CANVAS, []).program).toBe('s01');
    expect(pickCanvasProgram('事件视界是一条有去无回的边界。', CANVAS, []).program).toBe('s02');
    expect(pickCanvasProgram('时空被压弯成一口深井。', CANVAS, []).program).toBe('s03');
    expect(pickCanvasProgram('核燃料烧尽，恒星开始崩塌。', CANVAS, []).program).toBe('s04');
    expect(pickCanvasProgram('坍缩引发超新星爆发。', CANVAS, []).program).toBe('s05');
    expect(pickCanvasProgram('EHT 拍到了金色吸积盘。', CANVAS, []).program).toBe('s07');
  });

  it('零命中时取最久未用程序，保证全片画面覆盖不连续重复', () => {
    const programs = ['s01', 's02', 's03'];
    const a = pickCanvasProgram('无线索句子一。', programs, ['s02', 's01']);
    expect(a.program).toBe('s03'); // 未用过优先
    const b = pickCanvasProgram('无线索句子二。', programs, ['s01', 's02', 's03']);
    expect(b.program).not.toBe('s03'); // 不与上一个重复
  });

  it('离线分镜给出切点动机与机位变化，转场留空交给剪辑部裁决', async () => {
    const llm = new TemplateLlmClient();
    const raw = await llm.generate({
      kind: 'storyboard',
      payload: {
        segments: [
          { id: 'seg-1', text: '先看全景。' },
          { id: 'seg-2', text: '忽然推到脸上。' },
        ],
        directorNotes: [],
        templates: ['typography'],
        shotScaleBias: ['ELS', 'CU'],
        materialDecisions: [],
      },
    });
    const shots = raw as Array<{ motivation: string; camera: string; transition: string }>;
    expect(shots[0]!.motivation).toBe('');
    expect(shots[1]!.motivation).toContain('景别跳');
    expect(shots.every((s) => s.camera !== 'none')).toBe(true);
    expect(shots.every((s) => s.transition === '')).toBe(true);
  });

  it('templateStoryboard 端到端：同语义段不再按索引轮转，同形异义段拿到不同模板', () => {
    const llm = new TemplateLlmClient();
    return llm.generate({
      kind: 'storyboard',
      payload: {
        segments: [
          { id: 'seg-1', text: '首先，恒星点燃核聚变。' },
          { id: 'seg-2', text: '相比普通恒星，它的质量大得多。' },
          { id: 'seg-3', text: '然后燃料耗尽，核心坍缩。' },
        ],
        directorNotes: [],
        templates: ['typography', 'chart', 'flow', 'comparison', 'atmosphere'],
        shotScaleBias: ['MS'],
        materialDecisions: [],
      },
    }).then((raw) => {
      const shots = raw as Array<{ visual: { template: string } }>;
      expect(shots[0]!.visual.template).toBe('flow');
      expect(shots[1]!.visual.template).toBe('comparison');
      expect(shots[2]!.visual.template).toBe('flow');
    });
  });

  it('canvas 配方端到端：语义不同的段分配到主题对应的程序', () => {
    const llm = new TemplateLlmClient();
    return llm.generate({
      kind: 'storyboard',
      payload: {
        segments: [
          { id: 'seg-1', text: '光也无法逃脱它的引力。' },
          { id: 'seg-2', text: '时空在这里被压弯。' },
          { id: 'seg-3', text: '最终的剪影缓缓拉远，重归宁静。' },
        ],
        directorNotes: [],
        templates: ['canvas:s01', 'canvas:s02', 'canvas:s03', 'canvas:s04', 'canvas:s05', 'canvas:s06', 'canvas:s07', 'canvas:s08'],
        shotScaleBias: ['MS'],
        materialDecisions: [],
      },
    }).then((raw) => {
      const shots = raw as Array<{ visual: { template: string } }>;
      expect(shots[0]!.visual.template).toBe('canvas:s01');
      expect(shots[1]!.visual.template).toBe('canvas:s03');
      expect(shots[2]!.visual.template).toBe('canvas:s08');
    });
  });

  it('混合评分：canvas 配方下强语义段（≥2 线索）切出 MV 异质形式，弱语义段留在 canvas', () => {
    const llm = new TemplateLlmClient();
    return llm.generate({
      kind: 'storyboard',
      payload: {
        segments: [
          { id: 'seg-1', text: '它的质量是太阳的数百万倍，相当于一亿个地球。' },
          { id: 'seg-2', text: '黑洞相比恒星，密度截然不同。' },
          { id: 'seg-3', text: '宇宙中有一种天体。' },
        ],
        directorNotes: [],
        templates: ['canvas:s01', 'canvas:s02', 'canvas:s03', 'canvas:s04', 'canvas:s05', 'canvas:s06', 'canvas:s07', 'canvas:s08', 'chart', 'comparison'],
        shotScaleBias: ['MS'],
        materialDecisions: [],
      },
    }).then((raw) => {
      const shots = raw as Array<{ visual: { template: string } }>;
      expect(shots[0]!.visual.template).toBe('chart');
      expect(shots[1]!.visual.template).toBe('comparison');
      expect(shots[2]!.visual.template).toMatch(/^canvas:/);
    });
  });
});

// ---------- LLM scene 接线 + 带反馈重试 ----------

const GOOD_SCENE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden}body{font-family:sans-serif}
.stage{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.subject{font-size:80px;color:#111}</style></head>
<body data-scene-id="s01"><div class="stage"><div class="subject">◎</div></div>
<script src="../motion/motion-lib.js"></script>
<script>document.addEventListener('DOMContentLoaded',function(){
MV.enter('.subject',{easing:'power2.out',duration:600,from:{opacity:0,y:40}});
MV.camera('.stage',{move:'push-in',zoom:'MS'});});</script></body></html>`;

const BAD_SCENE = GOOD_SCENE.replace("MV.enter('.subject'", "MV.fly('.subject'");

/** 第一次给违规场景（触发反馈重试），第二次给合格场景 */
class SceneStubLlm implements LlmClient {
  readonly name = 'stub';
  calls: LlmTask[] = [];
  constructor(private readonly script: Array<Record<string, unknown>>) {}
  async generate(task: LlmTask): Promise<unknown> {
    this.calls.push(task);
    return this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
  }
}

let root = '';
let store: ProjectStore;
let pack: StylePack;
let project: Project;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-sem-'));
  await fs.cp(path.join(REPO_ROOT, 'templates'), path.join(root, 'templates'), { recursive: true });
  store = new ProjectStore(root);
  project = {
    meta: { id: 'p1', title: '测试片', topic: '测试', aspect: '16:9', durationTier: '0-5', fps: 30, genre: 'science-explainer', assetPolicy: 'auto' },
    stage: 'sourcing',
    directorNotes: [],
    confirmed: false,
    materialDecisions: {},
    shots: [],
    script: { fullText: '测试讲稿。', segments: [{ id: 'seg-1', text: '测试讲稿。' }] },
  } as unknown as Project;
  pack = {
    palette: { primary: '#123456', accent: '#abcdef', neutral: ['#111', '#333', '#777', '#bbb', '#f5f5f5'] },
    type: { families: ['sans-serif'], scale: { title: 0.11, body: 0.05 } },
    motion: { easing: 'power2.out', staggerMs: 120, spring: { stiffness: 170, damping: 14 } },
    layout: { maxElementsPerShot: 4, whitespace: 8 },
    effects: { grain: 0.1, vignette: 0.2 },
  } as unknown as StylePack;
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeShot(id = 's01'): Shot {
  return {
    id,
    segmentId: 'seg-1',
    narration: '这是一段测试旁白，讲一个具体的意思。',
    visual: { kind: 'code-scene', template: 'typography', prompt: '视觉意图：表现测试含义', params: {} },
    zoom: 'MS',
    camera: 'push-in',
    transition: 'dissolve',
    counterpoint: 'metaphor',
    state: 'pending',
  } as unknown as Shot;
}

describe('LLM scene 接线', () => {
  it('校验失败带反馈重试，修复后采用 LLM 场景', async () => {
    const llm = new SceneStubLlm([{ html: BAD_SCENE }, { html: GOOD_SCENE.replace('s01', 's01') }]);
    const shot = makeShot();
    const { file } = await drawScene(store, project, shot, pack, llm);
    expect(llm.calls.length).toBe(2);
    // 第二次调用的 payload 携带校验器反馈
    const feedback = String(llm.calls[1]!.payload['feedback'] ?? '');
    expect(feedback).toContain('V-SCENE-003');
    const html = await fs.readFile(file, 'utf8');
    expect(html).toContain('MV.camera');
  });

  it('重试耗尽回退 forge 模板（流水线不因 LLM 质量阻塞）', async () => {
    const llm = new SceneStubLlm([{ html: BAD_SCENE }]);
    const shot = makeShot('s02');
    const { file } = await drawScene(store, project, shot, pack, llm);
    expect(llm.calls.length).toBe(3); // 1 + SCENE_LLM_RETRIES
    const html = await fs.readFile(file, 'utf8');
    expect(html).toContain('data-scene-id="s02"');
  });

  it('template 模式（空 html 声明）直接走 forge 兜底，不浪费调用', async () => {
    const llm = new TemplateLlmClient();
    const shot = makeShot('s03');
    const { file } = await drawScene(store, project, shot, pack, llm);
    const html = await fs.readFile(file, 'utf8');
    expect(html).toContain('data-scene-id');
  });

  it('幂等：已落盘场景不被覆盖（agent/人工精修受保护）', async () => {
    const shot = makeShot('s04');
    const sceneFile = path.join(store.projectDir('p1'), 'scenes', 'Scene_s04.html');
    await fs.mkdir(path.dirname(sceneFile), { recursive: true });
    await fs.writeFile(sceneFile, GOOD_SCENE.replace('s01', 's04'), 'utf8');
    const llm = new SceneStubLlm([{ html: BAD_SCENE }]);
    const { file } = await drawScene(store, project, shot, pack, llm);
    expect(llm.calls.length).toBe(0); // 不该调 LLM
    expect(await fs.readFile(file, 'utf8')).toBe(GOOD_SCENE.replace('s01', 's04')); // 精修版原样沿用
  });

  it('幂等 + 精修版违规 → 带反馈报错（failReason 即修改意见）', async () => {
    const shot = makeShot('s05');
    const sceneFile = path.join(store.projectDir('p1'), 'scenes', 'Scene_s05.html');
    await fs.writeFile(sceneFile, BAD_SCENE.replace('s01', 's05'), 'utf8');
    await expect(drawScene(store, project, shot, pack)).rejects.toThrow(/V-SCENE-003/);
  });
});
