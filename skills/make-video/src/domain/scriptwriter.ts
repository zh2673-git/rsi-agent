import type { LlmClient } from '../infrastructure/llm-client.js';
import type { Project, Recipe, Script } from '../core/schema.js';
import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import type { ProjectStore } from '../infrastructure/project-store.js';

// V-RHY-003 密度曲线：镜长=旁白段时长，0-5min 档要求 1.5-3s 级剪切密度。
// 中文旁白一语义单元约 12-28 字 ≈ 3-6s，按档位时长中点推导目标段数（段长≈5s）。
const TARGET_SEGMENTS: Record<string, number> = { '0-5': 30, '5-10': 90, '10+': 144 };
const TIER_MINUTES: Record<string, number> = { '0-5': 2.5, '5-10': 7.5, '10+': 12 };

export async function writeScript(
  store: ProjectStore,
  project: Project,
  llm: LlmClient,
  recipe: Recipe,
  topic?: string,
): Promise<Script> {
  const tier = project.meta.durationTier;
  const targetSegments = TARGET_SEGMENTS[tier] ?? 5;
  const wordsPerMin = recipe.durationTiers[tier]?.wordsPerMin ?? 130;
  const raw = await llm.generate({
    kind: 'script',
    payload: {
      topic: topic ?? project.meta.topic,
      beats: recipe.beats,
      wordsPerMin,
      targetSegments,
      genre: recipe.id,
      durationTier: tier,
    },
  });
  const script = parseScript(raw);
  const issues = [...validateScript(script, recipe), ...validateCharBudget(script, recipe, tier)];
  if (V.hasError(issues)) {
    throw mvError(ERR.SCRIPT_FUNCTION, `讲稿校验失败:\n${V.formatIssues(issues)}`);
  }
  project.script = script;
  project.stage = 'script';
  await store.save(project);
  return script;
}

export function parseScript(raw: unknown): Script {
  const obj = raw as { fullText?: string; segments?: unknown };
  if (!obj || typeof obj.fullText !== 'string' || !Array.isArray(obj.segments)) {
    throw mvError(ERR.LLM_SCHEMA, 'LLM 讲稿输出不符合 Script schema');
  }
  const segments = obj.segments.map((s, i) => {
    const seg = s as {
      id?: string;
      text?: string;
      function?: string;
      beat?: string;
      mood?: string;
      emphasis?: string[];
      pausesMs?: number[];
    };
    if (!seg.text) throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段缺少 text`);
    // V-SCP-001：功能必填，禁止默认值架空校验（此前缺省填 inform 使校验永不触发）
    if (!seg.function) throw mvError(ERR.SCRIPT_FUNCTION, `第 ${i + 1} 段未标功能（V-SCP-001）`);
    if (!['advance', 'inform', 'emotion'].includes(seg.function)) {
      throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段功能非法: ${seg.function}`);
    }
    if (seg.mood && !['neutral', 'curious', 'tense', 'awe', 'warm', 'urgent'].includes(seg.mood)) {
      throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段情绪非法: ${seg.mood}`);
    }
    return {
      id: seg.id ?? `seg-${i + 1}`,
      text: seg.text,
      function: seg.function as Script['segments'][number]['function'],
      ...(seg.beat ? { beat: seg.beat } : {}),
      ...(seg.mood ? { mood: seg.mood as Script['segments'][number]['mood'] } : {}),
      ...(Array.isArray(seg.emphasis) ? { emphasis: seg.emphasis } : {}),
      ...(Array.isArray(seg.pausesMs) ? { pausesMs: seg.pausesMs } : {}),
    };
  });
  return { fullText: obj.fullText, segments };
}

export function validateScript(script: Script, recipe: Recipe): V.Issue[] {
  const issues: V.Issue[] = [];
  for (const seg of script.segments) {
    if (!seg.function) {
      issues.push(V.err('V-SCP-001', `段落 ${seg.id} 未标功能`));
    }
  }
  const beats = new Set(script.segments.map((s) => s.beat).filter(Boolean));
  const keyBeats = recipe.beats.filter((b) => b.id === 'hook' || b.function);
  for (const kb of keyBeats) {
    if (!beats.has(kb.id)) {
      issues.push(V.err('V-SCP-003', `beats 未覆盖关键节点 ${kb.id}(${kb.name})`));
    }
  }
  let informStreak = 0;
  for (const seg of script.segments) {
    informStreak = seg.function === 'inform' ? informStreak + 1 : 0;
    if (informStreak >= 3) {
      issues.push(V.warn('V-SCP-007', `连续三段 inform（信息倾倒）至 ${seg.id}`));
      informStreak = 0;
    }
  }
  // V-SCP-004 钩子前置：第一段必须落在 hook beat（三段式结构的硬起点）
  const hookBeat = recipe.beats[0];
  const first = script.segments[0];
  if (hookBeat && first && (!first.beat || first.beat !== hookBeat.id)) {
    issues.push(V.err('V-SCP-004', `第一段 ${first.id} 未落在钩子 beat「${hookBeat.id}」（钩子必须前置）`));
  }
  return issues;
}

// V-SCP-005 字数档位 ±10%（warn）：目标字数 = wordsPerMin × 档位时长中点
export function validateCharBudget(script: Script, recipe: Recipe, tier: string): V.Issue[] {
  const wpm = recipe.durationTiers[tier]?.wordsPerMin;
  const minutes = TIER_MINUTES[tier];
  if (!wpm || !minutes) return [];
  const target = Math.round(wpm * minutes);
  const actual = countChars(script);
  const lo = target * 0.9;
  const hi = target * 1.1;
  if (actual < lo || actual > hi) {
    return [
      V.warn('V-SCP-005', `总字数 ${actual} 偏离档位目标 ${target}（±10%，${tier} 档）`),
    ];
  }
  return [];
}

export function countChars(script: Script): number {
  return script.segments.reduce((acc, s) => acc + s.text.length, 0);
}
