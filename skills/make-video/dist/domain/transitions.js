const ALIASES = {
    'hard-cut': 'hard-cut',
    hardcut: 'hard-cut',
    cut: 'hard-cut',
    none: 'hard-cut',
    'smash-cut': 'smash-cut',
    smashcut: 'smash-cut',
    dissolve: 'dissolve',
    crossfade: 'dissolve',
    'whip-pan': 'whip-pan',
    whippan: 'whip-pan',
    whip: 'whip-pan',
    wipe: 'wipe',
    slide: 'slide',
    push: 'slide',
    'fade-black': 'fade-black',
    fadeblack: 'fade-black',
    'fade-to-black': 'fade-black',
    ftb: 'fade-black',
};
// 每个转场的时长与重叠：溶解/擦除必须重叠才不会出现"淡到黑再亮起"的翻页感
const TIMING = {
    'hard-cut': { durationMs: 0, overlapMs: 0 },
    'smash-cut': { durationMs: 320, overlapMs: 0 },
    dissolve: { durationMs: 420, overlapMs: 420 },
    'whip-pan': { durationMs: 360, overlapMs: 300 },
    wipe: { durationMs: 420, overlapMs: 420 },
    slide: { durationMs: 420, overlapMs: 420 },
    // 只有明确声明 fade-black 的风格包才走"黑场过渡"；默认风格词表里没有它
    'fade-black': { durationMs: 600, overlapMs: 300 },
};
export function normalizeTransition(word) {
    if (!word)
        return null;
    return ALIASES[word.trim().toLowerCase()] ?? null;
}
/**
 * 按风格包词表裁决转场：
 * - 词在词表内 → 用它；
 * - 词不在词表内 → 回退到词表第一项（词表为空则 hard-cut），并留下 warning。
 */
export function planTransition(word, allowed) {
    const allowKinds = allowed
        .map((w) => normalizeTransition(w))
        .filter((k) => k !== null);
    const fallback = allowKinds[0] ?? 'hard-cut';
    const wanted = normalizeTransition(word);
    if (!wanted) {
        return { kind: fallback, ...TIMING[fallback], ...(word ? { warning: `未知转场「${word}」→ ${fallback}` } : {}) };
    }
    if (allowKinds.length === 0 || allowKinds.includes(wanted)) {
        return { kind: wanted, ...TIMING[wanted] };
    }
    return {
        kind: fallback,
        ...TIMING[fallback],
        warning: `转场「${wanted}」不在风格包词表 [${allowKinds.join(', ')}] → ${fallback}`,
    };
}
const MOTIVATION_RULES = [
    [/同形|同构|接住|呼应|对齐|无缝/, 'match-cut'],
    [/动作|冲|甩|撞|砸|打断|爆发|抢|跑|追|落|掀|推倒/, 'action'],
    [/视线|目光|看向|对视|回头|眼神|注视/, 'eye-line'],
    [/情绪|沉默|停顿|回忆|怅惘|温柔|悲|温暖|顿悟|感慨|安静|留白|余味/, 'emotion'],
    [/节拍|打点|包袱|反转|梗|抖|停一拍|冷场/, 'beat'],
    [/景别|推近|拉远|跳切|特写|机位|zoom/i, 'zoom-jump'],
];
/** 从导演写的一句动机话里判定切点动机类型；判不出返回空（不拿"有文案"冒充动机） */
export function cutMotivation(text) {
    const t = (text ?? '').trim();
    if (!t)
        return '';
    for (const [re, kind] of MOTIVATION_RULES)
        if (re.test(t))
            return kind;
    return '';
}
const ZOOM_ORDER = { ELS: 0, LS: 1, MS: 2, CU: 3, ECU: 4 };
/**
 * 导演没写清理由时，剪辑部从两镜的客观关系反推动机（docs/08）：
 * 景别跨两档以上→跳切；同场主体方位反转→接视线；落点镜突然切进笑点→接节拍。
 */
export function deriveRelationMotivation(prev, cur) {
    const gap = Math.abs((ZOOM_ORDER[prev.zoom] ?? 2) - (ZOOM_ORDER[cur.zoom] ?? 2));
    if (gap >= 2)
        return 'zoom-jump';
    if (prev.scene === cur.scene && prev.side !== cur.side)
        return 'eye-line';
    if (cur.gag && !prev.gag)
        return 'beat';
    return '';
}
/** 转场词未显式声明（auto/空）时，由动机给出默认裁决 */
export function motivationTransition(m) {
    if (m === 'emotion')
        return 'dissolve';
    if (m === 'action' || m === 'beat')
        return 'smash-cut';
    return 'hard-cut';
}
