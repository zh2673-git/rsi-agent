// P13 阶段4：静止镜占比可覆写（消融对拍）
// 同一条 timeline：默认 0.6 报警（>60% 静止），放宽到 0.9 不报警。
// 证明「默认+可覆写」契约成立——规则笼子不新增 V-* 编号，只把阈值下沉。
import { describe, expect, it } from 'vitest';
import { validateIntraShotMotion } from '../src/core/validators/composer.js';
import type { Timeline } from '../src/core/schema.js';

function makeTimeline(staticCount: number, moveCount: number): Timeline {
  const shots = [
    ...Array.from({ length: staticCount }, (_, i) => ({
      shotId: `S${i}`,
      index: i,
      startMs: i * 3000,
      durationMs: 3000,
      narration: '',
      intent: null,
      visual: { kind: 'code' as const, prompt: '', params: {} },
      camera: 'static',
      motion: [],
    })),
    ...Array.from({ length: moveCount }, (_, i) => ({
      shotId: `M${i}`,
      index: staticCount + i,
      startMs: (staticCount + i) * 3000,
      durationMs: 3000,
      narration: '动',
      intent: null,
      visual: { kind: 'code' as const, prompt: '', params: {} },
      camera: i % 2 === 0 ? 'drift' : 'push-in',
      motion: [{ track: 'camera', name: 'drift' }],
    })),
  ];
  return {
    version: 1,
    shots,
    totalDurationMs: shots.length * 3000,
  } as unknown as Timeline;
}

describe('V-RHY-010 maxStaticRatio 消融对拍', () => {
  // 7 静止 + 3 运动 = 70% 静止
  const tl = makeTimeline(7, 3);

  it('默认 0.6：70% 静止应报警', () => {
    const issues = validateIntraShotMotion(tl);
    expect(issues.some((i) => i.id === 'V-RHY-010')).toBe(true);
  });

  it('recipe 覆写 0.9：70% 静止不报警', () => {
    const issues = validateIntraShotMotion(tl, { maxStaticRatio: 0.9 });
    expect(issues.some((i) => i.id === 'V-RHY-010')).toBe(false);
  });

  it('文案反映实际阈值', () => {
    const defaultIssue = validateIntraShotMotion(tl).find((i) => i.id === 'V-RHY-010');
    const overrideIssue = validateIntraShotMotion(tl, { maxStaticRatio: 0.9 }).find((i) => i.id === 'V-RHY-010');
    expect(defaultIssue?.message).toContain('60%');
    expect(overrideIssue).toBeUndefined();
  });
});
