// 声音部混音执行（docs/07）：三层声音 + ducking 包络 + 音效落点
// V-SND-001 三层各司其职 / V-SND-003 落点对齐 / V-SND-005 ducking / V-CMP-004
import path from 'node:path';
import fs from 'node:fs/promises';
import type { MixPlan, Project, Timeline } from '../core/schema.js';
import { runFfmpeg } from '../infrastructure/ffmpeg-utils.js';
import { ensureDir, exists } from '../infrastructure/fs-utils.js';
import { DUCK_RATIO } from '../core/constants.js';

// 旁白全轨：各镜按时间线起点延迟对齐后混音（时间真源 = timeline）
export async function buildVoTrack(
  project: Project,
  timeline: Timeline,
  dir: string,
): Promise<string> {
  await ensureDir(dir);
  const out = path.join(dir, 'vo-mix.wav');
  const voiced = timeline.shots.filter((t) => {
    const shot = project.shots.find((s) => s.id === t.shotId);
    return shot?.voice && exists(shot.voice.file);
  });
  if (voiced.length === 0) throw new Error('无可用旁白音轨');
  const args: string[] = [];
  const filters: string[] = [];
  voiced.forEach((t, i) => {
    const shot = project.shots.find((s) => s.id === t.shotId)!;
    args.push('-i', shot.voice!.file);
    filters.push(`[${i}:a]adelay=${t.startMs}|${t.startMs}[a${i}]`);
  });
  const mixIn = voiced.map((_, i) => `[a${i}]`).join('');
  const totalS = (
    (timeline.shots.at(-1)!.startMs + timeline.shots.at(-1)!.durationMs) / 1000
  ).toFixed(3);
  filters.push(`${mixIn}amix=inputs=${voiced.length}:normalize=0,apad=whole_dur=${totalS}[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-t', totalS, out);
  await runFfmpeg(args);
  return out;
}

// 程序化 BGM：双和弦慢速 pad（Dm → Bb）+ 极轻空气层，无音源依赖
// 结构：低频根音 + 五度 + 三度叠置，各自极慢颤音形成漂移；中段交叉换和弦给出情绪弧线
export async function buildBgm(totalMs: number, dir: string): Promise<string> {
  await ensureDir(dir);
  const out = path.join(dir, 'bgm-raw.wav');
  const total = totalMs / 1000;
  const d = total.toFixed(3);
  const shiftA = Math.max(24, total * 0.42); // 和弦开始换位
  const shiftB = shiftA + 12;
  const fadeOut = Math.max(2.0, total - 3.2);
  const bedA = `volume='if(lt(t,${shiftA.toFixed(2)}),1,if(lt(t,${shiftB.toFixed(2)}),(${shiftB.toFixed(2)}-t)/12,0))':eval=frame`;
  const bedB = `volume='if(lt(t,${shiftA.toFixed(2)}),0,if(lt(t,${shiftB.toFixed(2)}),(t-${shiftA.toFixed(2)})/12,1))':eval=frame`;
  await runFfmpeg([
    // Dm 床：D2 A2 D3 F3 A3
    '-f', 'lavfi', '-i', `sine=f=73.42:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=110.00:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=146.83:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=174.61:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=220.00:d=${d}`,
    // Bb 床：Bb1 F2 Bb2 D3 F3
    '-f', 'lavfi', '-i', `sine=f=58.27:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=87.31:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=116.54:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=146.83:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=174.61:d=${d}`,
    // 空气层：粉噪滤成极轻的风
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:d=${d}`,
    '-filter_complex',
    '[0:a]volume=0.30,tremolo=f=0.11:d=0.35[a0];' +
      '[1:a]volume=0.22,tremolo=f=0.13:d=0.30[a1];' +
      '[2:a]volume=0.14,tremolo=f=0.17:d=0.25[a2];' +
      '[3:a]volume=0.09,tremolo=f=0.10:d=0.40[a3];' +
      '[4:a]volume=0.06,tremolo=f=0.12:d=0.30[a4];' +
      `[a0][a1][a2][a3][a4]amix=5:normalize=0,lowpass=f=900,${bedA}[bedA];` +
      '[5:a]volume=0.22,tremolo=f=0.11:d=0.35[b0];' +
      '[6:a]volume=0.15,tremolo=f=0.14:d=0.30[b1];' +
      '[7:a]volume=0.10,tremolo=f=0.18:d=0.25[b2];' +
      '[8:a]volume=0.06,tremolo=f=0.12:d=0.30[b3];' +
      '[9:a]volume=0.04,tremolo=f=0.10:d=0.35[b4];' +
      `[b0][b1][b2][b3][b4]amix=5:normalize=0,lowpass=f=900,${bedB}[bedB];` +
      '[10:a]highpass=f=220,lowpass=f=1000,volume=0.18,tremolo=f=0.10:d=0.60[air];' +
      `[bedA][bedB][air]amix=3:normalize=0,lowpass=f=1300,volume=1.40,` +
      `afade=t=in:st=0:d=2.5,afade=t=out:st=${fadeOut.toFixed(2)}:d=3.2[out]`,
    '-map', '[out]', out,
  ]);
  return out;
}

// ducking：旁白区间 BGM 经 sidechaincompress 压至约 DUCK_RATIO（V-SND-005 / V-CMP-004）
export async function duckBgm(bgm: string, voTrack: string, dir: string): Promise<string> {
  const out = path.join(dir, 'bgm.wav');
  await runFfmpeg([
    '-i', bgm,
    '-i', voTrack,
    '-filter_complex',
    '[1:a]volume=1[sc];[0:a][sc]sidechaincompress=threshold=0.02:ratio=8:attack=60:release=450[out]',
    '-map', '[out]', out,
  ]);
  return out;
}

// 音效合成：whoosh（粉色噪声扫频）/ hit（低频锤点）
export async function buildSfx(dir: string): Promise<{ whoosh: string; hit: string }> {
  await ensureDir(dir);
  const whoosh = path.join(dir, 'whoosh.wav');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:d=0.7:a=0.7',
    '-af', 'lowpass=f=1400,highpass=f=300,afade=t=in:d=0.3,afade=t=out:st=0.32:d=0.38,volume=0.55',
    whoosh,
  ]);
  const hit = path.join(dir, 'hit.wav');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=f=58:d=0.5',
    '-af', 'afade=t=out:st=0.06:d=0.44,volume=0.75',
    hit,
  ]);
  return { whoosh, hit };
}

// 混音计划（A9 工件）：音效按转场类型分流，只在"有运动/有冲击"的切点落
// —— 硬切和溶解本身不需要音效，早期对每个切点都塞同一条 whoosh 会让全片变成"嗖嗖嗖"。
// whoosh@甩镜/擦除/横推（有真实横向运动）；hit@冲击切与重音镜（V-SND-003 落点对齐）。
// leadMs 让 whoosh 早于切点起势（声音先入的 J-cut）；atMs 仍锚在视觉切点，审计口径不变。
export function planMix(
  project: Project,
  timeline: Timeline,
  audioDir: string,
  transitionPlans?: Array<{ kind: string } | null>,
): MixPlan {
  const cues: MixPlan['sfxCues'] = [];
  const hasHit = (atMs: number): boolean =>
    cues.some((c) => c.kind === 'hit' && c.atMs === atMs);
  for (const [i, t] of timeline.shots.entries()) {
    if (t.transition !== 'none' && t.startMs > 0) {
      const kind = transitionPlans?.[i]?.kind ?? 'hard-cut';
      if (kind === 'smash-cut') {
        cues.push({ file: 'audio/sfx/hit.wav', atMs: t.startMs, kind: 'hit', leadMs: 0 });
      } else if (kind === 'whip-pan' || kind === 'wipe' || kind === 'slide') {
        cues.push({ file: 'audio/sfx/whoosh.wav', atMs: t.startMs, kind: 'whoosh', leadMs: -60 });
      }
    }
    const shot = project.shots.find((s) => s.id === t.shotId);
    const seg = project.script?.segments.find((x) => x.id === shot?.segmentId);
    if ((seg?.mood === 'tense' || seg?.mood === 'awe') && !hasHit(t.startMs)) {
      cues.push({ file: 'audio/sfx/hit.wav', atMs: t.startMs, kind: 'hit', leadMs: 0 });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    tracks: [
      { kind: 'vo', file: path.join(audioDir, 'vo-mix.wav'), gainDb: 0 },
      { kind: 'bgm', file: path.join(audioDir, 'bgm.wav'), gainDb: 0 },
      { kind: 'sfx', file: path.join(audioDir, 'sfx'), gainDb: -6 },
    ],
    duckRatio: DUCK_RATIO,
    sfxCues: cues,
  };
}

// srt 导出（docs/07 字幕工件；词边界策略：emphasis 优先 → 已在 cue.keywords 实现）
export async function exportSrt(timeline: Timeline, out: string): Promise<void> {
  const fmt = (ms: number): string => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const f = String(Math.floor(ms % 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${f}`;
  };
  const blocks = timeline.subtitles.map((c, i) => {
    const kw = c.keywords.length > 0 ? ` 【${c.keywords.join('、')}】` : '';
    return `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}${kw}\n`;
  });
  await fs.writeFile(out, blocks.join('\n'), 'utf8');
}
