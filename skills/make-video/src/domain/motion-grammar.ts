/**
 * 动效语法层（M4 美术摄影部 · P7：吸收阿杜 adu-motion-video + 花叔 huashu-art-motion）
 *
 * 为什么需要这一层：分镜只决定「这一镜画什么」，剪辑只决定「怎么接」，
 * 中间还缺「怎么动」。缺这一层的结果是——画面很稳但很素，或者很炫但和文案没关系。
 * 语法层把「这段口播在干什么 → 用哪种画法动」这件事变成可判定、可审计的纯函数。
 *
 * 三个出口：
 *   pickGrammar(narration, ctx)      → 语法 id（选型，纯函数）
 *   actionSheet(shot, grammar)       → 八字段动作谱（阿杜的动作谱方法）
 *   auditMotionMix(timeline, byShot) → 混剪审计（花叔的硬 lint）
 *
 * 数据归属：语法表是本模块的只读常量；每镜落成的动作谱写 project.json
 * 的 shots[].visual.params.actionSheet（项目独占，人工可改）。
 */

export type GrammarId =
  | 'y1_flat_explainer' // Kurzgesagt：扁平无描边、尺度穿行
  | 'y2_collage' //        Vox：剪报、红线、荧光笔
  | 'y3_whiteboard' //     白板：笔尖揭开线稿，最后拉远看全图
  | 'y4_story' //          故事型简笔：换姿势 0.1s 快切后定住，笑点靠反应特写
  | 'y5_kinetic_type' //   动态文字：字是演员，关键词踩重音砸进来
  | 't1_3b1b' //           3Blue1Brown：一个对象形变成下一个，几乎不切
  | 't2_keynote' //        发布会：一屏一件事，产品/截图当主角
  | 't3_finance' //        财经图表：先搭坐标系，再让数据长出来
  | 'b_roll'; //           兜底：无形式可依时的实拍/氛围镜

export interface GrammarSpec {
  id: GrammarId;
  /** 用户叫法/语义触发词（命中即加分，不看顺序） */
  cues: string[];
  /** 这段口播在讲什么（选型理由，写进 IR 让决策可追溯） */
  when: string;
  /** 什么情况别选它（花叔选型表右列） */
  avoid: string;
  /** 典型动作序列：本质是「这一镜的动作剧本」，场景作者照此写 MV.* */
  motionBeats: string[];
  /** 机位偏好（v3 词表内的值；punch-in/whip-pan 是标点，受预算约束） */
  cameraBias: string[];
  /** 文字主导镜占比上限（花叔：文字主导 ≤30%） */
  textShare: number;
  /** 这一派「画要一直是活的」用的母题（环境层，与主动作分离） */
  motifs: string[];
}

/**
 * 九种语法（y1-y5 / t1-t3 + b_roll 兜底）。
 * motionBeats 里的箭头 = 动作的先后关系，不是时间刻度——
 * 阿杜的要点是「保留动作之间的关系比照抄总秒数更重要」。
 */
export const GRAMMARS: GrammarSpec[] = [
  {
    id: 'y1_flat_explainer',
    cues: ['尺度', '里面是什么', '机制', '结构', '系统', '细胞', '宇宙', '原子', '层', '放大', '缩小', '组成', '原理'],
    when: '讲一个概念、一个机制，需要一个能无限缩放的具体对象',
    avoid: '没有真实材料可贴时用 y2 会变成假档案；讲自己经历时用 y4',
    motionBeats: ['主体淡入定场', '→ 环境母题开始循环', '→ 尺度推进（推/拉揭示内部）', '→ 关键部件逐个点亮', '→ 拉远交代全貌'],
    cameraBias: ['push-in', 'pull-out', 'drift'],
    textShare: 0.3,
    motifs: ['float', 'pulse'],
  },
  {
    id: 'y2_collage',
    cues: ['证据', '截图', '新闻', '档案', '报道', '对比', '前后', '资料', '原文', '记录', '出处', '调查'],
    when: '有真实材料、截图、原话，观众要亲眼看到出处',
    avoid: '没有真实材料时用它会长出假档案',
    motionBeats: ['桌面/画布铺开', '→ 材料以冲印件落下（错峰）', '→ 高亮扫过要读那一行', '→ 红线连接两件材料', '→ 拉远看全桌'],
    cameraBias: ['pan', 'pan-left', 'push-in'],
    textShare: 0.25,
    motifs: ['shimmer'],
  },
  {
    id: 'y3_whiteboard',
    cues: ['为什么', '推导', '一步一步', '推理', '论证', '因为', '所以', '得出', '证明', '怎么算'],
    when: '边讲边推导，说一句写一句，最后拉远看全图',
    avoid: '一次整屏切换的快剪段落',
    motionBeats: ['白板留白', '→ 笔尖擦除式揭出第一行（maskReveal）', '→ 相机跟到论证点（横移）', '→ 逐行追加', '→ 结尾拉远看全图'],
    cameraBias: ['pan', 'pan-left', 'pull-out'],
    textShare: 0.35,
    motifs: ['shimmer'],
  },
  {
    id: 'y4_story',
    cues: ['我', '那次', '结果', '翻车', '笑', '尴尬', '没想到', '后来', '然后我', '亲身', '经历'],
    when: '第一人称讲经历、翻车、笑点；观众要的是「这个人」',
    avoid: '自带好消息情绪的产品发布用它会被压住',
    motionBeats: ['角色姿势快切后定住（0.1s）', '→ 反应特写跳近', '→ 笑点那一下闭嘴+定格', '→ 停顿后再接下一句'],
    cameraBias: ['static', 'punch-in'],
    textShare: 0.2,
    motifs: ['pulse'],
  },
  {
    id: 'y5_kinetic_type',
    cues: ['第一步', '第', '个', '三点', '清单', '阶段', '总结', '金句', '关键', '记住', '只有', '从来', '本质'],
    when: '清单、几个要点、几个阶段、一句金句；信息是结构不是画面',
    avoid: '有能变形的对象时用 t1 更有说服力',
    motionBeats: ['关键词整词砸入（slam）', '→ 主词拉开字距定住', '→ 辅助词错峰跟上', '→ 色带/擦除换场', '→ 数字滚动落定'],
    cameraBias: ['punch-in', 'static', 'drift'],
    textShare: 0.7,
    motifs: ['shimmer', 'float'],
  },
  {
    id: 't1_3b1b',
    cues: ['变成', '转成', '映射', '矩阵', '梯度', '概率', '网络', '函数', '向量', '输入', '输出', '训练'],
    when: '讲一个机制怎么一步步变成另一个东西；颜色=概念名，几乎不切',
    avoid: '没有能变形的对象时（清单/金句）用它',
    motionBeats: ['黑底只放正在讲的那一个对象', '→ 用 morphTo 变成下一个概念', '→ 停在结论上让它读', '→ 镜头穿越到细节', '→ 概念接力'],
    cameraBias: ['drift', 'push-in', 'static'],
    textShare: 0.25,
    motifs: ['shimmer'],
  },
  {
    id: 't2_keynote',
    cues: ['产品', '功能', '发布', '上线', '版本', '参数', '规格', '界面', '演示', '教程', '设置', '一键'],
    when: '产品/功能发布、版本更新、教程步骤、参数公布；一屏一件事',
    avoid: '玻璃和光斑不承载逻辑，别用来讲机制',
    motionBeats: ['一屏一件事定场', '→ 主角（截图/实物）推近', '→ 名词与数字在口播说到时落定', '→ 相邻功能卡压后', '→ 换屏'],
    cameraBias: ['push-in', 'punch-in', 'static'],
    textShare: 0.35,
    motifs: ['float'],
  },
  {
    id: 't3_finance',
    cues: ['增长', '下降', '百分', '%', '倍', '营收', '份额', '数量', '人均', '成本', '每年', '数据', '统计', '翻'],
    when: '讲数字、增长、走势、对比；观众会截图较真',
    avoid: '一段里只有一个数——用 t2/y5 的大数字，不画图表',
    motionBeats: ['先搭坐标系（轴线擦出）', '→ 数据自己长出来（counter/描线）', '→ 只标一件事（高亮扫过）', '→ 缓推该数据点约 1s', '→ 拉回全图'],
    cameraBias: ['push-in', 'pull-out', 'static'],
    textShare: 0.3,
    motifs: ['shimmer'],
  },
  {
    id: 'b_roll',
    cues: [],
    when: '无形式可依的氛围/过渡镜',
    avoid: '能用前八种讲清时别用它（它是兜底不是风格）',
    motionBeats: ['主体定场', '→ 环境母题循环（画一直是活的）', '→ 慢漂', '→ 收在可读的静止'],
    cameraBias: ['drift', 'slow-drift', 'static'],
    textShare: 0.15,
    motifs: ['float', 'pulse', 'rotate'],
  },
];

export function getGrammar(id: GrammarId | string): GrammarSpec {
  const found = GRAMMARS.find((g) => g.id === id);
  return found ?? GRAMMARS[GRAMMARS.length - 1]!;
}

export interface GrammarContext {
  /** 这一镜是否有真实素材（截图/录屏/照片） */
  hasRealMaterial?: boolean;
  /** 这一镜画面是否以文字为主（导演声明） */
  textLed?: boolean;
  /** 前两镜用过的语法（防连用） */
  recent?: GrammarId[];
  /** 本镜是否只有一个数字（花叔兜底二：不画图表，用大数字） */
  singleNumber?: boolean;
  /** 风格包的 sceneBias（语法必须能在该风格的素材语言里落地） */
  styleBias?: string[];
}

const NUMBER_RE = /\d|百分|千|万|亿|倍|成|个点/;
const COMPARE_RE = /比|相比|而|反而|却|不是|而是|以前|现在|从前/;

/**
 * 语法选型（纯函数：同一输入永远同一语法）。
 *
 * 分两轮：先按硬规则排除候选，排空了再放宽——这样「不许连用」和
 * 「只有一个数不画图表」是**排除**而不是扣分（扣分会被线索词淹没：
 * 「增长了百分之三十」的线索词得分远高于 -2 的惩罚，等于没生效）。
 *
 * 第一轮候选（硬规则）：
 *   - 前两镜用过的语法排除（花叔：同一个模板不要连续用两次）
 *   - singleNumber 时排除 t3（花叔兜底二：一个数用大数字，不画图表）
 *   - hasRealMaterial 时排除 y3（白板不贴真实截图）
 * 第二轮打分（在候选内）：线索词命中 + 结构关系；都 0 分 → b_roll。
 *
 * 为什么不给「默认语法」：默认就是「每镜都一样」的根源。
 */
export function pickGrammar(narration: string, ctx: GrammarContext = {}): GrammarSpec {
  const text = narration.toLowerCase();
  const recent = ctx.recent ?? [];

  const isExcluded = (g: GrammarSpec): boolean => {
    if (g.id === 'b_roll') return false; // 兜底永远可选
    if (recent.includes(g.id)) return true;
    if (ctx.singleNumber && g.id === 't3_finance') return true;
    if (ctx.hasRealMaterial && g.id === 'y3_whiteboard') return true;
    return false;
  };

  const score = (g: GrammarSpec): number => {
    let s = 0;
    for (const cue of g.cues) {
      if (cue && text.includes(cue.toLowerCase())) s += cue.length >= 3 ? 2 : 1;
    }
    // 结构关系（不依赖线索词，只看句子形状）
    if (g.id === 't3_finance' && NUMBER_RE.test(narration)) s += 2;
    if (g.id === 'y2_collage' && COMPARE_RE.test(narration)) s += 1;
    if (g.id === 'y5_kinetic_type' && /[：:]|一是|二是|三是/.test(narration)) s += 1;
    if (g.id === 'y4_story' && /我|我们/.test(narration)) s += 1;
    // 素材兜底：有真实素材时优先能给材料位置的语法
    if (ctx.hasRealMaterial && (g.id === 't2_keynote' || g.id === 'y2_collage')) s += 3;
    return s;
  };

  const strict = GRAMMARS.filter((g) => !isExcluded(g) && g.id !== 'b_roll');
  const ranked = strict
    .map((g) => ({ g, score: score(g) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked[0]) return ranked[0].g;

  // 放宽：只有「连用」是软规则（可以放宽一次），singleNumber / hasRealMaterial 是硬规则不放宽。
  const relaxed = GRAMMARS.filter(
    (g) =>
      g.id !== 'b_roll' &&
      !(ctx.singleNumber && g.id === 't3_finance') &&
      !(ctx.hasRealMaterial && g.id === 'y3_whiteboard'),
  )
    .map((g) => ({ g, score: score(g) - (recent.includes(g.id) ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return relaxed[0]?.g ?? getGrammar('b_roll');
}

/**
 * 动作谱（阿杜八字段）：这一镜的动作剧本。
 * 写进 project.json 的 visual.params.actionSheet，是场景作者的施工图，
 * 也是「这一镜到底怎么动」的可审计凭据（V-MOT-019 读它判主动作是否齐全）。
 */
export interface ActionSheet {
  grammar: GrammarId;
  /** 对应口播（这一镜在讲什么） */
  line: string;
  /** 主体是谁 */
  subject: string;
  /** 准备动作：主动作之前的反向位移/蓄势（V-MOT-002 anticipation） */
  prepare: string;
  /** 主动作：这一镜唯一的主角动作 */
  main: string;
  /** 刹停/收势：落定方式（禁硬停，V-MOT-003 follow-through） */
  settle: string;
  /** 配角让位：非主语怎么退 */
  secondary: string;
  /** 相机路径（v3 词表内的值） */
  cameraPath: string;
  /** 声音落点：音效挂在哪个动作上 */
  soundCue: string;
  /** 环境母题：让画面「一直是活的」，与主动作作用在不同元素 */
  motif: string;
}

/** 机位偏好落成词表值（b_roll 的 slow-drift 是别名 → drift） */
export function normalizeCameraBias(bias: string): string {
  if (bias === 'slow-drift') return 'drift';
  return bias;
}

/**
 * 由语法 + 镜头生成动作谱。
 * prepare/settle/secondary 的措辞按语法给具体值，不是模板套话——
 * 这三条正是「画面素」与「画面有戏」的差别所在。
 */
export function actionSheet(
  shot: { id: string; narration: string; camera?: string; zoom?: string },
  grammar: GrammarSpec,
): ActionSheet {
  const beats = grammar.motionBeats;
  const bias = grammar.cameraBias[0] ?? 'static';
  const textLed = grammar.textShare >= 0.5;
  const settleByGrammar: Record<string, string> = {
    y1_flat_explainer: '尺度推进落定在可读尺度，减速 power2.out',
    y2_collage: '材料落下后回弹 3%，再静止给读字留白',
    y3_whiteboard: '笔尖停住，等下一句再动',
    y4_story: '定格 + 挤压回弹（0.1s expo.out 后定住）',
    y5_kinetic_type: '砸入 0.94 → 1.0 回弹后完全静止，焦点唯一',
    t1_3b1b: '形变完成即停，结论留在画面上被读',
    t2_keynote: '名词/数字落定即静止，不叠滑入',
    t3_finance: '数据长完标一件事，镜头停住',
    b_roll: '慢漂自然收住',
  };
  return {
    grammar: grammar.id,
    line: shot.narration,
    subject: textLed ? '画面主体是字（关键词/数字）' : '画面主体是一个具体物件',
    prepare: textLed ? '关键字先缩小到 1.2 倍外、留 120ms 蓄势' : '主体先反向位移 3%（60-100ms anticipation）',
    main: beats[Math.min(1, beats.length - 1)]!.replace(/^→\s*/, ''),
    settle: settleByGrammar[grammar.id] ?? '减速落定',
    secondary: '非主语元素透明度 ≤70%、压后 180ms，且在主动作落点前不动',
    cameraPath: shot.camera && shot.camera !== 'none' ? shot.camera : normalizeCameraBias(bias),
    soundCue: textLed ? 'hit 与砸入同帧' : 'whoosh 峰值落在动作启动帧',
    motif: grammar.motifs[0] ?? 'float',
  };
}

/* ------------------------------------------------------------------ */
/* 混剪审计（花叔硬 lint 的确定性实现）                                  */
/* ------------------------------------------------------------------ */

export interface MotionShotFact {
  shotId: string;
  durationMs: number;
  /** 运镜词（已归一化） */
  camera: string;
  /** 画面是否以文字为主 */
  textLed: boolean;
  /** 该镜用过哪些重音原语（MV.slam/punch/whip） */
  accents: string[];
  /** 该镜是否有主动作（动作谱 main 非空，或有任一 MV.* 动效原语） */
  hasMainAction: boolean;
  /** 构图 key（景别 + 侧位）：相邻镜相同即「没换构图」 */
  compositionKey: string;
  /** 语法 id（未落成时为空） */
  grammar?: string;
}

export interface MotionIssue {
  rule: string;
  level: 'error' | 'warn';
  message: string;
}

const PUSH_SET = new Set(['push-in', 'punch-in']);

/**
 * 混剪审计：把两家「哪些做法被判过坏片」的判据落成能数的比例。
 *
 * | 规则 | 判据 | 出处 |
 * |---|---|---|
 * | V-MOT-013 | 重音镜（用了 slam/punch/whip）≤ 镜头数 1/3 | 花叔 lint ⑯ |
 * | V-MOT-014 | 不连三镜往里推 | 花叔 lint ⑮ |
 * | V-MOT-015 | 推近次数/分钟 ≤ 8 | 花叔 film_gate 黄灯线 |
 * | V-MOT-016 | 文字主导镜 ≤ 30% | 花叔 SKILL.md 轨道档第 1 条 |
 * | V-MOT-017 | 单镜 2–6s（0-5 档位） | 花叔「一镜 2–6 秒」 |
 * | V-MOT-018 | 开头 3 秒是具体小场景 | 花叔「开头 3 秒不是标题」 |
 * | V-MOT-019 | 每镜 ≥1 主动作；同语法不连 ≥3 | 阿杜 motion-quality |
 * | V-MOT-020 | 相邻两镜换构图 | 花叔「相邻两镜换构图，不换画风」 |
 */
export function auditMotionMix(shots: MotionShotFact[], totalMs: number): MotionIssue[] {
  const issues: MotionIssue[] = [];
  const total = shots.length;
  if (total === 0) return issues;

  // V-MOT-013 重音预算
  // 判据是「这一镜是否有一次重音标点」，不是「用了哪个模板」——
  // 一个模板可能在部分镜里只用入场+母题（无标点），那就没有抢重音资源。
  // 所以预算按场景实际调用的原语数（composer 已从 HTML 里数出 accents）。
  const accentShots = shots.filter((s) => s.accents.length > 0);
  if (total >= 4 && accentShots.length / total > 1 / 3) {
    issues.push({
      rule: 'V-MOT-013',
      level: 'error',
      message: `重音镜 ${accentShots.length}/${total} = ${Math.round((accentShots.length / total) * 100)}% > 33%（全篇都加粗等于没有重点）：${accentShots.slice(0, 5).map((s) => s.shotId).join('/')}`,
    });
  }
  // V-MOT-014 不连三镜往里推
  let run = 0;
  for (let i = 0; i < shots.length; i += 1) {
    const push = PUSH_SET.has(shots[i]!.camera);
    run = push ? run + 1 : 0;
    if (run >= 3) {
      issues.push({
        rule: 'V-MOT-014',
        level: 'error',
        message: `连续 ${run} 镜往里推（${shots.slice(i - run + 1, i + 1).map((s) => s.shotId).join('→')}）：推进去了要找机会拉出来或横移开`,
      });
      break;
    }
  }

  // V-MOT-015 推近频率
  const minutes = Math.max(totalMs, 1) / 60000;
  const pushCount = shots.filter((s) => PUSH_SET.has(s.camera)).length;
  if (minutes >= 0.2 && pushCount / minutes > 8) {
    issues.push({
      rule: 'V-MOT-015',
      level: 'warn',
      message: `推近 ${(pushCount / minutes).toFixed(1)} 次/分钟 > 8（全片一推一推的 zoom in 感）`,
    });
  }

  // V-MOT-016 文字主导占比
  const textShots = shots.filter((s) => s.textLed).length;
  if (textShots / total > 0.3) {
    issues.push({
      rule: 'V-MOT-016',
      level: 'warn',
      message: `文字主导镜 ${textShots}/${total} = ${Math.round((textShots / total) * 100)}% > 30%（信息是结构，但整片都靠字就是 PPT）`,
    });
  }

  // V-MOT-017 单镜时长
  const short = shots.filter((s) => s.durationMs < 1800);
  const long = shots.filter((s) => s.durationMs > 6500);
  if (short.length > 0) {
    issues.push({
      rule: 'V-MOT-017',
      level: 'warn',
      message: `过短镜头 ${short.length}（${short.slice(0, 4).map((s) => `${s.shotId}:${(s.durationMs / 1000).toFixed(1)}s`).join(' ')}）< 1.8s`,
    });
  }
  if (long.length > 0) {
    issues.push({
      rule: 'V-MOT-017',
      level: 'warn',
      message: `过长镜头 ${long.length}（${long.slice(0, 4).map((s) => `${s.shotId}:${(s.durationMs / 1000).toFixed(1)}s`).join(' ')}）> 6.5s`,
    });
  }

  // V-MOT-019 主动作齐全 + 同语法不连三镜
  const noAction = shots.filter((s) => !s.hasMainAction);
  if (noAction.length > 0) {
    issues.push({
      rule: 'V-MOT-019',
      level: 'warn',
      message: `${noAction.length} 镜无主动作（${noAction.slice(0, 5).map((s) => s.shotId).join('/')}）：只有标题和一张不变的卡片不构成动画讲解`,
    });
  }
  let gRun = 1;
  for (let i = 1; i < shots.length; i += 1) {
    const same = shots[i]!.grammar && shots[i]!.grammar === shots[i - 1]!.grammar;
    gRun = same ? gRun + 1 : 1;
    if (gRun >= 3) {
      issues.push({
        rule: 'V-MOT-019',
        level: 'warn',
        message: `语法 ${shots[i]!.grammar} 连续 ${gRun} 镜（同一种动作家族连用，观众感觉到节拍器）`,
      });
      break;
    }
  }

  // V-MOT-020 相邻换构图
  const sameComp: string[] = [];
  for (let i = 1; i < shots.length; i += 1) {
    if (shots[i]!.compositionKey && shots[i]!.compositionKey === shots[i - 1]!.compositionKey) {
      sameComp.push(`${shots[i - 1]!.shotId}→${shots[i]!.shotId}`);
    }
  }
  if (sameComp.length > Math.max(1, Math.floor(total * 0.4))) {
    issues.push({
      rule: 'V-MOT-020',
      level: 'warn',
      message: `${sameComp.length}/${total - 1} 处相邻镜构图未变（${sameComp.slice(0, 4).join(', ')}）：换构图不换画风`,
    });
  }

  return issues;
}

/** 开头 3 秒判据（V-MOT-018）：第一镜必须是具体小场景，不是纯标题卡 */
export function auditOpening(shots: MotionShotFact[]): MotionIssue[] {
  const first = shots[0];
  if (!first) return [];
  if (!first.hasMainAction || first.textLed) {
    return [
      {
        rule: 'V-MOT-018',
        level: 'warn',
        message: `开头镜头 ${first.shotId} 是${first.textLed ? '标题卡' : '无动作画面'}：开头 3 秒要是一个具体的小场景（一双手/一个物在做和题目有关的事）`,
      },
    ];
  }
  return [];
}
