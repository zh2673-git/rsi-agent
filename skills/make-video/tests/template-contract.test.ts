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
