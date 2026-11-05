import { describe, it, expect } from 'vitest';
import {
  GRAMMARS,
  getGrammar,
  pickGrammar,
  actionSheet,
  auditMotionMix,
  auditOpening,
  type MotionShotFact,
} from '../src/domain/motion-grammar.js';

function fact(over: Partial<MotionShotFact> = {}): MotionShotFact {
  return {
    shotId: 's01',
    durationMs: 3000,
    camera: 'static',
    textLed: false,
    accents: [],
    hasMainAction: true,
    compositionKey: 'MS:center',
    ...over,
  };
}

describe('动效语法层（P7 吸收阿杜 + 花叔）', () => {
  it('九种语法齐备，每种都有 when/avoid/motionBeats/cameraBias', () => {
    const ids = GRAMMARS.map((g) => g.id);
    expect(ids).toContain('y5_kinetic_type');
    expect(ids).toContain('t3_finance');
    expect(ids).toContain('b_roll');
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GRAMMARS) {
      expect(g.when.length).toBeGreaterThan(4);
      expect(g.avoid.length).toBeGreaterThan(4);
      expect(g.motionBeats.length).toBeGreaterThanOrEqual(3);
      expect(g.cameraBias.length).toBeGreaterThan(0);
      expect(g.textShare).toBeGreaterThan(0);
    }
  });

  it('pickGrammar 是纯函数：同一输入永远同一语法', () => {
    const line = '增长了三倍，份额从百分之十二走到百分之三十一。';
    expect(pickGrammar(line).id).toBe(pickGrammar(line).id);
  });

  it('有数字与增长线索 → 财经图表语法（t3）', () => {
    const g = pickGrammar('营收增长了百分之四十，成本却翻了一倍。');
    expect(g.id).toBe('t3_finance');
  });

  it('只有清单/阶段线索 → 动态文字语法（y5）', () => {
    const g = pickGrammar('记住三点：一是先写契约，二是再写代码，三是最后跑测试。');
    expect(g.id).toBe('y5_kinetic_type');
  });

  it('第一人称经历 → 故事语法（y4）', () => {
    const g = pickGrammar('我那次翻车了，结果完全没想到。');
    expect(g.id).toBe('y4_story');
  });

  it('兜底一：有真实素材时优先能给材料位置的语法（t2/y2）', () => {
    const g = pickGrammar('这里是一段没有任何线索词的话。', { hasRealMaterial: true });
    expect(['t2_keynote', 'y2_collage']).toContain(g.id);
  });

  it('兜底二：一段里只有一个数时不画图表（t3 被降权）', () => {
    const line = '增长了百分之四十。';
    expect(pickGrammar(line, { singleNumber: true }).id).not.toBe('t3_finance');
  });

  it('连用惩罚：有可行替代时会换画法，不会被前两镜锁死', () => {
    // 第一镜是清单式（y5），第二镜有对比线索（y2 可接），不该被前两镜锁死成 y5
    const first = pickGrammar('记住三点：一是先写契约，二是再写代码，三是最后跑测试。');
    expect(first.id).toBe('y5_kinetic_type');
    const second = pickGrammar('而相比之下，以前是一天，现在是一小时。', { recent: [first.id] });
    expect(second.id).not.toBe('y5_kinetic_type');
  });

  it('无任何线索 → b_roll 兜底（不硬塞语法）', () => {
    expect(pickGrammar('嗯。').id).toBe('b_roll');
  });

  it('actionSheet 产出阿杜八字段，且准备动作不是套话', () => {
    const g = getGrammar('y5_kinetic_type');
    const sheet = actionSheet({ id: 's01', narration: '记住三点。' }, g);
    expect(sheet.grammar).toBe('y5_kinetic_type');
    expect(sheet.line).toBe('记住三点。');
    expect(sheet.prepare).toContain('蓄势');
    expect(sheet.main.length).toBeGreaterThan(0);
    expect(sheet.settle.length).toBeGreaterThan(0);
    expect(sheet.secondary).toContain('70%');
    expect(sheet.motif.length).toBeGreaterThan(0);
  });

  it('actionSheet 尊重导演声明的运镜（不被语法偏好覆盖）', () => {
    const g = getGrammar('y1_flat_explainer');
    const sheet = actionSheet({ id: 's02', narration: '尺度', camera: 'pull-out' }, g);
    expect(sheet.cameraPath).toBe('pull-out');
  });

  describe('混剪审计 V-MOT-013~020', () => {
    it('全片重音超 1/3 → V-MOT-013 error', () => {
      const shots = [
        fact({ shotId: 's01', accents: ['MV.slam'], compositionKey: 'CU:left' }),
        fact({ shotId: 's02', accents: ['MV.punch'], compositionKey: 'MS:right' }),
        fact({ shotId: 's03', accents: ['MV.whip'], compositionKey: 'LS:center' }),
        fact({ shotId: 's04', compositionKey: 'CU:top' }),
      ];
      const issues = auditMotionMix(shots, 12000);
      expect(issues.some((i) => i.rule === 'V-MOT-013' && i.level === 'error')).toBe(true);
    });

    it('重音不超预算时不报 V-MOT-013', () => {
      const shots = [
        fact({ shotId: 's01', accents: ['MV.slam'], compositionKey: 'CU:left' }),
        fact({ shotId: 's02', compositionKey: 'MS:right' }),
        fact({ shotId: 's03', compositionKey: 'LS:center' }),
        fact({ shotId: 's04', compositionKey: 'CU:top' }),
        fact({ shotId: 's05', compositionKey: 'MS:left' }),
        fact({ shotId: 's06', compositionKey: 'LS:right' }),
      ];
      const issues = auditMotionMix(shots, 18000);
      expect(issues.some((i) => i.rule === 'V-MOT-013')).toBe(false);
    });

    it('连三镜往里推 → V-MOT-014 error', () => {
      const shots = [
        fact({ shotId: 's01', camera: 'push-in', compositionKey: 'CU:left' }),
        fact({ shotId: 's02', camera: 'push-in', compositionKey: 'MS:right' }),
        fact({ shotId: 's03', camera: 'punch-in', compositionKey: 'LS:center' }),
      ];
      const issues = auditMotionMix(shots, 9000);
      expect(issues.some((i) => i.rule === 'V-MOT-014' && i.level === 'error')).toBe(true);
    });

    it('推进去了会拉出来 → 不报 V-MOT-014', () => {
      const shots = [
        fact({ shotId: 's01', camera: 'push-in', compositionKey: 'CU:left' }),
        fact({ shotId: 's02', camera: 'push-in', compositionKey: 'MS:right' }),
        fact({ shotId: 's03', camera: 'pull-out', compositionKey: 'LS:center' }),
        fact({ shotId: 's04', camera: 'pan', compositionKey: 'CU:top' }),
      ];
      const issues = auditMotionMix(shots, 12000);
      expect(issues.some((i) => i.rule === 'V-MOT-014')).toBe(false);
    });

    it('文字主导镜超 30% → V-MOT-016 warn', () => {
      const shots = [
        fact({ shotId: 's01', textLed: true, compositionKey: 'CU:1' }),
        fact({ shotId: 's02', textLed: true, compositionKey: 'CU:2' }),
        fact({ shotId: 's03', compositionKey: 'CU:3' }),
      ];
      const issues = auditMotionMix(shots, 9000);
      expect(issues.some((i) => i.rule === 'V-MOT-016')).toBe(true);
    });

    it('无主动作的镜 → V-MOT-019 warn（只有标题和卡片不算动画讲解）', () => {
      const shots = [
        fact({ shotId: 's01', hasMainAction: false, compositionKey: 'CU:1' }),
        fact({ shotId: 's02', compositionKey: 'MS:2' }),
      ];
      const issues = auditMotionMix(shots, 6000);
      expect(issues.some((i) => i.rule === 'V-MOT-019')).toBe(true);
    });

    it('同语法连三镜 → V-MOT-019 warn', () => {
      const shots = ['s01', 's02', 's03'].map((id, i) =>
        fact({ shotId: id, grammar: 'y5_kinetic_type', compositionKey: `CU:${i}` }),
      );
      const issues = auditMotionMix(shots, 9000);
      expect(issues.some((i) => i.rule === 'V-MOT-019')).toBe(true);
    });

    it('相邻镜构图全同 → V-MOT-020 warn（换构图不换画风）', () => {
      const shots = ['s01', 's02', 's03', 's04'].map((id) =>
        fact({ shotId: id, compositionKey: 'MS:center' }),
      );
      const issues = auditMotionMix(shots, 12000);
      expect(issues.some((i) => i.rule === 'V-MOT-020')).toBe(true);
    });

    it('构图有变化 → 不报 V-MOT-020', () => {
      const shots = ['CU:a', 'MS:b', 'LS:c', 'CU:d'].map((k, i) =>
        fact({ shotId: `s0${i + 1}`, compositionKey: k }),
      );
      const issues = auditMotionMix(shots, 12000);
      expect(issues.some((i) => i.rule === 'V-MOT-020')).toBe(false);
    });

    it('开头是标题卡 → V-MOT-018 warn', () => {
      const issues = auditOpening([fact({ shotId: 's01', textLed: true })]);
      expect(issues.some((i) => i.rule === 'V-MOT-018')).toBe(true);
    });

    it('开头是具体小场景 → 不报 V-MOT-018', () => {
      const issues = auditOpening([fact({ shotId: 's01' })]);
      expect(issues).toHaveLength(0);
    });
  });
});
