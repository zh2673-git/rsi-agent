import type { Project } from '../schema.js';
import { isCameraToken } from '../schema.js';
import { err, warn, type Issue } from './types.js';

export function validateStoryboard(p: Project): Issue[] {
  const issues: Issue[] = [];
  const shots = p.shots;

  if (p.script && shots.length > 0 && p.script.segments.length !== shots.length) {
    // V-RHY-007：镜头粒度=语义单元——一镜一单元，段数必须与镜数一致
    // （V-STE-003 属任务幂等条款，此处系历史借号）
    issues.push(
      err('V-RHY-007', `旁白段数(${p.script.segments.length}) ≠ 镜头数(${shots.length})`),
    );
  }

  for (const s of shots) {
    // V-CAM-002（修订）：词表合法即可——static/none 是导演的合法选择（静止构图 + 镜内表演，
    // 小津/北野武/死板喜剧都靠它），不再当"幻灯片"报错；全片画面是否够活由 V-RHY-010 统计，
    // 重音是否落到画面由 V-RHY-004 管。这里只拦没登记的词（拼错会静默退化成静止）。
    if (!isCameraToken(s.camera)) {
      issues.push(
        err('V-CAM-002', `镜头 ${s.id} 运镜词「${s.camera}」不在词表（push-in/pull-out/pan/pan-left/tilt-up/tilt-down/static/none）`),
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

  return issues;
}
