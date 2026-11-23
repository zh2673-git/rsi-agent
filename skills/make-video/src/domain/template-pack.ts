/**
 * TemplatePack：风格 × 配方 × 元素/动作谱系的跨维度打包（方案 §4.4）。
 *
 * 定位：TemplatePack 不是第四个"型"，而是把「应用场景（Recipe/题材）+ 约束场（Style）
 * + 该题材典型的元素/动作谱系提示」一次性打包的应用外壳。整包作为默认值注入项目：
 * 用户显式指定的 style/genre 优先，模板只填空缺——模板不是硬约束，随时可改。
 */
import path from 'node:path';
import { z } from 'zod';
import {
  ElementKindSchema,
  ElementRoleSchema,
  ActionLayerSchema,
  type Project,
  type StyleDecision,
} from '../core/schema.js';
import { GENRES } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import { exists, listFiles, readJson } from '../infrastructure/fs-utils.js';

export const TemplatePackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  /** 应用场景：对应的 Recipe/题材 id（GENRES 之一） */
  recipe: z.enum(GENRES),
  /** 约束场：推荐风格包 id（在 styles/ 注册） */
  style: z.string().min(1),
  /** 该题材典型的元素谱系提示（走编剧/分镜的语义引导，不直接写入 shots） */
  elementHints: z.array(z.object({
    kind: ElementKindSchema,
    role: ElementRoleSchema,
    hint: z.string(),
  })).default([]),
  /** 该题材典型的动作谱系提示 */
  actionHints: z.array(z.object({
    layer: ActionLayerSchema,
    hint: z.string(),
  })).default([]),
});
export type TemplatePack = z.infer<typeof TemplatePackSchema>;

const TEMPLATES_DIR = 'templates/packs';

/** 从 root/templates/packs/*.json 加载模板包；坏包抛 SCHEMA 错误（与风格/配方一致） */
export async function loadTemplatePacks(root: string): Promise<Map<string, TemplatePack>> {
  const dir = path.join(root, TEMPLATES_DIR);
  const result = new Map<string, TemplatePack>();
  if (!(await exists(dir))) return result;
  for (const file of await listFiles(dir)) {
    if (!file.endsWith('.json')) continue;
    const raw = await readJson<unknown>(file);
    const parsed = TemplatePackSchema.safeParse(raw);
    if (!parsed.success) {
      throw mvError(ERR.SCHEMA, `模板包 ${file} 校验失败: ${parsed.error.message}`);
    }
    if (result.has(parsed.data.id)) {
      throw mvError(ERR.SCHEMA, `模板包 id 重复: ${parsed.data.id}`);
    }
    result.set(parsed.data.id, parsed.data);
  }
  return result;
}

export interface ApplyTemplateResult {
  applied: boolean;
  packId: string;
  /** 实际改写了哪些字段（便于 CLI 回显，不写死语义） */
  filled: string[];
}

/**
 * 把模板整包作为默认值注入项目（只填未指定项，用户显式选择优先）。
 * - recipe → project.meta.genre（仅当 genre 还是缺省值 science-explainer 且未显式给定时由调用方决定）
 * - style  → project.style（user-specified + lineage 记录模板来源）
 * - templateId → project.templateId（追溯）
 * elementHints/actionHints 只留在模板包里供上游读取（当前不直接写 shots，避免覆盖人工精修）。
 */
export function applyTemplate(
  project: Project,
  pack: TemplatePack,
  opts: { forceGenre?: boolean; forceStyle?: boolean } = {},
): ApplyTemplateResult {
  const filled: string[] = [];
  if (opts.forceGenre || project.meta.genre === 'science-explainer') {
    project.meta.genre = pack.recipe;
    filled.push('genre');
  }
  if (opts.forceStyle || !project.style) {
    const decision: StyleDecision = {
      id: pack.style,
      source: 'user-specified',
      rationale: `模板包 ${pack.id} 预绑风格 ${pack.style}`,
      lineage: { template: pack.id },
      overrides: {},
    };
    project.style = decision;
    filled.push('style');
  }
  project.templateId = pack.id;
  filled.push('templateId');
  return { applied: true, packId: pack.id, filled };
}
