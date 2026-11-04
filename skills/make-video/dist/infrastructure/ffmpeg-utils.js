import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mvError, ERR } from '../core/errors.js';
import { ensureDir, exists } from './fs-utils.js';
import { readWavDurationMs } from './wav.js';
const execFileP = promisify(execFile);
async function run(bin, args) {
    try {
        const { stdout } = await execFileP(bin, args, { maxBuffer: 64 * 1024 * 1024 });
        return stdout;
    }
    catch (e) {
        throw mvError(ERR.PROBE, `${bin} 执行失败: ${e.message}`);
    }
}
export function hasFfmpeg() {
    try {
        execFileP('ffmpeg', ['-version']).catch(() => undefined);
        return true;
    }
    catch {
        return false;
    }
}
export function hasFfprobe() {
    try {
        execFileP('ffprobe', ['-version']).catch(() => undefined);
        return true;
    }
    catch {
        return false;
    }
}
export async function probeDurationMs(file) {
    if (!exists(file))
        throw mvError(ERR.PROBE, `文件不存在: ${file}`);
    if (file.endsWith('.wav'))
        return readWavDurationMs(file);
    const out = await run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        file,
    ]);
    const parsed = JSON.parse(out);
    const dur = Number(parsed.format?.duration);
    if (!Number.isFinite(dur) || dur <= 0) {
        throw mvError(ERR.PROBE, `无法探测时长: ${file}`);
    }
    return Math.round(dur * 1000);
}
export async function probeSize(file) {
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
    const parsed = JSON.parse(out);
    const s = parsed.streams?.[0];
    if (!s?.width || !s?.height)
        throw mvError(ERR.PROBE, `无法探测尺寸: ${file}`);
    return { width: s.width, height: s.height };
}
export async function extractFrame(video, atSeconds, outFile) {
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
    if (!exists(outFile))
        throw mvError(ERR.IMPORT_FAIL, `抽帧失败: ${video}`);
    return outFile;
}
export async function sliceClip(video, startSec, durationSec, outFile) {
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
    if (!exists(outFile))
        throw mvError(ERR.IMPORT_FAIL, `切片失败: ${video}`);
    return outFile;
}
export async function measureAudio(file) {
    return probeDurationMs(file);
}
/**
 * 视频转帧序列（P5-D）：渲染器逐帧 seek，内嵌 video 的播放时钟不可控，
 * 因此把素材视频按成片帧率抽成 JPEG 序列，由 GSAP 补间按合成时间换帧——帧索引是时间的纯函数。
 * 源片短于镜头时长时用 -stream_loop -1 循环补足，保证每帧都有画面。
 */
export async function extractFrameSequence(video, outDir, fps, width, durationSec) {
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
    if (files.length === 0)
        throw mvError(ERR.IMPORT_FAIL, `抽帧序列为空: ${video}`);
    return { dir: outDir, count: files.length };
}
export async function runFfmpeg(args) {
    try {
        await execFileP('ffmpeg', ['-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
    }
    catch (e) {
        throw mvError(ERR.PROBE, `ffmpeg 执行失败: ${e.message}`);
    }
}
