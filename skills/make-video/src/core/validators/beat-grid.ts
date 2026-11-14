import fs from 'node:fs';
import type { Timeline } from '../schema.js';
import { exists } from '../../infrastructure/fs-utils.js';
import { warn } from './index.js';
import type { Issue } from './index.js';

export interface BgmGrid {
  bpm: number;
  beatMs: number;
  barMs: number;
  beats: number[];
  bars: number[];
  generatedAt?: string;
}

/**
 * V-RHY-012 BGM 卡点吸附（v1.4 新增，warn 级）：
 *
 * 镜起点不能动——V-CMP-001 把镜长钉死在旁白实测时长上（音画同步 <100ms），
 * 所以「切点对齐小节线」吸附的是**镜内覆盖切点与音效落点**，不是镜间切点。
 * 本校验只做两件事：
 *   1) 覆盖切点/音效落点离最近小节线 > 0.5 拍 → 记账（剪辑部下一轮吸附）；
 *   2) 网格文件缺失 → 提醒 buildBgm 未产 sidecar（管线升级期的老项目）。
 */
export function validateBeatGrid(timeline: Timeline, gridPath: string): Issue[] {
  const issues: Issue[] = [];
  if (!exists(gridPath)) {
    return [warn('V-RHY-012', 'BGM 网格 sidecar 缺失（logs/bgm-grid.json）——本轮切点未做节拍吸附')];
  }
  let grid: BgmGrid | undefined;
  try {
    grid = JSON.parse(fs.readFileSync(gridPath, 'utf8')) as BgmGrid;
  } catch {
    grid = undefined;
  }
  if (!grid || !Array.isArray(grid.bars) || grid.bars.length === 0) {
    return [warn('V-RHY-012', 'BGM 网格 sidecar 缺失（logs/bgm-grid.json）——本轮切点未做节拍吸附')];
  }
  const tol = grid.beatMs * 0.5;
  const nearest = (ms: number, table: number[]): number => {
    let best = Infinity;
    for (const b of table) {
      const d = Math.abs(b - ms);
      if (d < best) best = d;
      if (b > ms + tol * 2) break;
    }
    return best;
  };
  // 覆盖切点：镜头内硬切落点吸附小节线
  const offCuts: string[] = [];
  for (const t of timeline.shots) {
    for (const c of t.coverage) {
      if (nearest(c.atMs, grid.bars) > tol) {
        offCuts.push(`${t.shotId}@${c.atMs}ms`);
      }
    }
  }
  if (offCuts.length > 0) {
    issues.push(
      warn(
        'V-RHY-012',
        `覆盖切点偏离 BGM 小节线 >0.5 拍：${offCuts.slice(0, 4).join(' ')}${offCuts.length > 4 ? '…' : ''}（吸附容差 ±${Math.round(tol)}ms）`,
      ),
    );
  }
  // 音效落点：卡点音效必须踩在拍线上（允许弱半拍）
  const offSfx: string[] = [];
  for (const s of timeline.sfx) {
    if (nearest(s.atMs, grid.beats) > tol) offSfx.push(`${s.kind}@${s.atMs}ms`);
  }
  if (offSfx.length > 0) {
    issues.push(warn('V-RHY-012', `音效落点偏离 BGM 拍线 >0.5 拍：${offSfx.slice(0, 4).join(' ')}`));
  }
  return issues;
}
