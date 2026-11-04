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
import { TemplateLlmClient, RetryingLlmClient } from '../src/infrastructure/llm-client.js';
import { createEngine } from '../src/application/pipeline.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env['MV_SKIP_RENDER'] = '1';

let root = '';
let store: ProjectStore;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-ste-'));
  for (const dir of ['templates', 'styles', 'recipes']) {
    await fs.cp(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  store = new ProjectStore(root);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeEngine() {
  return createEngine(root, {
    store,
    registry: new StyleRegistry(root),
    llm: new RetryingLlmClient(new TemplateLlmClient()),
    tts: new SilentTtsClient(),
    bridge: new BuddyCloudBridge(),
    renderer: new HyperFramesRenderer(),
  });
}

describe('V-STE-002/004/005 工程纪律', () => {
  it('V-STE-002+run.log：run 过程中事件 append-only 落 logs/run.log（JSONL 带 ts）', async () => {
    const engine = makeEngine();
    const project = await store.initProject({ topic: '事件日志验收', genre: 'science-explainer', durationTier: '0-5' });
    await engine.init(project.meta.id);
    await engine.run({ autoConfirm: true });
    const log = await fs.readFile(
      path.join(store.projectDir(project.meta.id), 'logs', 'run.log'),
      'utf8',
    );
    const lines = log.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!) as { ts: string; type: string };
    expect(first.ts).toBeTruthy();
    expect(first.type).toBe('stage-advanced');
    expect(log).toContain('confirm-required');
    expect(log).toContain('shot-advanced');
  }, 120000);

  it('V-STE-005：clean 只回收中间产物目录，out/ 与 project.json（成片/IR）不回收', async () => {
    const project = await store.initProject({ topic: '清理验收', genre: 'science-explainer', durationTier: '0-5' });
    const dir = store.projectDir(project.meta.id);
    await fs.writeFile(path.join(dir, 'out', 'final.mp4'), 'x');
    const { freed } = await store.clean(project.meta.id);
    expect(freed).toContain('cache');
    expect(await fs.readFile(path.join(dir, 'out', 'final.mp4'), 'utf8')).toBe('x');
    await expect(fs.readFile(store.projectFile(project.meta.id), 'utf8')).resolves.toContain('清理验收');
  });

  it('V-STE-005：destroy 逆序（停调度→释放副本），释放后可重新 init 同一项目续跑', async () => {
    const engine = makeEngine();
    const project = await store.initProject({ topic: '销毁逆序验收', genre: 'science-explainer', durationTier: '0-5' });
    await engine.init(project.meta.id);
    await engine.run({ autoConfirm: true });
    const before = engine.getProject().shots.map((s) => s.asset?.path);
    await engine.destroy();
    expect(() => engine.getProject()).toThrow();
    // 成片/IR 未回收 → 新引擎加载同一 IR 续跑且不重做产物（V-STE-003 幂等）
    const engine2 = makeEngine();
    await engine2.init(project.meta.id);
    await engine2.run({ autoConfirm: true });
    expect(engine2.getProject().shots.map((s) => s.asset?.path)).toEqual(before);
  }, 120000);
});
