/**
 * 模板契约层（L4 模板的「参数契约 + 语法归属 + 母题 + 机位 + 容量」）。
 *
 * 为什么要这一层（2026-11-16，P12 阶段1）：
 *
 * 本项目此前只有「模板 HTML」这一个事实源，没有「模板声明了什么」的契约层。
 * 后果不是文档不好看，而是**三个真实的静默失效**：
 *
 *   ① 模板里写了 {{HERO_WORD}} 这类占位符，但渲染期根本没人填它 →
 *      画面上出现字面量 `{{HERO_WORD}}`，且 `<script>` 里的 `{{FIGURE_TO}}`
 *      是**非法的 JS 语法**（对象字面量缺键名），整个 script 块抛异常 →
 *      **该镜所有动画都不发生**。实测 15 个模板有 6 个中招（kinetic-type /
 *      compare-stage / deep-stage / hierarchy-stack / paper-stage / process-track）。
 *
 *   ② 模板传了 `zoom:` 给 MV.camera，但 motion-lib 只读 `hold` → 景别死参数。
 *   ③ 模板传了 `stiffness/damping` 给 MV.performance，但原语硬编码缓动 → 风格包
 *      的 `motion.spring` 全网无效。
 *
 * ①②③ 是同一类病：**声明了但没人兑现**。本模块把「模板声明什么」变成**可机检的契约**：
 *
 *   - `params`：每个占位符的类型/默认值/枚举/范围。渲染前校验，非法值直接报错。
 *   - `grammar`：该模板实现了哪些语法（反查「哪个语法没有模板可落」）。
 *   - `motifs`：该模板用的母题 kind（与风格包 `visuals.motifs` 对账）。
 *   - `camera`：该模板的机位语汇（与 `CAMERA_MOVES` 对账）。
 *   - `capacity`：容量上限（超限明确失败，不静默缩字）。
 *   - `materials`：素材槽（语义角色 + 缺素材策略）。
 *   - `variants`：同镜型的不同画法（换预设，不换模板）。
 *
 * 对标：阿杜 motiongit 的 `guide.json` + `params.schema.json`（职责对齐，不搬包结构）。
 * 边界见 PLAN.md §10.7：`.motion` 与本项目架构同构、层次不同，只对齐契约层。
 *
 * 数据归属：`templates/scenes/<kind>.meta.json` 是模板契约的**唯一真源**；
 * 本模块只定义 schema、加载、校验与装配，不复制任何声明。
 */
import path from 'node:path';
import { exists, listFiles, readJson } from '../infrastructure/fs-utils.js';
import { TEMPLATES_DIR } from '../core/constants.js';
/**
 * 校验一个参数值是否符合规格。
 * 返回空数组 = 合法。
 */
export function validateParamValue(spec, value) {
    const issues = [];
    const fix = `检查模板 ${spec.name} 的参数声明（params/${spec.name}）`;
    if (spec.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            issues.push({ param: spec.name, problem: `期望数字，实得 ${JSON.stringify(value)}`, fix });
            return issues;
        }
        if (spec.min !== undefined && n < spec.min) {
            issues.push({ param: spec.name, problem: `${n} < 最小值 ${spec.min}`, fix });
        }
        if (spec.max !== undefined && n > spec.max) {
            issues.push({ param: spec.name, problem: `${n} > 最大值 ${spec.max}`, fix });
        }
    }
    if (spec.type === 'enum') {
        const allowed = spec.enum ?? [];
        if (!allowed.includes(String(value))) {
            issues.push({
                param: spec.name,
                problem: `「${value}」不在枚举 [${allowed.join('/')}]`,
                fix,
            });
        }
    }
    if (spec.type === 'boolean') {
        if (typeof value !== 'boolean') {
            issues.push({ param: spec.name, problem: `期望布尔，实得 ${JSON.stringify(value)}`, fix });
        }
    }
    if (spec.type === 'string') {
        if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
            issues.push({ param: spec.name, problem: `期望字符串，实得 ${typeof value}`, fix });
        }
    }
    return issues;
}
/**
 * 参数契约装配：把「规格」变成「实际要注入的值」。
 *
 * 这里是**参数契约真正生效**的地方：以前占位符的值是散落在
 * `renderTemplate` 的一张大 map 里（谁想加参数就往 map 里塞一行），
 * 现在改成「规格声明 → 本函数解析 → 渲染注入」。
 *
 * `overrides` 来自 project.json 的 `shots[].visual.params`——那是导演的显式覆盖，
 * 优先级最高；越界（非法枚举/超范围）**报错而不是静默夹取**：
 * 静默夹取会让导演写的 `duration: 99999` 变成 800，而画面看起来「正常」，
 * 没人知道有个值被吞了。
 */
export function resolveParams(contract, overrides = {}) {
    const values = {};
    const issues = [];
    for (const spec of contract.params) {
        const raw = overrides[spec.name];
        if (raw === undefined || raw === null || raw === '') {
            if (spec.default !== undefined)
                values[spec.name] = spec.default;
            continue;
        }
        const v = validateParamValue(spec, raw);
        if (v.length > 0) {
            issues.push(...v);
            continue;
        }
        values[spec.name] = raw;
    }
    // 契约外的覆盖：允许（导演可能加自定义参数），但记一条提示而不是报错——
    // 模板契约是「下限」不是「上限」，新增模板参数时先改契约更好，但不强制。
    const known = new Set(contract.params.map((p) => p.name));
    const extra = Object.keys(overrides).filter((k) => !known.has(k) && k !== 'actionSheet');
    if (extra.length > 0) {
        // 不报错：params 里还有 kicker/actionSheet/energy 等系统字段，不在契约内是正常的。
        // 真正的死参数问题由「占位符解析器」负责——模板里写了 {{X}} 但契约和注入表都没有 X，
        // 那个才会漏。
        void extra;
    }
    return { values, issues };
}
/** 扫出模板里所有 {{NAME}} 占位符 */
export function scanPlaceholders(html) {
    const counts = new Map();
    for (const m of html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * 判断某个位置的占位符处于「代码上下文」还是「文本上下文」。
 *
 * 判据：看该位置之前最近的 `<script>` / `<style>` 开闭标签。
 *   - 在 `<script>` 内 → JS 代码位置 → **不能转义**（`duration: 600` 转义就坏了）
 *   - 在 `<style>` 内  → CSS 代码位置 → **不能转义**（`font-family: 'YaHei'` 转义就坏了）
 *   - 其余            → HTML 文本位置 → **必须转义**（防 XSS）
 *
 * 为什么要**逐个出现位置**判定而不是「按名字统一判」：
 * 同一个占位符可能同时出现在代码与文本里——`{{SCENE_ID}}` 既是 HTML 属性
 * `data-scene-id="{{SCENE_ID}}"`，又是 JS 里的 `MV.use('scene-{{SCENE_ID}}')`。
 * 按名字统一判会让其中一个位置拿到错误的转义策略。
 */
export function contextAt(html, index) {
    const before = html.slice(0, index);
    const lastScript = before.lastIndexOf('<script');
    const lastScriptEnd = before.lastIndexOf('</script>');
    const lastStyle = before.lastIndexOf('<style');
    const lastStyleEnd = before.lastIndexOf('</style>');
    return lastScript > lastScriptEnd || lastStyle > lastStyleEnd ? 'code' : 'text';
}
/**
 * 占位符在模板里的上下文（供契约校验用：声明的 context 与实际位置是否一致）。
 *
 * 与 contextAt 的区别：这里是「这个占位符**有没有**出现在代码位置」，
 * 用于检查契约声明——如果契约说 context='text' 但模板实际把它放在 JS 里，
 * 那就是契约写错了（该声明成 code）。
 */
export function placeholderContext(html, name) {
    const re = new RegExp(`\\{\\{${name}\\}\\}`, 'g');
    let m;
    while ((m = re.exec(html)) !== null) {
        if (contextAt(html, m.index) === 'code')
            return 'code';
    }
    return 'text';
}
/**
 * 注入占位符。
 *
 * @param html  模板原文
 * @param values 参数名 → 值（**裸名**，不带 {{}}；值必须是原始值，不要提前转义）
 * @param escapeText 文本位置的转义函数
 *
 * 关键行为：
 *   ① **逐个出现位置**判定上下文并分别转义（见 contextAt 的说明）；
 *   ② **未提供的占位符替换成空串**，而不是留着 `{{X}}`。
 *      留着 `{{X}}` 在 HTML 文本里只是难看，在 `<script>` 里是**语法错误**——
 *      后者会让整镜动画全灭（实测 6/15 模板）。所以这里必须清干净。
 */
export function injectPlaceholders(html, values, escapeText) {
    // 一次性扫出所有占位符位置，倒序替换（避免替换后位置偏移）
    const hits = [];
    for (const m of html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)) {
        hits.push({ name: m[1], index: m.index, length: m[0].length });
    }
    let out = html;
    for (const hit of hits.reverse()) {
        const raw = values[hit.name];
        const text = raw === undefined || raw === null ? '' : String(raw);
        const ctx = contextAt(out, hit.index);
        const replacement = ctx === 'code' ? text : escapeText(text);
        out = out.slice(0, hit.index) + replacement + out.slice(hit.index + hit.length);
    }
    return out;
}
/** 渲染后残留的占位符（应当为空） */
export function leftoverPlaceholders(html) {
    return [...new Set([...html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)].map((m) => m[1]))].sort();
}
// ---------------------------------------------------------------------------
// 阶段 0 接线：素材槽 ifMissing / 容量上限 / 变体（P12 阶段4 遗留的三件事）
//
// 为什么放在这一层而不是 scene-forge：这三条都是**契约的事实**，与渲染器无关。
// 放在契约层，场景渲染、未来的分镜期预检、审计都能复用同一套判据，不会各写一份。
//
// 三条都**克制地只在「导演显式给的」上生效**：
//   派生值（deriveContent 的产出）不受容量约束——派生是**内容压缩器**，
//   它自己按槽位截断；再对它套容量会二次伤害（deep-stage 的 3 个 PANEL×16 + DESC
//   合计本就超过 capacity.maxChars=72，而那是模板的真实排版容量，不是文案预算）。
// ---------------------------------------------------------------------------
/**
 * 素材槽 → 参数名的绑定（命名约定，不改盘上 meta.json 的 schema）。
 *
 * 约定的来源：模板契约里 `role` 写的是**语义槽**（`text.hero` / `image.presenter`），
 * 参数名写的是**占位符**（`HERO_WORD` / `LEFT_TAG`）。两者此前没有任何机械联系，
 * 于是「槽位」只是文档，渲染期无人兑现。这里把约定写成可执行的一行表：
 *
 *   - `text.hero`      → 前缀 `HERO`（HERO_WORD / HERO_CARD…）
 *   - `text.left`      → 前缀 `LEFT`（LEFT_TAG / LEFT_NUM / LEFT_NOTE）
 *   - `text.right`     → 前缀 `RIGHT`
 *   - `text.note`      → `LEFT_NOTE` / `RIGHT_NOTE` / `NOTE`（两侧共用 NOTE 语义）
 *   - `text.panel`     → 前缀 `PANEL`（PANEL1..3）
 *   - `text.tier`      → 前缀 `TIER`；`text.desc` → 前缀 `DESC`
 *   - `text.card`      → 前缀 `CARD`（CARD1_TAG / CARD1_BODY…）
 *   - `text.stop`      → 前缀 `STOP`（STOP1..4）
 *   - `text.figure`    → 前缀 `FIGURE`
 *   - `image.*`/`video.*` → 无绑定参数（图片槽由素材层兑现，不是文本参数）
 *
 * 未列出的槽位返回空数组 = 「无绑定参数」，调用方不得据此报缺料（否则会误伤）。
 */
const SLOT_PARAM_PREFIXES = {
    hero: ['HERO'],
    figure: ['FIGURE'],
    left: ['LEFT'],
    right: ['RIGHT'],
    note: ['LEFT_NOTE', 'RIGHT_NOTE', 'NOTE'],
    panel: ['PANEL'],
    tier: ['TIER'],
    desc: ['DESC'],
    card: ['CARD'],
    stop: ['STOP'],
};
/** 槽位的语义基名（`text.hero` → `hero`；`image.presenter` → `presenter`） */
export function slotBaseName(role) {
    return role.replace(/^(text|image|video|audio)\./, '');
}
/** 该槽位绑定的契约参数名（按约定；无绑定返回 []） */
export function slotParamNames(slot, params) {
    const prefixes = SLOT_PARAM_PREFIXES[slotBaseName(slot.role)];
    if (!prefixes)
        return [];
    return params.filter((p) => prefixes.some((pre) => p.name.startsWith(pre))).map((p) => p.name);
}
/**
 * 素材槽缺料裁决（`ifMissing` 第一次真正生效）。
 *
 * 判据：**该槽位绑定的参数在最终值里是否全部为空**。
 * 只看绑定参数，不看「有没有图片文件」——图片槽没有绑定参数，自然不参与。
 *
 * 三种策略的落地行为：
 *   - `ask`         → **warn**。理由（2026-11-19 实测，非推测）：离线/默认流水线下
 *                    `deriveContent` 对 kinetic-type 的 `HERO_WORD` 在 12 句真实旁自上
 *                    **全部派生为空**，而 assetPolicy 默认 'auto'。若这里判 error，
 *                    端到端成片会直接挂——那不是「发现缺料」，那是把正常成片判死。
 *                    所以 ask 记 warn：**采集阶段该问的没问**要被看见，但已有派生/占位
 *                    兜底的成片不受阻断。
 *   - `skip`        → **由调用方清成空串**（画面相应部分不出现），本函数不报 issue。
 *   - `placeholder` → **由调用方填 `sample` 并打 `data-film-sample` 标记**，不报 issue；
 *                    但 `sample` 缺失是契约写错 → error。
 */
export function resolveMissingSlots(contract, values) {
    const issues = [];
    const out = [];
    for (const slot of contract.materials ?? []) {
        const bound = slotParamNames(slot, contract.params ?? []);
        const filled = bound.filter((n) => {
            const v = values[n];
            return v !== undefined && v !== null && String(v) !== '';
        });
        out.push({ slot, bound, filled });
        // 无绑定参数的槽（图片/视频/未约定槽）不参与文本缺料判定
        if (bound.length === 0)
            continue;
        if (filled.length > 0)
            continue;
        if (slot.ifMissing === 'ask') {
            issues.push({
                id: 'V-TPL-001',
                level: 'warn',
                message: `素材槽 ${slot.role} 缺内容（${bound.join('/')} 全空）且策略为 ask：采集阶段应询问用户后重画`,
            });
        }
        else if (slot.ifMissing === 'placeholder' && !slot.sample) {
            issues.push({
                id: 'V-TPL-001',
                level: 'error',
                message: `素材槽 ${slot.role} 声明 ifMissing=placeholder 但未给 sample（契约写错，无法占位）`,
            });
        }
    }
    return { slots: out, issues };
}
/**
 * 容量上限核验（`capacity.maxChars` / 槽位 `maxChars`，超限明确失败，不静默缩字）。
 *
 * **只核「导演显式值」与「变体值」，派生值豁免**——理由见本节开头：
 * 派生是内容压缩器，且 deep-stage 类模板的排版容量本就不等于文案预算。
 * 豁免是**有意的口径**，不是偷懒：`figure` 槽 maxChars=12 而派生把
 * `1234.5万` 原样写入（未截断），若对派生值判超限，等于把一条既有正确渲染判成失败。
 *
 * @param explicit 导演显式覆盖（shot.visual.params）
 * @param variantParams 变体覆盖
 */
export function checkCapacity(contract, explicit, variantParams) {
    const issues = [];
    const params = contract.params ?? [];
    const cap = contract.capacity ?? {};
    // 槽位级上限：先按命名约定找到槽 → 该槽绑定参数的上限
    const slotLimit = new Map();
    for (const slot of contract.materials ?? []) {
        if (slot.maxChars === undefined)
            continue;
        for (const name of slotParamNames(slot, params)) {
            const prev = slotLimit.get(name);
            // 同一参数被多槽绑定（如 LEFT_NOTE 同时属 left 与 note）时取更严的那个
            if (!prev || slot.maxChars < prev.max)
                slotLimit.set(name, { max: slot.maxChars, role: slot.role });
        }
    }
    for (const spec of params) {
        if (spec.type !== 'string' && spec.type !== 'enum')
            continue;
        // 值来源：变体覆盖优先于导演显式（变体是导演选的画法，但显式值更具体）——
        // 这里与 renderTemplate 的合并顺序保持一致：explicit > variant。
        const fromExplicit = explicit[spec.name];
        const hasExplicit = fromExplicit !== undefined && fromExplicit !== null && fromExplicit !== '';
        const raw = hasExplicit ? fromExplicit : variantParams[spec.name];
        if (raw === undefined || raw === null || raw === '')
            continue;
        const text = String(raw);
        const slot = slotLimit.get(spec.name);
        if (slot && text.length > slot.max) {
            issues.push({
                id: 'V-TPL-002',
                level: 'error',
                message: `参数 ${spec.name} 超槽位容量：${text.length} 字 > ${slot.role} 上限 ${slot.max} 字（"${text}"）`,
            });
            continue;
        }
        if (slot)
            continue; // 槽位上限比全局更严，已核过就不再按全局重复报
        if (cap.maxChars !== undefined && text.length > cap.maxChars) {
            issues.push({
                id: 'V-TPL-002',
                level: 'error',
                message: `参数 ${spec.name} 超模板容量：${text.length} 字 > ${contract.id} 上限 ${cap.maxChars} 字`,
            });
        }
    }
    return issues;
}
/**
 * 选出本镜变体（`shot.visual.params.variant`）。
 *
 * 为什么用 params 而不是新开 IR 字段：变体是**导演对画法的选择**，与其它参数同源同生命
 * 周期（分镜 → 确认 → 渲染）。新字段会让旧项目无法表达，且 IR 扩张必须配消费方。
 * 未命中 → V-TPL-003（error）：选了一个不存在的画法不能静默退回默认，
 * 否则「我选了砸入，成片却是缓入」这类错误无法在流水线上被看见。
 */
export function resolveVariant(contract, requested) {
    if (!contract)
        return { issues: [] };
    const id = typeof requested === 'string' ? requested.trim() : '';
    if (!id)
        return { issues: [] };
    const hit = (contract.variants ?? []).find((v) => v.id === id);
    if (!hit) {
        const available = (contract.variants ?? []).map((v) => v.id).join('/') || '（无）';
        return {
            issues: [
                {
                    id: 'V-TPL-003',
                    level: 'error',
                    message: `模板 ${contract.id} 无变体 "${id}"（可用：${available}）`,
                },
            ],
        };
    }
    return { variant: hit, issues: [] };
}
/**
 * 给占位符打样例标记：`placeholder` 策略下画面必须能自证「这是样例素材」。
 *
 * 做法是把填充值包一层 `<span data-film-sample="1">`——它只在 placeholder 槽生效，
 * 其它槽原样返回。为什么用行内 span 而不是改模板：模板是所有项目共用的，
 * 标记是**本镜的选择结果**，不能写死在模板里。
 * 只对**文本上下文**的占位符有意义；`injectPlaceholders` 里按位置决定是否转义，
 * 所以这里返回的是 HTML 片段，由调用方只用于 text 上下文参数。
 */
export function sampleMarkup(sample) {
    return `<span data-film-sample="1" data-sample-src="${sample}">${sample}</span>`;
}
export function assembleContentValues(contract, explicit, derived, requestedVariant) {
    const values = {};
    const issues = [];
    const samples = new Map();
    const vres = resolveVariant(contract, requestedVariant);
    issues.push(...vres.issues);
    const variantParams = (vres.variant?.params ?? {});
    const pick = (name) => {
        const ex = explicit[name];
        if (ex !== undefined && ex !== null && ex !== '')
            return ex;
        const vp = variantParams[name];
        // 变体里的 '' 是**有意的置空**（如 slam 让 HERO_WORD 不显示），必须尊重
        if (vp !== undefined && vp !== null)
            return vp;
        return undefined;
    };
    for (const spec of contract?.params ?? []) {
        const p = pick(spec.name);
        if (p !== undefined) {
            values[spec.name] = p;
            continue;
        }
        const d = derived[spec.name];
        if (d !== undefined && d !== null && d !== '') {
            values[spec.name] = d;
            continue;
        }
        if (spec.default !== undefined)
            values[spec.name] = spec.default;
    }
    // 契约外的派生值（白名单由内容派生层管）一并带上
    for (const [k, v] of Object.entries(derived)) {
        if (k === 'variant')
            continue; // 变体选择是控制信号，不是渲染值
        if (!(k in values))
            values[k] = v;
    }
    if (contract) {
        // 容量：只核导演显式值与变体值；派生值豁免（见本节开头说明）
        issues.push(...checkCapacity(contract, explicit, variantParams));
        // 素材槽：缺料裁决 + skip 清槽 + placeholder 打标记
        const slots = resolveMissingSlots(contract, values);
        issues.push(...slots.issues);
        for (const { slot, bound, filled } of slots.slots) {
            if (filled.length > 0 || bound.length === 0)
                continue;
            if (slot.ifMissing === 'skip') {
                // 画面相应部分不出现：显式清槽，避免 default 把占位值填回来
                for (const n of bound)
                    values[n] = '';
            }
            else if (slot.ifMissing === 'placeholder' && slot.sample) {
                for (const n of bound) {
                    values[n] = '';
                    samples.set(n, slot.sample);
                }
            }
            // 'ask' 只报 warn（见 resolveMissingSlots 的口径说明），画面保持既有派生结果
        }
    }
    return { values, issues, samples, variantId: vres.variant?.id };
}
// ---------------------------------------------------------------------------
// 契约加载与登记
// ---------------------------------------------------------------------------
const CONTRACT_SUFFIX = '.meta.json';
function contractPathFor(root, templateId) {
    return path.join(root, TEMPLATES_DIR, 'scenes', `${templateId}${CONTRACT_SUFFIX}`);
}
/**
 * 加载全部模板契约。
 * 没有契约文件的模板**不报错**——老模板先跑起来，契约是逐步补齐的。
 * 但 `hasContract=false` 的模板在「契约覆盖率」统计里会被记为缺契约。
 */
export async function loadTemplateContracts(root) {
    const out = new Map();
    const scenesDir = path.join(root, TEMPLATES_DIR, 'scenes');
    for (const file of await listFiles(scenesDir)) {
        if (!file.endsWith(CONTRACT_SUFFIX))
            continue;
        const raw = await readJson(file);
        const contract = raw;
        if (!contract || typeof contract.id !== 'string')
            continue;
        out.set(contract.id, contract);
    }
    return out;
}
/** 契约文件是否存在（用于覆盖率统计与守卫） */
export function contractExists(root, templateId) {
    return exists(contractPathFor(root, templateId));
}
/** 模板 HTML 文件名（不含扩展名） */
export function templateIdFromFile(file) {
    return file.replace(/\.html$/, '');
}
