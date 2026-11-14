import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mvError, ERR } from '../core/errors.js';
import { ensureDir, exists } from './fs-utils.js';
import { readWavDurationMs } from './wav.js';

const execFileP = promisify(execFile);

async function run(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw mvError(ERR.PROBE, `${bin} 执行失败: ${(e as Error).message}`);
  }
}

export function hasFfmpeg(): boolean {
  try {
    execFileP('ffmpeg', ['-version']).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function hasFfprobe(): boolean {
  try {
    execFileP('ffprobe', ['-version']).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function probeDurationMs(file: string): Promise<number> {
  if (!exists(file)) throw mvError(ERR.PROBE, `文件不存在: ${file}`);
  if (file.endsWith('.wav')) return readWavDurationMs(file);
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file,
  ]);
  const parsed = JSON.parse(out) as { format?: { duration?: string } };
  const dur = Number(parsed.format?.duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    throw mvError(ERR.PROBE, `无法探测时长: ${file}`);
  }
  return Math.round(dur * 1000);
}

export async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    file,
  ]);
  const parsed = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }> };
  const s = parsed.streams?.[0];
  if (!s?.width || !s?.height) throw mvError(ERR.PROBE, `无法探测尺寸: ${file}`);
  return { width: s.width, height: s.height };
}

export async function extractFrame(
  video: string,
  atSeconds: number,
  outFile: string,
): Promise<string> {
  await ensureDir(path.dirname(outFile));
  await run('ffmpeg', [
    '-y',
    '-ss',
    String(atSeconds),
    '-i',
    video,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    outFile,
  ]);
  if (!exists(outFile)) throw mvError(ERR.IMPORT_FAIL, `抽帧失败: ${video}`);
  return outFile;
}

export async function sliceClip(
  video: string,
  startSec: number,
  durationSec: number,
  outFile: string,
): Promise<string> {
  await ensureDir(path.dirname(outFile));
  await run('ffmpeg', [
    '-y',
    '-ss',
    String(startSec),
    '-i',
    video,
    '-t',
    String(durationSec),
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    outFile,
  ]);
  if (!exists(outFile)) throw mvError(ERR.IMPORT_FAIL, `切片失败: ${video}`);
  return outFile;
}

export async function measureAudio(file: string): Promise<number> {
  return probeDurationMs(file);
}

/**
 * 视频转帧序列（P5-D）：渲染器逐帧 seek，内嵌 video 的播放时钟不可控，
 * 因此把素材视频按成片帧率抽成 JPEG 序列，由 GSAP 补间按合成时间换帧——帧索引是时间的纯函数。
 * 源片短于镜头时长时用 -stream_loop -1 循环补足，保证每帧都有画面。
 */
export async function extractFrameSequence(
  video: string,
  outDir: string,
  fps: number,
  width: number,
  durationSec: number,
): Promise<{ dir: string; count: number }> {
  await ensureDir(outDir);
  await run('ffmpeg', [
    '-y',
    '-stream_loop',
    '-1',
    '-i',
    video,
    '-t',
    String(Math.max(0.2, durationSec)),
    '-vf',
    `fps=${fps},scale=${width}:-2`,
    '-q:v',
    '4',
    path.join(outDir, 'f%05d.jpg'),
  ]);
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(outDir)).filter((f) => /^f\d+\.jpg$/.test(f));
  if (files.length === 0) throw mvError(ERR.IMPORT_FAIL, `抽帧序列为空: ${video}`);
  return { dir: outDir, count: files.length };
}

export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileP('ffmpeg', ['-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw mvError(ERR.PROBE, `ffmpeg 执行失败: ${(e as Error).message}`);
  }
}

/**
 * 镜内空窗探针（V-RHY-012，T1a 精修闭环）：
 * ffmpeg silencedetect 扫音频文件，返回 ≥ minMs 的静音段（毫秒，相对文件开头）。
 * cue 时间轴是字符比例铺满的，看不出真停顿——空窗必须基于实测音频。
 */
export async function detectSilences(
  file: string,
  minMs: number,
): Promise<Array<{ startMs: number; endMs: number }>> {
  if (!exists(file)) throw mvError(ERR.PROBE, `音频不存在: ${file}`);
  // silencedetect 把结果写在 stderr，且 ffmpeg 对 `-f null` 常给非 0 退出码——
  // 所以不能用 promisify 的抛错路径拿输出，直接走底层 execFile 手动接。
  // 「没扫到静音」是合法结果（旁白连续），不是失败：以 stderr 里有没有
  // 'Input #0'（文件真的被读了）判定成败，不以有没有 silence_ 行判定。
  const { execFile } = await import('node:child_process');
  const out: string = await new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-i', file, '-af', `silencedetect=noise=-30dB:d=${(minMs / 1000).toFixed(2)}`, '-f', 'null', '-'],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        const text = String(stderr ?? '');
        if (text.includes('Input #0')) resolve(text);
        else reject(err ?? new Error(`silencedetect 无法读取音频: ${file}`));
      },
    );
  });
  const gaps: Array<{ startMs: number; endMs: number }> = [];
  let start: number | null = null;
  for (const line of out.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    if (s) start = Math.round(Number(s[1]) * 1000);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start !== null) {
      gaps.push({ startMs: start, endMs: Math.round(Number(e[1]) * 1000) });
      start = null;
    }
  }
  return gaps;
}
