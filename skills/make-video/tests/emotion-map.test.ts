/**
 * P13 阶段3：情绪词典（偏好层 + 覆写）与对拍盲评样本。
 * - 有/无词典的同稿对拍：视觉倾向只在有词典时出现；
 * - 覆写口子：StyleDecision.overrides.emotionMap 整体替换同名条目；
 * - 统计层纪律：词典未命中不抛错（不拦单镜），audit 只记录覆盖率。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StylePackSchema } from '../src/core/schema.js';
import { resolveEmotionVisual } from '../src/domain/style-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pack = StylePackSchema.parse(
  JSON.parse(readFileSync(path.join(ROOT, 'styles', 'bright-paper.json'), 'utf8')),
);

describe('阶段3 · emotionMap 偏好层与覆写口子', () => {
  it('示例风格包有 ≥1 条 emotionMap，且通过 schema 解析', () => {
    expect(pack.visuals.emotionMap).toBeDefined();
    expect(Object.keys(pack.visuals.emotionMap ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it('同稿对拍：有词典命中视觉倾向，无词典（undefined style）返回 null', () => {
    const withDict = resolveEmotionVisual(pack, 'calm');
    const withoutDict = resolveEmotionVisual(undefined, 'calm');
    expect(withDict).toMatchObject({ temperature: 'neutral', light: 'soft', pace: 'slow' });
    expect(withoutDict).toBeNull();
  });

  it('词典未覆盖的情绪 / 未声明情绪返回 null（统计层只记不拦）', () => {
    expect(resolveEmotionVisual(pack, 'unlisted-emotion')).toBeNull();
    expect(resolveEmotionVisual(pack, undefined)).toBeNull();
  });

  it('覆写口子：overrides.emotionMap 同名条目整体替换偏好层', () => {
    const overridden = resolveEmotionVisual(pack, 'calm', {
      emotionMap: { calm: { temperature: 'warm', light: 'hard', pace: 'fast', note: '覆写演示' } },
    });
    expect(overridden).toMatchObject({ temperature: 'warm', light: 'hard', pace: 'fast', note: '覆写演示' });
    // 别的情绪不受覆写影响（只替换同名条目）
    expect(resolveEmotionVisual(pack, 'awe', {
      emotionMap: { calm: { temperature: 'warm' } },
    })).toMatchObject({ temperature: 'cool', light: 'high-key' });
  });

  it('缺省风格包（无 emotionMap）零回归：返回 null 不抛错', () => {
    const bare = StylePackSchema.parse(
      JSON.parse(readFileSync(path.join(ROOT, 'styles', 'cinematic-dark.json'), 'utf8')),
    );
    expect(bare.visuals.emotionMap).toBeUndefined();
    expect(resolveEmotionVisual(bare, 'calm')).toBeNull();
  });
});
