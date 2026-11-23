import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

type StylePack = {
  id: string;
  grade: string;
  status: string;
  userFacing: { bestFor: string[] };
  transitions: string[];
  provenance: { review: string };
  references: string;
  antiPatterns: string;
  visuals: {
    dimension: string;
    motifs: string[];
    sceneBias: string[];
    sceneDeny: string[];
  };
};

type Recipe = {
  id: string;
  style: { recommended: string[]; rationale: string };
};

const STYLE_FILES = readdirSync(path.join(ROOT, 'styles'))
  .filter((f) => f.endsWith('.json'))
  .sort();
const RECIPE_FILES = readdirSync(path.join(ROOT, 'recipes'))
  .filter((f) => f.endsWith('.json'))
  .sort();
const STYLE_PACKS = STYLE_FILES.map((f) => readJson<StylePack>(`styles/${f}`));
const RECIPES = RECIPE_FILES.map((f) => readJson<Recipe>(`recipes/${f}`));

function scenarioList(text: string): string[] {
  const section = text.match(/^## 适用场景\s*$([\s\S]*?)(?=^## |\Z)/m)?.[1] ?? '';
  return [...section.matchAll(/^-\s*([a-z0-9-]+)\s*$/gm)].map((m) => m[1]!);
}

function tableValue(text: string, key: string): string {
  return text.match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))?.[1]?.trim() ?? '';
}

describe('① 风格 ↔ 配方：双向绑定', () => {
  it('风格 bestFor 只指向真实配方，且配方反向推荐该风格', () => {
    const recipeById = new Map(RECIPES.map((r) => [r.id, r]));
    const bad: string[] = [];
    for (const pack of STYLE_PACKS) {
      for (const rid of pack.userFacing.bestFor) {
        const recipe = recipeById.get(rid);
        if (!recipe) {
          bad.push(`${pack.id}→${rid}（配方不存在）`);
        } else if (!recipe.style.recommended.includes(pack.id)) {
          bad.push(`${pack.id}↔${rid}（配方未反向推荐）`);
        }
      }
    }
    expect(bad, `风格 bestFor 断链：${bad.join(', ')}`).toEqual([]);
  });

  it('配方 recommended 只指向真实风格，且风格反向列入 bestFor', () => {
    const styleById = new Map(STYLE_PACKS.map((p) => [p.id, p]));
    const bad: string[] = [];
    for (const recipe of RECIPES) {
      for (const sid of recipe.style.recommended) {
        const pack = styleById.get(sid);
        if (!pack) {
          bad.push(`${recipe.id}→${sid}（风格不存在）`);
        } else if (!pack.userFacing.bestFor.includes(recipe.id)) {
          bad.push(`${recipe.id}↔${sid}（风格未反向列入 bestFor）`);
        }
      }
    }
    expect(bad, `配方 recommended 断链：${bad.join(', ')}`).toEqual([]);
  });

  it('rationale 提到某个风格 id 时，该风格必须在推荐列表里', () => {
    const bad: string[] = [];
    for (const recipe of RECIPES) {
      for (const pack of STYLE_PACKS) {
        const mentioned = new RegExp(`\\b${pack.id}\\b`).test(recipe.style.rationale);
        if (mentioned && !recipe.style.recommended.includes(pack.id)) {
          bad.push(`${recipe.id} rationale 提到但未推荐 ${pack.id}`);
        }
      }
    }
    expect(bad, `理由与推荐列表漂移：${bad.join(', ')}`).toEqual([]);
  });
});

describe('② 风格档案：场景/转场/母题双向镜像', () => {
  it('references.md 的适用场景与 bestFor 完全一致', () => {
    const bad: string[] = [];
    for (const pack of STYLE_PACKS) {
      const listed = scenarioList(read(`styles/${pack.references}`));
      const expected = [...pack.userFacing.bestFor].sort();
      if (JSON.stringify(listed.sort()) !== JSON.stringify(expected)) {
        bad.push(`${pack.id}: refs=${listed.join('/')} json=${expected.join('/')}`);
      }
    }
    expect(bad, `适用场景镜像漂移：${bad.join(' | ')}`).toEqual([]);
  });

  it('references.md 的转场/场景偏好/禁用/母题行与风格包一致', () => {
    const bad: string[] = [];
    for (const pack of STYLE_PACKS) {
      const text = read(`styles/${pack.references}`);
      const expected: Record<string, string> = {
        转场: pack.transitions.join(' / '),
        偏好场景: pack.visuals.sceneBias.join(' / '),
        禁用场景: pack.visuals.sceneDeny.join(' / ') || '-',
        母题: pack.visuals.motifs.join(' / '),
      };
      for (const [key, value] of Object.entries(expected)) {
        if (tableValue(text, key) !== value) {
          bad.push(`${pack.id}.${key}: refs=${tableValue(text, key)} json=${value}`);
        }
      }
    }
    expect(bad, `视觉参数镜像漂移：${bad.join(' | ')}`).toEqual([]);
  });

  it('anti-patterns.md 的转场行与风格包一致', () => {
    const bad: string[] = [];
    for (const pack of STYLE_PACKS) {
      const text = read(`styles/${pack.antiPatterns}`);
      const m = text.match(/^- \*\*转场\*\*：本风格只允许 (.+?)；/m);
      const allowed = m?.[1]?.trim() ?? '';
      if (allowed !== pack.transitions.join(' / ')) {
        bad.push(`${pack.id}: anti=${allowed} json=${pack.transitions.join(' / ')}`);
      }
    }
    expect(bad, `anti-patterns 转场漂移：${bad.join(' | ')}`).toEqual([]);
  });

  it('反模式文案不得把未硬兑现的母题说成必须落到模板', () => {
    const bad: string[] = [];
    for (const pack of STYLE_PACKS) {
      const text = read(`styles/${pack.antiPatterns}`);
      if (text.includes('必须在某个模板里真的被用到') || text.includes('否则是空话')) {
        bad.push(pack.id);
      }
      if (!text.includes('prompt 表达约束')) bad.push(`${pack.id}: 缺少母题兑现口径`);
    }
    expect(bad, `母题文案漂移：${bad.join(', ')}`).toEqual([]);
  });

  it('sceneBias 与 sceneDeny 不得冲突，且 sceneDeny 不留空', () => {
    const bad: string[] = [];
    for (const pack of STYLE_PACKS) {
      if (pack.visuals.sceneDeny.length === 0) bad.push(`${pack.id}: sceneDeny 为空`);
      for (const t of pack.visuals.sceneBias) {
        if (pack.visuals.sceneDeny.includes(t)) bad.push(`${pack.id}: ${t} 同时偏好与禁用`);
      }
    }
    expect(bad, `场景约束不自洽：${bad.join(', ')}`).toEqual([]);
  });
});

describe('③ 等级与母题：声明必须有边界和落点', () => {
  it('vibe-cosmos 保持 B 级未对拍，并在 docs/11 镜像为 B', () => {
    const pack = STYLE_PACKS.find((p) => p.id === 'vibe-cosmos');
    expect(pack, 'vibe-cosmos 风格包不存在').toBeDefined();
    expect(pack!.grade).toBe('B');
    expect(pack!.provenance.review).toMatch(/未对拍/);
    const row = read('docs/11-风格库与类型配方.md').match(/^\|\s*vibe-cosmos\s*\|.*$/m)?.[0] ?? '';
    expect(row).toMatch(/\|\s*\*\*B\*\*\s*\|/);
  });

  it('声明 css3d 母题风格必须显式登记 3D 原语，mixed 风格不得偷渡 3D 母题', () => {
    const bad: string[] = [];
    const threeDMotifs = ['punch-line-3d', 'heroic-low-angle', 'smash-zoom', 'freeze-frame'];
    for (const pack of STYLE_PACKS) {
      const hasThreeDMotif = pack.visuals.motifs.some((m) => threeDMotifs.includes(m));
      if (pack.visuals.dimension === 'css3d' && !hasThreeDMotif) {
        bad.push(`${pack.id}: dimension=css3d 但无 3D 母题`);
      }
      if (pack.visuals.dimension === 'mixed' && hasThreeDMotif) {
        bad.push(`${pack.id}: dimension=mixed 但声明了纯 3D 母题`);
      }
    }
    expect(bad, `维度与母题不匹配：${bad.join(', ')}`).toEqual([]);
  });

  it('风格母题命名空间互不冲突（同名母题只许一个 owner）', () => {
    const owners = new Map<string, string[]>();
    for (const pack of STYLE_PACKS) {
      for (const motif of pack.visuals.motifs) {
        owners.set(motif, [...(owners.get(motif) ?? []), pack.id]);
      }
    }
    const shared = [...owners.entries()].filter(([, list]) => list.length > 1);
    expect(
      shared.map(([m, list]) => `${m}:${list.join('/')}`),
      `共享母题需额外对账：${shared.map(([m]) => m).join(', ')}`,
    ).toEqual(['silhouette:cinematic-dark/noir-contrast']);
  });
});
