import type { Project } from '../schema.js';
import { isCameraToken, CAMERA_MOVES } from '../schema.js';
import { err, warn, type Issue } from './types.js';
import { findSharedRuns } from './scene.js';

export function validateStoryboard(p: Project): Issue[] {
  const issues: Issue[] = [];
  const shots = p.shots;

  if (p.script && shots.length > 0 && p.script.segments.length !== shots.length) {
    // V-RHY-007：镜头粒度=语义单元——一镜一单元，段数必须与镜数一致
    // （V-STE-003 属任务幂等条款，此处系历史借号）
    // P8-T6 修订：超长镜切分（一镜装 >8s 旁白）会把一段合法地拆成 a/b 两镜——
    // 拆分镜共享同一 segmentId 且旁白原文拼接 = 原段，这属于「一镜变两拍」不是丢段；
    // 判据改为「每个 segmentId 至少有一镜覆盖」。
    const segIds = new Set(p.script.segments.map((s) => s.id));
    const covered = new Set(shots.map((s) => s.segmentId));
    const missing = [...segIds].filter((id) => !covered.has(id));
    if (missing.length > 0) {
      issues.push(
        err(
          'V-RHY-007',
          `旁白段数(${p.script.segments.length}) 与镜头数(${shots.length}) 不匹配：段 ${missing.join(', ')} 无镜头覆盖`,
        ),
      );
    }
  }

  for (const s of shots) {
    // V-CAM-002（修订）：词表合法即可——static/none 是导演的合法选择（静止构图 + 镜内表演，
    // 小津/北野武/死板喜剧都靠它），不再当"幻灯片"报错；全片画面是否够活由 V-RHY-010 统计，
    // 重音是否落到画面由 V-RHY-004 管。这里只拦没登记的词（拼错会静默退化成静止）。
    if (!isCameraToken(s.camera)) {
      // 报错文案从词表常量派生，不手写枚举——手写的那份迟早和 schema.ts 漂移，
      // 而漂移会骗人：「照报错写的词」反而不在词表里。
      issues.push(
        err(
          'V-CAM-002',
          `镜头 ${s.id} 运镜词「${s.camera}」不在词表（合法值：${[...CAMERA_MOVES, 'static', 'none'].join('/')}；别名如 panright/whip/punch 也会被归一化）`,
        ),
      );
    }
    if (!s.counterpoint) {
      issues.push(err('V-CP-002', `镜头 ${s.id} 未选对位模式`));
    }
    if (s.counterpoint === 'parody' && !s.gag) {
      issues.push(err('V-CP-004', `镜头 ${s.id} 使用戏仿对位但未声明 gag（违规许可）`));
    }
    // V-COL-002 色彩脚本：每镜必须带色温标注
    if (!s.colorTemp) {
      issues.push(err('V-COL-002', `镜头 ${s.id} 缺少色温标注（色彩脚本字段）`));
    }
  }

  // V-COL-003 相邻镜色温应有变化（全片一成不变 = 色彩脚本缺位）
  let sameTempRun = 1;
  for (let i = 1; i < shots.length; i += 1) {
    const prev = shots[i - 1]!;
    const cur = shots[i]!;
    if (prev.colorTemp && prev.colorTemp === cur.colorTemp) {
      sameTempRun += 1;
      if (sameTempRun >= 6) {
        issues.push(warn('V-COL-003', `色温连续 ${sameTempRun} 镜无变化（至 ${cur.id}）`));
        sameTempRun = 1;
      }
    } else {
      sameTempRun = 1;
    }
  }

  const zoomRank: Record<string, number> = {
    ELS: 0,
    LS: 1,
    MLS: 2,
    MS: 3,
    MCU: 4,
    CU: 5,
    ECU: 6,
  };
  for (let i = 1; i < shots.length; i += 1) {
    const prev = shots[i - 1];
    const cur = shots[i];
    if (!prev || !cur) continue;
    if (prev.segmentId === cur.segmentId) {
      const a = prev.visual.params['scene'] as string | undefined;
      const b = cur.visual.params['scene'] as string | undefined;
      if (a && a === b && prev.zoom !== cur.zoom) {
        const diff = Math.abs((zoomRank[prev.zoom] ?? 0) - (zoomRank[cur.zoom] ?? 0));
        if (diff < 2) {
          issues.push(
            warn('V-COMP-008', `镜头 ${prev.id}→${cur.id} 同场景景别差 ${diff} 级（应 ≥2）`),
          );
        }
      }
    }
  }

  if (!p.style) {
    issues.push(err('V-STYLE-001', '缺少风格决策记录'));
  } else if (!p.style.rationale) {
    issues.push(err('V-STYLE-001', '风格决策缺少 rationale'));
  }

  issues.push(...validateCounterpointDiversity(shots));

  return issues;
}

/**
 * V-CP-005 对位多样性（P13 阶段1 · 提案 §1.A）。
 *
 * 为什么是统计而不是逐镜：单镜选 `metaphor` 永远合法，问题只在**全片只有一种**——
 * 那是「一个语调讲完全片」，观众听到的节奏是平的。所以只在镜数 ≥6 时判，
 * 少镜短片本来就没有分布可言（4 镜里凑 2 种是凑数不是多样）。
 *
 * 照 V-RHY-010 / validateCutMotivation 的 `kinds.size < 2` 现成模式（composer.ts:110-112）。
 */
export function validateCounterpointDiversity(shots: Project['shots']): Issue[] {
  if (shots.length < 6) return [];
  const kinds = new Set(shots.map((s) => s.counterpoint).filter(Boolean));
  if (kinds.size >= 2) return [];
  return [
    warn(
      'V-CP-005',
      `${shots.length} 镜全片只有一种对位模式（${[...kinds].join('/') || '未声明'}）——一个语调讲完全片，至少给一段换对位（literal/atmospheric/complementary 都是现成选项）`,
    ),
  ];
}

/**
 * V-CP-006 字面直译率分档（P13 阶段1 · 提案 §1.A）。
 *
 * 判据：画面与旁白共享的连续片段（`findSharedRuns`，与 V-SCENE-005 同一数据源）
 * 占旁白内容单位数的比例。比例**过高** = 看图说话：观众看着字，听着同一句字。
 *
 * 为什么按 genre 分档而不是一个普世阈值：讲解类（科学/教程/儿童）本来就该让术语上画面，
 * 高重合是对的；叙事/观点类高重合就是插图。档位是**先验偏好**，进登记簿，不是普世法。
 *
 * 为什么只判上限、不判下限：低重合正是隐喻/纯氛围该有的样子——「跑题」与「意境」
 * 在纯统计上不可分（需要 judge 盲评）。硬判下限会把对的表达判错，所以这一侧留给人看。
 */
export const LITERAL_RATE_BANDS: Record<string, number> = {
  // 讲解/信息类：术语上画面是功能不是缺陷
  'science-explainer': 0.45,
  'tutorial-howto': 0.45,
  'kids-education': 0.5,
  'news-brief': 0.45,
  'product-promo': 0.4,
  // 叙事/观点/氛围类：字面复述就是插图
  'story-narrative': 0.3,
  'opinion-essay': 0.3,
  'documentary-mood': 0.25,
  'cosmos-cinematic': 0.25,
  'short-vibe': 0.35,
};
/** 未登记 genre 的兜底档（取讲解与叙事之间） */
export const LITERAL_RATE_DEFAULT_BAND = 0.35;

export function validateLiteralRate(narration: string, html: string, genre: string | undefined): Issue[] {
  const units = narrationUnits(narration);
  if (units < 8) return []; // 太短的句子没有比率可言（一两句口号）
  const runs = findSharedRuns(narration, html);
  const shared = runs.reduce((acc, r) => acc + r.length, 0);
  const rate = shared / units;
  // 注意不能写 `genre && LITERAL_RATE_BANDS[genre]`：genre 为空串时整个表达式就是 ''，
  // 类型被拉成 string | number，`rate <= band` 直接编译失败（且空串会绕过兜底档）。
  const band = LITERAL_RATE_BANDS[genre ?? ''] ?? LITERAL_RATE_DEFAULT_BAND;
  if (rate <= band) return [];
  return [
    warn(
      'V-CP-006',
      `字面直译率 ${(rate * 100).toFixed(0)}% 超过 ${genre || '默认'} 档 ${(band * 100).toFixed(0)}%（共享片段：${runs.join('、')}）——画面在复述旁白，换成对位表达（换主体/换尺度/换隐喻）`,
    ),
  ];
}

/** 旁白内容单位数：汉字 1 字 1 单位，英文/数字按词（≥2 字符）1 单位，标点不计 */
function narrationUnits(narration: string): number {
  const cjk = (narration.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = (narration.match(/[A-Za-z0-9]{2,}/g) ?? []).length;
  return cjk + words;
}
