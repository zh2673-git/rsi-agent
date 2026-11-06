/**
 * 重音预算分配（V-MOT-013 的唯一事实源）。
 *
 * 判据：全片重音镜（用了 slam/punch/whip 的镜）占比 ≤ 1/3。
 *
 * ## 为什么必须有确定性分配，而不是「各镜自己判断」
 *
 * 重音是全片资源，但画面是**逐镜独立生成**的：LLM 场景 30 镜并行，谁也看不到
 * 别人的 HTML；forge 模板也是单镜渲染。提示词里没有预算，模型只能凭「这一镜挺重要」
 * 的直觉往 HTML 里塞 MV.slam —— 实测 30 镜里 15 镜带标点（50%），30 个场景文件
 * 各自全部合规，整片却在合成阶段被一条全片审计判 error 卡死。
 *
 * 所以预算必须由**项目本身**算出来：同一份分镜，无论重跑多少次、用哪种生成路径、
 * 并发顺序如何，分配到「有资格用重音」的都是同一批镜。任何依赖「已生成几镜」的
 * 计数式预算都会随重跑漂移，那不是预算，是竞态。
 *
 * ## 分配原则（标点是给高光镜的）
 *
 * 1. 首镜必须有（V-MOT-018：开头是具体小场景，需要那一下砸）；
 * 2. 末两镜优先（收尾金句是天然的标点位置）；
 * 3. 情绪段（script function=emotion）与带 emphasis 词的段优先；
 * 4. 其余配额按 shotId 哈希打散——**不用「每 3 镜一次」**：固定节拍就是节拍器，
 *    观众会感觉到规律；打散后总量仍受约束，但节奏看不出周期。
 */

import type { Project } from '../core/schema.js';

/** hashSeed：稳定字符串哈希（FNV-1a 变体），不依赖平台 Math.random */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface AccentBudget {
  /** 有资格使用重音原语的镜 id */
  allowed: Set<string>;
  /** 全片上限（与 V-MOT-013 判据同源：floor(总镜数/3)，<4 镜不限） */
  cap: number;
  totalShots: number;
}

/**
 * 算全片重音预算。纯函数：只读 project.shots / project.script，不看生成状态。
 */
export function allocateAccentShots(project: Project): AccentBudget {
  const shots = project.shots;
  const n = shots.length;
  // 与 V-MOT-013 同一条豁免：镜头太少时不设预算
  if (n < 4) {
    return { allowed: new Set(shots.map((s) => s.id)), cap: n, totalShots: n };
  }
  const cap = Math.floor(n / 3);
  const quota = Math.max(1, cap);
  const segById = new Map((project.script?.segments ?? []).map((s) => [s.id, s]));

  const allowed = new Set<string>();
  // 1. 首镜必占
  allowed.add(shots[0]!.id);
  // 2. 末两镜优先（受配额限制）
  const tailIdx: number[] = [];
  for (let i = Math.max(1, n - 2); i < n && allowed.size < quota; i += 1) {
    tailIdx.push(i);
    allowed.add(shots[i]!.id);
  }
  // 3. 情绪段 / 带重音标记的段优先补位（按镜序，保证确定性）
  const tailSet = new Set(tailIdx);
  const priority: number[] = [];
  const rest: number[] = [];
  for (let i = 1; i < n; i += 1) {
    if (tailSet.has(i) || allowed.has(shots[i]!.id)) continue;
    const seg = segById.get(shots[i]!.segmentId);
    if (seg?.function === 'emotion' || (seg?.emphasis?.length ?? 0) > 0) priority.push(i);
    else rest.push(i);
  }
  for (const i of priority) {
    if (allowed.size >= quota) break;
    allowed.add(shots[i]!.id);
  }
  // 4. 其余配额按 shotId 哈希打散（固定节拍就是节拍器，所以要打散）
  const remaining = quota - allowed.size;
  if (remaining > 0) {
    rest
      .map((i) => ({ i, k: hashSeed(shots[i]!.id) }))
      .sort((a, b) => a.k - b.k)
      .slice(0, remaining)
      .forEach((x) => allowed.add(shots[x.i]!.id));
  }
  return { allowed, cap, totalShots: n };
}

/** 单点查询（forge 模板渲染用）：这一镜有没有重音预算 */
export function accentAllowedFor(project: Project, shotId: string): boolean {
  return allocateAccentShots(project).allowed.has(shotId);
}
