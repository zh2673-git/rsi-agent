import { normalizeCameraToken, type Project, type Timeline } from '../schema.js';
import { SYNC_TOLERANCE_MS } from '../constants.js';
import { err, warn, type Issue } from './types.js';

export function validateTimelineSync(shots: Project['shots'], timeline: Timeline): Issue[] {
  const issues: Issue[] = [];
  let acc = 0;
  timeline.shots.forEach((t, i) => {
    if (Math.abs(t.startMs - acc) > SYNC_TOLERANCE_MS) {
      issues.push(
        err(
          'V-CMP-001',
          `第 ${i + 1} 镜 startMs=${t.startMs} 与前序时长累加 ${acc} 偏差超 ${SYNC_TOLERANCE_MS}ms`,
        ),
      );
    }
    const shot = shots.find((s) => s.id === t.shotId);
    if (shot?.voice && Math.abs(t.durationMs - shot.voice.durationMs) > SYNC_TOLERANCE_MS) {
      issues.push(
        err(
          'V-CMP-001',
          `镜头 ${t.shotId} 时长 ${t.durationMs} ≠ 旁白实测 ${shot.voice.durationMs}`,
        ),
      );
    }
    acc += t.durationMs;
  });
  return issues;
}

// V-RHY-002 心理眨眼铁律（修订）：禁止"按字数均分"的无动机切镜。
// 句中切必须给出理由——句读停顿 / 切点动机 / 景别或色温变化 / 重音词落点，四者任一即可。
export function validateCutPoints(shots: Project['shots'], timeline: Timeline): Issue[] {
  const issues: Issue[] = [];
  for (let i = 1; i < timeline.shots.length; i += 1) {
    const prev = timeline.shots[i - 1];
    const cur = timeline.shots[i];
    if (!prev || !cur) continue;
    const prevShot = shots.find((s) => s.id === prev.shotId);
    const curShot = shots.find((s) => s.id === cur.shotId);
    if (!prevShot) continue;
    if (/[，。！？；.!?;]$/.test(prevShot.narration.trim())) continue;
    const hasMotivation = Boolean(cur.motivation);
    const zoomChange = prevShot.zoom !== (curShot?.zoom ?? prevShot.zoom);
    const tempChange = prevShot.colorTemp !== curShot?.colorTemp;
    const emphasisCut = (curShot?.visual.params['emphasisLanding'] as boolean) === true;
    if (!hasMotivation && !zoomChange && !tempChange && !emphasisCut) {
      issues.push(
        err('V-RHY-002', `剪切点 ${prev.shotId}→${cur.shotId} 落在句中且无切点动机（按字数均分切镜）`),
      );
    }
  }
  return issues;
}

// V-RHY-010 全片运动配比（修订）：静止是合法选择，但不能成为默认。
// 专业依据：静止构图 + 镜内表演是成熟的镜头语言（Bordwell《电影艺术》；
// 小津、北野武、死板喜剧），"幻灯片"的问题是**画面里什么都不动**，而不是没有外层机位。
// 因此不再逐镜告警，只统计两件事：静止占比过高（>60%）、全片运动式 <2 种（切点必然机械）。
export function validateIntraShotMotion(timeline: Timeline): Issue[] {
  const issues: Issue[] = [];
  const total = timeline.shots.length;
  if (total === 0) return issues;
  const staticIds: string[] = [];
  const moves = new Set<string>();
  for (const t of timeline.shots) {
    const move = normalizeCameraToken(t.camera) ?? 'static';
    if (move === 'static') staticIds.push(t.shotId);
    else moves.add(move);
  }
  if (staticIds.length / total > 0.6) {
    issues.push(
      warn(
        'V-RHY-010',
        `静止镜 ${staticIds.length}/${total} 超过 60%（${staticIds.slice(0, 4).join('/')}…）：静止是选择，不该是默认`,
      ),
    );
  }
  if (total >= 6 && moves.size < 2) {
    issues.push(
      warn('V-RHY-010', `全片机位运动单一（仅 ${[...moves].join('/') || '全静止'}），切点必然机械`),
    );
  }
  return issues;
}

// V-RHY-011 切点动机：镜间切必须声明动机（match-cut/action/eye-line/emotion/beat/zoom-jump）；
// 转场词只说明「怎么接」，不说明「为什么切」，因此不计入动机；缺失聚合成一条 warn 防刷屏
export function validateCutMotivation(timeline: Timeline): Issue[] {
  const issues: Issue[] = [];
  const kinds = new Set<string>();
  const missing: string[] = [];
  for (let i = 1; i < timeline.shots.length; i += 1) {
    const cur = timeline.shots[i]!;
    if (!cur.motivation) {
      missing.push(cur.shotId);
      continue;
    }
    kinds.add(cur.motivation);
  }
  if (missing.length > 0) {
    const head = missing.slice(0, 4).join('/');
    const more = missing.length > 4 ? ` 等 ${missing.length} 处` : '';
    const total = Math.max(1, timeline.shots.length - 1);
    const pct = Math.round((missing.length / total) * 100);
    issues.push(
      warn('V-RHY-011', `剪切点未声明动机 ${missing.length}/${total}（${pct}%）：${head}${more}`),
    );
  }
  if (timeline.shots.length >= 6 && kinds.size < 2) {
    issues.push(warn('V-RHY-011', `全片切点动机单一（${[...kinds].join('/') || '无'}）`));
  }
  return issues;
}

export function validateDensity(timeline: Timeline, minMs: number, maxMs: number): Issue[] {
  const issues: Issue[] = [];
  for (const t of timeline.shots) {
    if (t.durationMs < minMs - 300 || t.durationMs > maxMs + 1500) {
      issues.push(
        warn(
          'V-RHY-003',
          `镜头 ${t.shotId} 时长 ${t.durationMs}ms 偏离档位区间 [${minMs}, ${maxMs}]`,
        ),
      );
    }
  }
  return issues;
}

export function validateBreath(timeline: Timeline, every: number): Issue[] {
  const issues: Issue[] = [];
  if (timeline.shots.length >= every) {
    issues.push(warn('V-RHY-005', `共 ${timeline.shots.length} 镜，需检查呼吸镜间隔 ≤${every}`));
  }
  return issues;
}

export function validateContinuity(shots: Project['shots']): Issue[] {
  const issues: Issue[] = [];
  const byScene = new Map<string, Project['shots']>();
  for (const s of shots) {
    const scene = String(s.visual.params['scene'] ?? s.id);
    byScene.set(scene, [...(byScene.get(scene) ?? []), s]);
  }
  for (const [scene, list] of byScene) {
    if (list.length < 2) continue;
    const dirs = new Set(list.map((s) => String(s.visual.params['side'] ?? 'center')));
    if (dirs.size > 1 && !list.every((s) => s.gag)) {
      issues.push(
        err('V-CON-001', `场景「${scene}」跨镜主体方位不一致（轴线违规且未声明 gag）`),
      );
    }
  }
  return issues;
}

export function validateSfxLanding(timeline: Timeline): Issue[] {
  const issues: Issue[] = [];
  const cutSet = new Set(timeline.shots.map((t) => t.startMs));
  for (const sfx of timeline.sfx) {
    const near = [...cutSet].some((c) => Math.abs(c - sfx.atMs) <= SYNC_TOLERANCE_MS);
    if (!near) {
      issues.push(err('V-CMP-005', `音效 ${sfx.file} 落点 ${sfx.atMs} 未对齐任何剪切点`));
    }
  }
  return issues;
}

// V-RHY-001 剪切点候选集审计：每个剪切点必须落在 {句读停顿, 重音词, 景别变化点, 色温变化点}
export function validateCutCandidates(shots: Project['shots'], timeline: Timeline): Issue[] {
  const issues: Issue[] = [];
  for (let i = 1; i < timeline.shots.length; i += 1) {
    const prev = timeline.shots[i - 1]!;
    const cur = timeline.shots[i]!;
    const prevShot = shots.find((s) => s.id === prev.shotId);
    const curShot = shots.find((s) => s.id === cur.shotId);
    if (!prevShot || !curShot) continue;
    const atSentenceEnd = /[，。！？；.!?;]$/.test(prevShot.narration.trim());
    const atZoomChange = prevShot.zoom !== curShot.zoom;
    const atTempChange = prevShot.colorTemp !== undefined && prevShot.colorTemp !== curShot.colorTemp;
    const atEmphasis = (curShot.visual.params['emphasisLanding'] as boolean) === true;
    // 声明了切点动机（动作/视线/情绪/节拍/match-cut）同样是合法候选：剪辑语言优先于句读对齐
    const atMotive = Boolean(cur.motivation);
    if (!atSentenceEnd && !atZoomChange && !atTempChange && !atEmphasis && !atMotive) {
      issues.push(
        err('V-RHY-001', `剪切点 ${prev.shotId}→${cur.shotId} 不在候选集（句读/重音词/景别/色温/切点动机）`),
      );
    }
  }
  return issues;
}

// V-RHY-004 重音载体（修订）：字幕高亮 / 主体反应 / 机位或覆盖切，三路里至少两路。
// 为什么不再要求三路全中：重音靠"切、表演、光、声"任一路都能落地（Murch：情绪优先）；
// 静止镜没有机位腿时，主体 pulse + 高亮已足以把重音送到观众眼里。
export function validateEmphasisTriangle(
  shots: Project['shots'],
  timeline: Timeline,
  scenePulse: Map<string, boolean>,
): Issue[] {
  const issues: Issue[] = [];
  for (const t of timeline.shots) {
    const shot = shots.find((s) => s.id === t.shotId);
    if (!shot) continue;
    const hasHighlight = timeline.subtitles.some(
      (c) => c.shotId === t.shotId && c.keywords.length > 0,
    );
    const hasPulse = scenePulse.get(t.shotId) === true;
    const moving = (normalizeCameraToken(shot.camera) ?? 'static') !== 'static';
    const hasCamera = moving || (t.coverage?.length ?? 0) > 0;
    const carriers = [hasHighlight, hasPulse, hasCamera].filter(Boolean).length;
    if (carriers < 2) {
      const missing = [
        !hasHighlight ? '字幕高亮' : '',
        !hasPulse ? '主体pulse' : '',
        !hasCamera ? '机位运动/覆盖切' : '',
      ]
        .filter(Boolean)
        .join('/');
      issues.push(
        err(
          'V-RHY-004',
          `镜头 ${t.shotId} 重音落点不足（${carriers}/3 路载体，缺：${missing}）——至少两路`,
        ),
      );
    }
  }
  return issues;
}

// V-RHY-006 每 2-3s 一次视觉变化（doc 定级 warn）：节拍数须覆盖镜头时长
export function validateVisualChange(timeline: Timeline, sceneBeats: Map<string, number>): Issue[] {
  const issues: Issue[] = [];
  for (const t of timeline.shots) {
    const beats = sceneBeats.get(t.shotId) ?? 0;
    const required = Math.ceil(t.durationMs / 3000);
    if (beats < required) {
      issues.push(
        warn('V-RHY-006', `镜头 ${t.shotId} ${t.durationMs}ms 仅 ${beats} 个节拍（需 ≥${required}，每 2-3s 一次视觉变化）`),
      );
    }
  }
  return issues;
}

// V-SND-001 三层声音各司其职：混音计划必须含 vo/bgm/sfx 且 ducking 生效
export function validateMixPlan(
  plan: { tracks: Array<{ kind: string }>; duckRatio: number } | undefined,
): Issue[] {
  if (!plan) return [err('V-SND-001', '缺少混音计划工件（MixPlan）')];
  const kinds = new Set(plan.tracks.map((t) => t.kind));
  const missing = ['vo', 'bgm', 'sfx'].filter((k) => !kinds.has(k));
  if (missing.length > 0) {
    return [err('V-SND-001', `混音计划缺层：${missing.join('/')}`)];
  }
  if (plan.duckRatio <= 0 || plan.duckRatio >= 1) {
    return [err('V-SND-001', `ducking 比例非法: ${plan.duckRatio}`)];
  }
  return [];
}
