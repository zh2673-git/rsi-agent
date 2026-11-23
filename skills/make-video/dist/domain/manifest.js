import { ACCENT_PRIMITIVES, MOTION_WHITELIST } from '../core/validators/scene.js';
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
/** 动作原语 → 心智模型四层（方案 §1）。
 *  motifLoop/idle/performance → ambient；camera → camera；
 *  emphasis/slam/punch/whip/highlight → emphasis；其余 → subject。 */
export function actionLayerOf(primitive) {
    if (primitive === 'MV.camera')
        return 'camera';
    if (['MV.motifLoop', 'MV.idle', 'MV.performance'].includes(primitive))
        return 'ambient';
    if (['MV.emphasis', ...ACCENT_PRIMITIVES, 'MV.highlight'].includes(primitive))
        return 'emphasis';
    return 'subject';
}
function guessKind(tag, cls) {
    const t = `${tag} ${cls}`.toLowerCase();
    if (/img|image|photo/.test(t))
        return 'image';
    if (/video|clip/.test(t))
        return 'video';
    if (/particle|canvas|svg/.test(t))
        return 'particle';
    if (/text|title|label|caption|note|word|p$|h[1-6]/.test(t))
        return 'text';
    if (/side|card|box|panel|container|stage|wrap/.test(t))
        return 'container';
    return 'shape';
}
function guessRole(cls, index, total) {
    const c = cls.toLowerCase();
    if (/caption|subtitle|note|label/.test(c))
        return 'caption';
    if (/bg|background|grain|vignette|letterbox|env/.test(c))
        return 'env';
    if (/deco|ornament|glow|dot/.test(c))
        return 'deco';
    // 兜底：第一个非环境元素视为 subject，其余为 deco（反向抽取只能给出倾向，人工可改）
    return index === 0 || total === 1 ? 'subject' : 'deco';
}
/** 从 MV.xxx(selector, {...}) 调用中解析出 target 选择器。
 *  selector 为字符串字面量（'.title' / '#x' / 'div'）；取第一个参数。 */
function parseTarget(call) {
    const m = call.match(/^MV\.[A-Za-z]+\s*\(\s*(['"])(.*?)\1/);
    return m?.[2] ?? 'scene';
}
/** 粗解析参数对象里的关键字段（duration/delay/ease/kind/amp），保留原始字面量供预览展示。 */
function parseParams(call) {
    const body = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
    const params = {};
    for (const key of ['duration', 'delay', 'ease', 'easing', 'kind', 'amp', 'stiffness', 'damping']) {
        const m = body.match(new RegExp(`\\b${key}\\s*:\\s*('[^']*'|"[^"]*"|[\\d.]+)`));
        if (m) {
            const raw = m[1] ?? '';
            params[key] = raw.startsWith("'") || raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
        }
    }
    return params;
}
/**
 * 从场景 HTML 反向抽取两清单（P1 纯只读）。
 * 元素：取 body 内带 class 或 id 的可见标签，去重；跳过 script/style/背景修饰层。
 * 动作：匹配 MV.<白名单>(...) 调用，按四层分类，target 关联到元素 id（选择器命中）或 'scene'。
 */
export function extractManifestsFromHtml(html) {
    const elements = [];
    const seenSelectors = new Set();
    // 抽可见元素：逐个开标签取（不用成对标签正则——外层 html/body 会把内层全吞掉）。
    // 先剔除 script/style 块（里面是 MV.* 代码，不是画面元素），再取文案为标签后紧跟的文本节点。
    const SKIP = new Set(['script', 'style', 'head', 'html', 'body', 'title', 'meta', 'link', 'br', 'img', 'input', 'hr']);
    const stripped = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
    for (const m of stripped.matchAll(tagRe)) {
        const tag = (m[1] ?? '').toLowerCase();
        if (!tag || SKIP.has(tag))
            continue;
        const attrs = m[2] ?? '';
        const clsM = attrs.match(/class\s*=\s*["']([^"']+)["']/);
        const idM = attrs.match(/id\s*=\s*["']([^"']+)["']/);
        const cls = clsM?.[1] ?? '';
        const id = idM?.[1] ?? '';
        const selector = id ? `#${id}` : cls ? `.${cls.trim().split(/\s+/).join('.')}` : tag;
        if (seenSelectors.has(selector))
            continue;
        // 文案 = 该开标签后紧跟的文本节点（到下一个 '<' 为止）
        const after = stripped.slice((m.index ?? 0) + m[0].length);
        const textM = after.split('<')[0].replace(/\{\{[^}]+\}\}/g, '').trim();
        const text = textM && !textM.includes('MV.') ? textM.slice(0, 60) : '';
        seenSelectors.add(selector);
        elements.push({
            id: `el${elements.length + 1}`,
            kind: guessKind(tag, cls),
            role: guessRole(cls, elements.length, 1),
            source: 'code',
            visual: { selector, text, src: '', color: '' },
            visibility: {},
        });
    }
    // role 兜底二次修正：非首个 text/容器视为 deco，保证至少有一个 subject
    elements.forEach((el, i) => {
        el.role = guessRole(el.visual.selector, i, elements.length);
    });
    const actions = [];
    const callRe = new RegExp(`(MV\\.(?:${MOTION_WHITELIST.map((p) => p.slice(3)).join('|')}))\\s*\\(([^)]*)\\)`, 'g');
    for (const m of html.matchAll(callRe)) {
        const primitive = m[1] ?? '';
        const call = m[0] ?? '';
        const targetSel = parseTarget(call);
        // target 关联：选择器命中元素 → 元素 id；否则 'scene'
        const matched = elements.find((el) => el.visual.selector === targetSel)
            ?? elements.find((el) => targetSel !== 'scene' && el.visual.selector.includes(targetSel.replace(/^[.#]/, '')));
        actions.push({
            id: `ac${actions.length + 1}`,
            target: matched?.id ?? 'scene',
            layer: actionLayerOf(primitive),
            primitive,
            params: parseParams(call),
            timing: {},
        });
    }
    return { elements, actions };
}
/** 两清单规则前置可视（方案 §6 ⑤）：target 引用完整性 + 重音/并发预算。
 *  与 V-* 校验器同口径：重音 ≤ 镜数 1/3（V-MOT-013），但这里按单镜提示，warn 不拒。 */
export function validateManifests(project) {
    const issues = [];
    const shots = project.shots.filter((s) => s.elements || s.actions);
    let emphasisCount = 0;
    for (const shot of shots) {
        const ids = new Set(shot.elements?.map((e) => e.id) ?? []);
        for (const ac of shot.actions ?? []) {
            if (ac.target !== 'scene' && !ids.has(ac.target)) {
                issues.push({
                    code: 'V-MAN-001',
                    level: 'error',
                    detail: `镜 ${shot.id} 动作 ${ac.id}(${ac.primitive}) 的 target=${ac.target} 不存在`,
                });
            }
            if (ac.layer === 'emphasis')
                emphasisCount += 1;
        }
        if ((shot.actions?.length ?? 0) > 8) {
            issues.push({ code: 'V-MAN-002', level: 'warn', detail: `镜 ${shot.id} 动作数 ${shot.actions?.length} > 8，主体动作过挤` });
        }
    }
    if (shots.length > 0 && emphasisCount > Math.floor(shots.length / 3)) {
        issues.push({
            code: 'V-MOT-013',
            level: 'warn',
            detail: `重音动作 ${emphasisCount} 超过镜数 1/3（${Math.floor(shots.length / 3)}），预览阶段标红`,
        });
    }
    return issues;
}
/**
 * 由时间线回填 visibility / timing（方案 §5.6）——只读返回新对象，不改入参。
 * 每个 shot 的 durationMs/startMs 来自 timeline（配音时长真源），不写进元素/动作本身。
 */
export function backfillVisibility(project) {
    const byShot = new Map(project.timeline?.shots.map((t) => [t.shotId, t]) ?? []);
    const shots = project.shots.map((shot) => {
        if (!shot.elements && !shot.actions)
            return shot;
        const tl = byShot.get(shot.id);
        if (!tl)
            return shot;
        const endMs = tl.startMs + tl.durationMs;
        return {
            ...shot,
            elements: shot.elements?.map((el) => ({
                ...el,
                visibility: {
                    startMs: el.visibility.startMs ?? tl.startMs,
                    endMs: el.visibility.endMs ?? endMs,
                },
            })),
            actions: shot.actions?.map((ac) => ({
                ...ac,
                timing: {
                    atMs: ac.timing.atMs ?? tl.startMs,
                    durMs: ac.timing.durMs ?? tl.durationMs,
                },
            })),
        };
    });
    return { ...project, shots };
}
/** 时间切片（方案 §5.6）：输入绝对毫秒，返回当刻可见元素 + 在跑动作。 */
export function queryTimeSlice(project, atMs) {
    const result = {
        atMs,
        elements: [],
        actions: [],
    };
    for (const shot of project.shots) {
        const tl = project.timeline?.shots.find((t) => t.shotId === shot.id);
        const inShot = tl ? atMs >= tl.startMs && atMs < tl.startMs + tl.durationMs : false;
        if (inShot)
            result.shotId = shot.id;
        const vis = (v) => (v.startMs === undefined || atMs >= v.startMs) && (v.endMs === undefined || atMs < v.endMs);
        for (const el of shot.elements ?? []) {
            // 无时间窗的清单（未 backfill）：仅当镜头命中时列出；有则按窗过滤
            if (inShot || el.visibility.startMs !== undefined) {
                if (vis(el.visibility))
                    result.elements.push(el);
            }
        }
        for (const ac of shot.actions ?? []) {
            if (inShot || ac.timing.atMs !== undefined) {
                const t = ac.timing;
                if ((t.atMs === undefined || atMs >= t.atMs) && (t.durMs === undefined || t.atMs === undefined || atMs < t.atMs + t.durMs)) {
                    result.actions.push(ac);
                }
            }
        }
    }
    return result;
}
/** 导出可读 HTML：每镜元素表 + 动作表 + 关键帧占位（方案 §5.5 静帧由 CLI 补充）。 */
export function renderManifestHtml(project, keyFrames = {}) {
    const esc = escapeHtml;
    const shotsHtml = project.shots.map((shot) => {
        const frames = (keyFrames[shot.id] ?? []).map((f) => `<img src="${esc(f)}" alt="关键帧" loading="lazy">`).join('');
        const elRows = (shot.elements ?? []).map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.kind)}</td><td>${esc(e.role)}</td><td>${esc(e.source)}</td><td><code>${esc(e.visual.selector)}</code></td><td>${esc(e.visual.text)}</td></tr>`).join('') || '<tr><td colspan="6">（无元素）</td></tr>';
        const acRows = (shot.actions ?? []).map((a) => `<tr><td>${esc(a.id)}</td><td>${esc(a.layer)}</td><td><code>${esc(a.primitive)}</code></td><td>${esc(a.target)}</td><td>${esc(JSON.stringify(a.params))}</td></tr>`).join('') || '<tr><td colspan="5">（无动作）</td></tr>';
        return `<section class="shot"><h2>${esc(shot.id)} <small>${esc(shot.narration.slice(0, 60))}</small></h2>
      ${frames ? `<div class="frames">${frames}</div>` : ''}
      <h3>元素清单（有什么）</h3><table><thead><tr><th>id</th><th>kind</th><th>role</th><th>source</th><th>selector</th><th>文案</th></tr></thead><tbody>${elRows}</tbody></table>
      <h3>动作清单（怎么动）</h3><table><thead><tr><th>id</th><th>层</th><th>原语</th><th>target</th><th>params</th></tr></thead><tbody>${acRows}</tbody></table>
    </section>`;
    }).join('\n');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>元素/动作清单 · ${esc(project.meta.title)}</title>
  <style>body{font-family:system-ui,sans-serif;margin:24px;color:#222}h2 small{font-weight:400;color:#888}section.shot{border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;font-size:13px}th{background:#f5f5f5}.frames img{max-width:240px;margin:4px;border:1px solid #ccc}code{color:#06c}</style>
  </head><body><h1>元素 / 动作清单 — ${esc(project.meta.title)}</h1>
  <p>视觉 = 元素层 × 动作层 × 时间线。两表通过 target 关联；时间由配音时长回填。</p>
  ${shotsHtml}</body></html>`;
}
