import { describe, it, expect } from 'vitest';
import { auditContinuity, parseEnergyCurve, energyAt, auditEnergyCurve, cameraVector } from '../src/domain/continuity.js';
import { planTransition } from '../src/domain/transitions.js';

describe('T1b 跨镜连续性（出入画矢量 + 转场节奏）', () => {
  it('反向机位接力被 V-CON-003 抓住', () => {
    const r = auditContinuity([
      { shotId: 's01', camera: 'pan', transition: '' },
      { shotId: 's02', camera: 'pan-left', transition: 'hard-cut' },
    ]);
    expect(r.items).toHaveLength(1); // 切点数 = 镜数 - 1
    expect(r.items[0]!.status).toBe('reverse');
    expect(r.warns.some((w) => w.startsWith('V-CON-003'))).toBe(true);
  });

  it('静止/漂移镜是方向重置，不参与反向判据', () => {
    const r = auditContinuity([
      { shotId: 's01', camera: 'pan', transition: '' },
      { shotId: 's02', camera: 'static', transition: 'hard-cut' },
      { shotId: 's03', camera: 'pan-left', transition: 'dissolve' },
    ]);
    expect(r.items.every((i) => i.status !== 'reverse')).toBe(true);
    expect(r.warns.some((w) => w.startsWith('V-CON-003'))).toBe(false);
  });

  it('同向/正交接力不告警', () => {
    const r = auditContinuity([
      { shotId: 's01', camera: 'dolly-in', transition: '' },
      { shotId: 's02', camera: 'push-in', transition: 'dissolve' },
    ]);
    expect(r.items[0]!.status).toBe('ok');
    expect(r.warns.some((w) => w.startsWith('V-CON-003'))).toBe(false);
  });

  it('X6：同款软转场 ≥3 连 → V-CON-004', () => {
    const r = auditContinuity([
      { shotId: 's01', camera: 'static', transition: '' },
      { shotId: 's02', camera: 'static', transition: 'dissolve' },
      { shotId: 's03', camera: 'static', transition: 'dissolve' },
      { shotId: 's04', camera: 'static', transition: 'dissolve' },
      { shotId: 's05', camera: 'static', transition: 'hard-cut' },
    ]);
    expect(r.softTransitionRuns.length).toBe(1);
    expect(r.softTransitionRuns[0]!.run).toBe(3);
    expect(r.warns.some((w) => w.startsWith('V-CON-004'))).toBe(true);
  });

  it('两连软转场不告警（语言上合法）', () => {
    const r = auditContinuity([
      { shotId: 's01', camera: 'static', transition: '' },
      { shotId: 's02', camera: 'static', transition: 'dissolve' },
      { shotId: 's03', camera: 'static', transition: 'dissolve' },
    ]);
    expect(r.softTransitionRuns.length).toBe(0);
  });
});

describe('T1c 能量曲线', () => {
  it('parseEnergyCurve：合法格式解析，非法返回 undefined', () => {
    expect(parseEnergyCurve('0.9,0.6,0.4,0.7')).toEqual([0.9, 0.6, 0.4, 0.7]);
    expect(parseEnergyCurve('0.9, abc')).toBeUndefined();
    expect(parseEnergyCurve(undefined)).toBeUndefined();
  });

  it('energyAt：按幕均分映射到镜', () => {
    const curve = [0.9, 0.3];
    expect(energyAt(4, 0, curve)).toBe(0.9); // 前半幕
    expect(energyAt(4, 3, curve)).toBe(0.3); // 后半幕
  });

  it('V-CON-002：语法能量均值偏离曲线 >0.25 告警', () => {
    const allLow = auditEnergyCurve(['b_roll', 'y4_story', 't1_3b1b', 'b_roll'], [0.9, 0.9]);
    expect(allLow.length).toBe(1);
    expect(allLow[0]!.startsWith('V-CON-002')).toBe(true);
    const balanced = auditEnergyCurve(['y5_kinetic_type', 'y2_collage'], [0.7, 0.6]);
    expect(balanced.length).toBe(0);
  });

  it('cameraVector：机位词→矢量，未知词 undefined', () => {
    expect(cameraVector('pan')).toEqual({ x: 1, y: 0, z: 0 });
    expect(cameraVector('drift')).toBeUndefined();
    expect(cameraVector('bogus')).toBeUndefined();
  });
});

describe('T3a oneshot 转场', () => {
  const WORDS = ['hard-cut', 'dissolve', 'smash-cut', 'wipe', 'whip-pan', 'slide'];
  it('oneshot/continuity 声明不受风格词表约束', () => {
    expect(planTransition('oneshot', WORDS).kind).toBe('continuity');
    expect(planTransition('continuity', WORDS).kind).toBe('continuity');
    expect(planTransition('continuity', WORDS).overlapMs).toBe(0);
  });
  it('其它词仍受词表把关（dissolve 在表内可用）', () => {
    expect(planTransition('dissolve', WORDS).kind).toBe('dissolve');
  });
});
