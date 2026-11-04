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
