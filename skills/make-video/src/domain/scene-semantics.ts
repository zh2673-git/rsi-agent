/**
 * 场景语义匹配（M4 美术摄影部 · docs/04「根据剧本拍电影」的确定性实现层）：
 * 分镜不允许按索引轮转模板（那是"凑镜头数"的根源），必须按旁白语义选画面形式。
 * 该模块是 template 模式的兜底语义引擎；真实 LLM 接线见 scene-forge.tryLlmScene。
 */

import type { StyleVisual } from '../core/schema.js';

export interface TemplateCue {
  template: string;
  cues: string[];
}

/** 语义 → 模板线索表（命中词越多分越高；typography 为陈述/定义的兜底形式） */
export const TEMPLATE_CUES: TemplateCue[] = [
  { template: 'chart', cues: ['%', '百分', '数据', '倍', '每年', '增长', '统计', '质量是', '相当于', '数量级'] },
  { template: 'comparison', cues: ['相比', '对比', '差异', '截然不同', '不同于', '而它', '却是', '反而', '恰恰相反', 'vs'] },
  { template: 'flow', cues: ['首先', '然后', '接着', '随后', '最终', '于是', '步骤', '过程', '经过', '直到', '接着', '开始', '形成'] },
  { template: 'atmosphere', cues: ['深', '暗', '寂静', '浩瀚', '旋转', '悬浮', '漂浮', '遥远', '寂静无声', '光芒', '黑暗'] },
  { template: 'comic-symbol', cues: ['想象', '好比', '就像', '例如', '比方说', '打比方', '符号', '标志性的'] },
  // 3D 素材语言（风格 visuals.sceneBias 引入时才在候选池里，语义命中才会被选中）
  { template: 'iso-stage', cues: ['结构', '搭建', '框架', '立体', '空间', '舞台', '坐标', '层级', '齿轮', '机器'] },
  { template: 'depth-layers', cues: ['纵深', '层叠', '远近', '深处', '走进', '穿进', '镜头拉', '望向', '背后'] },
];

/**
 * 风格 → 素材池（V-STYLE-008）：风格说禁用的一律剔除，说偏好的提到候选池最前。
 * 偏好只影响排序与兜底，不硬塞镜头——真正的镜头语义仍由分镜/LLM 决定。
 */
export function applyStyleVisualPool(templates: string[], visuals: StyleVisual | undefined): string[] {
  if (!visuals) return templates;
  const deny = new Set(visuals.sceneDeny);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...visuals.sceneBias, ...templates]) {
    if (!t || deny.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  // 全被禁用属于风格配置过窄：宁可回退原池让工程能出片，漂移由 V-STYLE-008 审计记录
  return out.length > 0 ? out : templates;
}

export function bestTemplate(
  narration: string,
  allowed: string[],
  bias: string[] = [],
): { template: string; score: number } | null {
  const t = narration.toLowerCase();
  const rank = (name: string): number => {
    const i = bias.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  let best: { template: string; score: number } | null = null;
  for (const cue of TEMPLATE_CUES) {
    if (!allowed.includes(cue.template)) continue;
    const score = cue.cues.reduce((acc, c) => (t.includes(c.toLowerCase()) ? acc + 1 : acc), 0);
    if (score <= 0) continue;
    // 同分时风格偏好靠前的优先——素材形态要服从风格，而不是字典顺序
    if (
      !best ||
      score > best.score ||
      (score === best.score && rank(cue.template) < rank(best.template))
    ) {
      best = { template: cue.template, score };
    }
  }
  return best;
}

export function pickTemplateBySemantics(
  narration: string,
  allowed: string[],
  bias: string[] = [],
): string {
  const best = bestTemplate(narration, allowed, bias);
  if (best) return best.template;
  // 无线索命中 → 风格偏好的第一个（若有），否则基础陈述形式 typography
  const preferred = bias.find((b) => allowed.includes(b));
  if (preferred) return preferred;
  return allowed.find((x) => x === 'typography') ?? allowed[0] ?? 'typography';
}

/** canvas 画面程序语义主题（与 canvas-programs.js 每个程序的注释一一对应） */
export const CANVAS_PROGRAM_CUES: Record<string, string[]> = {
  s01: ['引力', '吸引', '拉', '逃脱', '逃逸', '旋入', '卷入', '吞噬', '无法摆脱', '深渊'],
  s02: ['事件视界', '视界', '边界', '有去无回', '光子环', '界限', '一去不返', '不可返回'],
  s03: ['弯曲', '时空', '网格', '引力井', '压弯', '凹陷', '测地线', '扭曲', '几何', '时间', '放慢', '空间'],
  s04: ['燃料', '烧尽', '耗尽', '红巨星', '核心', '熄灭', '脉动', '膨胀', '核聚变', '枯竭'],
  s05: ['坍缩', '超新星', '激波', '内爆', '爆炸', '爆发', '冲击波', '崩塌'],
  s06: ['双星', '伴星', '互绕', '天鹅座', '物质流', '潮汐', '撕裂', '绕转', '伴星'],
  s07: ['吸积盘', 'm87', 'eht', '金色', '盘面', '照片', '成像', '多普勒', '发光', '明亮', '拍到'],
  s08: ['拉远', '宁静', '结束', '答案', '回望', '终幕', '剪影', '重归', '平静', '余韵', '揭开', '奥秘', '浪漫'],
};

export interface CanvasPick {
  program: string;
  score: number;
}

/**
 * 按旁白语义选 canvas 程序；全零分时取"最久未用"的程序保证全片画面覆盖
 * （断绝连续重复——V-RHY-006 视觉变化律的分配层保障）。
 */
export function pickCanvasProgram(narration: string, programs: string[], recentUsed: string[]): CanvasPick {
  const t = narration.toLowerCase();
  let best: { program: string; score: number } | null = null;
  for (const p of programs) {
    const cues = CANVAS_PROGRAM_CUES[p] ?? [];
    const score = cues.reduce((acc, c) => (t.includes(c) ? acc + 1 : acc), 0);
    if (score > 0 && (!best || score > best.score)) best = { program: p, score };
  }
  if (best) return best;
  // 零命中 → 全历史 LRU：优先"从未用过"的，否则取距上次使用最远的（不与上一个重复），
  // 保证 8 个画面程序在全片均匀覆盖
  const lastIdx = new Map<string, number>();
  recentUsed.forEach((p, i) => lastIdx.set(p, i));
  const last = recentUsed[recentUsed.length - 1];
  const pool = programs.filter((p) => p !== last);
  const candidates = pool.length ? pool : programs;
  let chosen = candidates[0]!;
  let bestDist = -1;
  for (const p of candidates) {
    const idx = lastIdx.get(p);
    const dist = idx === undefined ? Number.MAX_SAFE_INTEGER : recentUsed.length - 1 - idx;
    if (dist > bestDist) {
      bestDist = dist;
      chosen = p;
    }
  }
  return { program: chosen, score: 0 };
}
