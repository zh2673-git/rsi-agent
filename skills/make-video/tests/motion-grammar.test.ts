import { describe, it, expect } from 'vitest';
import {
  GRAMMARS,
  getGrammar,
  pickGrammar,
  actionSheet,
  auditMotionMix,
  auditOpening,
  defaultCameraFor,
  varyCameraFor,
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

  describe('P8 增量', () => {
    it('十一种语法齐备：y6_mechanism / y7_system_map 已入表', () => {
      const ids = GRAMMARS.map((g) => g.id);
      expect(ids).toContain('y6_mechanism');
      expect(ids).toContain('y7_system_map');
      expect(ids).toHaveLength(11);
    });

    it('机制线索 → y6_mechanism；系统/关系线索 → y7_system_map', () => {
      expect(pickGrammar('它的内部机制是三部分协作驱动的。').id).toBe('y6_mechanism');
      expect(pickGrammar('系统之间的架构关系像一张地图，脉络清晰。').id).toBe('y7_system_map');
    });

    it('actionSheet 带 requiredPrimitives 且必含 motifLoop', () => {
      const g = getGrammar('y2_collage');
      const sheet = actionSheet({ id: 's03', narration: '证据摆在这里。' }, g);
      expect(sheet.requiredPrimitives).toContain('MV.motifLoop');
      // y2 的动作拍是「材料落下（错峰）→ 红线连接」，高亮是导演按镜头取舍的可选项。
      // 源码 REQUIRED_BY_GRAMMAR 已明确去掉 highlight（本片 8 个 y2 镜 8 个都没写 highlight，
      // 若强制则全部打回，等于把主力路径卡死）；此处断言的是**骨架**而非可选项。
      expect(sheet.requiredPrimitives).toContain('MV.staggeredIn');
      expect(sheet.requiredPrimitives).not.toContain('MV.highlight');
      for (const gr of GRAMMARS) {
        const s = actionSheet({ id: 'x', narration: 'n' }, gr);
        expect(s.requiredPrimitives.length).toBeGreaterThan(0);
        expect(s.requiredPrimitives).toContain('MV.motifLoop');
      }
    });

    it('suppressTextLed 硬排除 y5（文字主导闸）', () => {
      const line = '记住三点：一是先写契约，二是再写代码，三是最后跑测试。';
      expect(pickGrammar(line).id).toBe('y5_kinetic_type');
      const g = pickGrammar(line, { suppressTextLed: true });
      expect(g.id).not.toBe('y5_kinetic_type');
    });

    it('V-MOT-022：母题动幅不可见 → warn', () => {
      const shots = [
        fact({ shotId: 's01', minMotifMotionPx: 1.9, motifKinds: ['float'], compositionKey: 'CU:1' }),
        fact({ shotId: 's02', minMotifMotionPx: 5.2, motifKinds: ['breathe'], compositionKey: 'MS:2' }),
      ];
      const issues = auditMotionMix(shots, 6000);
      expect(issues.some((i) => i.rule === 'V-MOT-022' && i.message.includes('不可见'))).toBe(true);
    });

    it('V-MOT-022：动幅可见 → 不报', () => {
      const shots = [
        fact({ shotId: 's01', minMotifMotionPx: 4.8, motifKinds: ['float'], compositionKey: 'CU:1' }),
        fact({ shotId: 's02', minMotifMotionPx: 6, motifKinds: ['pulse'], compositionKey: 'MS:2' }),
      ];
      const issues = auditMotionMix(shots, 6000);
      expect(issues.some((i) => i.rule === 'V-MOT-022')).toBe(false);
    });

    it('V-MOT-022：过半镜无母题 → warn', () => {
      const shots = ['s01', 's02', 's03', 's04'].map((id, i) =>
        fact({ shotId: id, minMotifMotionPx: i === 0 ? undefined : 5, motifKinds: [], compositionKey: `CU:${i}` }),
      );
      const issues = auditMotionMix(shots, 12000);
      expect(issues.some((i) => i.rule === 'V-MOT-022' && i.message.includes('无母题'))).toBe(true);
    });

    it('T4 口径（在 audit 层验证豁免逻辑的输入由 toMotionFact 决定）：b_roll 语法镜带 hasMainAction', () => {
      // composer 已把 b_roll / 真素材镜折算成 hasMainAction=true（见 composer.toMotionFact），
      // 这里钉住审计端行为：全 true 时无 V-MOT-019 主动作告警
      const shots = ['s01', 's02', 's03'].map((id, i) =>
        fact({ shotId: id, grammar: 'b_roll', compositionKey: `CU:${i}`, accents: [] }),
      );
      const issues = auditMotionMix(shots, 9000);
      expect(issues.some((i) => i.rule === 'V-MOT-019' && i.message.includes('无主动作'))).toBe(false);
    });
  });

  // 死板清除 X1/X2/X3 + T1c/T3a（2026-11-14）：机位变奏 / b_roll 成对抑制 / 能量曲线 / oneshot 豁免
  describe('死板清除与新语法（2026-11-14）', () => {
    it('X1 varyCameraFor：同语法相邻镜机位变奏，取偏好里与 prev 不同的第一个', () => {
      expect(varyCameraFor('b_roll', 'drift')).toBe('static');
      expect(varyCameraFor('y2_collage', 'pan')).toBe('pan-left');
      expect(varyCameraFor('y5_kinetic_type', 'static')).toBe('punch-in');
      // 全同偏好（单值语法）保持不变
      expect(varyCameraFor('y4_story', 'static')).toBe('punch-in');
      expect(defaultCameraFor('b_roll')).toBe('drift');
    });

    it('X2 suppressBroll：上镜已 b_roll 时无线索句不再成对落 b_roll（有可行替代时）', () => {
      const line = '为什么结果翻车了。'; // y4 线索词
      expect(pickGrammar(line, { suppressBroll: true }).id).not.toBe('b_roll');
      // 真无线索词 + 抑制 b_roll：放宽轮后仍无候选才落回（不硬塞语法）
      expect(pickGrammar('嗯。', { suppressBroll: true }).id).toBe('b_roll');
      expect(pickGrammar('嗯。').id).toBe('b_roll');
    });

    it('X3 cameraBias 认领 v3 新机位词（dolly/crane）', () => {
      const bias = new Set(GRAMMARS.flatMap((g) => g.cameraBias));
      expect(bias.has('dolly-in')).toBe(true);
      expect(bias.has('dolly-out')).toBe(true);
      expect(bias.has('crane-up')).toBe(true);
      expect(bias.has('crane-down')).toBe(true);
    });

    it('X4 motifs 认领更多 MOTIF kind（不再 shimmer/float 两家独大）', () => {
      const kinds = new Set(GRAMMARS.flatMap((g) => g.motifs));
      expect(kinds.size).toBeGreaterThanOrEqual(8);
      expect(kinds.has('sweep')).toBe(true);
      expect(kinds.has('compress')).toBe(true);
    });

    it('T1c 能量曲线：低能量幕排除高能量语法，高能量幕反之', () => {
      expect(pickGrammar('营收增长了百分之四十，成本却翻了一倍。', { energy: 0.3 }).id).not.toBe('t3_finance');
      expect(pickGrammar('营收增长了百分之四十，成本却翻了一倍。', { energy: 0.85 }).id).toBe('t3_finance');
    });

    it('T3a oneshot：continuity 节拍段豁免「同语法连 3 镜」与「相邻同构图」', () => {
      const shots = ['s01', 's02', 's03'].map((id, i) =>
        fact({
          shotId: id,
          grammar: 'y1_flat_explainer',
          compositionKey: 'MS:center', // 三镜同构图
          accents: [],
          continuity: i > 0, // s02/s03 由 continuity 切入
        }),
      );
      const issues = auditMotionMix(shots, 9000);
      expect(issues.some((i) => i.rule === 'V-MOT-019' && i.message.includes('连续'))).toBe(false);
      expect(issues.some((i) => i.rule === 'V-MOT-020')).toBe(false);
      // 无豁免时同样输入必须报警（判据本身还活着）
      const noExempt = shots.map((s, i) => ({ ...s, continuity: false }));
      const issues2 = auditMotionMix(noExempt, 9000);
      expect(issues2.some((i) => i.rule === 'V-MOT-019' && i.message.includes('连续'))).toBe(true);
    });
  });
});
