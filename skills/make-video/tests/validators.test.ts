import { describe, expect, it } from 'vitest';
import { V } from '../src/core/index.js';
import { MOTION_WHITELIST } from '../src/core/validators/scene.js';
import { parseScript, validateCharBudget } from '../src/domain/scriptwriter.js';
import type { Project } from '../src/core/schema.js';

describe('V-STYLE-003 组合确认门', () => {
  const decision = {
    id: 'noir-contrast',
    source: 'agent-chosen' as const,
    rationale: '自由组合：base + noir effects',
    lineage: { base: 'keynote-minimal' },
    overrides: {},
  };
  const gate = (style: unknown, confirmed: boolean) =>
    V.validateStyleGate({ style, confirmed } as unknown as Project);

  it('agent 自由组合未确认 → error', () => {
    expect(V.hasError(gate(decision, false))).toBe(true);
  });
  it('用户显式确认后放行', () => {
    expect(V.hasError(gate(decision, true))).toBe(false);
  });
  it('user-specified 组合不需要二次确认；recipe 预绑不触发', () => {
    expect(V.hasError(gate({ ...decision, source: 'user-specified' }, false))).toBe(false);
    expect(
      V.hasError(gate({ ...decision, source: 'recipe-recommended', lineage: {} }, false)),
    ).toBe(false);
  });
});

describe('场景校验器', () => {
  // 合法场景夹具必须含母题循环（V-MOT-021）：入场动作之外还要有持续运动，
  // 否则镜头后半段是死画面。夹具跟随不变量一起演进。
  const goodScene = `<body data-scene-id="s01"><div class="subject">hi</div>
<script>MV.enter('.subject', {duration: 600});
MV.motifLoop('.subject', {kind: 'pulse', amp: 0.6});</script></body>`;

  it('合法场景通过', () => {
    const issues = V.validateSceneFile(goodScene, { narration: '这是一段旁白。' });
    expect(V.hasError(issues)).toBe(false);
  });

  it('禁时间轴属性', () => {
    const bad = goodScene.replace('data-scene-id="s01"', 'data-scene-id="s01" data-start="0"');
    expect(V.hasError(V.validateSceneFile(bad, { narration: '旁白' }))).toBe(true);
  });

  it('禁非白名单原语', () => {
    const bad = goodScene.replace("MV.enter('.subject'", "MV.fly('.subject'");
    const issues = V.validateSceneFile(bad, { narration: '旁白' });
    expect(issues.some((i) => i.id === 'V-SCENE-003')).toBe(true);
  });

  it('对位铁律：画面复述旁白原文被拦', () => {
    const bad = goodScene.replace('hi', '黑洞的形成');
    const issues = V.validateSceneFile(bad, { narration: '今天讲讲黑洞的形成。' });
    expect(issues.some((i) => i.id === 'V-SCENE-005')).toBe(true);
  });

  it('对位铁律：仅两字巧合不误报', () => {
    const ok = goodScene.replace('hi', '黑洞');
    const issues = V.validateSceneFile(ok, { narration: '今天讲讲黑洞的形成。' });
    expect(issues.some((i) => i.id === 'V-SCENE-005')).toBe(false);
  });

  /**
   * A3（P13 阶段1）英文豁免通道。审计发现 exemptTerms 只作用于中文挖词——
   * 英文分支独立走 split，从不查豁免表。于是旁白里的 API/GPU/LLM（≥4 字符）
   * 只要画面显示就被判「复述旁白」，而编剧在 segment.emphasis 里声明豁免完全无效。
   */
  it('英文术语命中视作复述（基线：未豁免时确实报错）', () => {
    const bad = goodScene.replace('hi', 'Kubernetes GPU');
    const issues = V.validateSceneFile(bad, { narration: '这套 Kubernetes GPU 调度很关键。' });
    expect(issues.some((i) => i.id === 'V-SCENE-005')).toBe(true);
  });

  it('英文术语声明豁免后不再报错（A3 英文豁免通道）', () => {
    const ok = goodScene.replace('hi', 'Kubernetes GPU');
    const issues = V.validateSceneFile(ok, {
      narration: '这套 Kubernetes GPU 调度很关键。',
      exemptTerms: ['Kubernetes', 'GPU'],
    });
    expect(issues.filter((i) => i.id === 'V-SCENE-005')).toEqual([]);
  });

  it('英文豁免大小写不敏感，且只豁免该词本身（A3 边界）', () => {
    // 大小写不同也应豁免（旁白写 gpu、画面写 GPU）
    const ok = goodScene.replace('hi', 'GPU');
    const issues = V.validateSceneFile(ok, {
      narration: '调度 gpu 资源。',
      exemptTerms: ['GPU'],
    });
    expect(issues.filter((i) => i.id === 'V-SCENE-005')).toEqual([]);
    // 未豁免的相邻英文词照查：豁免 GPU 不影响 Kubernetes
    const still = goodScene.replace('hi', 'Kubernetes');
    const issues2 = V.validateSceneFile(still, {
      narration: '这套 Kubernetes GPU 调度很关键。',
      exemptTerms: ['GPU'],
    });
    expect(issues2.some((i) => i.id === 'V-SCENE-005')).toBe(true);
  });

  /**
   * A3 长度门槛裁决（P13 阶段1）：旧代码英文分支 `word.length < 4 → continue`，
   * 3 字符的 GPU/API/SDK 根本走不到判断，也走不到豁免表——
   * 于是上面那条「GPU 豁免生效」的断言其实是空转（两边都不报，测不出东西）。
   * 这条钉住真实行为：**未豁免的 3 字符词必须被查出来**。
   */
  it('未豁免的 3 字符英文词也要被判复述（A3 门槛放宽后不再空转）', () => {
    const bad = goodScene.replace('hi', 'GPU');
    const issues = V.validateSceneFile(bad, { narration: '调度 GPU 资源。' });
    expect(issues.some((i) => i.id === 'V-SCENE-005')).toBe(true);
  });

  it('中文 3 字重音词声明豁免后不再报错（旧 minLen 门槛曾让它豁免失效）', () => {
    const ok = goodScene.replace('hi', '三体问题');
    // 基线：未声明豁免 → 4 字窗口命中，报错
    expect(
      V.validateSceneFile(ok, { narration: '三体问题很难解。' }).some((i) => i.id === 'V-SCENE-005'),
    ).toBe(true);
    // 声明豁免（3 字，低于 minLen=4）→ 不再报
    expect(
      V.validateSceneFile(ok, {
        narration: '三体问题很难解。',
        exemptTerms: ['三体'],
      }).filter((i) => i.id === 'V-SCENE-005'),
    ).toEqual([]);
  });

  it('图表禁 3D 装饰（Tufte）', () => {
    const bad = '<div>立体饼图 3d 效果</div>';
    expect(V.hasError(V.validateChartScene(bad))).toBe(true);
  });
});

describe('风格校验器', () => {
  const pack = {
    id: 'p',
    name: 'n',
    grade: 'A' as const,
    status: 'registered' as const,
    userFacing: { name: 'n', aliases: [], vibe: 'v', bestFor: [] },
    anatomy: {
      script: 's', directing: 'd', art: 'a', camera: 'c',
      performance: 'p', sourcing: 'so', sound: 'sd', editing: 'e',
    },
    palette: { primary: '#111111', accent: '#222222', neutral: ['#1','#2','#3','#4','#5'], colorArc: 'x' },
    type: { families: ['sans'], scale: { title: 0.1, body: 0.03 }, tracking: {} },
    layout: { density: 0.3, maxElementsPerShot: 3, whitespace: 0.4 },
    motion: { easing: 'e', intensity: 0.5, staggerMs: 80, spring: { stiffness: 180, damping: 20 } },
    pacing: { curve: 'c', shotLenMs: [1500, 3000] as [number, number], breathEvery: 5 },
    effects: {},
    transitions: ['dissolve'],
    shotScaleBias: ['MS' as const],
    provenance: { source: 'manual' as const, from: 'x', version: '1.0' },
  };

  it('无 rationale 的风格决策被拦', () => {
    expect(V.hasError(V.validateStyleDecision({ id: 'p', source: 'agent-chosen', rationale: '' }))).toBe(true);
  });

  it('组合覆写未知参数组被拦', () => {
    const issues = V.validateCombination(pack, { bogus: 1 }, [pack]);
    expect(V.hasError(issues)).toBe(true);
  });

  it('合法覆写通过', () => {
    const issues = V.validateCombination(pack, { effects: { grain: 0.2 }, _lineage: [] }, [pack]);
    expect(V.hasError(issues)).toBe(false);
  });

  it('沉淀包缺 review 不许上架', () => {
    const absorbed = { ...pack, provenance: { ...pack.provenance, source: 'absorbed' as const, review: '' } };
    expect(V.hasError(V.validateProvenance(absorbed))).toBe(true);
    const reviewed = { ...absorbed, provenance: { ...absorbed.provenance, review: '对拍通过' } };
    expect(V.hasError(V.validateProvenance(reviewed))).toBe(false);
  });

  it('agent-chosen 风格缺谱系是 error（V-STYLE-004）', () => {
    const issues = V.validateStyleDecision({ id: 'p', source: 'agent-chosen', rationale: '理由充分' });
    const hit = issues.find((i) => i.id === 'V-STYLE-004');
    expect(hit?.level).toBe('error');
  });
});

describe('剪辑节奏校验器', () => {
  const mkShot = (id: string, narration: string) =>
    ({ id, narration, visual: { kind: 'code-scene', template: 'typography', params: {} }, state: 'ready', zoom: 'MS', camera: 'none', transition: 'dissolve', gag: false } as never);
  const mkTimeline = (narrations: string[]) => ({
    shots: narrations.map((_, i) => ({ shotId: `s${String(i + 1).padStart(2, '0')}`, startMs: i * 5000, durationMs: 5000, transition: 'dissolve' })),
    subtitles: [],
    sfx: [],
  } as never);

  it('句中切镜是 error（V-RHY-002，心理眨眼铁律）', () => {
    const shots = [mkShot('s01', '这是一句没有说完的旁白'), mkShot('s02', '第二句。')];
    const issues = V.validateCutPoints(shots, mkTimeline(['a', 'b']));
    const hit = issues.find((i) => i.id === 'V-RHY-002');
    expect(hit?.level).toBe('error');
  });

  it('句读边界切镜通过', () => {
    const shots = [mkShot('s01', '第一句完整。'), mkShot('s02', '第二句。')];
    expect(V.hasError(V.validateCutPoints(shots, mkTimeline(['a', 'b'])))).toBe(false);
  });

  it('段数≠镜数报 V-RHY-007（非借号）', () => {
    const p = {
      script: { fullText: '', segments: [{ id: 'seg-1', text: 'a', function: 'inform' }] },
      shots: [mkShot('s01', 'a'), mkShot('s02', 'b')],
    } as never;
    const issues = V.validateStoryboard(p);
    expect(issues.some((i) => i.id === 'V-RHY-007')).toBe(true);
    expect(issues.some((i) => i.id === 'V-STE-003')).toBe(false);
  });
});

// v1.1.0 事故复现：8 句套话按 i % 8 轮转填满 30 段、画面按 8 模板循环 3.75 遍，
// 当时所有形式校验全绿。以下用例锁死「内容空转必须被拦」。
describe('内容门（v1.1.1）', () => {
  const mkShot = (id: string, narration: string, template = 'typography') =>
    ({ id, narration, segmentId: id, visual: { kind: 'code-scene', template, params: {} }, state: 'ready' } as never);

  it('V-SCP-011 台词重复：8 句循环填 30 段判 error', () => {
    const pool = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 句套话。`);
    const segments = Array.from({ length: 30 }, (_, i) => ({
      id: `seg-${i + 1}`,
      text: pool[i % 8]!,
      function: 'advance' as const,
    }));
    const issues = V.validateScriptContent({ fullText: '', segments } as never, 'CPU 流水线');
    expect(issues.find((i) => i.id === 'V-SCP-011')?.level).toBe('error');
  });

  it('V-SCP-012 套话黑名单：可套任意主题的空话命中 ≥2 段判 error', () => {
    const segments = [
      { id: 'seg-1', text: '把镜头拉近，看看这条流水线。', function: 'advance' as const },
      { id: 'seg-2', text: '回到最初的问题：它为什么快？', function: 'advance' as const },
      { id: 'seg-3', text: '取指阶段每秒搬运 4 条指令。', function: 'advance' as const },
    ];
    const issues = V.validateScriptContent({ fullText: '', segments } as never, 'CPU 流水线');
    expect(issues.find((i) => i.id === 'V-SCP-012')?.level).toBe('error');
  });

  it('V-SCP-013 主题落地：写通用叙事不写主题判 error', () => {
    const segments = Array.from({ length: 6 }, (_, i) => ({
      id: `seg-${i + 1}`,
      text: `这是第 ${i + 1} 个通用的观察，和它背后的故事。`,
      function: 'advance' as const,
    }));
    const issues = V.validateScriptContent({ fullText: '', segments } as never, 'CPU 流水线');
    expect(issues.some((i) => i.id === 'V-SCP-013' && i.level === 'error')).toBe(true);
  });

  it('V-SCP-015 离线占位标记直接判 error（硬闸）', () => {
    const segments = [
      { id: 'seg-1', text: '【离线占位】第 1 段待 LLM 填写：CPU 流水线', function: 'advance' as const },
      { id: 'seg-2', text: '【离线占位】第 2 段待 LLM 填写：CPU 流水线', function: 'advance' as const },
    ];
    const issues = V.validateScriptContent({ fullText: '', segments } as never, 'CPU 流水线');
    expect(issues.find((i) => i.id === 'V-SCP-015')?.level).toBe('error');
  });

  it('真有内容的讲稿零 error（门不能误伤正常稿）', () => {
    const lines = [
      '主频 4GHz 不等于每秒执行四十亿条指令。',
      '流水线把一条指令拆成取指、译码、执行、访存、写回五级。',
      '数据冒险时后一条指令要等前一条写回。',
      '转发技术绕过寄存器直接传结果，省下两个周期。',
      '分支预测猜错要清空流水线，损失十几个周期。',
      '所以电脑很快，一半是流水线替你藏起来的错觉。',
    ];
    const segments = lines.map((text, i) => ({ id: `seg-${i + 1}`, text, function: 'advance' as const }));
    const issues = V.validateScriptContent({ fullText: lines.join(''), segments } as never, '流水线');
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('V-RHY-012 画面形态周期重复：8 模板循环 3.75 遍判 error', () => {
    const forms = Array.from({ length: 8 }, (_, i) => `tpl-${i}`);
    const shots = Array.from({ length: 30 }, (_, i) => mkShot(`s${i + 1}`, `第 ${i + 1} 句旁白。`, forms[i % 8]!));
    const issues = V.validateRhythmPeriodicity({ shots } as never);
    expect(issues.find((i) => i.id === 'V-RHY-012')?.level).toBe('error');
  });

  it('V-RHY-012 全片单一形态判 error', () => {
    const shots = Array.from({ length: 10 }, (_, i) => mkShot(`s${i + 1}`, `第 ${i + 1} 句旁白。`));
    const issues = V.validateRhythmPeriodicity({ shots } as never);
    expect(issues.some((i) => i.id === 'V-RHY-012')).toBe(true);
  });

  it('V-RHY-012 形态多样且无周期时放行', () => {
    const forms = ['paper-stage', 'flow', 'chart', 'comparison', 'process-track', 'kinetic-type', 'atmosphere'];
    const shots = Array.from({ length: 14 }, (_, i) => mkShot(`s${i + 1}`, `第 ${i + 1} 句不同的旁白内容。`, forms[i % forms.length]!));
    expect(V.validateRhythmPeriodicity({ shots } as never)).toEqual([]);
  });
});

describe('编剧校验器', () => {
  it('parseScript 缺功能直接报错（V-SCP-001 不被默认值架空）', () => {
    const raw = { fullText: '文本', segments: [{ id: 'seg-1', text: '无功能段' }] };
    expect(() => parseScript(raw)).toThrow(/V-SCP-001|未标功能/);
  });

  // V-SCP-005 字数口径：中文按字算（60000/MS_PER_CHAR_CN ≈ 273 字/分），不是英文 wordsPerMin。
  // 旧口径把 2.5 分钟档目标定成 325 字，正常中文讲稿（~680 字）全被判「偏离」——警告变噪音。
  it('V-SCP-005 中文正常字数不告警（按字/durationTier 推导，不按 wordsPerMin）', () => {
    const recipe = {
      durationTiers: { '0-5': { wordsPerMin: 130, structure: 'x', chapters: 2 } },
    } as never;
    // 2.5min × 60000ms / 220ms ≈ 682 字，取 660 字（-3%）应落在 ±20% 内
    const text = '流'.repeat(22);
    const script = {
      fullText: '',
      segments: Array.from({ length: 30 }, (_, i) => ({
        id: `seg-${i + 1}`,
        text,
        function: 'advance' as const,
      })),
    };
    expect(validateCharBudget(script as never, recipe, '0-5')).toEqual([]);
    // 明显过短（150 字）仍要告警，门没被放松成永不触发
    const thin = {
      fullText: '',
      segments: [{ id: 'seg-1', text: '短'.repeat(150), function: 'advance' as const }],
    };
    expect(validateCharBudget(thin as never, recipe, '0-5').some((i) => i.id === 'V-SCP-005')).toBe(true);
  });
});

describe('画面来源：提示词与校验器必须同源（v1.1.2 根因回归）', () => {
  it('场景提示词只点名 motion-lib 真实存在的原语，且与 MOTION_WHITELIST 完全一致', async () => {
    const { buildSceneSystemPrompt } = await import('../src/infrastructure/llm-client.js');
    const prompt = buildSceneSystemPrompt();
    // 提示词里出现的每个 MV.xxx 必须都在白名单里
    const mentioned = new Set([...prompt.matchAll(/MV\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!));
    const allowed = new Set(MOTION_WHITELIST.map((p) => p.replace('MV.', '')));
    // from/to/fromTo 在 motion-lib 里不存在：v1.1.1 曾把它们写进提示词，
    // 模型照写 → 校验器 V-SCENE-003 必判 error → 重试耗尽 → 22/30 镜静默回退模板
    for (const loose of ['from', 'to', 'fromTo', 'fade']) {
      expect(allowed.has(loose)).toBe(false);
    }
    const unknown = [...mentioned].filter((m) => !allowed.has(m) && !['motifLoop'].includes(m));
    // 允许 prompt 里出现「不要臆造 MV.from」这种反例提示，但要确保白名单本身干净
    expect(unknown.length === 0 || prompt.includes('不要臆造')).toBe(true);
    // 白名单里的每个原语都应被提示词点名（单一事实源不能有孤岛）；
    // 排除 MV.MO / MV.MOTIF_KINDS 这类「常量导出」——它们不是可调用原语，
    // 只是挂在同名对象上的数据表，提示词无需点名。
    const NOT_PRIMITIVES = new Set(['MO', 'MOTIF_KINDS']);
    for (const p of allowed) {
      if (NOT_PRIMITIVES.has(p)) continue;
      expect(prompt.includes(`MV.${p}`)).toBe(true);
    }
  });

  it('V-SCENE-003 对未实现的 MV.from 判 error（锁住判据）', () => {
    const html = `<body data-scene-id="s01"><div class="stage"><div class="subject">A</div></div>
<script src="../motion/motion-lib.js"></script>
<script>document.addEventListener('DOMContentLoaded',function(){
  MV.from('.subject',{opacity:0});
  MV.motifLoop('.stage',{amp:2,duration:1200});
});</script></body>`;
    const issues = V.validateSceneFile(html, { narration: '一句旁白' });
    expect(issues.find((i) => i.id === 'V-SCENE-003')?.level).toBe('error');
  });
});

describe('V-SCP-013 主题落地：实体级判据（v1.1.2 校准回归）', () => {
  const topic = 'CPU流水线如何让你以为电脑很快';

  it('主题实体只抽实词，不产生跨词边界垃圾', async () => {
    const { topicEntities } = await import('../src/core/validators/content.js');
    const ents = topicEntities(topic);
    // 旧实现产出 15 个 2 字窗，其中「线如/何让/为电/脑很」这类不构成词，
    // 讲稿越贴题越命中不了 → 覆盖率上限 53%，门在上限附近随机翻转
    for (const junk of ['线如', '何让', '为电', '脑很', 'U流']) {
      expect(ents).not.toContain(junk);
    }
    expect(ents).toContain('CPU');
    expect(ents).toContain('流水线');
    expect(ents).toContain('电脑');
  });

  it('贴题讲稿零 error（好稿子不能被随机打回）', async () => {
    const { validateScriptContent } = await import('../src/core/validators/content.js');
    const lines = [
      '真相藏在一条叫流水线的装配线里。',
      '一条指令要拆成五步走，才凑得出这个速度。',
      '关键不在快，在于五级同时开工。',
      '五条指令抢同一批资源，这叫流水线冒险。',
      '分支预测走错方向，整条流水线被清空。',
      '于是乱序执行登场，谁的数据先备齐谁先跑。',
      '前端一个周期能喂四到六条指令。',
      '所以电脑很快是个统计错觉，快在重叠。',
    ];
    const segments = lines.map((text, i) => ({ id: `seg-${i + 1}`, text, function: 'advance' as const }));
    const issues = validateScriptContent(
      { fullText: lines.join(''), segments } as never,
      topic,
    );
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('通用叙事讲稿（零主题实体）判 error', async () => {
    const { validateScriptContent } = await import('../src/core/validators/content.js');
    const lines = [
      '这件事比看起来要有意思得多。',
      '我们不妨把它拆成几个部分来看。',
      '第一部分是大家最熟悉的那一层。',
      '第二部分往往被人忽略掉。',
      '真正关键的地方在第三部分。',
      '说到这里，脉络就逐渐清晰了。',
    ];
    const segments = lines.map((text, i) => ({ id: `seg-${i + 1}`, text, function: 'advance' as const }));
    const issues = validateScriptContent(
      { fullText: lines.join(''), segments } as never,
      topic,
    );
    expect(issues.find((i) => i.id === 'V-SCP-013')?.level).toBe('error');
  });

  it('问句式主题：长块切出头部名词做第二实体（vibe 首条「时间」误杀回归）', async () => {
    const { topicEntities, validateScriptContent } = await import('../src/core/validators/content.js');
    const q = '为什么时间会越感觉越快';
    // 回归背景：整串「时间会越感觉越快」是唯一实体时，好稿写「时间」「记忆」
    // 而不复述整句 → 零命中 → V-SCP-013 error 误杀，writeScript 连续拒稿。
    const ents = topicEntities(q);
    expect(ents).toContain('时间会越感觉越快');
    expect(ents).toContain('时间');
    // 贴题好稿（不复述整句）必须零 error
    const lines = [
      '你有没有发现，刚过去的这一年，好像比小时候一整年短得多。',
      '这不是错觉，心理学管它叫时间压缩。',
      '大脑并不记录时长，它记录的是新鲜事件的密度。',
      '同一段路，第一次走觉得长，走熟了就变短。',
      '想让一年变长，靠的不是休假，是制造第一次。',
      '你上一次觉得一天很长，是在做什么？',
    ];
    const segments = lines.map((text, i) => ({ id: `seg-${i + 1}`, text, function: 'advance' as const }));
    const issues = validateScriptContent({ fullText: lines.join(''), segments } as never, q);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('重音预算：全片资源不能由逐镜独立判断（V-MOT-013 合成卡死回归）', () => {
  const mk = (n: number, emotions: number[] = []) => ({
    meta: { id: 'p', title: 't', topic: 'CPU流水线', aspect: '16:9', durationTier: '0-5', fps: 30, genre: 'science-explainer', assetPolicy: 'auto', aiConsent: false },
    stage: 'storyboard',
    script: {
      fullText: '',
      segments: Array.from({ length: n }, (_, i) => ({
        id: `seg-${i + 1}`,
        text: `段${i}`,
        function: emotions.includes(i) ? 'emotion' : 'advance',
        beat: 'hook',
        mood: 'neutral',
        emphasis: emotions.includes(i) ? ['重'] : [],
      })),
    },
    shots: Array.from({ length: n }, (_, i) => ({
      id: `s${String(i + 1).padStart(2, '0')}`,
      segmentId: `seg-${i + 1}`,
      narration: `旁白${i}`,
      counterpoint: 'evidence',
      zoom: 'MS',
      camera: 'static',
      state: 'planned',
      visual: { kind: 'code-scene', prompt: 'x', template: 'typography', params: {} },
    })),
  });

  it('预算上限与 V-MOT-013 判据同源（floor(n/3)），且不会超配', async () => {
    const { allocateAccentShots } = await import('../src/domain/accent-budget.js');
    for (const n of [4, 10, 30]) {
      const b = allocateAccentShots(mk(n) as never);
      expect(b.cap).toBe(Math.floor(n / 3));
      expect(b.allowed.size).toBeLessThanOrEqual(b.cap);
      expect(b.allowed.size / n).toBeLessThanOrEqual(1 / 3);
    }
  });

  it('同一项目重复计算得到同一结果（预算不能随重跑漂移，否则是竞态不是预算）', async () => {
    const { allocateAccentShots } = await import('../src/domain/accent-budget.js');
    const p = mk(30, [3, 7]);
    const a = [...allocateAccentShots(p as never).allowed].sort();
    const b = [...allocateAccentShots(p as never).allowed].sort();
    expect(a).toEqual(b);
  });

  it('首镜必占（V-MOT-018 开头那一下砸），情绪段优先', async () => {
    const { allocateAccentShots } = await import('../src/domain/accent-budget.js');
    const b = allocateAccentShots(mk(30, [5]) as never);
    expect(b.allowed.has('s01')).toBe(true);
    expect(b.allowed.has('s06')).toBe(true); // 第 6 镜 = index 5，情绪段
  });

  it('镜头太少时不设预算（与 V-MOT-013 的 <4 豁免一致）', async () => {
    const { allocateAccentShots } = await import('../src/domain/accent-budget.js');
    const b = allocateAccentShots(mk(3) as never);
    expect(b.allowed.size).toBe(3);
  });

  it('无预算的镜头写了 slam 会被就地降级成 enter（结构不变，不再占预算）', async () => {
    const { normalizeSceneHtml } = await import('../src/domain/scene-forge.js');
    const html = `<body data-scene-id="s02"><div class="stage"><div class="subject">主</div></div>
      <script>MV.slam('.subject', {duration:200}); MV.highlight('.subject');</script></body>`;
    const out = normalizeSceneHtml(html, { accentAllowed: false });
    expect(out).not.toContain('MV.slam');
    expect(out).toContain('MV.enter(');
    // 非重音原语不受影响
    expect(out).toContain('MV.highlight(');
  });

  it('有预算的镜头不被降级', async () => {
    const { normalizeSceneHtml } = await import('../src/domain/scene-forge.js');
    const html = `<body data-scene-id="s01"><div class="stage"><div class="subject">主</div></div>
      <script>MV.slam('.subject');</script></body>`;
    expect(normalizeSceneHtml(html, { accentAllowed: true })).toContain('MV.slam');
  });
});

describe('场景规范化：机械可修项就地修，不为「少写一个 class」重画整镜', () => {
  it('主语 0 个时补到第一个有文字的非装饰元素（V-COMP-001）', async () => {
    const { normalizeSceneHtml } = await import('../src/domain/scene-forge.js');
    const html = `<body data-scene-id="s01"><div class="stage">
      <div class="bg-circle"></div>
      <div class="label">4 路并行</div>
    </div></body>`;
    const out = normalizeSceneHtml(html);
    expect(out).toContain('class="label subject"');
    // 装饰元素不能当主语
    expect(out).not.toContain('bg-circle subject');
    const issues = V.validateSceneFile(out, { narration: '一句旁白' });
    expect(issues.find((i) => i.id === 'V-COMP-001')).toBeUndefined();
  });

  it('主语 >1 个时只保留第一个，其余降级为 deco', async () => {
    const { normalizeSceneHtml } = await import('../src/domain/scene-forge.js');
    const html = `<body data-scene-id="s01"><div class="stage">
      <div class="subject">主</div>
      <div class="title">副</div>
    </div></body>`;
    const out = normalizeSceneHtml(html);
    expect((out.match(/\b(subject|title|hero)\b/g) ?? []).length).toBe(1);
    expect(out).toContain('class="deco"');
  });

  it('单引号 class 被统一成双引号（否则明明写了 subject 也被判 0 个）', async () => {
    const { normalizeSceneHtml } = await import('../src/domain/scene-forge.js');
    const html = `<body data-scene-id="s01"><div class="stage"><div class='subject'>主</div></div></body>`;
    const out = normalizeSceneHtml(html);
    expect(out).toContain('class="subject"');
  });

  it('已经合规的场景不被改动（规范化必须幂等）', async () => {
    const { normalizeSceneHtml } = await import('../src/domain/scene-forge.js');
    const html = `<body data-scene-id="s01"><div class="stage"><div class="subject">主</div></div></body>`;
    expect(normalizeSceneHtml(html)).toBe(html);
  });
});

describe('运镜词表：提示词/校验器/归一化必须同源（v1.1.2 分镜打回回归）', () => {
  it('pan-right 归一化为 pan（模型按左右直觉命名）', async () => {
    const { normalizeCameraToken, isCameraToken } = await import('../src/core/schema.js');
    // v1.1.2 实测：一份分镜里 s02/s08/s10/s17/s22/s26 全写 pan-right，
    // 缺别名 → V-CAM-002 六条 error → 整份分镜被打回，片子出不来
    expect(isCameraToken('pan-right')).toBe(true);
    expect(normalizeCameraToken('pan-right')).toBe('pan');
    expect(normalizeCameraToken('panright')).toBe('pan');
    // 左向仍走 pan-left，不能一起归一成 pan，否则左右不分
    expect(normalizeCameraToken('pan-left')).toBe('pan-left');
  });

  it('分镜提示词的 camera 词表与 schema.CAMERA_MOVES 一致', async () => {
    const { CAMERA_MOVES } = await import('../src/core/schema.js');
    const mod = await import('../src/infrastructure/llm-client.js');
    const prompt = mod.buildStoryboardSystemPrompt();
    for (const m of CAMERA_MOVES) {
      expect(prompt.includes(m)).toBe(true);
    }
  });

  it('V-CAM-002 报错文案里的合法值 == 真实词表（不手写枚举）', () => {
    const shots = [
      { id: 's01', camera: 'dolly-zoom', counterpoint: 'metaphor', colorTemp: 'warm' },
    ] as never;
    const issues = V.validateStoryboard({
      shots,
      meta: {},
      script: { segments: [{ id: 'seg-1' }] },
    } as never);
    const msg = issues.find((i) => i.id === 'V-CAM-002')!.message;
    // 文案点名了合法值，照着文案写就不会再被打回
    expect(msg).toContain('push-in');
    expect(msg).toContain('whip-pan');
  });
});

describe('V-CP-005 对位多样性（P13 阶段1）', () => {
  const shot = (id: string, counterpoint: string) => ({ id, counterpoint }) as never;

  it('≥6 镜全片同一种对位 → warn', () => {
    const shots = Array.from({ length: 6 }, (_, i) => shot(`s0${i + 1}`, 'metaphor'));
    const issues = V.validateCounterpointDiversity(shots);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe('V-CP-005');
    expect(issues[0]!.level).toBe('warn');
  });

  it('5 镜同一种 → 不报（少镜短片没有分布可言）', () => {
    const shots = Array.from({ length: 5 }, (_, i) => shot(`s0${i + 1}`, 'metaphor'));
    expect(V.validateCounterpointDiversity(shots)).toEqual([]);
  });

  it('≥6 镜出现第二种对位 → 不报', () => {
    const shots = [
      ...Array.from({ length: 5 }, (_, i) => shot(`s0${i + 1}`, 'metaphor')),
      shot('s06', 'literal'),
    ];
    expect(V.validateCounterpointDiversity(shots)).toEqual([]);
  });

  it('统计层永不拦单镜：只有 warn，没有 error', () => {
    const shots = Array.from({ length: 8 }, (_, i) => shot(`s0${i + 1}`, 'emotion'));
    expect(V.hasError(V.validateCounterpointDiversity(shots))).toBe(false);
  });
});

describe('V-CP-006 字面直译率分档（P13 阶段1）', () => {
  // 旁白 20 个内容单位；画面只出现两段 4 字片段（引力其实 / 苹果落地）
  // → 共享 8 单位 = 直译率 0.40。落在讲解档（0.45）之下、叙事档（0.30）之上——
  // 这一对数据正好用来证明「档位不是装饰」：同一画面换个 genre 结论就反了。
  const narration = '引力其实是一种时空弯曲而苹果落地只是表象';
  const html = '<div>引力其实</div><div>苹果落地</div>';

  it('讲解类高重合不报（术语上画面是功能）', () => {
    const issues = V.validateLiteralRate(narration, html, 'science-explainer');
    expect(issues).toEqual([]);
  });

  it('story-narrative 同输入报 warn（叙事类字面复述就是插图）', () => {
    const issues = V.validateLiteralRate(narration, html, 'story-narrative');
    expect(issues.map((i) => i.id)).toEqual(['V-CP-006']);
    expect(issues[0]!.level).toBe('warn');
    expect(issues[0]!.message).toContain('story-narrative');
  });

  it('连画面整句照搬时讲解档也拦（不是无脑放行）', () => {
    const heavy = `<div>${narration}</div>`;
    const issues = V.validateLiteralRate(narration, heavy, 'science-explainer');
    expect(issues.map((i) => i.id)).toEqual(['V-CP-006']);
  });

  it('未登记 genre 走兜底档，空串也不绕过（不写 `genre &&` 的坑）', () => {
    const issues = V.validateLiteralRate(narration, html, '');
    expect(issues.map((i) => i.id)).toEqual(['V-CP-006']);
    expect(issues[0]!.message).toContain('默认');
  });

  it('旁白过短（units<8）直接放行', () => {
    expect(V.validateLiteralRate('涨了', '<div>涨了</div>', 'story-narrative')).toEqual([]);
  });

  it('画面不复述旁白 → 不报（低重合是隐喻该有的样子，不判下限）', () => {
    expect(V.validateLiteralRate(narration, '<div>一条被拉弯的床单</div>', 'story-narrative')).toEqual([]);
  });
});

describe('V-CON-006 机位动机断点（P13 阶段1）', () => {
  it('连续段内 intent 突变 → intentBreaks 有值且 warns 含 V-CON-006', async () => {
    const { auditContinuity } = await import('../src/domain/continuity.js');
    const audit = auditContinuity([
      { id: 's01', segmentId: 'seg-1', zoom: 'MS', camera: 'push-in', transition: 'continuity', intent: 'reveal', colorTemp: 'cool' },
      { id: 's02', segmentId: 'seg-1', zoom: 'MS', camera: 'pan', transition: 'continuity', intent: 'hold', colorTemp: 'cool' },
    ] as never);
    expect(audit.intentBreaks.length).toBeGreaterThan(0);
    expect(audit.warns.some((w) => w.includes('V-CON-006'))).toBe(true);
    expect(audit.intentCoverage.withIntent).toBe(2);
  });

  it('intent 一致 → 不报断点', async () => {
    const { auditContinuity } = await import('../src/domain/continuity.js');
    const audit = auditContinuity([
      { id: 's01', segmentId: 'seg-1', zoom: 'MS', camera: 'push-in', transition: 'continuity', intent: 'reveal', colorTemp: 'cool' },
      { id: 's02', segmentId: 'seg-1', zoom: 'MS', camera: 'pan', transition: 'continuity', intent: 'reveal', colorTemp: 'cool' },
    ] as never);
    expect(audit.intentBreaks).toEqual([]);
    expect(audit.warns.some((w) => w.includes('V-CON-006'))).toBe(false);
  });
});

// P13 阶段2：V-RHY-013 场内/场间转场双规则（sceneScope 由 computeTimeline 单点派生，校验器只读 timeline）
describe('V-RHY-013 场内/场间转场双规则', () => {
  const shot = (id: string, over: Record<string, unknown> = {}) => ({
    shotId: id,
    startMs: 0,
    durationMs: 1500,
    transition: 'hard-cut',
    motivation: '',
    audioShiftMs: 0,
    coverage: [],
    ...over,
  });
  const tl = (shots: ReturnType<typeof shot>[]) => ({ shots, subtitles: [], sfx: [] }) as never;

  it('全 inter → 不告警（缺省 sceneScope 视为场间，保守不收紧旧片）', () => {
    const issues = V.validateSceneTransition(
      tl([shot('s1'), shot('s2', { sceneScope: 'inter', motivation: 'emotion', transition: 'dissolve' })]),
    );
    expect(issues).toEqual([]);
  });

  it('场内 dissolve → 规则2 warn；场间 dissolve → 沉默', () => {
    const issues = V.validateSceneTransition(
      tl([shot('s1', { sceneScope: 'intra' }), shot('s2', { sceneScope: 'intra', transition: 'dissolve', motivation: 'action' })]),
    );
    expect(issues.filter((i) => i.id === 'V-RHY-013').length).toBe(1);
    expect(issues[0]!.message).toContain('溶解');
  });

  it('场内 emotion 动机 → 规则1 warn（越集）；场内 action → 沉默', () => {
    const issues = V.validateSceneTransition(
      tl([shot('s1', { sceneScope: 'intra' }), shot('s2', { sceneScope: 'intra', motivation: 'emotion', transition: 'hard-cut' })]),
    );
    expect(issues.filter((i) => i.id === 'V-RHY-013').length).toBe(1);
    expect(issues[0]!.message).toContain('动机越集');
  });

  it('oneshot 与 match-cut 是合法场内动机 → 沉默', () => {
    const issues = V.validateSceneTransition(
      tl([
        shot('s1', { sceneScope: 'intra' }),
        shot('s2', { sceneScope: 'intra', motivation: 'oneshot', transition: 'continuity' }),
        shot('s3', { sceneScope: 'intra', motivation: 'match-cut', transition: 'hard-cut' }),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('computeTimeline 派生：同 segment ⇒ intra；scenes 编组优先于 segment 口径', async () => {
    const { computeTimeline } = await import('../src/domain/composer.js');
    const base = {
      schemaVersion: 1,
      meta: { id: 'p9', title: 't', topic: 'x', aspect: '16:9', durationTier: '0-5', fps: 30, genre: 'science-explainer', assetPolicy: 'auto' },
      stage: 'compose',
      confirmed: false,
      shots: [
        { id: 's1', segmentId: 'seg-1', zoom: 'MS', camera: 'none', transition: 'auto', narration: '一', counterpoint: {}, coverage: [], gag: false, visual: { kind: 'code', prompt: '', params: {} } },
        { id: 's2', segmentId: 'seg-2', zoom: 'CU', camera: 'none', transition: 'auto', narration: '二', counterpoint: {}, coverage: [], gag: false, visual: { kind: 'code', prompt: '', params: {} } },
      ],
      directorNotes: [],
      materialDecisions: {},
    } as never;
    // 回退口径：不同 segment ⇒ 全 inter
    expect(computeTimeline(base).shots.map((s) => s.sceneScope)).toEqual(['inter', 'inter']);
    // scenes 编组把两镜放进同一场 ⇒ 第二镜 intra（编组优先于 segment 口径）
    const withScene = { ...base, scenes: [{ id: 'sc1', canvas: 'c', shotIds: ['s1', 's2'], viewportWindows: [] }] } as never;
    expect(computeTimeline(withScene).shots.map((s) => s.sceneScope)).toEqual(['inter', 'intra']);
  });
});
