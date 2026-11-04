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

/** 覆盖偏移：scale 连乘、位移/旋转累加，都有上限，避免叠加成"越切越糊的近景" */
function accumulate(cuts: CoverageCut[], tS: number, inclusive: boolean): RigKeyframe {
  let scale = 1;
  let x = 0;
  let y = 0;
  let rotation = 0;
  for (const c of cuts) {
    const at = c.atMs / 1000;
    if (inclusive ? at > tS + 1e-6 : at >= tS - 1e-6) break;
    scale *= c.scale;
    x += c.xPercent;
    y += c.yPercent;
    rotation += c.rotation;
  }
  return {
    atS: tS,
    scale: clamp(scale, 1, 1.28),
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

const DRIFT = 2.2;

function waypointsFor(
  move: CameraMove,
  amp: number,
  durS: number,
  enterS: number,
  midS: number,
  sign: number,
): Waypoint[] {
  switch (move) {
    case 'push-in':
      return [
        { t: 0, scale: 1 + amp * 0.12, x: -sign * 0.9, y: 0 },
        { t: enterS, scale: 1 + amp * 0.28, x: 0, y: 0 },
        { t: midS, scale: 1 + amp * 0.92, x: sign * 0.5, y: 0 },
        { t: durS, scale: 1 + amp * 1.16, x: sign * 0.7, y: 0 },
      ];
    case 'pull-out':
      return [
        { t: 0, scale: 1 + amp * 1.12, x: sign * 0.8, y: 0 },
        { t: enterS, scale: 1 + amp * 0.96, x: 0, y: 0 },
        { t: midS, scale: 1 + amp * 0.30, x: -sign * 0.4, y: 0 },
        { t: durS, scale: 1 + amp * 0.16, x: -sign * 0.5, y: 0 },
      ];
    case 'pan':
      return [
        { t: 0, scale: 1 + amp * 0.6, x: -DRIFT * 0.82, y: 0 },
        { t: enterS, scale: 1 + amp * 0.58, x: -DRIFT, y: 0 },
        { t: midS, scale: 1 + amp * 0.56, x: DRIFT, y: 0 },
        { t: durS, scale: 1 + amp * 0.58, x: DRIFT * 1.1, y: 0 },
      ];
    case 'pan-left':
      return [
        { t: 0, scale: 1 + amp * 0.6, x: DRIFT * 0.82, y: 0 },
        { t: enterS, scale: 1 + amp * 0.58, x: DRIFT, y: 0 },
        { t: midS, scale: 1 + amp * 0.56, x: -DRIFT, y: 0 },
        { t: durS, scale: 1 + amp * 0.58, x: -DRIFT * 1.1, y: 0 },
      ];
    case 'tilt-up':
      return [
        { t: 0, scale: 1 + amp * 0.6, x: 0, y: DRIFT * 0.7 },
        { t: enterS, scale: 1 + amp * 0.58, x: 0, y: DRIFT * 0.9 },
        { t: midS, scale: 1 + amp * 0.56, x: 0, y: -DRIFT * 0.9 },
        { t: durS, scale: 1 + amp * 0.58, x: 0, y: -DRIFT },
      ];
    case 'tilt-down':
      return [
        { t: 0, scale: 1 + amp * 0.6, x: 0, y: -DRIFT * 0.7 },
        { t: enterS, scale: 1 + amp * 0.58, x: 0, y: -DRIFT * 0.9 },
        { t: midS, scale: 1 + amp * 0.56, x: 0, y: DRIFT * 0.9 },
        { t: durS, scale: 1 + amp * 0.58, x: 0, y: DRIFT },
      ];
    default:
      return [
        { t: 0, scale: 1 + amp * 0.10, x: 0, y: 0 },
        { t: enterS, scale: 1 + amp * 0.14, x: 0, y: 0 },
        { t: midS, scale: 1 + amp * 0.40, x: sign * 0.4, y: 0 },
        { t: durS, scale: 1 + amp * 0.54, x: sign * 0.5, y: 0 },
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
          { t: 0, scale: 1, x: 0, y: 0 },
          { t: durationS, scale: 1, x: 0, y: 0 },
        ]
      : waypointsFor(move, amp, durationS, enterS, midS, sign);

  // 分段边界：三段 + 每个覆盖切点（切点把整条曲线切成"切前/切后"两段）
  const bounds = [...new Set([0, enterS, ...cuts.map((c) => c.atMs / 1000), midS, durationS])]
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
    const ease = isFirst ? 'power2.out' : isLast ? (options.punchOut ? 'power2.in' : 'power2.out') : 'none';
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
    scale: +(base.scale * off.scale).toFixed(4),
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
          { t: 0, scale: 1, x: 0, y: 0 },
          { t: plan.durationS, scale: 1, x: 0, y: 0 },
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
