import type { LlmClient } from '../infrastructure/llm-client.js';
import type { Project, Recipe, Script } from '../core/schema.js';
import { MS_PER_CHAR_CN } from '../core/constants.js';
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
  const issues = [
    ...validateScript(script, recipe),
    ...validateCharBudget(script, recipe, tier),
    // 内容门（v1.1.1）：形式校验全绿不代表讲稿有内容——套话循环必须在这里被拦住
    ...V.validateScriptContent(script, topic ?? project.meta.topic),
  ];
  if (V.hasError(issues)) {
    throw mvError(ERR.SCRIPT_FUNCTION, `讲稿校验失败:\n${V.formatIssues(issues)}`);
  }
  // warn 级问题落盘留痕，避免「静默通过」
  if (issues.length > 0) {
    console.warn(`[script] 内容门提醒:\n${V.formatIssues(issues)}`);
  }
  project.script = script;
  project.stage = 'script';
  await store.save(project);
  return script;
}

/**
 * 重音词归一化（v1.1.1）。
 *
 * 为什么需要兜底：真实 LLM 常漏 `emphasis` 字段（本轮案例 30/30 段全空），
 * 而剪辑部的 V-RHY-004 要求每镜至少两路重音载体——零高亮会让整片 compose 打回，
 * 而这其实是「模型漏字段」而不是「片子不想给重音」。所以：
 *   - 模型给了且能对上原文 → 原样保留（去掉空串与整句）；
 *   - 没给 / 全对不上 → 从原文派生 1-3 个可用词（中文取内容 2-gram，去掉虚词开头）。
 * 派生只保证「有落点」，不追求最优——真正的重音语义仍以模型输出为准。
 */
export function normalizeEmphasis(raw: unknown, text: string): string[] {
  const picked = Array.isArray(raw)
    ? raw.filter((w): w is string => typeof w === 'string' && w.trim().length > 0 && text.includes(w))
    : [];
  if (picked.length > 0) return [...new Set(picked)].slice(0, 3);
  return deriveEmphasis(text);
}

/** 从一句旁白里派生候选重音词：跳过虚词开头，优先带数字/英文/专有感的片段 */
const STOP_HEADS = new Set(['的', '了', '是', '在', '和', '就', '也', '都', '而', '它', '你', '我', '这', '那', '把', '被', '让', '给', '更', '最', '不', '没']);

export function deriveEmphasis(text: string): string[] {
  const clean = text.replace(/[，。、！？；：""''（）()《》…—]/g, ' ');
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 2);
  // 优先：含数字或英文的 token（"4GHz""流水线五个阶段"这类最像重音）
  const strong = tokens.filter((t) => /\d|[A-Za-z]{2,}/.test(t));
  const pool = strong.length > 0 ? strong : tokens;
  const out: string[] = [];
  for (const t of pool) {
    if (out.length >= 2) break;
    const head = [...t].slice(0, 2).join('');
    if (STOP_HEADS.has([...t][0]!)) continue;
    // 太短的整句片段不好高亮，取 2-4 字的内容核
    out.push(t.length <= 4 ? t : head);
  }
  // 全被虚词过滤掉时，退化为「去标点前 2 字」，保证非空
  if (out.length === 0 && clean.replace(/\s/g, '').length >= 2) {
    out.push([...clean.replace(/\s/g, '')].slice(0, 2).join(''));
  }
  return [...new Set(out)];
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
      // emphasis 缺失时按原文派生（详见 deriveEmphasis）：
      // 模型漏字段是小概率常态，但整片零高亮会让 V-RHY-004 一票否决、
      // 且观众失去重音提示——兜底派生而不是判死。
      emphasis: normalizeEmphasis(seg.emphasis, seg.text),
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

// V-SCP-005 字数档位（warn）：中文讲稿要按「字」算，不能拿 wordsPerMin（英文单词/分）当目标——
// 旧口径 130 words/min × 2.5min = 325「字」，而中文口播真实容量是 60000/220 ≈ 273 字/分（≈682 字），
// 于是几乎所有正常中文讲稿都被报「字数偏离」，警告变噪音、门就废了。
// 现口径：目标字数 = 档位时长 / MS_PER_CHAR_CN，容差 ±20%（TTS 语速本身有 10-15% 波动）。
const CHAR_BUDGET_TOLERANCE = 0.2;
export function validateCharBudget(script: Script, recipe: Recipe, tier: string): V.Issue[] {
  const minutes = TIER_MINUTES[tier];
  if (!minutes) return [];
  const target = Math.round((minutes * 60 * 1000) / MS_PER_CHAR_CN);
  const actual = countChars(script);
  const lo = target * (1 - CHAR_BUDGET_TOLERANCE);
  const hi = target * (1 + CHAR_BUDGET_TOLERANCE);
  if (actual < lo || actual > hi) {
    return [
      V.warn(
        'V-SCP-005',
        `总字数 ${actual} 偏离档位目标 ${target}（±${Math.round(CHAR_BUDGET_TOLERANCE * 100)}%，${tier} 档，按 ${MS_PER_CHAR_CN}ms/字）`,
      ),
    ];
  }
  return [];
}

export function countChars(script: Script): number {
  return script.segments.reduce((acc, s) => acc + s.text.length, 0);
}
