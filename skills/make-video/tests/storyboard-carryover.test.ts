import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { StoryboardLlmStub } from './_storyboard-stub.js';
import { storyboard } from '../src/domain/storyboard.js';
import { StyleRegistry } from '../src/domain/style-registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-carry-'));
  for (const dir of ['templates', 'styles', 'recipes']) {
    await fs.cp(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const SCRIPT = {
  fullText: '第一句旁白。第二句旁白。',
  segments: [
    { id: 'seg-1', text: '第一句旁白。', function: 'emotion' as const, beat: 'hook' },
    { id: 'seg-2', text: '第二句旁白。', function: 'emotion' as const, beat: 'summary' },
  ],
};

async function setup() {
  const store = new ProjectStore(root);
  const registry = new StyleRegistry(root);
  await registry.load();
  const project = await store.initProject({
    topic: '重跑分镜不丢配音',
    genre: 'science-explainer',
    durationTier: '0-5',
  });
  const loaded = await store.load(project.meta.id);
  loaded.script = SCRIPT;
  loaded.confirmed = true;
  loaded.directorNotes = [
    {
      segmentId: 'seg-1',
      visualIntent: '测试用批注',
      emotionGoal: 'neutral',
      referenceMood: '',
      counterpoint: 'metaphor',
    },
  ];
  await store.save(loaded);
  const recipe = registry.getRecipe('science-explainer');
  return { store, registry, project: loaded, recipe };
}

describe('重跑分镜的产物沿用（避免无谓重配音）', () => {
  it('旁白原文未变时沿用已有 voice/asset；原文变了才丢弃', async () => {
    const { store, registry, project, recipe } = await setup();

    // 第一轮：借 stub 生成分镜
    const shots = await storyboard(
      store,
      project,
      new StoryboardLlmStub(SCRIPT.segments.map((s) => s.text)),
      recipe,
      registry,
      { items: [] },
      'bright-paper',
    );
    expect(shots).toHaveLength(2);

    // 模拟已完成配音+素材
    shots[0].voice = {
      file: 'audio/vo/s01.wav',
      durationMs: 1200,
      voice: 'default',
      rate: 1,
      source: 'tts',
      estimated: false,
    };
    shots[0].asset = { kind: 'code-scene', path: 'scenes/Scene_s01.html', meta: { scene: 's01' } };
    shots[0].state = 'voiced';
    project.shots = shots;
    await store.save(project);

    // 第二轮：旁白原文完全一致 → s01 必须保留配音与素材
    const again = await storyboard(
      store,
      project,
      new StoryboardLlmStub(SCRIPT.segments.map((s) => s.text)),
      recipe,
      registry,
      { items: [] },
      'bright-paper',
    );
    expect(again[0].voice?.durationMs).toBe(1200);
    expect(again[0].asset?.path).toBe('scenes/Scene_s01.html');

    // 第三轮：s01 旁白改字 → 旧配音必须作废（否则声画不对应）
    const changed = {
      ...SCRIPT,
      fullText: '第一句旁白改过了。第二句旁白。',
      segments: [
        { id: 'seg-1', text: '第一句旁白改过了。', function: 'emotion' as const, beat: 'hook' },
        { id: 'seg-2', text: '第二句旁白。', function: 'emotion' as const, beat: 'summary' },
      ],
    };
    project.script = changed;
    await store.save(project);
    const third = await storyboard(
      store,
      project,
      new StoryboardLlmStub(changed.segments.map((s) => s.text)),
      recipe,
      registry,
      { items: [] },
      'bright-paper',
    );
    expect(third[0].voice).toBeUndefined();
    expect(third[1].voice).toBeUndefined();
  });
});
