/**
 * 文档漂移守卫（F12）。
 *
 * 为什么需要这个文件：本项目的失效模式**从来不是写错代码**，而是
 * **几份手写清单互相漂移**——文档说 16 个风格、磁盘只有 10 个；
 * 文档说 8 类配方、代码是 10 类；文档说 7 类转场、代码是 8 类。
 * tsc 与功能测试都抓不到，只有「拿文档对表」才能抓。
 *
 * `tests/catalog.test.ts` 之前只守 SKILL.md 的三处数字，README/docs 无人看守。
 * 本文件把守卫扩到 README.md / SKILL.md / docs/10 / docs/11。
 *
 * 守的全是**带数字的硬声明**——措辞类（"九种"）由人工改一次即可，
 * 这里钉住的是容易被复制粘贴带偏的写法：`N 个风格` / `N 类配方` / `N 类转场`。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENRES } from '../src/core/constants.js';
import { normalizeAllowed } from '../src/domain/transitions.js';
import { CAMERA_MOVES } from '../src/core/validators/scene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const STYLE_IDS = readdirSync(path.join(ROOT, 'styles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(ROOT, 'styles', f), 'utf8')).id as string);

const TEMPLATE_IDS = readdirSync(path.join(ROOT, 'templates', 'scenes'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''));

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16,
  二十: 20, 二十四: 24, 二十五: 25, 二十六: 26,
};

function parseNum(raw: string): number | undefined {
  return /^\d+$/.test(raw) ? Number(raw) : CN_NUM[raw];
}

describe('① 风格数量：文档 ↔ 磁盘', () => {
  it('README.md 声明的 registered 风格数 = 磁盘上的风格包数', () => {
    const doc = read('README.md');
    const m = doc.match(/([一二三四五六七八九十百\d]+)\s*个\s*registered\s*风格/);
    expect(m, 'README.md 里找不到「N 个 registered 风格」声明').not.toBeNull();
    const n = parseNum(m![1]!);
    expect(n, `README.md 声称 ${n} 个 registered 风格，磁盘上有 ${STYLE_IDS.length} 个`).toBe(
      STYLE_IDS.length,
    );
  });

  it('docs/11 的风格目录表只列磁盘上真实存在的风格（双向）', () => {
    const doc = read('docs/11-风格库与类型配方.md');
    const section = doc.split('## 三、风格目录')[1]?.split('### 3.1')[0] ?? '';
    expect(section, 'docs/11 里找不到「## 三、风格目录」段').not.toBe('');
    const claimed = [...section.matchAll(/^\|\s*`?([a-z0-9-]+)`?\s*\|/gm)].map((m) => m[1]!);
    expect(claimed.length, '风格目录表没解析出任何风格 id').toBeGreaterThan(0);
    // 排除表头（"风格 id"）与分隔行
    const ids = claimed.filter((id) => id !== 'id' && !id.startsWith('-'));
    const ghosts = ids.filter((id) => !STYLE_IDS.includes(id));
    expect(ghosts, `docs/11 风格目录点名了磁盘上不存在的风格：${ghosts.join(', ')}`).toEqual([]);
    const unlisted = STYLE_IDS.filter((id) => !ids.includes(id));
    expect(unlisted, `磁盘上的风格没进 docs/11 目录表：${unlisted.join(', ')}`).toEqual([]);
  });

  it('每个风格包都带 references / antiPatterns 档案，且文件真实存在', () => {
    const bad: string[] = [];
    for (const f of readdirSync(path.join(ROOT, 'styles')).filter((x) => x.endsWith('.json'))) {
      const pack = JSON.parse(read(`styles/${f}`));
      for (const field of ['references', 'antiPatterns'] as const) {
        const rel = pack[field] as string;
        if (!rel) {
          bad.push(`${pack.id} 缺 ${field}`);
          continue;
        }
        try {
          read(`styles/${rel}`);
        } catch {
          bad.push(`${pack.id}.${field} 指向不存在的文件 ${rel}`);
        }
      }
    }
    expect(bad, `风格档案缺失：${bad.join(', ')}`).toEqual([]);
  });
});

describe('② 配方数量：文档 ↔ 代码', () => {
  it('docs/11 的配方总表行数 = GENRES 的数量（双向）', () => {
    const doc = read('docs/11-风格库与类型配方.md');
    const section = doc.split('### 6.1')[1]?.split('### 6.2')[0] ?? '';
    expect(section, 'docs/11 里找不到「### 6.1」段').not.toBe('');
    const rows = section
      .split('\n')
      .map((l) => l.match(/^\|\s*([a-z][a-z0-9-]*)\s+\S/)?.[1])
      .filter((x): x is string => !!x && x !== 'genre');
    expect(rows.length, `docs/11 配方表列了 ${rows.length} 类，代码 GENRES 有 ${GENRES.length} 类`).toBe(
      GENRES.length,
    );
    const missing = GENRES.filter((g) => !rows.includes(g));
    expect(missing, `docs/11 配方表缺：${missing.join(', ')}`).toEqual([]);
    const extra = rows.filter((r) => !(GENRES as readonly string[]).includes(r));
    expect(extra, `docs/11 配方表多了代码里没有的：${extra.join(', ')}`).toEqual([]);
  });

  it('文档声明的配方类数 = 实际', () => {
    for (const doc of ['docs/11-风格库与类型配方.md', 'SKILL.md', 'README.md']) {
      const text = read(doc);
      const re = /([一二三四五六七八九十百\d]+)\s*类\s*(?:recipe|配方|场景组装)/g;
      for (const m of text.matchAll(re)) {
        const n = parseNum(m[1]!);
        expect(n, `${doc} 声称 ${n} 类配方，实际 ${GENRES.length} 类`).toBe(GENRES.length);
      }
    }
  });
});

describe('③ 转场数量：文档 ↔ 词表', () => {
  const ALL_KINDS = [
    'hard-cut', 'smash-cut', 'dissolve', 'whip-pan', 'wipe', 'slide', 'page-turn', 'fade-black',
  ];

  it('SKILL.md 声明的转场类数 = 词表里的 kind 数（不含 continuity）', () => {
    const doc = read('SKILL.md');
    const m = doc.match(/`(hard-cut)`[\s\S]{0,300}?([一二三四五六七八九十\d]+)\s*类/);
    if (!m) return;
    const n = parseNum(m[2]!);
    expect(n, `SKILL.md 声称 ${n} 类转场，实际词表 ${ALL_KINDS.length} 类`).toBe(ALL_KINDS.length);
  });

  it('每个风格包声明的转场词都真的可识别（不被静默丢弃）', () => {
    const bad: string[] = [];
    for (const f of readdirSync(path.join(ROOT, 'styles')).filter((x) => x.endsWith('.json'))) {
      const pack = JSON.parse(read(`styles/${f}`));
      const declared = (pack.transitions ?? []) as string[];
      const normalized = normalizeAllowed(declared);
      if (normalized.length !== declared.length) {
        const dropped = declared.filter((d) => !normalized.includes(d as never));
        bad.push(`${pack.id}: ${dropped.join(', ')}`);
      }
    }
    expect(
      bad,
      `风格包声明了词表里没有的转场（会被静默丢弃，该风格实际少一种转场）：${bad.join(' | ')}`,
    ).toEqual([]);
  });
});

describe('④ 模板与规范：文档 ↔ 代码', () => {
  it('docs/10 的机位词数量与代码一致', () => {
    const doc = read('docs/10-视觉与剪辑规范.md');
    const m = doc.match(/([一二三四五六七八九十百\d]+)\s*个机位/);
    if (!m) return;
    const n = parseNum(m[1]!);
    expect(n, `docs/10 声称 ${n} 个机位词，代码 ${CAMERA_MOVES.length} 个`).toBe(CAMERA_MOVES.length);
  });

  it('docs/10 的 V-MOT-008 时长档位数与校验器一致', () => {
    const doc = read('docs/10-视觉与剪辑规范.md');
    const src = read('src/core/validators/scene.ts');
    const block = src.split('const inRange =')[1]?.split(';')[0] ?? '';
    // 校验器的时长区间数（每个 `(ms >= a && ms <= b)` 算一档）
    const ranges = (block.match(/\(ms >=/g) ?? []).length;
    // docs/10 里 V-MOT-008 那一行列了几个档（「200-400 / 入场 400-800 …」）
    const row = doc.split('\n').find((l) => l.includes('V-MOT-008')) ?? '';
    const tiers = (row.match(/\d+-\d+/g) ?? []).length;
    if (tiers === 0) return;
    expect(tiers, `docs/10 的 V-MOT-008 列了 ${tiers} 档，校验器 ${ranges} 档`).toBe(ranges);
  });

  it('每个场景模板都有契约文件（模板契约层覆盖率 100%）', () => {
    const present = new Set(readdirSync(path.join(ROOT, 'templates', 'scenes')));
    const missing = TEMPLATE_IDS.filter((id) => !present.has(`${id}.meta.json`));
    expect(missing, `缺契约的模板：${missing.join(', ')}`).toEqual([]);
  });
});
