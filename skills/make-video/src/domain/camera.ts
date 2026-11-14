// 摄影部机位轨（docs/05 摄影 / docs/08 剪辑）：
// 一镜 = 一张满幅场景时，剪切点只剩"整场换画布"一种形态，画面必然机械。
// 本模块补上两层运动中的外层：
//   1) 外层机位（这里）：在场景根元素上做"进入-漂移-离场"三段式大机位运动，时长取旁白实测；
//   2) 内层微动（motion-lib 的 MV.camera）：场景自带的 Ken Burns / 主体动效原样保留。
// 覆盖（coverage）落地为"同一个场景、换一次机位"的硬切：不新建子合成——子合成动画会
// 从头重启、连续性断裂——而是在相机轨上按时间 snap 到新构图，视觉等价于换机位且保留场景动效。
import {
  normalizeCameraToken,
  type CameraMove,
  type Coverage,
  type CoverageCut,
  type Shot,
} from '../core/schema.js';

export type { CameraMove };

// 景别 → 机位幅度（越近的景别机身位移越明显；ELS 几乎是静态定场）
const ZOOM_AMP: Record<string, number> = {
  ELS: 0.028,
  LS: 0.034,
  MLS: 0.038,
  MS: 0.044,
  MCU: 0.052,
  CU: 0.060,
  ECU: 0.072,
};

export interface Focus {
  x: number;
  y: number;
}

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

/** 平移行程（%画幅）：配 SCALE_HOLD=1.06 的余量，>2.4 会露边 */

export interface RigKeyframe {
  atS: number;
  scale: number;
  xPercent: number;
  yPercent: number;
  rotation: number;
}

/**
 * 逐镜运镜覆写（导演在 shot.visual.params 里给，缺省走默认）：
 * - amp：行程倍率（0-2.5），0 即该镜不动；相机是导演的，不是流水线的
 * - punchOut：末段加速收势（急推标点，默认关闭，受 V-CAM-005 全片≤2次约束）
 * - dir：漂移方向；缺省按主体在画幅的哪一侧推导（把主体带回中轴）
 */
export interface CameraOptions {
  amp?: number;
  punchOut?: boolean;
  dir?: 'left' | 'right';
}

/** 从 shot.visual.params 读显式运镜参数（cameraAmp / cameraPunchOut / cameraDir） */
export function parseCameraOptions(params: Record<string, unknown> | undefined): CameraOptions {
  const p = params ?? {};
  const rawAmp = p['cameraAmp'];
  const amp = rawAmp === undefined ? undefined : Number(rawAmp);
  const rawDir = String(p['cameraDir'] ?? '').trim().toLowerCase();
  return {
    amp: Number.isFinite(amp) ? clamp(amp as number, 0, 2.5) : undefined,
    punchOut: p['cameraPunchOut'] === true,
    dir: rawDir === 'left' || rawDir === 'right' ? rawDir : undefined,
  };
}

export interface RigPlan {
  shotId: string;
  durationS: number;
  move: CameraMove;
  zoom: string;
  focus: Focus;
  /** 实际行程幅度与方向（审计/复算用，避免二次推导不一致） */
  amp: number;
  sign: number;
  coverage: CoverageCut[];
  /** 三段式拐点（秒）：进入结束 / 主体漂移结束 */
  enterS: number;
  midS: number;
  /** 机位轨分段（含覆盖切点打断）；静止镜为空数组 */
  segments: RigSegment[];
  /** 审计用：各分段起点构图 */
  keyframes: RigKeyframe[];
}

export function normalizeMove(raw: string | undefined): CameraMove {
  return normalizeCameraToken(raw) ?? 'static';
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 主语焦点：优先读场景 CSS 里 .subject 的定位，把它当作机位推近的锚点。
 * 推轨锚在主语上才算"镜头语言"，锚在画面正中只是数字缩放。
 */
export function pickSubjectFocus(sceneHtml: string): Focus {
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
export function deriveCoverage(
  shot: Pick<Shot, 'id' | 'narration' | 'coverage'>,
  emphasis: string[],
  durationMs: number,
  auto = false,
): CoverageCut[] {
  const cuts: CoverageCut[] = (shot.coverage ?? []).map((c: Coverage) => ({
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
      if (idx <= 0) continue; // 句首重音词没有"切过去"的意义
      const ratio = (idx + word.length * 0.5) / Math.max(1, shot.narration.length);
      const atMs = Math.round(clamp(ratio * durationMs, durationMs * 0.22, durationMs * 0.82));
      if (atMs < 760) continue;
      if (cuts.some((c) => Math.abs(c.atMs - atMs) < 900)) continue;
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
      if (added >= maxAuto) break;
    }
  }
  return cuts.sort((a, b) => a.atMs - b.atMs);
}

/**
 * 覆盖偏移：位移/旋转累加，各有上限，避免叠加成"构图飘走"。
 *
 * 历史（2026-11-13）这里曾按 scale 连乘并夹到 1.28，导致 16 镜全被推到 1.2-1.28
 * 满幅放大，成片读起来就是「每镜都在刻意放大 + 段间硬阶跃」。2026-11-15 用户进一步
 * 裁决「放大缩小的动效不要，改用移动视角」——于是 scale 彻底退出机位轨：
 * coverage 只剩位移（±6）与旋转（±1.5）两种构图手段，不再产生任何缩放。
 *
 * 保留函数签名与 clamp 边界：位移/旋转是构图选择，不是放大，自由度照留。
 */
function accumulate(cuts: CoverageCut[], tS: number, inclusive: boolean): RigKeyframe {
  let x = 0;
  let y = 0;
  let rotation = 0;
  for (const c of cuts) {
    const at = c.atMs / 1000;
    if (inclusive ? at > tS + 1e-6 : at >= tS - 1e-6) break;
    x += c.xPercent;
    y += c.yPercent;
    rotation += c.rotation;
  }
  return {
    atS: tS,
    // no-zoom：coverage 的 scale 恒为 1（全片不允许「换机位 = 放大」）。
    // 位移与旋转仍是构图手段，保留 —— 用户要的是「移动视角」，不是「画面不动」。
    scale: 1,
    xPercent: clamp(x, -6, 6),
    yPercent: clamp(y, -6, 6),
    rotation: clamp(rotation, -1.5, 1.5),
  };
}

interface Waypoint {
  t: number;
  scale: number;
  x: number;
  y: number;
}

function sample(waypoints: Waypoint[], t: number): Waypoint {
  if (t <= waypoints[0]!.t) return { ...waypoints[0]!, t };
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
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
  return { ...waypoints.at(-1)!, t };
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
function waypointsFor(
  move: CameraMove,
  amp: number,
  durS: number,
  enterS: number,
  midS: number,
  sign: number,
): Waypoint[] {
  const S = SCALE_HOLD;             // 恒定过扫：单镜内不放大也不缩小
  const travel = DRIFT * (0.6 + amp * 6);  // 位移幅度：景别越近，视野越窄，同样位移占比越大
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
 * 三段式机位：进入（settle）→ 主体漂移（linear，像真的推轨）→ **落定**。
 * 末段默认减速（power2.out）：切点前把运动收住，观众的眼位是稳的，剪辑才藏得住
 * （Murch《眨眼之间》：切在视线静止处最不刺眼）。加速收势是"急推标点"，
 * 只在导演显式 punchOut 时启用，并受 V-CAM-005「全片急推≤2次」约束。
 * 静止镜（static/none 且无覆盖切）返回空分段——是真的定帧，交给场景内表演。
 * 覆盖切点会把曲线打断成若干段：切点前收在当前构图，切点后从新构图继续漂移。
 */
export function planCameraRig(args: {
  shotId: string;
  durationMs: number;
  zoom: string;
  camera: string;
  focus: Focus;
  coverage: CoverageCut[];
  options?: CameraOptions;
}): RigPlan {
  const options = args.options ?? {};
  const durationS = Math.max(0.3, args.durationMs / 1000);
  // 行程随镜长缩放：短促节拍镜给满幅位移只会变成急推/甩镜——标点不能成为常态
  const durationFactor = clamp(durationS / 3.5, 0.45, 1);
  const amp = (ZOOM_AMP[args.zoom] ?? 0.044) * durationFactor * (options.amp ?? 1);
  const move = normalizeMove(args.camera);
  const sign = options.dir ? (options.dir === 'left' ? -1 : 1) : focusSign(args.focus, args.shotId);
  const cuts = args.coverage.filter((c) => c.atMs >= 760 && c.atMs <= args.durationMs - 320);
  const enterS = Math.min(0.5, Math.max(0.24, durationS * 0.16));
  const midS = Math.max(enterS + 0.12, durationS - Math.min(0.45, Math.max(0.22, durationS * 0.14)));
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
  const waypoints =
    move === 'static'
      ? [
          { t: 0, scale: SCALE_HOLD, x: 0, y: 0 },
          { t: durationS, scale: SCALE_HOLD, x: 0, y: 0 },
        ]
      : waypointsFor(move, amp, durationS, enterS, midS, sign);

  // 标点运镜（punch-in / whip-pan）的「打中点」必须成为分段边界，
  // 否则缓动会把 0.28s 的冲击摊到整段三秒里——那就退化成慢推了。
  const punctS =
    move === 'punch-in' ? Math.min(durationS * 0.42, 0.32)
    : move === 'whip-pan' ? Math.min(durationS * 0.3, 0.28)
    : null;

  // 分段边界：三段 + 标点打中点 + 每个覆盖切点（切点把整条曲线切成"切前/切后"两段）
  const bounds = [
    ...new Set([
      0,
      enterS,
      ...(punctS === null ? [] : [punctS]),
      ...cuts.map((c) => c.atMs / 1000),
      midS,
      durationS,
    ]),
  ]
    .filter((b) => b >= 0 && b <= durationS)
    .sort((a, b) => a - b);

  // 分段：切点前一段收在"切前构图"，后一段从"切后构图"起步继续漂移——
  // 同一帧上后一段的 set 覆盖前一段的收尾值，就是一次换机位硬切。
  const segments: RigSegment[] = [];
  for (let i = 1; i < bounds.length; i += 1) {
    const a = bounds[i - 1]!;
    const b = bounds[i]!;
    const durS = +(b - a).toFixed(3);
    if (durS <= 0) continue;
    const isFirst = i === 1;
    const isLast = i === bounds.length - 1;
    // 标点段用「冲进去」的缓动（expo.out），冲完之后的段落才减速落定；
    // 常规镜维持 进入 settle(power2.out) → 漂移(none) → 落定(power2.out)。
    const isPunct = punctS !== null && Math.abs(b - punctS) < 1e-6;
    const ease = isPunct
      ? (move === 'whip-pan' ? 'expo.out' : 'power3.out')
      : isFirst
        ? 'power2.out'
        : isLast
          ? (options.punchOut ? 'power2.in' : 'power2.out')
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
function focusSign(focus: Focus, shotId: string): number {
  if (focus.x < 48) return 1;
  if (focus.x > 52) return -1;
  return hashSeed(shotId) % 2 === 0 ? 1 : -1;
}

export interface RigSegment {
  atS: number;
  durationS: number;
  from: RigKeyframe;
  to: RigKeyframe;
  ease: string;
}

function stateAt(
  waypoints: Waypoint[],
  cuts: CoverageCut[],
  tS: number,
  inclusive: boolean,
): RigKeyframe {
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
export function rigStateAt(plan: RigPlan, tS: number, inclusive = false): RigKeyframe {
  const waypoints =
    plan.move === 'static'
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
export function buildRigScript(plan: RigPlan): string {
  const host = `[data-composition-id="scene-${plan.shotId}"]`;
  if (plan.segments.length === 0) return '';
  const segs: string[] = [];
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
