import { ASSET_NEEDS, COUNTERPOINTS } from '../core/schema.js';
import { MS_PER_CHAR_CN } from '../core/constants.js';
import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import path from 'node:path';
// V-RHY-003 密度曲线：镜长=旁白段时长，0-5min 档要求 1.5-3s 级剪切密度。
// 中文旁白一语义单元约 12-28 字 ≈ 3-6s，按档位时长中点推导目标段数（段长≈5s）。
// 段数按档位时长中点推导（段长≈5s；V-RHY-003 语速铁律是真正的约束，段数只是给 LLM 的脚手架）。
// short-60：60-90s 竖屏知识片（vibe 知识大赏档），12-18 镜（镜长≈4-6s，含 0-2s 钩子镜）。
const TARGET_SEGMENTS = { 'short-60': 15, '0-5': 30, '5-10': 90, '10+': 144 };
const TIER_MINUTES = { 'short-60': 1.125, '0-5': 2.5, '5-10': 7.5, '10+': 12 };
export async function writeScript(store, project, llm, recipe, topic) {
    const tier = project.meta.durationTier;
    const targetSegments = TARGET_SEGMENTS[tier] ?? 5;
    const wordsPerMin = recipe.durationTiers[tier]?.wordsPerMin ?? 130;
    const raw = await llm.generate({
        kind: 'script',
        payload: {
            topic: topic ?? project.meta.topic,
            wordsPerMin,
            targetSegments,
            genre: recipe.id,
            durationTier: tier,
        },
    });
    const script = parseScript(raw);
    const issues = [
        ...validateScript(script),
        ...validateCharBudget(script, recipe, tier),
        // 内容门（v1.1.1）：形式校验全绿不代表讲稿有内容——套话循环必须在这里被拦住
        ...V.validateScriptContent(script, topic ?? project.meta.topic),
    ];
    if (V.hasError(issues)) {
        // 拒稿留痕：把被拒讲稿写进 logs/script-rejected.json，否则无法归因「模型这次写了什么」
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const logDir = path.join(store.projectDir(project.meta.id), 'logs');
        try {
            mkdirSync(logDir, { recursive: true });
            writeFileSync(path.join(logDir, 'script-rejected.json'), JSON.stringify({ at: new Date().toISOString(), topic, issues: V.formatIssues(issues), script }, null, 2), 'utf8');
        }
        catch {
            // 留痕失败不改变主错误
        }
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
export function normalizeEmphasis(raw, text) {
    const picked = Array.isArray(raw)
        ? raw.filter((w) => typeof w === 'string' && w.trim().length > 0 && text.includes(w))
        : [];
    if (picked.length > 0)
        return [...new Set(picked)].slice(0, 3);
    return deriveEmphasis(text);
}
/** 从一句旁白里派生候选重音词：跳过虚词开头，优先带数字/英文/专有感的片段 */
const STOP_HEADS = new Set(['的', '了', '是', '在', '和', '就', '也', '都', '而', '它', '你', '我', '这', '那', '把', '被', '让', '给', '更', '最', '不', '没']);
export function deriveEmphasis(text) {
    const clean = text.replace(/[，。、！？；：""''（）()《》…—]/g, ' ');
    const tokens = clean.split(/\s+/).filter((t) => t.length >= 2);
    // 优先：含数字或英文的 token（"4GHz""流水线五个阶段"这类最像重音）
    const strong = tokens.filter((t) => /\d|[A-Za-z]{2,}/.test(t));
    const pool = strong.length > 0 ? strong : tokens;
    const out = [];
    for (const t of pool) {
        if (out.length >= 2)
            break;
        const head = [...t].slice(0, 2).join('');
        if (STOP_HEADS.has([...t][0]))
            continue;
        // 太短的整句片段不好高亮，取 2-4 字的内容核
        out.push(t.length <= 4 ? t : head);
    }
    // 全被虚词过滤掉时，退化为「去标点前 2 字」，保证非空
    if (out.length === 0 && clean.replace(/\s/g, '').length >= 2) {
        out.push([...clean.replace(/\s/g, '')].slice(0, 2).join(''));
    }
    return [...new Set(out)];
}
export function parseScript(raw) {
    const obj = raw;
    if (!obj || typeof obj.fullText !== 'string' || !Array.isArray(obj.segments)) {
        throw mvError(ERR.LLM_SCHEMA, 'LLM 讲稿输出不符合 Script schema');
    }
    const segments = obj.segments.map((s, i) => {
        const seg = s;
        if (!seg.text)
            throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段缺少 text`);
        // V-SCP-001：功能必填，禁止默认值架空校验（此前缺省填 inform 使校验永不触发）
        if (!seg.function)
            throw mvError(ERR.SCRIPT_FUNCTION, `第 ${i + 1} 段未标功能（V-SCP-001）`);
        if (!['advance', 'inform', 'emotion'].includes(seg.function)) {
            throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段功能非法: ${seg.function}`);
        }
        if (seg.mood && !['neutral', 'curious', 'tense', 'awe', 'warm', 'urgent'].includes(seg.mood)) {
            throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段情绪非法: ${seg.mood}`);
        }
        // P13 阶段1（A2）：四个表达层字段照 mood 的纪律——写了就校验，写错就报错，
        // 没写就整键不出现（不是往 IR 里塞空串/默认值，否则「未声明」与「声明为空」不可分）。
        if (seg.assetNeed && !ASSET_NEEDS.includes(seg.assetNeed)) {
            throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段素材诉求非法: ${seg.assetNeed}`);
        }
        if (seg.counterpoint && !COUNTERPOINTS.includes(seg.counterpoint)) {
            throw mvError(ERR.LLM_SCHEMA, `第 ${i + 1} 段对位模式非法: ${seg.counterpoint}`);
        }
        return {
            id: seg.id ?? `seg-${i + 1}`,
            text: seg.text,
            function: seg.function,
            ...(seg.beat ? { beat: seg.beat } : {}),
            ...(seg.mood ? { mood: seg.mood } : {}),
            // emphasis 缺失时按原文派生（详见 deriveEmphasis）：
            // 模型漏字段是小概率常态，但整片零高亮会让 V-RHY-004 一票否决、
            // 且观众失去重音提示——兜底派生而不是判死。
            emphasis: normalizeEmphasis(seg.emphasis, seg.text),
            ...(Array.isArray(seg.pausesMs) ? { pausesMs: seg.pausesMs } : {}),
            ...(seg.subtext ? { subtext: seg.subtext } : {}),
            ...(seg.emotion ? { emotion: seg.emotion } : {}),
            ...(seg.assetNeed ? { assetNeed: seg.assetNeed } : {}),
            ...(seg.counterpoint
                ? { counterpoint: seg.counterpoint }
                : {}),
        };
    });
    return { fullText: obj.fullText, segments };
}
export function validateScript(script) {
    const issues = [];
    // 表达层解放：结构、beat、钩子、信息节奏全部交还编剧/导演按主题实例判断。
    // 引擎只守一条硬底线：每段必须声明 function（下游分镜/剪辑的依赖，不是创作框架）。
    // 曾有过 V-SCP-003（beat 覆盖）/V-SCP-004（钩子前置）/V-SCP-007（连续 inform）
    // 三条 error/warn 门，实测它们把「结构」误当「质量」，按主题自由谱写的好稿会被
    // 因为「第一段不是钩子」直接拒稿——这是用死结构替代创作判断，已移除。
    for (const seg of script.segments) {
        if (!seg.function) {
            issues.push(V.err('V-SCP-001', `段落 ${seg.id} 未标功能`));
        }
    }
    return issues;
}
// V-SCP-005 字数档位（warn）：中文讲稿要按「字」算，不能拿 wordsPerMin（英文单词/分）当目标——
// 旧口径 130 words/min × 2.5min = 325「字」，而中文口播真实容量是 60000/220 ≈ 273 字/分（≈682 字），
// 于是几乎所有正常中文讲稿都被报「字数偏离」，警告变噪音、门就废了。
// 现口径：目标字数 = 档位时长 / MS_PER_CHAR_CN，容差 ±20%（TTS 语速本身有 10-15% 波动）。
const CHAR_BUDGET_TOLERANCE = 0.2;
export function validateCharBudget(script, recipe, tier) {
    const minutes = TIER_MINUTES[tier];
    if (!minutes)
        return [];
    const target = Math.round((minutes * 60 * 1000) / MS_PER_CHAR_CN);
    const actual = countChars(script);
    const lo = target * (1 - CHAR_BUDGET_TOLERANCE);
    const hi = target * (1 + CHAR_BUDGET_TOLERANCE);
    if (actual < lo || actual > hi) {
        return [
            V.warn('V-SCP-005', `总字数 ${actual} 偏离档位目标 ${target}（±${Math.round(CHAR_BUDGET_TOLERANCE * 100)}%，${tier} 档，按 ${MS_PER_CHAR_CN}ms/字）`),
        ];
    }
    return [];
}
export function countChars(script) {
    return script.segments.reduce((acc, s) => acc + s.text.length, 0);
}
