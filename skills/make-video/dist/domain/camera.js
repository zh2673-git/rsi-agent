// 摄影部机位轨（docs/05 摄影 / docs/08 剪辑）：
// 一镜 = 一张满幅场景时，剪切点只剩"整场换画布"一种形态，画面必然机械。
// 本模块补上两层运动中的外层：
//   1) 外层机位（这里）：在场景根元素上做"进入-漂移-离场"三段式大机位运动，时长取旁白实测；
//   2) 内层微动（motion-lib 的 MV.camera）：场景自带的 Ken Burns / 主体动效原样保留。
// 覆盖（coverage）落地为"同一个场景、换一次机位"的硬切：不新建子合成——子合成动画会
// 从头重启、连续性断裂——而是在相机轨上按时间 snap 到新构图，视觉等价于换机位且保留场景动效。
import { normalizeCameraToken, } from '../core/schema.js';
// 景别 → 机位幅度（越近的景别机身位移越明显；ELS 几乎是静态定场）
const ZOOM_AMP = {
    ELS: 0.028,
    LS: 0.034,
    MLS: 0.038,
    MS: 0.044,
    MCU: 0.052,
    CU: 0.060,
    ECU: 0.072,
};
/**
 * 恒定过扫（no-zoom 模式）。
 *
 * 2026-11-15 用户裁决：「放大缩小的运镜能否取消掉，感觉在各个视频里这种效果都不好看」，
 * 并要求改用「移动视角的运镜」。这不是调参数能解决的——**只要 scale 随时间变化，观众
 * 读到的就是变焦**，无论幅度多小、缓动多柔。故引入一条硬规则：
 *
 *   机位轨的 scale 全片恒定 = SCALE_HOLD，运动只由 xPercent / yPercent 承担。
 *
 * 为什么不是恒为 1：平移需要画面比窗口大，否则边缘露出空白。SCALE_HOLD=1.06 给出
 * 3% 的单侧余量，2.2 的 DRIFT 行程（pan）刚好落在余量内，不会露边。
 * 同理，coverage 的 scale 也一律折成 1（见 accumulate）——「换机位」靠位移与旋转表达，
 * 不靠放大。
 */
export const SCALE_HOLD = 1.06;
/** 从 shot.visual.params 读显式运镜参数（cameraAmp / cameraPunchOut / cameraDir） */
export function parseCameraOptions(params) {
    const p = params ?? {};
    const rawAmp = p['cameraAmp'];
    const amp = rawAmp === undefined ? undefined : Number(rawAmp);
    const rawDir = String(p['cameraDir'] ?? '').trim().toLowerCase();
    return {
        amp: Number.isFinite(amp) ? clamp(amp, 0, 2.5) : undefined,
        punchOut: p['cameraPunchOut'] === true,
        dir: rawDir === 'left' || rawDir === 'right' ? rawDir : undefined,
    };
}
export function normalizeMove(raw) {
    return normalizeCameraToken(raw) ?? 'static';
}
function hashSeed(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 1000;
}
function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
/**
 * 主语焦点：优先读场景 CSS 里 .subject 的定位，把它当作机位推近的锚点。
 * 推轨锚在主语上才算"镜头语言"，锚在画面正中只是数字缩放。
 */
export function pickSubjectFocus(sceneHtml) {
    const block = sceneHtml.match(/\.subject\s*\{([^}]*)\}/)?.[1] ?? '';
    const left = Number(block.match(/(?:^|[;\s])left:\s*([\d.]+)%/)?.[1]);
    const top = Number(block.match(/(?:^|[;\s])top:\s*([\d.]+)%/)?.[1]);
    const bottom = Number(block.match(/(?:^|[;\s])bottom:\s*([\d.]+)%/)?.[1]);
    // 文字左对齐（无 translate(-50%)）时，视觉重心在定位点右侧
    const centered = /translate\(\s*-?50%/.test(block);
    let x = Number.isFinite(left) ? left + (centered ? 0 : 8) : 50;
    let y = Number.isFinite(top) ? top : Number.isFinite(bottom) ? 100 - bottom - 10 : 48;
    x = clamp(x, 26, 74);
    y = clamp(y, 26, 74);
    return { x: Math.round(x), y: Math.round(y) };
}
/**
 * 句内覆盖切点：导演声明的 `coverage` 始终生效；重音词自动派生**默认关闭**。
 * 为什么关：coverage 是开机前就定下的镜头清单（master + 单人 + 插入），
 * 由导演决定；合成阶段按重音词自动加刀，等于替导演重剪。要开就逐镜写
 * `visual.params.autoCoverage = true`（喜剧/信息密集的长镜可以开）。
 * 仍然只在 ≥3.8s 的镜头里派生（喜剧短镜本身就是一个节拍，再切就碎）；>6s 允许两刀。
 */
export function deriveCoverage(shot, emphasis, durationMs, auto = false) {
    const cuts = (shot.coverage ?? []).map((c) => ({
        atMs: Math.round(clamp(c.at, 0.08, 0.92) * durationMs),
        kind: c.kind,
        scale: c.scale,
        xPercent: c.xPercent,
        yPercent: c.yPercent,
        rotation: c.rotation,
        motivation: c.motivation,
    }));
    if (auto && durationMs >= 3800 && emphasis.length > 0) {
        const maxAuto = durationMs >= 6000 ? 2 : 1;
        let added = 0;
        for (const word of emphasis) {
            const idx = shot.narration.indexOf(word);
            if (idx <= 0)
                continue; // 句首重音词没有"切过去"的意义
            const ratio = (idx + word.length * 0.5) / Math.max(1, shot.narration.length);
            const atMs = Math.round(clamp(ratio * durationMs, durationMs * 0.22, durationMs * 0.82));
            if (atMs < 760)
                continue;
            if (cuts.some((c) => Math.abs(c.atMs - atMs) < 900))
                continue;
            const sign = hashSeed(`${shot.id}:${word}`) % 2 === 0 ? 1 : -1;
            const punch = added % 2 === 0;
            cuts.push({
                atMs,
                kind: punch ? 'punch-in' : 'reframe',
                scale: punch ? 1.16 : 1.02,
                xPercent: punch ? 0 : sign * 3.4,
                yPercent: 0,
                rotation: punch ? 0 : sign * 0.6,
                motivation: 'emphasis',
            });
            added += 1;
            if (added >= maxAuto)
                break;
        }
    }
    return cuts.sort((a, b) => a.atMs - b.atMs);
}
/**
 * 覆盖切偏移（X12 已退出机位轨）：X9 曾把 coverage 的位移/旋转累加进镜头状态、
 * scale 连乘（2026-11-13 事故，16 镜被推到 1.2-1.28 满幅放大）。no-zoom 先废掉
 * scale（2026-11-15），X12 再废掉位移/旋转——用户最终裁决「任何片子里都不需要
 * 镜头抖动」：构图差不驱动任何镜头运动，机位轨只表达分镜声明的慢速运镜。
 *
 * 切点只留在 plan.coverage 里（审计、转场裁决、V-RHY-004 载体判定），
 * 本函数恒返回零偏移——保留签名让 rigStateAt 审计口径不破。
 */
function accumulate(_cuts, tS, _inclusive) {
    return {
        atS: tS,
        // no-zoom：scale 恒为 1（全片不允许「换机位 = 放大」）；X12：位移/旋转恒为 0
        // （镜头不因重音/覆盖切而动）。强调由画面内元素动效与剪辑点承担。
        scale: 1,
        xPercent: 0,
        yPercent: 0,
        rotation: 0,
    };
}
function sample(waypoints, t) {
    if (t <= waypoints[0].t)
        return { ...waypoints[0], t };
    for (let i = 1; i < waypoints.length; i += 1) {
        const a = waypoints[i - 1];
        const b = waypoints[i];
        if (t <= b.t) {
            const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
            return {
                t,
                scale: a.scale + (b.scale - a.scale) * k,
                x: a.x + (b.x - a.x) * k,
                y: a.y + (b.y - a.y) * k,
            };
        }
    }
    return { ...waypoints.at(-1), t };
}
/** 平移行程基准（%画幅）：配 SCALE_HOLD=1.06 的余量，>2.4 会露边 */
const DRIFT = 2.2;
/**
 * 机位轨迹。**no-zoom 模式（2026-11-15 起）**：所有 scale 恒为 SCALE_HOLD，
 * 运动只由 x/y 位移承担。用户原话「放大缩小的运镜能否取消掉，感觉在各个视频里
 * 这种效果都不好看」——只要 scale 随时间变，读者就读成变焦，柔化幅度只是让它
 * 变得更难察觉，不是消除。故这里的 scale 字面量一律 SCALE_HOLD，改这一个常量
 * 就调整全片过扫量。
 *
 * 词表语义随之重新定义（保留词位，语义改为方位）：
 *   push-in / dolly-in / punch-in / drift  → 向主体方向**平移**
 *   pull-out / dolly-out                   → 背离主体方向**平移**
 *   pan / pan-left / tilt-up / tilt-down   → 原有横/纵摇，本来就无缩放
 */
function waypointsFor(move, amp, durS, enterS, midS, sign) {
    const S = SCALE_HOLD; // 恒定过扫：单镜内不放大也不缩小
    const travel = DRIFT * (0.6 + amp * 6); // 位移幅度：景别越近，视野越窄，同样位移占比越大
    switch (move) {
        // 向主体「推」= 画面沿主体方向平移，主体由远及近地滑向中心（视觉上仍是靠近，
        // 但读作机位横移而非变焦）
        case 'push-in':
            return [
                { t: 0, scale: S, x: -sign * travel * 0.9, y: 0 },
                { t: enterS, scale: S, x: -sign * travel * 0.62, y: 0 },
                { t: midS, scale: S, x: sign * travel * 0.22, y: 0 },
                { t: durS, scale: S, x: sign * travel * 0.5, y: 0 },
            ];
        // 标点：短促冲到位的平移（0.25-0.35s），冲完停住，是加粗不是换行
        case 'punch-in': {
            const hit = Math.min(durS * 0.42, 0.32);
            return [
                { t: 0, scale: S, x: 0, y: 0 },
                { t: hit, scale: S, x: sign * travel * 1.1, y: 0 },
                { t: durS, scale: S, x: sign * travel * 1.2, y: 0 },
            ];
        }
        // 甩镜：视线突然转移。前段冲出去、后段落定，中段是运动模糊的主体。
        case 'whip-pan': {
            const hit = Math.min(durS * 0.3, 0.28);
            return [
                { t: 0, scale: S, x: -sign * DRIFT * 1.6, y: 0 },
                { t: hit, scale: S, x: sign * DRIFT * 1.5, y: 0 },
                { t: durS, scale: S, x: sign * DRIFT * 1.1, y: 0 },
            ];
        }
        // 慢漂：整镜匀速横移（原来靠缩放表现，现改为纯位移）
        case 'drift':
            return [
                { t: 0, scale: S, x: -sign * travel * 0.5, y: 0 },
                { t: enterS, scale: S, x: -sign * travel * 0.34, y: 0 },
                { t: midS, scale: S, x: sign * travel * 0.1, y: 0 },
                { t: durS, scale: S, x: sign * travel * 0.3, y: 0 },
            ];
        // 拉远 = 背离主体平移（原为缩小）
        case 'pull-out':
            return [
                { t: 0, scale: S, x: sign * travel * 0.6, y: 0 },
                { t: enterS, scale: S, x: sign * travel * 0.4, y: 0 },
                { t: midS, scale: S, x: -sign * travel * 0.2, y: 0 },
                { t: durS, scale: S, x: -sign * travel * 0.45, y: 0 },
            ];
        case 'pan':
            return [
                { t: 0, scale: S, x: -DRIFT * 0.82, y: 0 },
                { t: enterS, scale: S, x: -DRIFT, y: 0 },
                { t: midS, scale: S, x: DRIFT, y: 0 },
                { t: durS, scale: S, x: DRIFT * 1.1, y: 0 },
            ];
        case 'pan-left':
            return [
                { t: 0, scale: S, x: DRIFT * 0.82, y: 0 },
                { t: enterS, scale: S, x: DRIFT, y: 0 },
                { t: midS, scale: S, x: -DRIFT, y: 0 },
                { t: durS, scale: S, x: -DRIFT * 1.1, y: 0 },
            ];
        case 'tilt-up':
            return [
                { t: 0, scale: S, x: 0, y: DRIFT * 0.7 },
                { t: enterS, scale: S, x: 0, y: DRIFT * 0.9 },
                { t: midS, scale: S, x: 0, y: -DRIFT * 0.9 },
                { t: durS, scale: S, x: 0, y: -DRIFT },
            ];
        case 'tilt-down':
            return [
                { t: 0, scale: S, x: 0, y: -DRIFT * 0.7 },
                { t: enterS, scale: S, x: 0, y: -DRIFT * 0.9 },
                { t: midS, scale: S, x: 0, y: DRIFT * 0.9 },
                { t: durS, scale: S, x: 0, y: DRIFT },
            ];
        // dolly / crane 原本靠缩放表达纵深与升降，现一律平移（带一点纵向分量区分）
        case 'dolly-in':
            return [
                { t: 0, scale: S, x: -sign * travel * 0.8, y: DRIFT * 0.2 },
                { t: enterS, scale: S, x: -sign * travel * 0.5, y: DRIFT * 0.15 },
                { t: midS, scale: S, x: sign * travel * 0.2, y: -DRIFT * 0.15 },
                { t: durS, scale: S, x: sign * travel * 0.45, y: -DRIFT * 0.2 },
            ];
        case 'dolly-out':
            return [
                { t: 0, scale: S, x: sign * travel * 0.5, y: -DRIFT * 0.2 },
                { t: enterS, scale: S, x: sign * travel * 0.32, y: -DRIFT * 0.15 },
                { t: midS, scale: S, x: -sign * travel * 0.15, y: DRIFT * 0.15 },
                { t: durS, scale: S, x: -sign * travel * 0.35, y: DRIFT * 0.2 },
            ];
        case 'crane-up':
            return [
                { t: 0, scale: S, x: -sign * travel * 0.25, y: DRIFT * 0.9 },
                { t: enterS, scale: S, x: -sign * travel * 0.15, y: DRIFT * 0.7 },
                { t: midS, scale: S, x: sign * travel * 0.15, y: -DRIFT * 0.7 },
                { t: durS, scale: S, x: sign * travel * 0.25, y: -DRIFT * 0.9 },
            ];
        case 'crane-down':
            return [
                { t: 0, scale: S, x: -sign * travel * 0.25, y: -DRIFT * 0.9 },
                { t: enterS, scale: S, x: -sign * travel * 0.15, y: -DRIFT * 0.7 },
                { t: midS, scale: S, x: sign * travel * 0.15, y: DRIFT * 0.7 },
                { t: durS, scale: S, x: sign * travel * 0.25, y: DRIFT * 0.9 },
            ];
        default:
            return [
                { t: 0, scale: S, x: -sign * travel * 0.5, y: 0 },
                { t: enterS, scale: S, x: -sign * travel * 0.34, y: 0 },
                { t: midS, scale: S, x: sign * travel * 0.12, y: 0 },
                { t: durS, scale: S, x: sign * travel * 0.32, y: 0 },
            ];
    }
}
/**
 * 三段式机位：进入（settle）→ 主体漂移（linear，像真的推轨）→ 滑入切点。
 * 2026-11-15 用户裁决（v1.4.1 去同质化 X9）：「动效不流畅协调，像历史默认设置」。
 * 旧默认首段一律 power2.out、末段一律 power2.out，实测 15 镜里 14 镜走同一条
 * [settle→匀速→刹车] 曲线，第三镜起观众就能摸到节拍器——机械感的直接来源。
 * 现在：进场 ease 与拐点时值按镜 seed 变奏；末段默认不再刹车，与中段同为
 * none（匀速滑到切点，剪在运动中）。旧「切前收住眼位」的 Murch 式处理保留为
 * 导演显式 punchOut（急推标点，V-CAM-005 全片≤2次约束不变）。
 * 静止镜（static）返回空分段——是真的定帧，交给场景内表演。
 * 覆盖切（X12）不进机位轨：构图差不驱动任何镜头运动，切点只留审计与转场裁决
 * （X9 零帧硬跳 → X10 0.24s 快速 reframe，用户复盘仍读作「镜头突然抽动」，最终裁决
 * 「任何片子里都不需要镜头抖动」——机位只做慢速连贯漂移）。
 */
export function planCameraRig(args) {
    const options = args.options ?? {};
    const durationS = Math.max(0.3, args.durationMs / 1000);
    // 行程随镜长缩放：短促节拍镜给满幅位移只会变成急推/甩镜——标点不能成为常态
    const durationFactor = clamp(durationS / 3.5, 0.45, 1);
    const amp = (ZOOM_AMP[args.zoom] ?? 0.044) * durationFactor * (options.amp ?? 1);
    const move = normalizeMove(args.camera);
    const sign = options.dir ? (options.dir === 'left' ? -1 : 1) : focusSign(args.focus, args.shotId);
    const cuts = args.coverage.filter((c) => c.atMs >= 760 && c.atMs <= args.durationMs - 320);
    // 镜间变奏（X9）：所有镜共用同一组拐点 = 全片同一个「步频」，也是节拍器。
    // 进场时长 ±0.1s、收尾余量 ±0.09s 按镜 seed 抖动，边界仍受原上下限约束。
    const seed = hashSeed(args.shotId);
    const enterBase = Math.min(0.5, Math.max(0.24, durationS * 0.16));
    const enterS = clamp(enterBase + ((seed % 9) - 4) * 0.025, 0.18, 0.55);
    const tailBase = Math.min(0.45, Math.max(0.22, durationS * 0.14));
    const tailS = clamp(tailBase + (((seed >> 4) % 7) - 3) * 0.03, 0.15, 0.5);
    const midS = Math.max(enterS + 0.12, durationS - tailS);
    const base = {
        shotId: args.shotId,
        durationS: +durationS.toFixed(3),
        move,
        zoom: args.zoom,
        focus: args.focus,
        amp: +amp.toFixed(5),
        sign,
        enterS: +enterS.toFixed(3),
        midS: +midS.toFixed(3),
    };
    // 真静止：没有覆盖切就一段都不生成（buildRigScript 返回空串，画面原封不动）
    if (move === 'static' && cuts.length === 0) {
        return { ...base, coverage: [], segments: [], keyframes: [] };
    }
    // 真静止：X12 起切点不再产生镜头事件，static 镜没有运镜就是一段都不生成
    // （旧「static + coverage 仍生成零运动分段」的行为随覆盖切一起退出机位轨）
    if (move === 'static') {
        return { ...base, coverage: cuts, segments: [], keyframes: [] };
    }
    const waypoints = waypointsFor(move, amp, durationS, enterS, midS, sign);
    // 标点运镜（punch-in / whip-pan）的「打中点」必须成为分段边界，
    // 否则缓动会把 0.28s 的冲击摊到整段三秒里——那就退化成慢推了。
    const punctS = move === 'punch-in' ? Math.min(durationS * 0.42, 0.32)
        : move === 'whip-pan' ? Math.min(durationS * 0.3, 0.28)
            : null;
    // 分段边界：三段 + 标点打中点（X12：覆盖切点不再是分段边界——它不进机位轨）
    const bounds = [
        ...new Set([
            0,
            enterS,
            ...(punctS === null ? [] : [punctS]),
            midS,
            durationS,
        ]),
    ]
        .filter((b) => b >= 0 && b <= durationS)
        .sort((a, b) => a - b);
    // 分段：机位轨只表达本镜运镜的慢速漂移（X12）。
    const segments = [];
    // 覆盖切不再进机位轨（X12，2026-11-15）：LLM 分镜把 motivation=emphasis 的
    // reframe 当「标点」密集下发（vibe 首条 15 镜有 4 镜，一次瞬移 4-6% 位移 +
    // 最高 1.5° 旋转）。X9 渲染为零帧硬跳、X10 降为 0.24s 快速 reframe，用户复盘
    // 仍读作「镜头突然抽动」，最终裁决：任何片子里都不需要镜头抖动——构图差不再
    // 驱动任何镜头位移，切点仅保留在 coverage 里供审计与转场裁决。
    for (let i = 1; i < bounds.length; i += 1) {
        const a = bounds[i - 1];
        const b = bounds[i];
        const durS = +(b - a).toFixed(3);
        if (durS <= 0)
            continue;
        const isFirst = i === 1;
        const isLast = i === bounds.length - 1;
        // X9 ease 变奏：进场在 [power2.out / sine.out / cubic.out] 间按镜轮换；
        // 末段默认 none（匀速滑到切点），punchOut 急收保留；中段维持匀速漂移。
        const isPunct = punctS !== null && Math.abs(b - punctS) < 1e-6;
        const enterEases = ['power2.out', 'sine.out', 'cubic.out'];
        const ease = isPunct
            ? (move === 'whip-pan' ? 'expo.out' : 'power3.out')
            : isFirst
                ? enterEases[seed % enterEases.length]
                : isLast
                    ? (options.punchOut ? 'power2.in' : 'none')
                    : 'none';
        segments.push({
            atS: +a.toFixed(3),
            durationS: durS,
            from: stateAt(waypoints, cuts, a, i > 1),
            to: stateAt(waypoints, cuts, b, false),
            ease,
        });
    }
    return {
        ...base,
        coverage: cuts,
        segments,
        keyframes: segments.map((s) => s.from),
    };
}
/** 机位横移服务构图：主体偏左就把画面往右带、偏右就往左带，回到画心中轴 */
function focusSign(focus, shotId) {
    if (focus.x < 48)
        return 1;
    if (focus.x > 52)
        return -1;
    return hashSeed(shotId) % 2 === 0 ? 1 : -1;
}
function stateAt(waypoints, cuts, tS, inclusive) {
    const base = sample(waypoints, tS);
    const off = accumulate(cuts, tS, inclusive);
    return {
        atS: +tS.toFixed(3),
        // no-zoom：整条机位轨的 scale 恒定（base 已是 SCALE_HOLD，off 恒为 1）
        scale: SCALE_HOLD,
        xPercent: +(base.x + off.xPercent).toFixed(3),
        yPercent: +(base.y + off.yPercent).toFixed(3),
        rotation: +off.rotation.toFixed(3),
    };
}
/** 供测试与审计：取某一时刻的机位状态（inclusive=true 表示切点之后） */
export function rigStateAt(plan, tS, inclusive = false) {
    const waypoints = plan.move === 'static'
        ? [
            { t: 0, scale: SCALE_HOLD, x: 0, y: 0 },
            { t: plan.durationS, scale: SCALE_HOLD, x: 0, y: 0 },
        ]
        : waypointsFor(plan.move, plan.amp, plan.durationS, plan.enterS, plan.midS, plan.sign);
    return stateAt(waypoints, plan.coverage, tS, inclusive);
}
/**
 * 生成注入场景合成的相机轨脚本（GSAP，注册到该场景的 __timelines）。
 * 每个分段都显式 set 段首状态 + to 段尾状态：切点处后一段的 set 覆盖前一段的收尾值，
 * 渲染器按帧抓图时该帧就是"新机位"，正是覆盖切要的效果。
 *
 * 变换对象是 .stage 外包的一层运行时 wrapper（不是场景根）：黑遮幅/颗粒/暗角留在原处不动，
 * 只有画面内容随镜头推拉；内层 MV.camera 改的是 .stage 自身，两者作用对象不同、互不覆盖属性。
 */
export function buildRigScript(plan) {
    const host = `[data-composition-id="scene-${plan.shotId}"]`;
    if (plan.segments.length === 0)
        return '';
    const segs = [];
    for (const s of plan.segments) {
        const from = JSON.stringify({
            scale: s.from.scale,
            xPercent: s.from.xPercent,
            yPercent: s.from.yPercent,
            rotation: s.from.rotation,
        });
        const to = JSON.stringify({
            scale: s.to.scale,
            xPercent: s.to.xPercent,
            yPercent: s.to.yPercent,
            rotation: s.to.rotation,
            duration: s.durationS,
            ease: s.ease,
        });
        segs.push(`    tl.set(SEL, ${from}, ${s.atS});`);
        segs.push(`    tl.to(SEL, ${to}, ${s.atS});`);
    }
    return `<script>
(function () {
  function target() {
    var host = document.querySelector('${host}');
    if (!host) return null;
    var stage = host.querySelector('.stage');
    if (!stage || !stage.parentNode) return host;
    var wrap = stage.parentNode.querySelector(':scope > [data-mv-rig-wrap]');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.setAttribute('data-mv-rig-wrap', '1');
      wrap.style.cssText = 'position:absolute;inset:0;';
      stage.parentNode.insertBefore(wrap, stage);
      wrap.appendChild(stage);
    }
    return wrap;
  }
  function apply() {
    var tl = window.__timelines && window.__timelines['scene-${plan.shotId}'];
    var SEL = target();
    if (!tl || !SEL) return;
    tl.set(SEL, { transformOrigin: '${plan.focus.x}% ${plan.focus.y}%' }, 0);
${segs.join('\n')}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(apply); });
  } else {
    requestAnimationFrame(apply);
  }
})();
</script>`;
}
