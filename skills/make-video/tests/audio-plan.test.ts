import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioPlanSchema, ProjectSchema, StylePackSchema } from '../src/core/schema.js';
import { buildConfirmation } from '../src/domain/storyboard.js';
import { buildScriptSystemPrompt } from '../src/infrastructure/llm-client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('audioPlan：配乐/音效差异化方案的 IR 契约', () => {
  it('提供可用默认值，且亮度限制在 0..1', () => {
    const plan = AudioPlanSchema.parse({});
    expect(plan.mood).toBe('warm-curious');
    expect(plan.progression).toBe('warm-jazzy');
    expect(plan.brightness).toBe(0.5);
    expect(() => AudioPlanSchema.parse({ brightness: 2 })).toThrow();
  });

  it('vibe-cosmos 风格包带结构化 audio 字段', async () => {
    const raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'styles', 'vibe-cosmos.json'), 'utf8'));
    const pack = StylePackSchema.parse(raw);
    expect(pack.audio?.sfxPalette).toBe('glassy');
    expect(pack.audio?.bpm).toBe(84);
  });

  it('确认表展示 audioPlan，缺失时给出警告', () => {
    const base = ProjectSchema.parse({
      meta: { id: 'p', title: 'T', topic: 'X' },
    });
    expect(buildConfirmation(base)).toContain('尚未写 project.audioPlan');

    const withPlan = ProjectSchema.parse({
      meta: { id: 'p', title: 'T', topic: 'X' },
      audioPlan: {
        rationale: '三角函数从旋转到波形：冷色稀疏底床配金线重音',
        mood: 'warm-curious',
        bpm: 84,
        progression: 'mysterious',
        texture: 'bell-air',
        brightness: 0.7,
        sfxPalette: 'glassy',
      },
    });
    const text = buildConfirmation(withPlan);
    expect(text).toContain('【配乐/音效方案】');
    expect(text).toContain('mysterious');
    expect(text).toContain('glassy');
    expect(text).toContain('三角函数从旋转到波形');
  });

  it('确认表每次都展示本片实际编剧结构，不提任何预设结构模板词', () => {
    const base = ProjectSchema.parse({ meta: { id: 'p', title: 'T', topic: 'X' } });
    const noScript = buildConfirmation(base);
    expect(noScript).toContain('【编剧结构方案（按本片主题独创）】');
    expect(noScript).not.toMatch(/钩子|beats?/i);

    const withScript = ProjectSchema.parse({
      meta: { id: 'p', title: 'T', topic: 'X' },
      script: {
        fullText: '甲先铺陈全景。乙逐层深入。丙收束回扣。',
        segments: [
          { id: 's1', text: '甲先铺陈全景。', function: 'inform' },
          { id: 's2', text: '乙逐层深入。', function: 'advance' },
          { id: 's3', text: '丙收束回扣。', function: 'emotion' },
        ],
      },
    });
    const text = buildConfirmation(withScript);
    expect(text).toContain('s1 [inform] 甲先铺陈全景');
    expect(text).toContain('以上为本片实际结构');
    expect(text).not.toMatch(/钩子|beats?/i);
  });

  it('编剧系统提示词不含 beats/钩子/格子等任何预设结构锚点', () => {
    const prompt = buildScriptSystemPrompt();
    expect(prompt).toMatch(/结构纪律/);
    expect(prompt).not.toMatch(/钩子|beats?|格子|节拍表/i);
    expect(prompt).toContain('没有预设结构');
  });
});
