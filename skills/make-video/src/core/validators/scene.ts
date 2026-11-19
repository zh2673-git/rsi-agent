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
  // 动效语法原语（P7：吸收阿杜 adu-motion-video + 花叔 huashu-art-motion）
  // 每个都对应一条可数语义，动机由场景作者写；重音类受 V-MOT-013 全片预算约束
  'MV.slam',
  'MV.staggeredIn',
  'MV.morphTo',
  'MV.counter',
  'MV.highlight',
  'MV.cards',
  'MV.punch',
  'MV.whip',
  'MV.drift',
  'MV.maskReveal',
  'MV.bands',
  'MV.motifLoop',
  // 3D 素材语言层（docs/11 §二 visuals.dimension=css3d 时使用）
  'MV.depth',
  'MV.tilt3d',
  'MV.orbit',
  'MV.card3d',
  'MV.spin3d',
  // 揭示类原语（P13 阶段2，白名单 26→28）：
  //   strokeDraw = SVG 笔迹沿路径画出（stroke-dashoffset 补间；y7 关系线 / y3 示意线，
  //   与 maskReveal 分工：mask 揭开区域，strokeDraw 生长笔迹）；
  //   typewriter = 文本逐字显现（引言/结论的逐字落地，定点 set 保 seek 可复现）。
  //   接口一律毫秒；沉淀的是「怎么动」，画面画什么仍由场景作者原创。
  'MV.strokeDraw',
  'MV.typewriter',
];

/** 重音类原语（标点）：slam/punch/whip —— 全片占比受 V-MOT-013 约束 */
export const ACCENT_PRIMITIVES = ['MV.slam', 'MV.punch', 'MV.whip'] as const;

/** 往里推的运镜词（V-MOT-014 不连三镜往里推） */
export const PUSH_CAMERAS = ['push-in', 'punch-in'] as const;

/**
 * 持续并列运动原语（V-MOT-010）：它们常驻画面，主体数受「共同命运 ≤4」约束。
 *
 * B3（P13 阶段2）：这里曾是 validator 里手抄的第二份原语清单——11 个名字全在
 * 白名单里，却要再抄一遍进正则；新增持续型原语时必然漂移。现在正则从本数组派生，
 * 新增原语只登记数组，校验自动跟上。motifLoop 不在本表：它的调用目标已单独作为
 * 环境层豁免（P7 修订，见 V-MOT-010 调用点）。
 */
export const SUSTAINED_PRIMITIVES = [
  'MV.camera',
  'MV.emphasis',
  'MV.idle',
  'MV.performance',
  'MV.orbit',
  'MV.tilt3d',
  'MV.spin3d',
  'MV.card3d',
  'MV.depth',
  'MV.drift',
  'MV.cards',
] as const;

/**
 * SUSTAINED_RE 只许 matchAll 消费——/g 正则是共享对象，.exec/.test 会拖动
 * lastIndex 让下一次 matchAll 丢匹配（与 MAIN_ACTION_RE 用 .test 的场景不同）。
 */
export const SUSTAINED_RE = new RegExp(
  `MV\\.(?:${SUSTAINED_PRIMITIVES.map((p) => p.slice(3)).join('|')})\\s*\\('([^']+)'`,
  'g',
);

/**
 * 长镜活性原语（V-ACT-005）：长镜（估计 >4s）必须至少一种「画面活着」的手段。
 *
 * B3（P13 阶段2）：V-ACT-005 与 domain/composer.ts 的 scenePulse（重音三角
 * V-MOT-018 的主体活性载体判据）是同一语义的两处手写正则，且口径还不一样
 * （前者含 motifLoop，后者只数 idle/performance/emphasis + 裸 pulse 词量）。
 * 收口为一份清单，两处共用。裸 `pulse` 子串一并删除（C2）：它只是 motifLoop 的
 * kind 值，不是原语——词量撞上就在活性判据里偷跑，白名单对它无约束力。
 */
export const LIVENESS_PRIMITIVES = [
  'MV.motifLoop',
  'MV.idle',
  'MV.performance',
  'MV.emphasis',
] as const;

export const LIVENESS_RE = new RegExp(
  `MV\\.(?:${LIVENESS_PRIMITIVES.map((p) => p.slice(3)).join('|')})\\s*\\(`,
);

/**
 * MV.camera 的 move 词表 —— 必须与 templates/motion/motion-lib.js 的 if 分支一致。
 * 拼错或漏实现会走 else 分支「静默 set scale」，画面看起来正常但根本没运镜。
 * V-SCENE-006 用本表把关（v1.1.1 案例 s09 写 move:'push' 踩过）。
 */
export const CAMERA_MOVES: readonly string[] = [
  'push-in',
  'pull-out',
  'pan',
  'pan-left',
  'tilt-up',
  'tilt-down',
  // 2026-11-13 增补：全片只有 push/pull/drift/tilt 四类时，16 镜必然成对重复，
  // 观感是「同一种缓慢放大」。补三种带纵深/升降的机位，给运镜留出可区分的词。
  'dolly-in',
  'dolly-out',
  'crane-up',
  'crane-down',
  'punch-in',
  'whip-pan',
  'drift',
  'static',
  'none',
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
    /**
     * 画面**有意显示**的术语（P12 阶段1）。
     *
     * 为什么需要豁免：V-SCENE-005（禁看图说话）禁止画面复述旁白，
     * 判据是「旁白的连续 4 个汉字出现在画面上」。但**术语本来就在旁白里**——
     * 「同步执行」「内存屏障」这类词，观众要看的正是这个词。
     * 规则一刀切地把术语也挡掉，结果是画面只能显示抽象图形或空标签。
     *
     * 豁免范围严格受限：
     *   - 只有**声明式**的术语（编剧在 segment.emphasis 里显式标注的词）才豁免；
     *   - 启发式抽取的词**不豁免**（那是猜的，猜错了就是复述旁白）；
     *   - 豁免只针对「该词整体」，词周围的旁白片段仍然照查。
     */
    exemptTerms?: string[];
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
  // 原语名含数字（tilt3d / card3d / spin3d / md5 式命名），字符类必须带 0-9，
  // 否则 MV.tilt3d 会被截成「MV.tilt」误判为非白名单原语
  const calls = html.match(/MV\.[a-zA-Z][a-zA-Z0-9]*/g) ?? [];
  for (const call of calls) {
    if (!whitelist.includes(call)) {
      issues.push(err('V-SCENE-003', `场景引用非白名单原语 ${call}`));
    }
  }
  // V-SCENE-006 运镜词拼写：MV.camera 的 move 只认词表里的值，
  // 拼错（如 move:'push'）在 motion-lib 里走 else 分支 → 静默失效，
  // 结果是「声明了运镜、画面其实没动」，V-RHY-004 到 compose 期才炸。
  // 实测来历：v1.1.1 案例 s09 写 move:'push'，整镜无相机腿，重音载体只剩 1 路。
  for (const m of html.matchAll(/MV\.camera\s*\(\s*[^,]+,\s*\{([^}]*)\}/g)) {
    const moveMatch = /move\s*:\s*['"]([^'"]+)['"]/.exec(m[1] ?? '');
    const move = moveMatch?.[1];
    if (move && !CAMERA_MOVES.includes(move)) {
      issues.push(
        err(
          'V-SCENE-006',
          `MV.camera 的 move「${move}」不在词表（${CAMERA_MOVES.join('/')}）——运行时走 else 分支静默失效，等于没运镜`,
        ),
      );
    }
  }
  // V-MOT-021 每镜必须有母题循环（error）：画面里一直有事发生。
  //
  // 出处：阿杜「每幕 1 个主动作 + 2 个母题循环」、花叔「画要一直是活的，禁图片之间做转场」。
  // 为什么必须是 error 而不是 warn：入场动作再漂亮也只占开头 1 秒，
  // 之后 4 秒如果没有任何循环运动，成片就是「动一下、然后死掉」。
  // 实测证据（2026-11-05 案例 A，flow 模板 7 镜全无 motifLoop）：
  //   帧间变化像素仅 4.6%，且只集中在左侧一个小方块和右下角标——整片 65% 帧近乎全静止。
  // 加入母题循环后同一指标升到 20-92%（整屏 16×9 热区几乎全亮）。
  // 注意：canvas 程序镜有自己的 rAF 循环，不走 MV.motifLoop，故豁免。
  if (!html.includes('canvas') && !/MV\.motifLoop\s*\(/.test(html)) {
    issues.push(
      err(
        'V-MOT-021',
        '场景无任何 MV.motifLoop：入场动作结束后画面会完全静止（阿杜/花叔共同铁律「画面一直是活的」）',
      ),
    );
  }
  // V-MOT-008 时长 token 纪律（error）：时长必须落在 motion profile 区间
  // {标点 150-200 / 微 200-400 / 入场 400-800 / 转场 300-600 / 微动 800-1200 / 强调循环 1200-2600ms}
  // 标点档（150-200ms）来自花叔实测的砸入 0.17s：重音那一下比「微动」还要短，
  // 否则砸下来变成推出来。三档以上覆盖 200-800 连续区，动画不必卡在档位缝里。
  // P13 阶段2 补档：motion-lib 的 MO 缺省表里 motif=2400ms——旧强调循环档上限 2000
  // 把**库自己的缺省值判成非法**，模板只能手写 duration 绕开。现在：
  //   ① 新增微动档 800-1200（MO.counter 缺省 900 等单次微动动作）；
  //   ② 强调循环档 1200-2000 放宽到 1200-2600（容纳 motif 缺省 2400 与
  //      hierarchy-stack/process-track 已显式写的 2000ms 档，均不破坏既有合规）。
  for (const m of html.match(/duration:\s*(\d{3,})/g) ?? []) {
    const ms = Number(m.match(/(\d+)/)![1]);
    const inRange =
      (ms >= 150 && ms <= 200) ||
      (ms >= 200 && ms <= 400) ||
      (ms >= 400 && ms <= 800) ||
      (ms >= 300 && ms <= 600) ||
      (ms >= 800 && ms <= 1200) ||
      (ms >= 1200 && ms <= 2600);
    if (!inRange) {
      issues.push(err('V-MOT-008', `时长 ${ms}ms 不在 motion profile 区间（150-200/200-400/400-800/300-600/800-1200/1200-2600）`));
    }
  }
  // V-MOT-001 缓动白名单（error）：非 token 缓动拦截
  // 白名单按「这条缓动的形状干什么用」收录，不是收集所有 GSAP 名称：
  //   out 系 = 入场/落定；in 系 = 退场/收势；inOut = 位移与形变；
  //   quint.out = 数字滚动落定（花叔 t3）；expo.inOut = 甩镜（y4）；power4.in = 砸入（y5）
  const EASING_WHITELIST = [
    'power1.out', 'power1.in', 'power1.inOut', 'power2.out', 'power2.in', 'power2.inOut',
    'power3.out', 'power3.in', 'power3.inOut', 'power4.out', 'power4.in', 'power4.inOut',
    'sine.out', 'sine.in', 'sine.inOut',
    'expo.out', 'expo.in', 'expo.inOut',
    'quint.out', 'quint.in', 'quint.inOut',
    'back.out', 'back.in', 'elastic.out', 'none',
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
  // V-MOT-010/011 并发约束（error）：同屏**持续并列运动**的主体 ≤4、位移方向 ≤2
  //
  // P7 修订（两处，都为对齐两家方法论）：
  //  1) 只数「持续并列运动」，不数一次性揭示。入场/擦除/高亮/砸入都是 resolve 到静止的
  //     一次性动作，本质是错峰不是并列——把它们算进共同命运，等于禁止阿杜的「错峰入场」。
  //     真正要防的是「好几样东西同时朝不同方向缓慢漂」那种廉价感。
  //  2) 环境母题（MV.motifLoop）是环境层，与主体分属两层、不抢属性，不计入——
  //     这正是「每幕一个主动作 + 2 个母题循环」的落地方式。
  const isCanvas = html.includes('canvas');
  if (!isCanvas) {
    // B3：持续并列原语清单从 SUSTAINED_PRIMITIVES 派生（不再手抄第二份白名单子集）；
    // matchAll 内部克隆正则，共享 /g 对象不会拖 lastIndex
    const motifCalls = new Set([...html.matchAll(/MV\.motifLoop\('([^']+)'/g)].map((m) => m[1]));
    const targets = new Set(
      [...html.matchAll(SUSTAINED_RE)].map((m) => m[1]).filter((t) => !motifCalls.has(t)),
    );
    if (targets.size > 4) {
      issues.push(
        err('V-MOT-010', `同屏持续运动主体 ${targets.size} > 4（共同命运约束；一次性揭示与环境母题不计入）`),
      );
    }
    let dirs = 0;
    if (/\bx:\s*-/.test(html)) dirs += 1;
    if (/\bx:\s*\d/.test(html)) dirs += 1;
    if (/\by:\s*-/.test(html)) dirs += 1;
    // 色带（MV.bands）是转场层，方向由 opts.dir 统一给，不参与主体方向计数
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
  // P7：环境母题循环（MV.motifLoop）同样是「画面里一直有事发生」，与 idle/emphasis 等价
  // B3：判据正则从 LIVENESS_PRIMITIVES 派生（与 domain/composer.ts 的 scenePulse 共用一份清单）；
  // 旧正则里的裸 `pulse` 子串已删（C2）——那是 motifLoop 的 kind 值，不是原语，
  // 词量撞上会让「画面死了」的长镜因为 CSS 里恰好有 pulse 这个词而漏检
  const estSec = opts.narration.length * 0.22;
  if (estSec > 4 && !LIVENESS_RE.test(html)) {
    issues.push(warn('V-ACT-005', `长镜（≈${estSec.toFixed(1)}s）无 idle 微动（禁死寂）`));
  }
  const visualText = stripSubtitleAreas(html, opts.title);
  const shared = findSharedRuns(opts.narration, visualText, 4, opts.exemptTerms);
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

/**
 * 找出画面与旁白共享的连续片段（V-SCENE-005 的数据源）。
 *
 * @param exemptTerms 豁免的术语（声明式）。命中豁免词的片段不算「复述」。
 *
 * 豁免的实现方式：把旁白里被豁免的词**挖掉**再找共享片段。
 * 这样豁免是精确到词的——「同步执行」豁免后，
 * 「并行流水线的吞吐」这样的其余片段仍然照查。
 */
export function findSharedRuns(
  narration: string,
  html: string,
  minLen = 4,
  exemptTerms: string[] = [],
): string[] {
  const cleaned = narration.replace(/[，。！？、；：""''（）\s,.!?;:()]/g, '');
  // 先挖掉豁免词（挖成空格，保持长度不影响其他窗口的判定）
  let carved = cleaned;
  // A3（P13 阶段1）：英文豁免通道。此前豁免只作用于中文挖词——旁白里的 API/GPU
  // 这类 ≥4 字符词，画面上一显示就被判「复述旁白」，而编剧在 emphasis 里声明豁免它
  // 完全无效（英文分支独立走 split，不查 carve 结果）。豁免通道必须两种字符都通。
  const exemptLower = new Set<string>();
  for (const term of exemptTerms) {
    if (!term) continue;
    const t = term.replace(/[，。！？、；：""''（）\s,.!?;:()]/g, '');
    // A3 裁决（P13 阶段1）：豁免词的**长度门槛不能借用 minLen**。
    // minLen 是「窗口多大算共享」，豁免是「这个词是有意显示的」——两者无关。
    // 用 minLen 当门槛会让 2-3 字的重音词（GPU/三体/复利）豁免失效，而它们
    // 恰恰最容易被中文 4 字窗口「跨词」命中（窗口 引力/GPU 之类的相邻组合）。
    // 下限取 2：1 个字符挖洞会把旁白打成筛子，那不叫豁免。
    if (t.length < 2) continue;
    exemptLower.add(t.toLowerCase());
    // 中文侧挖洞（英文词在 cleaned 里挖也一样有效，一并挖掉更省事）
    carved = carved.split(t).join(' '.repeat(t.length));
  }
  const runs = new Set<string>();
  const CJK = /[\u4e00-\u9fff]/;
  if (CJK.test(carved)) {
    for (let i = 0; i + minLen <= carved.length; i += 1) {
      const run = carved.slice(i, i + minLen);
      if (CJK.test(run) && html.includes(run)) runs.add(run);
    }
  }
  // 英文分支：按同一份豁免表跳过整词（大小写不敏感，与下面的 includes 口径一致）
  for (const word of narration.split(/[^A-Za-z0-9]+/)) {
    // A3 裁决（P13 阶段1）：短英文词不该被无条件放过——API/GPU/SDK/CPU 这类 3 字符
    // 缩写正是「有意显示在画面上」的术语，此前 `length < 4` 直接跳过，等于永远不判、
    // 也永远豁免不到（豁免表根本走不到这一行）。门槛降到 2（单字母多半是变量名/量纲，
    // 不值得当共享片段报），豁免表在下一行仍然生效。
    if (word.length < 2) continue;
    // 纯数字 token 不是术语：它既能命中「章节编号/刻度」这类正当显示，又会以子串形式
    // 命中 CSS 里的任意数值（"10" 命中 "100"/"translate(10px)"），把整批场景判成复述旁白。
    // 判据是「含至少一个字母」——API/GPU/SDK 过，10/3.5/2026 不过。
    if (!/[A-Za-z]/.test(word)) continue;
    if (exemptLower.has(word.toLowerCase())) continue;
    if (html.toLowerCase().includes(word.toLowerCase())) {
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

/**
 * V-SCENE-007：场景里不许残留未填充的占位符（2026-11-16，P12 阶段1）。
 *
 * 为什么是 error 而不是 warn：残留 `{{HERO_WORD}}` 在 HTML 文本里只是难看，
 * 但在 `<script>` 里是**非法 JS 语法**——`MV.counter('.x', { to: {{FIGURE_TO}} })`
 * 会被 JS 引擎当成对象字面量里没有键名的表达式，整个 script 块抛 SyntaxError，
 * 于是**这一镜的所有动画都不发生**（画面只剩静态文字）。
 *
 * 实测（2026-11-16）：15 个场景模板里有 6 个中招
 * （kinetic-type / compare-stage / deep-stage / hierarchy-stack / paper-stage / process-track），
 * 而所有既有校验器全绿——它们查的是「调用了哪些原语」，不是「JS 能不能跑」。
 * 这类缺陷此前能一路出片，说明缺口就在「渲染后有没有残留占位符」这一层。
 *
 * 判据：渲染完成后 HTML 里还有 `{{NAME}}` 形态的占位符 → error。
 */
export function validateNoLeftoverPlaceholder(html: string): Issue[] {
  const leftovers = [
    ...new Set([...html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)].map((m) => m[1]!)),
  ];
  if (leftovers.length === 0) return [];
  return [
    err(
      'V-SCENE-007',
      `场景残留未填充的占位符 ${leftovers.map((l) => `{{${l}}}`).join(' ')}：` +
        '若该占位符在 <script> 内会导致整块 JS 语法错误（该镜动画全部失效）；' +
        '请在模板契约 params 里声明它，或在内容派生层给出值',
    ),
  ];
}
