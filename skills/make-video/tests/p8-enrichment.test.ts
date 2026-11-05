import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { StoryboardLlmStub } from './_storyboard-stub.js';
import { storyboard } from '../src/domain/storyboard.js';
import { StyleRegistry } from '../src/domain/style-registry.js';
import { pickGrammar, actionSheet } from '../src/domain/motion-grammar.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-p8-'));
  for (const dir of ['templates', 'styles', 'recipes']) {
    await fs.cp(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** 超长旁白（>36 字，两句）：触发 P8-T6 超长镜切分 */
const LONG_TEXT =
  '换一个模型要改七处，加一个工具要动主循环。插件只能看见内核允许它看见的那一部分。';
const SHORT_TEXT = '这不是重启，是换刀。';

const SCRIPT = {
  fullText: `${LONG_TEXT}${SHORT_TEXT}`,
  segments: [
    { id: 'seg-1', text: LONG_TEXT, function: 'inform' as const, beat: 'hook' },
    { id: 'seg-2', text: SHORT_TEXT, function: 'emotion' as const, beat: 'summary' },
  ],
};

function makeNotes() {
  return SCRIPT.segments.map((s) => ({
    segmentId: s.id,
    visualIntent: '测试用批注',
    emotionGoal: 'neutral',
    referenceMood: '',
    counterpoint: 'metaphor' as const,
  }));
}

describe('P8-T6 超长镜切分 + 语法前移', () => {
  it('>8s 旁白镜拆成两镜（a/b 后缀），后半镜景别更近；短镜不拆', async () => {
    const store = new ProjectStore(root);
    const registry = new StyleRegistry(root);
    await registry.load();
    const base = await store.initProject({
      topic: '超长镜切分',
      genre: 'science-explainer',
      durationTier: '0-5',
    });
    const project = await store.load(base.meta.id);
    project.script = SCRIPT;
    project.confirmed = true;
    project.directorNotes = makeNotes();
    await store.save(project);
    const recipe = registry.getRecipe('science-explainer');

    const shots = await storyboard(
      store,
      project,
      new StoryboardLlmStub(SCRIPT.segments.map((s) => s.text)),
      recipe,
      registry,
      { items: [] },
      'bright-paper',
    );
    // 长镜拆 a/b（2 镜）+ 短镜 1 镜 = 3 镜
    expect(shots).toHaveLength(3);
    const ids = shots.map((s) => s.id);
    expect(ids).toContain('s01a');
    expect(ids).toContain('s01b');
    // 拆开的旁白拼回原文（不丢字）
    const merged = shots
      .filter((s) => s.id.startsWith('s01'))
      .map((s) => s.narration)
      .join('');
    expect(merged).toBe(LONG_TEXT);
    // 后半镜景别比前半近（推近叙事）
    const a = shots.find((s) => s.id === 's01a')!;
    const b = shots.find((s) => s.id === 's01b')!;
    const ladder = ['ELS', 'LS', 'MLS', 'MS', 'MCU', 'CU', 'ECU'];
    expect(ladder.indexOf(b.zoom)).toBeGreaterThan(ladder.indexOf(a.zoom));
    // 短镜原样保留
    expect(shots[2].narration).toBe(SHORT_TEXT);
  });

  it('分镜期 actionSheet 已落成（语法前移）：每镜带 grammar 与 requiredPrimitives', async () => {
    const store = new ProjectStore(root);
    const registry = new StyleRegistry(root);
    await registry.load();
    const base = await store.initProject({
      topic: '语法前移',
      genre: 'science-explainer',
      durationTier: '0-5',
    });
    const project = await store.load(base.meta.id);
    project.script = {
      ...SCRIPT,
      fullText: `${SHORT_TEXT}它的内部机制是三部分协作驱动的。`,
      segments: [
        { id: 'seg-1', text: SHORT_TEXT, function: 'emotion' as const, beat: 'hook' },
        { id: 'seg-2', text: '它的内部机制是三部分协作驱动的。', function: 'inform' as const, beat: 'summary' },
      ],
    };
    project.confirmed = true;
    project.directorNotes = makeNotes();
    await store.save(project);
    const recipe = registry.getRecipe('science-explainer');

    const shots = await storyboard(
      store,
      project,
      new StoryboardLlmStub(project.script.segments.map((s) => s.text)),
      recipe,
      registry,
      { items: [] },
      'bright-paper',
    );
    for (const shot of shots) {
      const sheet = shot.visual.params['actionSheet'] as { grammar?: string; requiredPrimitives?: string[] };
      expect(sheet?.grammar).toBeTruthy();
      expect(sheet?.requiredPrimitives).toContain('MV.motifLoop');
    }
    // 机制镜的语法是 y6（选型与模板解耦：模板走语义 cues，语法走 pickGrammar）
    const mech = shots.find((s) => s.narration.includes('内部机制'))!;
    expect((mech.visual.params['actionSheet'] as { grammar: string }).grammar).toBe('y6_mechanism');
  });

  it('pickGrammar 纯函数回归：同一输入永远同一语法（前移后的稳定性契约）', () => {
    const line = '系统之间的架构关系像一张地图。';
    const ctx = { recent: [] as never[], singleNumber: false, hasRealMaterial: false };
    expect(pickGrammar(line, ctx).id).toBe(pickGrammar(line, ctx).id);
  });

  it('worker 空闲超时参数解析（复刻 _idle_seconds 逻辑的常量契约）', () => {
    // worker 用 MV_QWEN3_IDLE_EXIT 秒（默认 300）；这里钉住「0/负数/非法值回退默认」的约定
    const parse = (v: string | undefined): number => {
      try {
        const n = Number(v ?? '300');
        return n > 0 ? n : 300;
      } catch {
        return 300;
      }
    };
    expect(parse(undefined)).toBe(300);
    expect(parse('60')).toBe(60);
    expect(parse('0')).toBe(300);
    expect(parse('-5')).toBe(300);
    expect(parse('abc')).toBe(300);
  });

  it('compare-stage/process-track/hierarchy-stack 的 cue 能命中语义选择', async () => {
    const { TEMPLATE_CUES, bestTemplate } = await import('../src/domain/scene-semantics.js');
    const all = TEMPLATE_CUES.map((c) => c.template);
    expect(bestTemplate('和以前相比现在快了三倍', all)?.template).toBe('compare-stage');
    expect(bestTemplate('首先接着随后最终四步流程', all)?.template).toBe('process-track');
    expect(bestTemplate('它分三层，架构从下到上', all)?.template).toBe('hierarchy-stack');
  });

  it('actionSheet 工厂不依赖镜头形态（纯函数）', () => {
    const g = pickGrammar('它内部由三个模块组成，逐个拆开看。');
    const s1 = actionSheet({ id: 'a', narration: '它内部由三个模块组成，逐个拆开看。' }, g);
    const s2 = actionSheet({ id: 'a', narration: '它内部由三个模块组成，逐个拆开看。' }, g);
    expect(s1).toEqual(s2);
    expect(s1.grammar).toBe('y6_mechanism');
  });
});
