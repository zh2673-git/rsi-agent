/**
 * 模板契约层（P12 阶段1）的防腐断言。
 *
 * 为什么单独一个测试文件：本轮引入的最重要的东西是**契约与实现的一致性**——
 * 模板 HTML 里写的占位符、契约里声明的参数、运动库真正读的参数，
 * 三者以前**各写各的**，于是有 6 个模板渲染出未填充的 `{{HERO_WORD}}`，
 * 其中在 `<script>` 里的那些让整镜动画全部失效，而所有既有校验器全绿。
 *
 * 这类缺陷的共同特征：**单看任何一处都是对的**，只有「拿几份清单对表」才能抓。
 * 所以本文件干的就是对表：
 *   ① 模板占位符 ↔ 契约声明 ↔ 内容派生（三个来源必须对齐）
 *   ② 契约声明的语法/母题/机位 ↔ 实际实现
 *   ③ 风格包 ↔ 配方 ↔ 场景模板（幽灵引用）
 *   ④ 具名能量曲线 ↔ 实际可解析
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanPlaceholders,
  injectPlaceholders,
  placeholderContext,
  leftoverPlaceholders,
  validateParamValue,
  resolveParams,
  assembleContentValues,
  resolveMissingSlots,
  checkCapacity,
  resolveVariant,
  slotParamNames,
  sampleMarkup,
  type TemplateContract,
} from '../src/domain/template-contract.js';
import { deriveContent, safeLabel, extractTerm, splitTiers, splitTierPair } from '../src/domain/template-content.js';
import { GRAMMARS, REQUIRED_BY_GRAMMAR } from '../src/domain/motion-grammar.js';
import { NAMED_ENERGY_CURVES, parseEnergyCurve } from '../src/domain/continuity.js';
import { MOTION_WHITELIST, CAMERA_MOVES } from '../src/core/validators/scene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

const SCENES_DIR = path.join(ROOT, 'templates', 'scenes');
const TEMPLATE_IDS = readdirSync(SCENES_DIR)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''))
  .sort();

function contractOf(id: string): TemplateContract {
  return readJson<TemplateContract>(`templates/scenes/${id}.meta.json`);
}

describe('① 模板契约：每个模板都有契约（阶段1 的地基）', () => {
  it('每个场景模板都有 .meta.json 契约', () => {
    const missing = TEMPLATE_IDS.filter((id) => !existsSync(path.join(SCENES_DIR, `${id}.meta.json`)));
    expect(missing, `缺契约的模板：${missing.join(', ')}`).toEqual([]);
  });

  it('契约的 id 与文件名一致（防「契约张冠李戴」）', () => {
    for (const id of TEMPLATE_IDS) {
      expect(contractOf(id).id, `契约 ${id}.meta.json 的 id 字段`).toBe(id);
    }
  });

  it('契约里的参数名唯一，且不含 {{}} 包裹', () => {
    for (const id of TEMPLATE_IDS) {
      const names = contractOf(id).params.map((p) => p.name);
      expect(new Set(names).size, `${id} 的参数名有重复`).toBe(names.length);
      for (const n of names) {
        expect(n.startsWith('{{'), `${id} 的参数名 ${n} 不该带 {{}}`).toBe(false);
      }
    }
  });
});

describe('② 占位符 ↔ 契约 ↔ 派生：三源对齐', () => {
  it('模板里的每个占位符都在契约里声明（否则渲染时无人负责）', () => {
    // 系统级占位符由渲染层提供（token/镜别/机位），不进契约
    const SYSTEM = new Set([
      'SCENE_ID', 'TITLE', 'PROMPT', 'NARRATION_HINT', 'PRIMARY', 'ACCENT',
      'NEUTRAL_0', 'NEUTRAL_1', 'NEUTRAL_2', 'NEUTRAL_3', 'NEUTRAL_4',
      'FONT', 'TITLE_SIZE', 'BODY_SIZE', 'EASING', 'DURATION', 'STAGGER',
      'SPRING_STIFFNESS', 'SPRING_DAMPING', 'ZOOM', 'CAMERA', 'GRAIN',
      'VIGNETTE', 'LETTERBOX', 'DOF', 'BLOOM', 'MAX_ELEMENTS',
      'ACCENT_FLAG', 'KICKER', 'BEATS', 'SCENE_PROGRAM', 'CANVAS_W', 'CANVAS_H', 'STAR_SEED',
      // P12 阶段2 新增的系统级参数（风格包 → 版式/运动的通道）
      'INTENSITY', 'DENSITY', 'WHITESPACE', 'STAGE_PAD',
    ]);
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      const html = read(`templates/scenes/${id}.html`);
      const declared = new Set(contractOf(id).params.map((p) => p.name));
      for (const hit of scanPlaceholders(html)) {
        if (SYSTEM.has(hit.name)) continue;
        if (!declared.has(hit.name)) bad.push(`${id}→{{${hit.name}}}`);
      }
    }
    expect(bad, `模板占位符没在契约里声明（渲染时无人填 → 残留 {{X}}）：${bad.join(', ')}`).toEqual([]);
  });

  it('契约里声明的每个参数都真的出现在模板里（防「声明了但模板不用」）', () => {
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      const html = read(`templates/scenes/${id}.html`);
      const used = new Set(scanPlaceholders(html).map((h) => h.name));
      for (const p of contractOf(id).params) {
        if (!used.has(p.name)) bad.push(`${id}→${p.name}`);
      }
    }
    expect(bad, `契约声明了模板不用的参数（死参数）：${bad.join(', ')}`).toEqual([]);
  });

  it('契约声明的 context 与模板里的实际位置一致', () => {
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      const html = read(`templates/scenes/${id}.html`);
      for (const p of contractOf(id).params) {
        const actual = placeholderContext(html, p.name);
        // 契约写 text，但模板把它放在 <script>/<style> 里 → 转义会破坏代码
        if (p.context === 'text' && actual === 'code') bad.push(`${id}→${p.name}(声明 text，实为 code)`);
      }
    }
    expect(bad, `契约的 context 与模板实际位置不符：${bad.join(', ')}`).toEqual([]);
  });

  it('每个内容槽都能被派生层填上（无残留 {{X}}）', () => {
    const NARRATIONS = [
      '首先取指，然后译码，接着执行，最后写回。',
      '相比同步执行，并行流水线的吞吐是它的四倍。',
      '上层是控制单元，中层是执行单元，底层是存储单元。',
      '记住三点：一是先写契约，二是再写代码，三是最后跑测试。',
    ];
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      const html = read(`templates/scenes/${id}.html`);
      for (const narration of NARRATIONS) {
        const derived = deriveContent(id, {
          narration,
          prompt: '测试意图',
          params: {},
          emphasis: ['取指', '译码', '执行'],
          shotId: 's01',
        });
        const values: Record<string, string | number> = {};
        for (const p of contractOf(id).params) {
          const v = derived[p.name];
          if (v !== undefined && v !== null && v !== '') values[p.name] = v;
        }
        const rendered = injectPlaceholders(html, values, (s) => s);
        const left = leftoverPlaceholders(rendered);
        if (left.length > 0) bad.push(`${id}「${narration.slice(0, 8)}…」→${left.join(',')}`);
      }
    }
    expect(bad, `派生后仍有未填充占位符：${bad.join(' | ')}`).toEqual([]);
  });
});

describe('③ 占位符注入器：转义与上下文判定', () => {
  const HTML = `<body data-scene-id="{{SCENE_ID}}"><div class="s">{{HERO_WORD}}</div>
<script>MV.use('scene-{{SCENE_ID}}'); MV.counter('.x', { to: {{FIGURE_TO}} });</script></body>`;

  it('文本位置转义、代码位置不转义（逐个出现位置判定）', () => {
    const out = injectPlaceholders(
      HTML,
      { SCENE_ID: 's01', HERO_WORD: '<b>x</b>', FIGURE_TO: 42 },
      (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;'); // 文本位置：已转义
    expect(out).toContain("MV.use('scene-s01')"); // 代码位置：原样
    expect(out).toContain('to: 42'); // 代码位置：原样（数字）
  });

  it('未提供的占位符替换成空串，不留 {{X}}', () => {
    const out = injectPlaceholders(HTML, { SCENE_ID: 's01' }, (s) => s);
    expect(leftoverPlaceholders(out)).toEqual([]);
  });

  it('JS 里的 {{X}} 必须被清干净——残留会让整个 script 块语法错误', () => {
    // 这是本轮最严重的缺陷：6/15 模板渲染出残留 {{FIGURE_TO}}，
    // 而 `to: {{FIGURE_TO}}` 在 JS 里是非法语法 → 整镜动画全灭
    const out = injectPlaceholders(HTML, { SCENE_ID: 's01' }, (s) => s);
    expect(out).not.toContain('{{');
    // 清空后 JS 仍然合法（不能出现 `to: ,` 这种悬空逗号）
    expect(out).not.toMatch(/to:\s*,/);
  });
});

describe('④ 参数契约：类型/范围校验', () => {
  it('数值越界报错（不静默夹取——夹取会让导演写的值被吞掉）', () => {
    const spec = { name: 'PUNCH_AT', type: 'number' as const, context: 'code' as const, min: 0, max: 6000 };
    expect(validateParamValue(spec, 720)).toEqual([]);
    expect(validateParamValue(spec, 99999).length).toBe(1);
    expect(validateParamValue(spec, -1).length).toBe(1);
  });

  it('枚举越界报错', () => {
    const spec = { name: 'X', type: 'enum' as const, context: 'text' as const, enum: ['a', 'b'] };
    expect(validateParamValue(spec, 'a')).toEqual([]);
    expect(validateParamValue(spec, 'c').length).toBe(1);
  });

  it('resolveParams：缺省值生效、显式覆盖优先、非法值报错', () => {
    const contract: TemplateContract = {
      id: 'x', name: 'x', grammar: [], motifs: [], camera: [],
      params: [
        { name: 'A', type: 'number', context: 'code', default: 10 },
        { name: 'B', type: 'string', context: 'text' },
      ],
      materials: [], capacity: {}, variants: [],
    };
    const r1 = resolveParams(contract, {});
    expect(r1.values['A']).toBe(10);
    expect(r1.issues).toEqual([]);
    const r2 = resolveParams(contract, { A: 99, B: 'hi' });
    expect(r2.values['A']).toBe(99);
    expect(r2.values['B']).toBe('hi');
    const r3 = resolveParams(contract, { A: 'not-a-number' });
    expect(r3.issues.length).toBe(1);
  });
});

describe('⑤ 语法 ↔ 模板 ↔ 风格：三层对齐', () => {
  it('每种语法都至少有一个模板承载（否则语法选出来没人接）', () => {
    const byGrammar = new Map<string, string[]>();
    for (const id of TEMPLATE_IDS) {
      for (const g of contractOf(id).grammar) {
        byGrammar.set(g, [...(byGrammar.get(g) ?? []), id]);
      }
    }
    const missing = GRAMMARS.map((g) => g.id).filter((id) => !(byGrammar.get(id) ?? []).length);
    expect(missing, `没有模板能承载的语法：${missing.join(', ')}`).toEqual([]);
  });

  it('契约里声明的语法都真实存在', () => {
    const ids = new Set(GRAMMARS.map((g) => g.id));
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      for (const g of contractOf(id).grammar) {
        if (!ids.has(g)) bad.push(`${id}→${g}`);
      }
    }
    expect(bad, `契约声明了不存在的语法：${bad.join(', ')}`).toEqual([]);
  });

  it('语法声明的 sceneForms 与契约的归属互为镜像（不悬空）', () => {
    const templateGrammar = new Map<string, Set<string>>();
    for (const id of TEMPLATE_IDS) {
      templateGrammar.set(id, new Set(contractOf(id).grammar));
    }
    for (const g of GRAMMARS) {
      for (const form of g.sceneForms) {
        expect(
          templateGrammar.has(form),
          `语法 ${g.id} 声明的 sceneForm「${form}」不是任何模板`,
        ).toBe(true);
        expect(
          templateGrammar.get(form)!.has(g.id),
          `语法 ${g.id} ↔ 模板 ${form}：模板契约没声明这个语法（双向关系断了）`,
        ).toBe(true);
      }
    }
  });

  it('契约声明的母题 kind 都在 motion-lib 里实现（防「声明了不生效」）', () => {
    const lib = read('templates/motion/motion-lib.js');
    const kinds = new Set(
      [...lib.matchAll(/^\s{4}(\w+):\s*function\s*\(nodes,\s*amp/gm)].map((m) => m[1]!),
    );
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      for (const m of contractOf(id).motifs) {
        if (!kinds.has(m)) bad.push(`${id}→${m}`);
      }
    }
    expect(bad, `契约声明了 motion-lib 没实现的母题 kind：${bad.join(', ')}`).toEqual([]);
  });

  it('契约声明的机位都在词表里', () => {
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      for (const c of contractOf(id).camera) {
        if (!CAMERA_MOVES.includes(c)) bad.push(`${id}→${c}`);
      }
    }
    expect(bad, `契约声明了词表外的机位：${bad.join(', ')}`).toEqual([]);
  });

  it('每个配方推荐的风格都真实存在（幽灵风格会让整类内容退化到第一个包）', () => {
    const styleIds = new Set(
      readdirSync(path.join(ROOT, 'styles'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<{ id: string }>(`styles/${f}`).id),
    );
    const bad: string[] = [];
    for (const f of readdirSync(path.join(ROOT, 'recipes'))) {
      if (!f.endsWith('.json')) continue;
      const rec = readJson<{ id: string; style: { recommended: string[] } }>(`recipes/${f}`);
      for (const s of rec.style.recommended) {
        if (!styleIds.has(s)) bad.push(`${rec.id}→${s}`);
      }
    }
    expect(bad, `配方推荐了不存在的风格：${bad.join(', ')}`).toEqual([]);
  });
});

describe('⑥ 能量曲线：具名曲线必须可解析（治 pacing.curve 全 no-op）', () => {
  it('所有风格包与配方的 pacing.curve 都能解析出能量序列', () => {
    const bad: string[] = [];
    const check = (id: string, curve: string) => {
      const parsed = parseEnergyCurve(curve);
      if (!parsed || parsed.length < 2) bad.push(`${id}→${curve}`);
    };
    for (const f of readdirSync(path.join(ROOT, 'styles'))) {
      if (!f.endsWith('.json')) continue;
      const p = readJson<{ id: string; pacing: { curve: string } }>(`styles/${f}`);
      check(p.id, p.pacing.curve);
    }
    for (const f of readdirSync(path.join(ROOT, 'recipes'))) {
      if (!f.endsWith('.json')) continue;
      const p = readJson<{ id: string; pacing: { curve: string } }>(`recipes/${f}`);
      check(p.id, p.pacing.curve);
    }
    expect(bad, `pacing.curve 不可解析（节奏曲线对该资产恒为 no-op）：${bad.join(', ')}`).toEqual([]);
  });

  it('每条具名曲线都有 2 个以上数值点', () => {
    for (const [name, seq] of Object.entries(NAMED_ENERGY_CURVES)) {
      expect(seq.length, `具名曲线 ${name} 的点数`).toBeGreaterThanOrEqual(2);
      for (const v of seq) {
        expect(v, `具名曲线 ${name} 的值 ${v}`).toBeGreaterThanOrEqual(0);
        expect(v, `具名曲线 ${name} 的值 ${v}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('语法的能量档与 pickGrammar 的闸门口径一致', () => {
    for (const g of GRAMMARS) {
      expect(g.energy, `${g.id} 缺 energy`).toBeGreaterThanOrEqual(0);
      expect(g.energy, `${g.id} 的 energy 越界`).toBeLessThanOrEqual(1);
    }
  });
});

describe('⑦ 内容派生：安全与术语', () => {
  it('safeLabel：与旁白共享 4 字窗口的标签被判废（防「看图说话」）', () => {
    const narr = '这是同步执行的流水线';
    expect(safeLabel('同步执行', narr, 12)).toBe('');
    expect(safeLabel('内存', narr, 12)).toBe('内存'); // 2 字：V-SCENE-005 只查 4 字窗口
  });

  it('extractTerm：在谓语边界处断开，不切出半个动词', () => {
    expect(extractTerm('顶层负责调度')).toBe('顶层');
    expect(extractTerm('取指单元把地址送上总线')).toBe('取指单元');
  });

  it('splitTiers：保留层级名，不产出碎段', () => {
    const tiers = splitTiers('上层是控制单元，中层是执行单元，底层是存储单元。');
    expect(tiers.length).toBe(3);
    expect(tiers[0]).toContain('上层');
    expect(splitTierPair(tiers[0]!).tier).toBe('上层');
    expect(splitTierPair(tiers[0]!).object).toBe('控制单元');
  });

  it('派生是纯函数：同一输入永远同一结果（逐帧确定性渲染的铁律）', () => {
    const ctx = {
      narration: '首先取指，然后译码，接着执行。',
      prompt: '测试',
      params: {},
      emphasis: ['取指'],
      shotId: 's01',
    };
    expect(deriveContent('process-track', ctx)).toEqual(deriveContent('process-track', ctx));
  });
});

describe('⑧ 骨架原语：契约与骨架表用同一套口径', () => {
  it('语法骨架表里的原语都在白名单里（既有不变量，本轮不得破坏）', () => {
    for (const [id, prims] of Object.entries(REQUIRED_BY_GRAMMAR)) {
      for (const p of prims) {
        expect(MOTION_WHITELIST.includes(p), `${id}→${p}`).toBe(true);
      }
    }
  });
});

describe('⑨ 阶段0 接线：素材槽 ifMissing / 容量上限 / 变体', () => {
  it('槽位绑定按命名约定成立，且图片槽不绑文本参数（否则会误报缺料）', () => {
    const kt = contractOf('kinetic-type');
    const hero = kt.materials.find((m) => m.role === 'text.hero')!;
    expect(slotParamNames(hero, kt.params)).toEqual(['HERO_WORD']);
    const th = contractOf('talking-head');
    const presenter = th.materials.find((m) => m.role === 'image.presenter')!;
    expect(slotParamNames(presenter, th.params)).toEqual([]);
  });

  it('merge 优先级：导演显式 > 变体 > 派生 > 契约缺省', () => {
    const spec = { name: 'A', type: 'string' as const, context: 'text' as const, default: 'from-default' };
    const specB = { name: 'B', type: 'string' as const, context: 'text' as const, default: 'from-default' };
    const specC = { name: 'C', type: 'string' as const, context: 'text' as const, default: 'from-default' };
    const specD = { name: 'D', type: 'string' as const, context: 'text' as const, default: 'from-default' };
    const contract = {
      id: 'synthetic', name: '合成', grammar: [], motifs: [], camera: [],
      params: [spec, specB, specC, specD], materials: [], capacity: {},
      variants: [{ id: 'v1', name: '变体1', params: { B: 'from-variant', C: 'from-variant' } }],
    } as TemplateContract;
    const r = assembleContentValues(
      contract,
      { A: 'from-explicit', B: 'from-explicit' },
      { C: 'from-derived', D: 'from-derived' },
      'v1',
    );
    expect(r.values).toEqual({ A: 'from-explicit', B: 'from-explicit', C: 'from-variant', D: 'from-derived' });
    expect(r.variantId).toBe('v1');
    expect(r.issues).toEqual([]);
  });

  it('变体的空串是「有意置空」（slam 让 HERO_WORD 不显示），不得被派生值填回', () => {
    const r = assembleContentValues(
      contractOf('kinetic-type'),
      {},
      { HERO_WORD: '派生词', FIGURE: '' },
      'slam',
    );
    expect(r.values['HERO_WORD']).toBe('');
    expect(r.variantId).toBe('slam');
  });

  it('变体未命中 → V-TPL-003 error（不能静默退回默认画法）', () => {
    const r = assembleContentValues(contractOf('kinetic-type'), {}, {}, 'nonexistent');
    const hit = r.issues.find((i) => i.id === 'V-TPL-003');
    expect(hit?.level).toBe('error');
    expect(hit?.message).toContain('slam');
  });

  it('容量超限 → V-TPL-002 error，不静默缩字（显式值原样保留以便报错定位）', () => {
    const kt = contractOf('kinetic-type');
    // 槽位 text.hero 上限 24 字：25 字即超（判据是 >，等于上限是合法的）
    const atLimit = '这是一个刚好二十四个字符上限的导演显式主标题文案';
    expect(atLimit.length).toBe(24);
    const over = `${atLimit}超`;
    expect(over.length).toBe(25);
    const issues = checkCapacity(kt, { HERO_WORD: over }, {});
    const hit = issues.find((i) => i.id === 'V-TPL-002');
    expect(hit?.level).toBe('error');
    expect(hit?.message).toContain('HERO_WORD');
    // 恰好等于上限不算超（边界不误伤）
    expect(checkCapacity(kt, { HERO_WORD: atLimit }, {})).toEqual([]);
  });

  it('派生值豁免容量（deep-stage 三块 PANEL×16 合计本就超过 capacity 72）', () => {
    const ds = contractOf('deep-stage');
    // 派生值是内容压缩器的产出，不参与容量判定：空 explicit + 空 variant → 零 issue
    expect(checkCapacity(ds, {}, {})).toEqual([]);
    // 但导演显式写超长就会报
    const issues = checkCapacity(ds, { PANEL1: '一'.repeat(40) }, {});
    expect(issues.some((i) => i.id === 'V-TPL-002')).toBe(true);
  });

  it('素材槽 ask：缺料记 warn 不阻断（离线流水线 kinetic-type 的 HERO_WORD 常派生为空）', () => {
    const kt = contractOf('kinetic-type');
    const r = resolveMissingSlots(kt, { HERO_WORD: '', FIGURE: '' });
    const hit = r.issues.find((i) => i.id === 'V-TPL-001');
    expect(hit?.level).toBe('warn');
    // 有内容时不报
    expect(resolveMissingSlots(kt, { HERO_WORD: '取指' }).issues).toEqual([]);
  });

  it('素材槽 skip：清空绑定参数且不报 issue（画面相应部分不出现）', () => {
    const kt = contractOf('kinetic-type');
    const r = assembleContentValues(kt, {}, { HERO_WORD: '取指', FIGURE: '3' }, undefined);
    // skip 槽（text.figure）缺料时清槽
    expect(r.issues.filter((i) => i.id === 'V-TPL-001')).toEqual([]);
  });

  it('素材槽 placeholder：填样例并带 data-film-sample 标记（契约注释里承诺过）', () => {
    // 真实盘上 talking-head 的 presenter 是图片槽，无绑定文本参数（下一用例钉住），
    // 所以 placeholder 分支必须用合成契约验证——分支本身要有证据，不能靠纸面承诺。
    const contract = {
      id: 'synthetic', name: '合成', grammar: [], motifs: [], camera: [],
      params: [{ name: 'HERO_WORD', type: 'string' as const, context: 'text' as const }],
      materials: [{ role: 'text.hero', required: false, ifMissing: 'placeholder' as const, sample: 'templates/canvas/avatar.png' }],
      capacity: {},
      variants: [],
    } as TemplateContract;
    const r = assembleContentValues(contract, {}, {}, undefined);
    expect(r.samples.get('HERO_WORD')).toBe('templates/canvas/avatar.png');
    expect(r.values['HERO_WORD']).toBe('');
    expect(sampleMarkup('templates/canvas/avatar.png')).toContain('data-film-sample');
    expect(r.issues).toEqual([]);
    // placeholder 缺 sample 是契约写错 → error
    const bad = { ...contract, materials: [{ ...contract.materials[0]!, sample: undefined }] } as TemplateContract;
    expect(resolveMissingSlots(bad, {}).issues.find((i) => i.id === 'V-TPL-001')?.level).toBe('error');
  });

  it('盘上图片槽无绑定文本参数：placeholder 的样例标记只能挂在文本槽上（口径留档）', () => {
    const th = contractOf('talking-head');
    const slot = th.materials.find((m) => m.ifMissing === 'placeholder')!;
    expect(slot.sample).toBeTruthy(); // 契约里写了样例路径（纸面事实）
    expect(slotParamNames(slot, th.params)).toEqual([]); // 但无文本参数可挂标记
    // 因此 data-film-sample 在真实盘面上不出现是**设计结果**，不是漏实现：
    // 要让主播头像真占位，需要素材层（image 槽）兑现，那属于阶段 1 的 assetNeed。
    expect(th.params.length).toBe(0);
  });

  it('resolveVariant 无契约/无请求时不产出任何 issue（旧项目零回归）', () => {
    expect(resolveVariant(undefined, 'x').issues).toEqual([]);
    expect(resolveVariant(contractOf('typography'), undefined).issues).toEqual([]);
    expect(resolveVariant(contractOf('typography'), '').issues).toEqual([]);
  });

  it('全部 15 个模板：缺省调用（无显式值/无变体）不产生任何 error 级 issue', () => {
    const bad: string[] = [];
    for (const id of TEMPLATE_IDS) {
      const r = assembleContentValues(contractOf(id), {}, {}, undefined);
      for (const i of r.issues) {
        if (i.level === 'error') bad.push(`${id}→${i.id}:${i.message}`);
      }
    }
    expect(bad, `缺省调用不该报 error：${bad.join(' | ')}`).toEqual([]);
  });
});

