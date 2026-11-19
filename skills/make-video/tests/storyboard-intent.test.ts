import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { StoryboardLlmStub } from './_storyboard-stub.js';
import { storyboard, deriveIntent } from '../src/domain/storyboard.js';
import { StyleRegistry } from '../src/domain/style-registry.js';
import { CAMERA_INTENTS } from '../src/core/schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-intent-'));
  for (const dir of ['templates', 'styles', 'recipes']) {
    await fs.cp(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * P13 阶段1 · A5 生产方的回归。
 *
 * A5 先把 intent/staging 的消费方全接通（motion-audit 的 intentCoverage、cut-audit、
 * V-CON-006、rigSummary），但全链路没人写这两个字段——intentCoverage 恒为 0，
 * 「覆盖率 100%」这个验收项永远不可能达成。这组测试就是那个空白的第一道闸：
 * 分镜跑完，每一镜都必须有机位动机，且调度表的相机轨与 shot.intent 一致。
 */
describe('A5：分镜必须产出机位动机与调度表', () => {
  const SEGMENTS = [
    { id: 'seg-1', text: '先说结论：引力不是力。', function: 'inform' as const, beat: 'hook' },
    { id: 'seg-2', text: '我那次真的翻车了。', function: 'emotion' as const, beat: 'turn' },
    { id: 'seg-3', text: '它其实是一张被拉弯的床单。', function: 'inform' as const, beat: 'point' },
    { id: 'seg-4', text: '记住这一句就够了。', function: 'inform' as const, beat: 'summary' },
  ];

  async function run() {
    const store = new ProjectStore(root);
    const registry = new StyleRegistry(root);
    await registry.load();
    const project = await store.initProject({
      topic: '机位动机生产',
      genre: 'science-explainer',
      durationTier: '0-5',
    });
    const loaded = await store.load(project.meta.id);
    loaded.script = { fullText: SEGMENTS.map((s) => s.text).join(''), segments: SEGMENTS };
    loaded.confirmed = true;
    loaded.directorNotes = SEGMENTS.map((s) => ({
      segmentId: s.id,
      visualIntent: '测试批注',
      emotionGoal: 'neutral',
      referenceMood: '',
      counterpoint: 'metaphor' as const,
    }));
    await store.save(loaded);
    const recipe = registry.getRecipe('science-explainer');
    const shots = await storyboard(
      store,
      loaded,
      new StoryboardLlmStub(SEGMENTS.map((s) => s.text)),
      recipe,
      registry,
      { items: [] },
      'bright-paper',
    );
    return shots;
  }

  it('每一镜都有合法 intent，且 staging.camera.intent 与之一致', async () => {
    const shots = await run();
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) {
      expect(CAMERA_INTENTS).toContain(s.intent as never);
      expect(s.staging?.camera.intent).toBe(s.intent);
      // 五轨只有机位轨必填；其余轨要么有内容要么不出现（缺省 = 未单独调度）
      expect(s.staging?.camera.what.length).toBeGreaterThan(0);
      expect(s.staging?.camera.why.length).toBeGreaterThan(0);
    }
    // 「覆盖率 100%」不再恒为 0
    expect(shots.filter((s) => s.intent).length).toBe(shots.length);
  });

  it('motion 轨与机位事实自洽：static 不能声称 move', async () => {
    const shots = await run();
    for (const s of shots) {
      const still = s.camera === 'static' || s.camera === 'none';
      expect(s.staging?.camera.motion).toBe(still ? 'still' : 'move');
      if (still) expect(s.intent).toBe('hold');
    }
  });

  it('首镜动机是 setup（交代这是哪儿），与它选了什么语法无关', async () => {
    const shots = await run();
    expect(shots[0]!.intent).toBe('setup');
  });
});

describe('deriveIntent 映射表（对齐 GRAMMARS 的 when/动作谱）', () => {
  it('揭示型语法 → reveal', () => {
    for (const g of ['y1_flat_explainer', 'y6_mechanism', 'y7_system_map', 't1_3b1b']) {
      expect(deriveIntent(g, 3, 'push-in')).toBe('reveal');
    }
  });
  it('跟读型语法 → follow', () => {
    for (const g of ['y2_collage', 'y3_whiteboard', 't3_finance']) {
      expect(deriveIntent(g, 3, 'pan')).toBe('follow');
    }
  });
  it('情绪/文字/兜底各自归位', () => {
    expect(deriveIntent('y4_story', 3, 'static')).toBe('hold');
    expect(deriveIntent('y4_story', 3, 'punch-in')).toBe('emotion');
    expect(deriveIntent('y5_kinetic_type', 3, 'punch-in')).toBe('setup');
    expect(deriveIntent('t2_keynote', 3, 'push-in')).toBe('setup');
    expect(deriveIntent('b_roll', 3, 'drift')).toBe('hold');
  });
  it('机位事实优先于语法：静止镜一律 hold', () => {
    expect(deriveIntent('y1_flat_explainer', 3, 'static')).toBe('hold');
    expect(deriveIntent('t3_finance', 3, 'none')).toBe('hold');
  });
  it('语法缺失（旧项目/手写 IR）→ 按机位事实兜底', () => {
    expect(deriveIntent(undefined, 3, 'push-in')).toBe('follow');
    expect(deriveIntent(undefined, 3, 'static')).toBe('hold');
  });
  it('首镜一律 setup', () => {
    expect(deriveIntent('b_roll', 0, 'drift')).toBe('setup');
    expect(deriveIntent('y4_story', 0, 'static')).toBe('setup');
  });
});
