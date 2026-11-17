/**
 * 跨镜运动连续性（T1b 出入画矢量，2026-11-14 · 行业通识项落成参数）
 *
 * 「生硬感」的机器可检成分之一：A 镜出画方向与 B 镜入画方向相反时，
 * 观众的眼睛被迫每两秒反向跳一次——这就是「每镜都在动但整片在打架」的来源。
 * 广告/预告片剪辑的通识：相邻镜运动方向尽量同向或静止接运动。
 *
 * 机位词 → 归一化方向矢量（x 右正 / y 下正 / z 推近为正）。
 * 只有矢量都有定义且夹角 >90°（点积 <0）才报警：静止镜是天然的方向重置，
 * drift/无位移机位不参与判据。
 */

import { GRAMMARS } from './motion-grammar.js';

export interface MotionVector {
  x: number;
  y: number;
  z: number;
}

/** 机位运动词 → 方向矢量（与 motion-lib MV.camera / camera.ts rig 词表同口径） */
export const CAMERA_VECTORS: Record<string, MotionVector> = {
  'pan': { x: 1, y: 0, z: 0 },
  'pan-left': { x: -1, y: 0, z: 0 },
  'tilt-up': { x: 0, y: -1, z: 0 },
  'tilt-down': { x: 0, y: 1, z: 0 },
  'push-in': { x: 0, y: 0, z: 1 },
  'punch-in': { x: 0, y: 0, z: 1 },
  'dolly-in': { x: 0.5, y: 0, z: 1 },
  'dolly-out': { x: -0.5, y: 0, z: -1 },
  'crane-up': { x: 0, y: -1, z: 0.4 },
  'crane-down': { x: 0, y: 1, z: -0.4 },
  'whip-pan': { x: 1, y: 0, z: 0 },
  // drift / static / none：无确定方向，不参与夹角判据
};

export function cameraVector(camera: string | undefined): MotionVector | undefined {
  if (!camera) return undefined;
  return CAMERA_VECTORS[camera];
}

function dot(a: MotionVector, b: MotionVector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export interface ContinuityCheckItem {
  cut: string;
  prevCamera: string;
  camera: string;
  status: 'ok' | 'reverse' | 'skipped';
  detail: string;
}

export interface ContinuityAudit {
  generatedAt: string;
  items: ContinuityCheckItem[];
  softTransitionRuns: Array<{ kind: string; run: number; cuts: string[] }>;
  warns: string[];
}

export interface ContinuityShotInput {
  shotId: string;
  camera: string;
  /** 本镜切入所用的转场 kind（cut-audit 的 plan.kind；首镜为空） */
  transition: string;
}

/**
 * 连续性审计：出入画矢量（V-CON-003）+ 软转场节奏（同款 ≥3 连，死板清除 X6）。
 * 纯函数：输入只来自 timeline.shots 与转场裁决结果。
 */
export function auditContinuity(shots: ContinuityShotInput[]): ContinuityAudit {
  const items: ContinuityCheckItem[] = [];
  const warns: string[] = [];
  for (let i = 1; i < shots.length; i += 1) {
    const prev = shots[i - 1]!;
    const cur = shots[i]!;
    const cut = `${prev.shotId}→${cur.shotId}`;
    const va = cameraVector(prev.camera);
    const vb = cameraVector(cur.camera);
    if (!va || !vb) {
      items.push({
        cut,
        prevCamera: prev.camera,
        camera: cur.camera,
        status: 'skipped',
        detail: '存在静止/漂移镜，方向重置合法',
      });
      continue;
    }
    const d = dot(va, vb);
    if (d < 0) {
      items.push({
        cut,
        prevCamera: prev.camera,
        camera: cur.camera,
        status: 'reverse',
        detail: `出入画方向相反（${prev.camera} → ${cur.camera}），眼睛要反向跳`,
      });
    } else {
      items.push({
        cut,
        prevCamera: prev.camera,
        camera: cur.camera,
        status: 'ok',
        detail: `运动同向或正交（${prev.camera} → ${cur.camera}）`,
      });
    }
  }
  const reverse = items.filter((i) => i.status === 'reverse');
  if (reverse.length > 0) {
    warns.push(
      `V-CON-003: ${reverse.length} 处相邻镜运动反向（${reverse.slice(0, 4).map((r) => r.cut).join(', ')}）——出画方向与入画方向打架，换机位或插静止镜重置`,
    );
  }
  // 死板清除 X6：同款软转场 ≥3 连（六连 dissolve 的「同一种呼吸感」来源）
  const softTransitionRuns: ContinuityAudit['softTransitionRuns'] = [];
  let runKind = '';
  let runCuts: string[] = [];
  const flush = () => {
    if (runCuts.length >= 3) {
      softTransitionRuns.push({ kind: runKind, run: runCuts.length, cuts: runCuts.slice(0, 6) });
      warns.push(
        `V-CON-004: 软转场 ${runKind} 连用 ${runCuts.length} 次（${runCuts.slice(0, 4).join(' → ')}…）——同一种节奏呼吸 ${runCuts.length} 连就是节拍器，换词或改硬切`,
      );
    }
    runCuts = [];
  };
  for (const s of shots) {
    const kind = s.transition;
    const isSoft = kind && kind !== 'hard-cut' && kind !== 'smash-cut' && kind !== 'continuity';
    if (isSoft && kind === runKind) {
      runCuts.push(s.shotId);
    } else {
      flush();
      runKind = isSoft ? kind : '';
      if (isSoft) runCuts.push(s.shotId);
    }
  }
  flush();
  return { generatedAt: new Date().toISOString(), items, softTransitionRuns, warns };
}

/**
 * T1c 全片节奏曲线（2026-11-14）：pacing.curve 的可执行化。
 *
 * schema 的 pacing.curve 本来就是 string，但从未被解析——「先快后慢」只活在文档里。
 * 格式：逗号分隔的能量目标序列（0-1），按幕均分映射到镜（"0.9,0.6,0.4,0.7" =
 * 四幕：钩子高能量 → 展开 → 沉潜 → 收束回升）。解析失败返回 undefined（不猜）。
 *
 * P12 阶段2：新增**具名曲线**支持（治 F2「20 处 pacing.curve 全部不可解析」）。
 * 10 个风格包与 10 个配方写的是 `three-act` / `beat-pause` / `tarkovsky` 这类
 * **具名**曲线——那是有价值的表达（比一串裸数字更能说明意图），
 * 缺的从来不是意图，而是**具名 → 数值**的映射表。
 * 所以本层做两件事：① 给出具名曲线的标准数值；② 解析时先认具名、再认数字。
 */
export function parseEnergyCurve(curve: string | undefined): number[] | undefined {
  if (!curve) return undefined;
  const named = NAMED_ENERGY_CURVES[curve.trim().toLowerCase()];
  if (named) return [...named];
  const parts = curve
    .split(/[,;，；]/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
  return parts.length >= 2 ? parts : undefined;
}

/**
 * 具名能量曲线 → 数值序列（0-1）。
 *
 * 每条曲线都是一个**全片形状**，不是每镜的值：
 *   - `three-act`：三幕剧形状（起→承→合，能量先升后落再收）
 *   - `beat-pause`：打点-停顿（重音后留白，用于产品片/发布会）
 *   - `staccato`：短促切分（全程高能量，用于信息密集的短片）
 *   - `even`：匀速（用于教学/教程）
 *   - `slow-burn`：慢燃（全程低能量，用于纪录/氛围）
 *   - `beat-grid`：节拍网格（规律重音，用于知识卡片）
 *   - `comedy-beat`：喜剧节拍（起→爆→收，用于喜剧）
 *   - `tarkovsky`：塔可夫斯基式长镜（几乎不切，能量压低，用于纪录片）
 *   - `gentle`：温和（低能量平缓，用于儿童教育）
 *   - `rapid`：快节奏（高能量，用于新闻）
 *   - `argument`：论证（起伏推进，用于观点文）
 *   - `story-arc`：故事弧（起承转合，用于叙事）
 *   - `steady`：稳定（用于教程）
 *
 * 取值口径：0.3 = 低能量（氛围/停顿），0.6 = 中性，0.9 = 高能量（重音/爆发）。
 * 判定与 pickGrammar 的能量闸一致（≥0.7 排除低能量语法，≤0.4 排除高能量语法）。
 */
export const NAMED_ENERGY_CURVES: Record<string, readonly number[]> = {
  // 三幕：起（钩子）→ 承（展开）→ 合（收束）
  'three-act': [0.75, 0.5, 0.85, 0.45],
  // 打点-停顿：重音后留白（产品发布/发布会节奏）
  'beat-pause': [0.85, 0.35, 0.8, 0.4],
  // 短促切分：全程高能量（信息密集短片）
  staccato: [0.9, 0.85, 0.9, 0.8],
  // 匀速（教学/教程）
  even: [0.55, 0.6, 0.55, 0.6],
  // 慢燃：全程低能量（纪录/氛围）
  'slow-burn': [0.35, 0.45, 0.4, 0.3],
  // 节拍网格：规律重音（知识卡片）
  'beat-grid': [0.8, 0.8, 0.8, 0.8],
  // 喜剧节拍：起→爆→收
  'comedy-beat': [0.6, 0.95, 0.5, 0.75],
  // 塔可夫斯基式长镜：几乎不切，能量压低（纪录片）
  tarkovsky: [0.3, 0.4, 0.35, 0.25],
  // 温和（儿童教育）
  gentle: [0.4, 0.5, 0.45, 0.35],
  // 快节奏（新闻）
  rapid: [0.9, 0.85, 0.9, 0.85],
  // 论证（观点文）
  argument: [0.7, 0.55, 0.75, 0.5],
  // 故事弧（叙事）
  'story-arc': [0.7, 0.6, 0.8, 0.4],
  // 稳定（教程）
  steady: [0.5, 0.55, 0.5, 0.55],
};

/** 具名曲线名单（给文档守卫与 CLI 提示用） */
export const NAMED_ENERGY_CURVE_IDS: readonly string[] = Object.keys(NAMED_ENERGY_CURVES);

/** 镜序 → 能量目标：按幕均分（第 i 镜落在 curve 的第 floor(i/n*acts) 幕） */
export function energyAt(shotsTotal: number, index: number, curve: number[]): number {
  if (shotsTotal <= 0) return curve[0] ?? 0.6;
  const acts = Math.min(curve.length, shotsTotal);
  const act = Math.min(acts - 1, Math.floor((index / shotsTotal) * acts));
  return curve[act] ?? 0.6;
}

/**
 * 语法 id → 能量档。
 *
 * P12 阶段2：这张表原先住在 continuity.ts 里，与语法本体分居两处——
 * 加一条语法忘了同步，就是一次静默漂移（语法有 energy 概念、审计却查不到）。
 * 现在并回 `GrammarSpec.energy` 本体，此处只保留一个读取器
 * （审计层拿的是 grammar id 字符串，不持有 GrammarSpec 对象）。
 */
function grammarEnergy(grammarId: string): number {
  return GRAMMARS.find((g) => g.id === grammarId)?.energy ?? 0.6;
}

/**
 * V-CON-002 节奏曲线偏离审计：全片实际语法能量均值 vs 曲线均值。
 * 偏离 >0.25 说明声明的节奏形状没有被选型执行——告警指向选型参数，
 * 不是逐镜过错（单镜能量是设计自由度，整片形状才是曲线的职责）。
 */
export function auditEnergyCurve(
  grammars: string[],
  curve: number[] | undefined,
): string[] {
  if (!curve || grammars.length === 0) return [];
  const actual =
    grammars.reduce((acc, g) => acc + grammarEnergy(g), 0) / grammars.length;
  const target = curve.reduce((a, b) => a + b, 0) / curve.length;
  if (Math.abs(actual - target) > 0.25) {
    return [
      `V-CON-002: 全片语法能量均值 ${actual.toFixed(2)} 偏离 pacing.curve 目标 ${target.toFixed(2)} > 0.25——声明的节奏形状没被选型执行，检查 energy 偏置或改曲线`,
    ];
  }
  return [];
}
