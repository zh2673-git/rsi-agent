import { err, warn, type Issue } from './types.js';

export const MOTION_WHITELIST = [
  'MV.enter',
  'MV.exit',
  'MV.emphasis',
  'MV.camera',
  'MV.performance',
  'MV.subtitle',
  'MV.idle',
  'MV.use',
  'MV.timeline',
  // 3D 素材语言层（docs/11 §二 visuals.dimension=css3d 时使用）
  'MV.depth',
  'MV.tilt3d',
  'MV.orbit',
  'MV.card3d',
  'MV.spin3d',
];

/** 3D 痕迹：透视/三轴旋转/景深原语任一出现即视为用了立体素材 */
const HAS_3D =
  /perspective\s*:|preserve-3d|rotate3d\(|rotate[XY]\(|translateZ\(|rotation[XY]\s*:|transformPerspective|MV\.(depth|tilt3d|orbit|card3d|spin3d)/i;

export function uses3d(html: string): boolean {
  return HAS_3D.test(html);
}

const TIME_ATTRS = ['data-start', 'data-duration', 'data-track-index'];

export function validateSceneFile(
  html: string,
  opts: {
    narration: string;
    title?: string;
    whitelist?: string[];
    /** 风格声明的视觉维度（V-STYLE-008 素材语言一致性） */
    dimension?: '2d' | 'css3d' | 'mixed';
  },
): Issue[] {
  const issues: Issue[] = [];
  const whitelist = opts.whitelist ?? MOTION_WHITELIST;

  // V-STYLE-008 素材语言一致性：声明的维度必须和场景实际用的素材对得上，
  // 否则风格只是换了配色，素材还是另一派（2D 扁平包混进 3D 场景 / 声明立体却全程平面）
  const is3d = uses3d(html);
  if (opts.dimension === '2d' && is3d) {
    issues.push(warn('V-STYLE-008', '风格声明 dimension=2d，但场景使用了 3D 元素（素材语言漂移）'));
  }
  if (opts.dimension === 'css3d' && !is3d) {
    issues.push(warn('V-STYLE-008', '风格声明 dimension=css3d，但场景无任何 3D 元素（立体语言未落地）'));
  }

  if (!html.includes('data-scene-id')) {
    issues.push(err('V-SCENE-002', '场景缺少根元素 data-scene-id'));
  }
  for (const attr of TIME_ATTRS) {
    if (html.includes(attr)) {
      issues.push(
        err('V-SCENE-002', `场景禁止包含时间轴属性 ${attr}（时序只允许剪辑部机器生成）`),
      );
    }
  }
  const calls = html.match(/MV\.[a-zA-Z]+/g) ?? [];
  for (const call of calls) {
    if (!whitelist.includes(call)) {
      issues.push(err('V-SCENE-003', `场景引用非白名单原语 ${call}`));
    }
  }
  // V-MOT-008 时长 token 纪律（error）：时长必须落在 motion profile 区间
  // {微 200-400 / 入场 400-800 / 转场 300-600 / 强调循环 1200-2000ms}
  for (const m of html.match(/duration:\s*(\d{3,})/g) ?? []) {
    const ms = Number(m.match(/(\d+)/)![1]);
    const inRange =
      (ms >= 200 && ms <= 400) || (ms >= 400 && ms <= 800) || (ms >= 300 && ms <= 600) || (ms >= 1200 && ms <= 2000);
    if (!inRange) {
      issues.push(err('V-MOT-008', `时长 ${ms}ms 不在 motion profile 区间（200-400/400-800/300-600/1200-2000）`));
    }
  }
  // V-MOT-001 缓动白名单（error）：非 token 缓动拦截
  const EASING_WHITELIST = [
    'power1.out', 'power1.in', 'power1.inOut', 'power2.out', 'power2.in', 'power2.inOut',
    'power3.out', 'power3.in', 'power3.inOut', 'power4.out', 'sine.out', 'sine.in', 'sine.inOut',
    'expo.out', 'expo.in', 'back.out', 'elastic.out', 'none',
  ];
  for (const m of html.match(/(?:ease|easing):\s*'([^']+)'/g) ?? []) {
    const val = m.match(/'([^']+)'/)?.[1];
    if (!val) continue;
    if (val.startsWith('{{') || val.includes('(')) continue; // token / back.out(1.4) 带参形式
    if (!EASING_WHITELIST.includes(val)) {
      issues.push(err('V-MOT-001', `缓动 '${val}' 不在 motion 组 token 白名单`));
    }
  }
  // V-MOT-005 / V-ACT-004 位移禁直线匀速急停（error）：带 x/y 位移的 tween 禁 ease:'none'
  for (const m of html.match(/\.[a-zA-Z]+\([^)]*x:\s*-?\d+[^)]*ease:\s*'none'[^)]*\)/g) ?? []) {
    issues.push(err('V-MOT-005', `位移沿直线匀速（ease:'none' + x 位移）：${m.slice(0, 60)}`));
  }
  for (const m of html.match(/\.[a-zA-Z]+\([^)]*y:\s*-?\d+[^)]*ease:\s*'none'[^)]*\)/g) ?? []) {
    issues.push(err('V-ACT-004', `位移急停（ease:'none' + y 位移，禁急停）`));
  }
  // V-MOT-004 staging（error）：辅助元素（note/hint/sub/deco）显式 opacity > 0.7 抢主语
  for (const m of html.match(/\.(?:note|hint|sub|deco)\s*\{[^}]*opacity:\s*(0?\.\d+|1)\b/g) ?? []) {
    const op = Number(m.match(/opacity:\s*(0?\.\d+|1)/)![1]);
    if (op > 0.7) {
      issues.push(err('V-MOT-004', `辅助元素透明度 ${op} > 0.7（staging：非主语让位主语）`));
    }
  }
  // V-MOT-010/011 并发约束（error）：MV 场景同屏运动元素 ≤3、位移方向 ≤2
  const isCanvas = html.includes('canvas');
  if (!isCanvas) {
    const targets = new Set(
      [...html.matchAll(/MV\.(?:enter|to|from|fromTo|emphasis)\('([^']+)'/g)].map((m) => m[1]),
    );
    if (targets.size > 4) {
      issues.push(err('V-MOT-010', `同屏运动元素 ${targets.size} > 3（共同命运约束）`));
    }
    let dirs = 0;
    if (/\bx:\s*-/.test(html)) dirs += 1;
    if (/\bx:\s*\d/.test(html)) dirs += 1;
    if (/\by:\s*-/.test(html)) dirs += 1;
    if (dirs > 2) {
      issues.push(err('V-MOT-011', `同屏运动方向 > 2（共同命运约束）`));
    }
  }
  // V-COMP-001 主语唯一（error，MV 模板场景）：subject/title/hero 主语元素恰 1 个
  if (!isCanvas) {
    const subjects = (html.match(/class="[^"]*\b(subject|title|hero)\b[^"]*"/g) ?? []).length;
    if (subjects !== 1) {
      issues.push(err('V-COMP-001', `视觉主语数量 ${subjects} ≠ 1（最大对比元素恰为一个）`));
    }
  }
  // V-ACT-005 长镜 idle（warn）：估计时长 >4s 的场景须有表演微动
  const estSec = opts.narration.length * 0.22;
  if (estSec > 4 && !/MV\.idle|MV\.emphasis|MV\.performance|pulse/.test(html)) {
    issues.push(warn('V-ACT-005', `长镜（≈${estSec.toFixed(1)}s）无 idle 微动（禁死寂）`));
  }
  const visualText = stripSubtitleAreas(html, opts.title);
  const shared = findSharedRuns(opts.narration, visualText);
  for (const run of shared) {
    // V-SCENE-005：画面禁复述旁白原文（对位铁律）；V-SCP-005 属编剧字数档位条款，不得借用
    issues.push(
      err('V-SCENE-005', `画面元素复述旁白原文「${run}」（对位铁律：禁看图说话）`),
    );
  }
  return issues;
}

function stripSubtitleAreas(html: string, title?: string): string {
  let out = html.replace(
    /<(div|span|p)[^>]*class="[^"]*\b(caption|hint|sub|subtitle)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g,
    ' ',
  );
  if (title && title.length >= 4) {
    out = out.split(title).join(' ');
  }
  return out;
}

const CJK = /[\u4e00-\u9fff]/;

export function findSharedRuns(narration: string, html: string, minLen = 4): string[] {
  const cleaned = narration.replace(/[，。！？、；：""''（）\s,.!?;:()]/g, '');
  const runs = new Set<string>();
  if (CJK.test(cleaned)) {
    for (let i = 0; i + minLen <= cleaned.length; i += 1) {
      const run = cleaned.slice(i, i + minLen);
      if (CJK.test(run) && html.includes(run)) runs.add(run);
    }
  }
  for (const word of narration.split(/[^A-Za-z0-9]+/)) {
    if (word.length >= 4 && html.toLowerCase().includes(word.toLowerCase())) {
      runs.add(word);
    }
  }
  return [...runs].slice(0, 3);
}

export function extractKeywords(text: string): string[] {
  const cleaned = text.replace(/[，。！？、；：""''（）\s,.!?;:]/g, ' ');
  return cleaned
    .split(' ')
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 8);
}

export function validateChartScene(html: string): Issue[] {
  const issues: Issue[] = [];
  if (/\b3d\b|三维|立体饼图/i.test(html)) {
    issues.push(err('V-CHT-001', '图表禁 3D/立体装饰（Tufte：data-ink 最大化）'));
  }
  const gradientFills = html.match(/fill="url\(#grad\)"/g) ?? [];
  if (gradientFills.length > 2) {
    issues.push(warn('V-CHT-001', '图表渐变填充过多，疑似装饰 junk'));
  }
  return issues;
}
