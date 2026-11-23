import { describe, expect, it } from 'vitest';
import { validateScript } from '../src/domain/scriptwriter.js';

/**
 * 表达层解放回归（创作自由红线）：
 * 讲稿的结构/beat/钩子/信息节奏属于编剧导演的创作判断，引擎不得拒稿。
 * 这四条曾经分别被 V-SCP-003（beat 覆盖）、V-SCP-004（钩子前置）、
 * V-SCP-007（连续 inform）判 error/warn——好稿因「第一段不是钩子」被直接打回。
 */
describe('讲稿结构自由（表达层不设硬门）', () => {
  const makeScript = (segments: Array<Partial<{ id: string; text: string; function: string; beat: string }>>) =>
    ({
      fullText: segments.map((s) => s.text ?? '').join(''),
      segments: segments.map((s, i) => ({
        id: s.id ?? `seg-${i + 1}`,
        text: s.text ?? '一段具体的旁白。',
        function: s.function ?? 'advance',
        ...(s.beat ? { beat: s.beat } : {}),
      })),
    }) as never;

  it('第一段不是钩子、完全不填 beat：零 error', () => {
    // 先铺陈全景再逐层深入——一种完全合理但「钩子后置」的讲法
    const script = makeScript([
      { text: '先看清整条装配线的全貌。', function: 'inform' },
      { text: '取指单元每周期搬进四条指令。', function: 'inform' },
      { text: '译码阶段把指令拆成控制信号。', function: 'inform' },
    ]);
    expect(validateScript(script).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('连续多段 inform：不再判「信息倾倒」', () => {
    const script = makeScript([
      { text: '取指单元每周期搬进四条指令。', function: 'inform' },
      { text: '译码阶段把指令拆成控制信号。', function: 'inform' },
      { text: '执行单元在流水线上并行运算。', function: 'inform' },
      { text: '访存阶段把结果写回缓存。', function: 'inform' },
    ]);
    const issues = validateScript(script);
    expect(issues.some((i) => i.id === 'V-SCP-007')).toBe(false);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('自造结构、不覆盖任何 recipe beat：零 error', () => {
    const script = makeScript([
      { text: '用一个贯穿的比喻讲完整个机制。', function: 'emotion', beat: 'my-own-opening' },
      { text: '这个类比对应到真实结构是这样的。', function: 'inform', beat: 'my-own-body' },
      { text: '回到这个类比，收束。', function: 'emotion', beat: 'my-own-close' },
    ]);
    expect(validateScript(script).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('唯一保留的硬门：段落缺 function 仍要报错', () => {
    const script = makeScript([{ text: '这一段没有标功能。', function: '' }]);
    expect(validateScript(script).some((i) => i.id === 'V-SCP-001' && i.level === 'error')).toBe(true);
  });
});
