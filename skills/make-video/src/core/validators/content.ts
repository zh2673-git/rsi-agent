import type { Project, Script } from '../schema.js';
import { PLACEHOLDER_MARK } from '../constants.js';
import { err, warn, type Issue } from './types.js';

/**
 * 内容门（v1.1.1）。此前全套校验只审形式（时长/分辨率/动效预算/字段齐全），
 * 于是「8 句套话循环 3.75 遍」的讲稿能把所有门跑绿——形式全绿而内容空转，
 * 这是比任何单点 bug 更严重的验收失效。本文件补三件事：
 *   1. V-SCP-011 台词去重：重复句占比过高 = 没有内容，只有填充。
 *   2. V-SCP-012 套话黑名单：可套在任何主题上的空话，一律不许进片。
 *   3. V-SCP-013 主题落地：讲稿必须真的在讲这个主题，而不是通用叙事。
 * 以及 V-RHY-012 节奏周期重复：镜头时长/形态成周期循环 = 观众看到「同一段反复放」。
 * （V-RHY-011 已被「切点动机」占用，见 validators/composer.ts。）
 */

/**
 * 套话黑名单：每一条都能套在任意主题上而不失真，因此出现在成片里就说明
 * 讲稿没有产出信息。命中 ≥2 段判 error（单段偶发可能只是过渡句）。
 */
export const BOILERPLATE_PHRASES: readonly string[] = [
  '把镜头拉近',
  '再退一步看',
  '远比表面看起来更有意思',
  '核心机制可以拆成几步',
  '最反直觉的一点来了',
  '这里有一个容易被带过的转折',
  '把上面连起来',
  '脉络浮出水面',
  '回到最初的问题',
  '答案已经在眼前',
  '细节开始显形',
  '结构就完整了',
  '值得注意的是',
  '让我们一起',
  '接下来我们来看',
  '总而言之',
];

/** 判重前归一化：去标点空白，只比字面意思 */
function normalize(text: string): string {
  return text.replace(/[\s，。、！？；：""''（）()《》…—\-.,!?;:'"]/g, '');
}

/** 主题词：按标点切成片段（CPU / 流水线 / 电脑…） */
export function topicTerms(topic: string): string[] {
  return topic
    .split(/[\s，。、！？；：""''（）()《》…—\-.,!?;:'"]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * 主题实体（v1.1.2）：从标题里抽出「会被讲稿真的复述」的实词。
 *
 * 旧实现用 2 字滑窗做指纹，跨词边界会造出「线如」「何让」「为电」这种词——
 * 中文标题里这些位置根本不构成词，讲稿再贴题也不可能写它们。实测
 * "CPU流水线如何让你以为电脑很快" 的 15 个二元组里 8 个是跨界垃圾，
 * 覆盖率上限被压到 53%，而判据卡在 30%：好稿子在 temperature 0.7 下随机翻转，
 * 27% 被判跑题、打回重写。永远在临界点的门等于随机门。
 *
 * 现在按「中文停用词 + 虚词」切出实词块，只留长度 ≥2 的实体：
 * CPU / 流水线 / 电脑 —— 这些才是讲稿会反复回到的锚点。
 */
const CN_STOPWORDS = [
  '如何', '怎么', '怎样', '为什么', '是什么', '什么', '哪些', '哪个',
  '让你', '让你以为', '你以为', '以为', '我们', '你们', '他们',
  '可以', '能够', '到底', '究竟', '其实', '真的', '原来',
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '很',
];

export function topicEntities(topic: string): string[] {
  let rest = topic.replace(/[\s，。、！？；：""''（）()《》…—\-.,!?;:'"]/g, '');
  // 长停用词先切，避免「让你」被当成实体残留
  for (const sw of [...CN_STOPWORDS].sort((a, b) => b.length - a.length)) {
    rest = rest.split(sw).join('|');
  }
  const out = new Set<string>();
  for (const chunk of rest.split('|')) {
    const c = chunk.trim();
    if (c.length < 2) continue;
    // 「CPU流水线」这种「英文缩写紧跟中文实词」的粘块要拆开：
    // 讲稿可能分别写 CPU 和 流水线，粘成一块会两边都匹配不上。
    const parts = c.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? [c];
    for (const p of parts) if (p.length >= 2) out.add(p);
  }
  for (const t of topicTerms(topic)) {
    if (/^[A-Za-z0-9]+$/.test(t)) out.add(t);
  }
  return [...out];
}

/**
 * 主题指纹（兼容旧调用）：返回实体列表。
 * 保留这个名字是因为 index.ts 已导出；语义已从「二元组」改成正词实体。
 */
export function topicBigrams(topic: string): string[] {
  return topicEntities(topic);
}

/**
 * 讲稿内容门。topic 由项目元信息给（writeScript 时传入），
 * 用于判断讲稿是否真的在讲这个主题。
 */
export function validateScriptContent(script: Script, topic: string): Issue[] {
  const issues: Issue[] = [];
  const segs = script.segments;
  if (segs.length === 0) return issues;

  // V-SCP-015 离线占位：template 引擎没有内容能力，其产出只是骨架。
  // 这条必须排在最前——它是最硬的判据：不是「质量不好」，而是「根本没有内容」。
  const placeholders = segs.filter((s) => s.text.includes(PLACEHOLDER_MARK));
  if (placeholders.length > 0) {
    issues.push(
      err(
        'V-SCP-015',
        `离线占位讲稿：${placeholders.length}/${segs.length} 段带「${PLACEHOLDER_MARK}」标记——当前是 template 兜底引擎（未配 LLM_BASE_URL），产出不是真实内容，不能当成片交付。请配置 LLM_BASE_URL / LLM_MODEL 后重跑`,
      ),
    );
  }

  // V-SCP-011 台词去重：唯一句占比 < 80% 判 error
  const seen = new Map<string, number>();
  for (const s of segs) {
    const key = normalize(s.text);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const unique = seen.size;
  const ratio = unique / segs.length;
  if (ratio < 0.8) {
    const worst = [...seen.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `「${t.slice(0, 18)}」×${n}`)
      .join('，');
    issues.push(
      err(
        'V-SCP-011',
        `台词重复：${segs.length} 段仅 ${unique} 句唯一（${Math.round(ratio * 100)}%，要求 ≥80%）。高频重复：${worst}`,
      ),
    );
  }

  // V-SCP-012 套话黑名单：命中 ≥2 段判 error
  const hits: string[] = [];
  for (const s of segs) {
    for (const p of BOILERPLATE_PHRASES) {
      if (s.text.includes(p)) hits.push(`${s.id}「${p}」`);
    }
  }
  if (hits.length >= 2) {
    issues.push(
      err(
        'V-SCP-012',
        `套话空转：命中 ${hits.length} 处可套任意主题的空话（${hits.slice(0, 4).join('，')}${hits.length > 4 ? '…' : ''}）——讲稿必须给具体机制/因果/数字`,
      ),
    );
  }

  // V-SCP-013 主题落地：讲稿必须真的在讲这个主题。
  //
  // v1.1.2 校准：旧判据「二元组命中率 ≥30%」有两个错——
  //   1) 二元组跨词边界（线如/何让/为电）根本不可能被贴题讲稿命中，覆盖率上限只有 53%；
  //   2) 阈值卡在上限附近，好稿子实测 27%、坏稿子也可能 40%，门在随机翻转。
  // 现在改用**实体**（CPU / 流水线 / 电脑），判据是「至少一半实体在讲稿里出现过」，
  // 并对「只出现一次」的实体打 warn（念了标题就再没回来 = 没展开）。
  const prints = topicEntities(topic);
  if (prints.length > 0) {
    const full = segs.map((s) => s.text).join('').toLowerCase();
    const counts = prints.map((b) => {
      const re = new RegExp(b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      return { term: b, n: (full.match(re) ?? []).length };
    });
    const hit = counts.filter((c) => c.n > 0);
    const coverage = hit.length / prints.length;
    if (hit.length === 0) {
      issues.push(
        err('V-SCP-013', `主题落地：全片没有任何主题实体命中（${prints.join('/')}）——讲稿跑题`),
      );
    } else if (coverage < 0.5 && segs.length >= 6) {
      issues.push(
        err(
          'V-SCP-013',
          `主题落地：主题实体仅命中 ${hit.length}/${prints.length}（${Math.round(coverage * 100)}%）——讲稿在写通用叙事而不是「${topic}」。缺：${counts.filter((c) => c.n === 0).map((c) => c.term).join('/')}`,
        ),
      );
    } else {
      // 只点一次名就不再回来：标题念过了，但内容没围绕它展开
      const once = hit.filter((c) => c.n === 1).map((c) => c.term);
      if (once.length > 0 && segs.length >= 10) {
        issues.push(
          warn(
            'V-SCP-013',
            `主题实体只出现一次：${once.join('/')}——像把标题念了一遍就转去通用叙事`,
          ),
        );
      }
    }
  }

  // V-SCP-014 信息密度（warn）：全片零数字/零英文字符 = 没有任何具体锚点
  const hasAnchor = segs.some((s) => /\d|[A-Za-z]{2,}/.test(s.text));
  if (!hasAnchor && segs.length >= 6) {
    issues.push(
      warn('V-SCP-014', '信息密度：全片没有数字或专有名词，观众抓不到具体锚点'),
    );
  }

  return issues;
}

/**
 * 节奏周期门：镜头时长或画面形态如果成周期循环，观众看到的就是「同一段反复放」。
 * 判据：存在周期 p ≤ 长度/2，且序列按 p 重复 ≥2 轮（容忍最后一轮不完整）。
 */
export function findPeriod(items: string[]): number | null {
  const n = items.length;
  if (n < 4) return null;
  for (let p = 1; p <= Math.floor(n / 2); p += 1) {
    let matches = 0;
    let total = 0;
    for (let i = p; i < n; i += 1) {
      total += 1;
      if (items[i] === items[i - p]) matches += 1;
    }
    // 周期重复判定：除首轮外，后续元素几乎全部与 p 前一致
    if (total > 0 && matches / total >= 0.95) return p;
  }
  return null;
}

export function validateRhythmPeriodicity(p: Project): Issue[] {
  const issues: Issue[] = [];
  const shots = p.shots;
  if (shots.length < 6) return issues;

  // 画面形态抽样（优先模板名，其次 canvas 场景程序）
  const forms = shots.map((s) =>
    String(s.visual.template ?? s.visual.params['scene'] ?? s.visual.kind),
  );

  // 情形一：全片单一形态（不是"周期"，是"根本没换过画面"）
  const uniqueForms = new Set(forms);
  if (uniqueForms.size === 1) {
    issues.push(
      err(
        'V-RHY-012',
        `全片单一画面形态：${shots.length} 镜全部使用「${forms[0]}」——这就是「一张图反复放」的极端形态`,
      ),
    );
  } else {
    // 情形二：形态按固定周期轮转（例：8 个模板循环 3.75 遍）
    const formPeriod = findPeriod(forms);
    if (formPeriod !== null && formPeriod < shots.length / 2) {
      const cycle = forms.slice(0, formPeriod);
      issues.push(
        err(
          'V-RHY-012',
          `画面形态周期重复：每 ${formPeriod} 镜一轮（${cycle.join('→')}），全片 ${shots.length} 镜循环 ${(shots.length / formPeriod).toFixed(2)} 遍——观众看到的是同一段素材反复播放`,
        ),
      );
    }
  }

  // 旁白顺序周期（与 V-SCP-011 互补：查的是排列规律，即使句子不完全相同）
  const narration = shots.map((s) => normalize(s.narration).slice(0, 12));
  if (new Set(narration).size > 1) {
    const textPeriod = findPeriod(narration);
    if (textPeriod !== null && textPeriod < shots.length / 2) {
      issues.push(
        err(
          'V-RHY-012',
          `旁白顺序周期重复：每 ${textPeriod} 镜一轮，讲稿在按模板轮转填段而不是叙事推进`,
        ),
      );
    }
  }

  return issues;
}
