// 声音部混音执行（docs/07）：三层声音 + ducking 包络 + 音效落点
// V-SND-001 三层各司其职 / V-SND-003 落点对齐 / V-SND-005 ducking / V-CMP-004
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AudioPlan, MixPlan, Project, Timeline } from '../core/schema.js';
import { runFfmpeg, detectSilences } from '../infrastructure/ffmpeg-utils.js';
import { ensureDir, exists } from '../infrastructure/fs-utils.js';
import { DUCK_RATIO } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import { err as issueErr, warn as issueWarn, type Issue } from '../core/validators/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * V-RHY-012 空窗探针（T1a）：单镜旁白音频的实测静音段。
 * 命名 detectGaps 是给剪辑部的语义——「空窗」= 画面无事发生的候选区。
 */
export function detectGaps(
  audioFile: string,
  minMs = 1200,
): Promise<Array<{ startMs: number; endMs: number }>> {
  return detectSilences(audioFile, minMs);
}

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

// 音效音色：AudioPlan.sfxPalette（展示名）→ 合成器实现名。
const SFX_HIT: Record<string, string> = {
  glassy: 'chime', woody: 'soft', metallic: 'glitch', soft: 'soft', punchy: 'impact',
};
const SFX_WHOOSH: Record<string, string> = {
  glassy: 'digital', woody: 'silk', metallic: 'digital', soft: 'silk', punchy: 'air',
};

// AudioPlan 的展示名 → bgm_synth.py 的实现名；未识别的名字安全回退暖默认。
function textureToSynth(t: string): string {
  const map: Record<string, string> = {
    'pluck-pad': 'warm-pad', 'pad-only': 'drone', 'arp-drive': 'pluck-lead',
    'bell-air': 'sparse', 'drone-pulse': 'drone', 'full-band': 'percussive',
  };
  return map[t] ?? 'warm-pad';
}

// 程序化配乐：scripts/bgm_synth.py 合成"有编排的极简科技 bed"。
// 旧实现是 10 路纯正弦叠加再低通 —— 那会得到 20–120Hz 占 71% 能量的 drone：
// 笔记本/手机扬声器放不出这段低频，只露出谐波与拍频，听感就是"刺啦"。
// 现实现骨架 Am7→Fmaj7→Cmaj7→G6（84BPM），拨弦琶音 + 暖 pad + 贝斯 + 轻节奏，
// 并带循环渐进的情绪弧线；中高频有音乐性内容，人声区 150–500Hz 交给 duckBgm 让位。
// audioPlan 把「配乐不固定」落到参数：进行/织体/亮度/BPM 全由开工确认门定下的方案驱动；
// 未传 plan 时用 warm-jazzy + warm-pad（旧默认），保证老项目行为不变。
// 风格/主题不同 → 确认门写不同 plan → 这里产出真正不同的 BGM。
export async function buildBgm(
  totalMs: number,
  dir: string,
  opts?: { bpm?: number; gridOut?: string; audioPlan?: AudioPlan },
): Promise<string> {
  await ensureDir(dir);
  const out = path.join(dir, 'bgm-raw.wav');
  const script = path.join(ROOT_DIR, 'scripts', 'bgm_synth.py');
  const py = process.env['MV_PYTHON'] ?? 'python';
  const plan = opts?.audioPlan;
  const args = [script, '--ms', String(Math.round(totalMs)), '--out', out];
  const bpm = plan && plan.bpm > 0 ? plan.bpm : opts?.bpm;
  if (bpm && bpm > 0) args.push('--bpm', String(bpm));
  if (opts?.gridOut) args.push('--grid-out', opts.gridOut);
  if (plan) {
    args.push('--progression', plan.progression || 'warm-jazzy');
    args.push('--texture', textureToSynth(plan.texture));
    args.push('--brightness', String(0.5 + (plan.brightness || 0.5))); // 0..1 → 0.5..1.5
    args.push('--mood', plan.mood || 'warm-curious');
  }
  try {
    await execFileP(py, args, {
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    throw mvError(
      ERR.PROBE,
      `BGM 合成失败（需要 python + numpy：pip install numpy）: ${(e as Error).message}`,
    );
  }
  if (!exists(out)) throw mvError(ERR.PROBE, `BGM 未生成: ${out}`);
  return out;
}

// ducking + 让位：BGM 先做 EQ（挖掉人声基频区与齿音区），再做侧链压缩。
// 只有 ducking 没有 EQ 是不够的——BGM 与旁白都堆在 120–400Hz，
// 电平压下去还会有"糊"的掩蔽感；反过来只做 EQ 不 duck，停顿处 BGM 又显突兀。
// 主链 = BGM（[0:a]），侧链 = 旁白（[1:a]）。（V-SND-005 / V-CMP-004）
export async function duckBgm(bgm: string, voTrack: string, dir: string): Promise<string> {
  const out = path.join(dir, 'bgm.wav');
  await runFfmpeg([
    '-i', bgm,
    '-i', voTrack,
    '-filter_complex',
    '[0:a]highpass=f=95,' +
      'equalizer=f=110:t=q:w=0.9:g=-5.0,' +   // 收掉次低频/贝斯尾巴：小扬声器放不出，只会露出拍频与谐波
      'equalizer=f=260:t=q:w=1.1:g=-4.5,' +   // 人声基频区让位（少挖一档，避免配乐失去厚度而显单薄生硬）
      'equalizer=f=700:t=q:w=1.4:g=-1.5,' +   // 胸声/鼻音区轻让
      'equalizer=f=3200:t=q:w=1.2:g=-2.0,' +  // 齿音区轻让（保清晰度）
      'equalizer=f=9000:t=h:w=2000:g=+1.5,' + // 极轻空气感（不参与人声辨识）
      // -9dB 时配乐在停顿处几乎听不见、一进来又突兀，听感是"一段一段"的；
      // -5dB 让 bed 保持连续存在感，配合更温和的侧链，不再有开关式的忽大忽小。
      'volume=-5dB,aformat=channel_layouts=stereo[bed];' +
      '[1:a]aformat=channel_layouts=stereo[sc];' +
      // 侧链放宽（threshold 0.02→0.035 / ratio 9→4.5 / release 280→200）：
      // 旧参数压得过深、恢复过慢，旁白一停配乐像被"掰开"再慢慢合上，是生硬的主因。
      // 放宽后仍满足 V-SND-006 的 ducking 判据（旁白处确有让位），但过渡自然得多。
      '[bed][sc]sidechaincompress=threshold=0.035:ratio=4.5:attack=20:release=200[out]',
    '-map', '[out]', out,
  ]);
  return out;
}

// 音效合成：scripts/sfx_synth.py 做"三层拼瞬态"的拟音。
// 旧实现 hit = sine 58Hz 一条纯正弦（100% 能量在 20–120Hz）、whoosh = 固定 lowpass 1400 的粉噪：
// 前者在小扬声器上放不出来只会露功放失真与谐波拍频（就是"刺啦"的来源，每片 11–14 个），
// 后者被压成没有方向感的"沙沙"。新版 hit 由 body/click/noise 三层错开起音拼成，
// whoosh 做真实带通扫频（380→3200Hz），听感是"有冲击"而不是"有噪声"。
export async function buildSfx(dir: string, palette?: string): Promise<{ whoosh: string; hit: string }> {
  await ensureDir(dir);
  const script = path.join(ROOT_DIR, 'scripts', 'sfx_synth.py');
  const py = process.env['MV_PYTHON'] ?? 'python';
  const hitPalette = SFX_HIT[palette ?? ''] ?? 'impact';
  const whooshPalette = SFX_WHOOSH[palette ?? ''] ?? 'air';
  try {
    await execFileP(py, [script, '--dir', dir, '--hit-palette', hitPalette, '--whoosh-palette', whooshPalette], { maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    throw mvError(
      ERR.PROBE,
      `音效合成失败（需要 python + numpy：pip install numpy）: ${(e as Error).message}`,
    );
  }
  const whoosh = path.join(dir, 'whoosh.wav');
  const hit = path.join(dir, 'hit.wav');
  if (!exists(whoosh) || !exists(hit)) throw mvError(ERR.PROBE, `音效未生成: ${dir}`);
  return { whoosh, hit };
}

// V-SND-006 可听性闸门：把"BGM 别盖人声 / 别只堆在小扬声器放不出的低频"变成可复现的自动判据。
// 判据与实测口径见 scripts/audio_check.py 头部注释；这里只负责把它接进 compose 的闸门。
// 缺 python/numpy 时降级为不阻断（不因环境缺件挡住出片），但明确写入 warn。
export async function checkMixAudibility(audioDir: string): Promise<Issue[]> {
  const script = path.join(ROOT_DIR, 'scripts', 'audio_check.py');
  const py = process.env['MV_PYTHON'] ?? 'python';
  if (!exists(script)) return [];
  try {
    await execFileP(py, [script, '--mixdir', audioDir], { maxBuffer: 16 * 1024 * 1024 });
    return [];
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    // exit 1 = 判据未过（stdout 里带 issues）；其它 = 环境问题，降级为 warn
    if (err.code === 1 && err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout) as Record<string, { issues?: string[] }>;
        const msgs = Object.values(parsed).flatMap((v) => v.issues ?? []);
        if (msgs.length > 0) return msgs.map((m) => issueErr('V-SND-006', m));
      } catch {
        /* fallthrough */
      }
    }
    return [issueWarn('V-SND-006', `混音体检未执行（需 python + numpy）: ${err.message ?? ''}`)];
  }
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
