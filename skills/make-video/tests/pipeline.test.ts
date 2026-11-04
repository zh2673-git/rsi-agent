import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { StyleRegistry } from '../src/domain/style-registry.js';
import { BuddyCloudBridge } from '../src/infrastructure/buddy-cloud-bridge.js';
import { HyperFramesRenderer } from '../src/infrastructure/hyperframes-renderer.js';
import { SilentTtsClient } from '../src/infrastructure/tts-client.js';
import { TemplateLlmClient } from '../src/infrastructure/llm-client.js';
import { RetryingLlmClient } from '../src/infrastructure/llm-client.js';
import { createEngine } from '../src/application/pipeline.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root = '';

beforeAll(async () => {
  // 测试模式跳过真实渲染（真实渲染已由冒烟验证：28.6s/858 帧/0ms 误差）；
  // 取消本 env 且在渲染环境齐全时，端到端测试将真实产出 mp4。
  process.env['MV_SKIP_RENDER'] = '1';
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-e2e-'));
  for (const dir of ['templates', 'styles', 'recipes']) {
    await fs.cp(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeEngine() {
  const store = new ProjectStore(root);
  const registry = new StyleRegistry(root);
  const engine = createEngine(root, {
    store,
    registry,
    llm: new RetryingLlmClient(new TemplateLlmClient()),
    tts: new SilentTtsClient(),
    bridge: new BuddyCloudBridge(),
    renderer: new HyperFramesRenderer(),
  });
  return { engine, registry, store };
}

describe('端到端（template 模式，silent TTS）', () => {
  it('init → run --yes → 成 IR/素材/旁白/时间线/合成项目', async () => {
    const { engine, registry, store } = makeEngine();
    await registry.load();

    const project = await store.initProject({
      topic: '黑洞是怎么形成的',
      genre: 'science-explainer',
      durationTier: '0-5',
    });
    await engine.init(project.meta.id);
    const events = await engine.run({ autoConfirm: true });
    const types = events.map((e) => e.type);

    expect(types).toContain('stage-advanced');
    const p = engine.getProject();

    // 编剧 + 分镜
    expect(p.script?.segments.length).toBeGreaterThan(0);
    expect(p.shots.length).toBe(p.script?.segments.length);
    expect(p.style?.id).toBeTruthy();
    expect(p.directorNotes.length).toBe(p.shots.length);

    // 素材 + 旁白 + 时间线
    for (const shot of p.shots) {
      expect(shot.asset?.path).toBeTruthy();
      expect(shot.voice?.durationMs).toBeGreaterThan(0);
      expect(['voiced', 'ready']).toContain(shot.state);
    }
    expect(p.timeline?.shots.length).toBe(p.shots.length);
    const total = p.timeline?.shots.reduce((a, s) => a + s.durationMs, 0) ?? 0;
    expect(total).toBeGreaterThan(1000);

    // 合成项目落盘
    const hfDir = path.join(store.projectDir(p.meta.id), 'remotion');
    const indexHtml = await fs.readFile(path.join(hfDir, 'index.html'), 'utf8');
    expect(indexHtml).toContain('data-composition-id="root"');
    expect(indexHtml).toContain('data-track-index="0"');
    expect(indexHtml).toContain('window.__captions');
    for (const shot of p.shots) {
      const f = path.join(hfDir, 'compositions', `Scene_${shot.id}.html`);
      await expect(fs.readFile(f, 'utf8')).resolves.toContain('data-scene-id');
    }
    // 动效库已复制
    await expect(
      fs.readFile(path.join(hfDir, 'motion', 'motion-lib.js'), 'utf8'),
    ).resolves.toContain('MV.enter');

    // 渲染阶段：MV_SKIP_RENDER=1 → 停在 render（合成项目就绪）；
    // 否则环境齐全 → done；环境缺失 → 优雅停在 render（V-RND-001 设计行为）
    if (process.env['MV_SKIP_RENDER'] === '1') {
      expect(p.stage).toBe('render');
      expect(types).toContain('stopped');
    } else {
      const renderer = new HyperFramesRenderer();
      const checks = await renderer.doctor();
      if (checks.every((c) => c.ok)) {
        expect(p.stage).toBe('done');
        expect(p.shots.every((s) => s.state === 'ready')).toBe(true);
      } else {
        expect(p.stage).toBe('render');
        expect(types).toContain('stopped');
      }
    }
  }, 120000);

  it('确认门：未确认时停在 storyboard', async () => {
    const { engine, store } = makeEngine();
    const project = await store.initProject({ topic: '测试确认门', genre: 'news-brief' });
    await engine.init(project.meta.id);
    const events = await engine.run({ autoConfirm: false });
    expect(events.map((e) => e.type)).toContain('confirm-required');
    expect(engine.getProject().stage).toBe('storyboard');
  }, 60000);

  it('断点续跑：二次 run 不重复已完成工作', async () => {
    const { engine, store } = makeEngine();
    const project = await store.initProject({ topic: '测试续跑', genre: 'tutorial-howto' });
    await engine.init(project.meta.id);
    await engine.run({ autoConfirm: true });
    const first = engine.getProject();
    const scenesBefore = first.shots.map((s) => s.asset?.path);
    await engine.destroy();

    const engine2 = createEngine(root, {
      store,
      registry: await freshRegistry(),
      llm: new RetryingLlmClient(new TemplateLlmClient()),
      tts: new SilentTtsClient(),
      bridge: new BuddyCloudBridge(),
      renderer: new HyperFramesRenderer(),
    });
    await engine2.init(project.meta.id);
    const events = await engine2.run({ autoConfirm: true });
    // 二次 run 直接续跑：不重新生成场景资产
    expect(engine2.getProject().shots.map((s) => s.asset?.path)).toEqual(scenesBefore);
    if (process.env['MV_SKIP_RENDER'] === '1') {
      expect(engine2.getProject().stage).toBe('render');
      expect(events.map((e) => e.type)).toContain('stopped');
    } else {
      const renderer = new HyperFramesRenderer();
      const checks = await renderer.doctor();
      if (checks.every((c) => c.ok)) {
        expect(events.map((e) => e.type)).toContain('done');
        expect(engine2.getProject().stage).toBe('done');
      } else {
        expect(engine2.getProject().stage).toBe('render');
        expect(events.map((e) => e.type)).toContain('stopped');
      }
    }
  }, 120000);
});

async function freshRegistry(): Promise<StyleRegistry> {
  const registry = new StyleRegistry(root);
  await registry.load();
  return registry;
}
