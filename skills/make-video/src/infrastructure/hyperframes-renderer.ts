import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { CODEC, FPS, HYPERFRAMES_VERSION, ASPECT_SIZE } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import type { Check, RenderBackend, RenderSpec } from './render-backend.js';
import { ensureDir, exists } from './fs-utils.js';
import { probeDurationMs, probeSize } from './ffmpeg-utils.js';

const execFileP = promisify(execFile);

function quoteIfNeeded(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

async function runNpx(args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  if (process.platform === 'win32') {
    const cmd = ['npx', ...args].map(quoteIfNeeded).join(' ');
    return execFileP(cmd, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: 32 * 1024 * 1024,
      shell: true,
    });
  }
  return execFileP('npx', args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export type { Check, RenderBackend, RenderSpec };

export class HyperFramesRenderer implements RenderBackend {
  readonly name = 'hyperframes';

  async doctor(): Promise<Check[]> {
    const node = process.versions.node;
    const nodeOk = Number(node.split('.')[0]) >= 22;
    return [
      { name: 'node>=22', ok: nodeOk, detail: `v${node}` },
      { name: 'ffmpeg', ok: await binExists('ffmpeg'), detail: 'PATH' },
      { name: 'ffprobe', ok: await binExists('ffprobe'), detail: 'PATH' },
      {
        name: 'hyperframes',
        ok: await hyperframesAvailable(),
        detail: `npx hyperframes@${HYPERFRAMES_VERSION}`,
      },
      { name: 'chrome', ok: await chromeAvailable(), detail: '渲染浏览器（hyperframes 内置 chromium 兜底）' },
    ];
  }

  async render(projectDir: string, spec: RenderSpec, outFile: string): Promise<string> {
    await ensureDir(path.dirname(outFile));
    const hfDir = path.join(projectDir, 'remotion');
    // V-RND-002 渲染锁：同一项目禁止并发渲染
    const lockFile = path.join(projectDir, '.render.lock');
    if (exists(lockFile)) {
      throw mvError(ERR.RENDER, `渲染锁已存在（.${path.sep}.render.lock）——另一渲染在进行或上次异常退出后未清理`);
    }
    await fs.writeFile(lockFile, String(process.pid), 'utf8');
    const args = [
      '--yes',
      `hyperframes@${HYPERFRAMES_VERSION}`,
      'render',
      hfDir,
      '-o',
      outFile,
      '-f',
      String(spec.fps),
      '-q',
      'standard',
    ];
    try {
      const { stdout, stderr } = await runNpx(args, {
        cwd: projectDir,
        timeout: 30 * 60 * 1000,
      });
      const logDir = path.join(projectDir, 'logs');
      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(path.join(logDir, 'render.log'), `${stdout}\n${stderr}\n`);
    } catch (e) {
      throw mvError(ERR.RENDER, `hyperframes render 失败: ${(e as Error).message}`);
    } finally {
      await fs.rm(lockFile, { force: true });
    }
    if (!exists(outFile)) {
      throw mvError(ERR.RENDER_OUTPUT, `渲染未产出文件: ${outFile}`);
    }
    return outFile;
  }

  async validateOutput(outFile: string, expectedMs: number): Promise<Check[]> {
    const checks: Check[] = [];
    try {
      const dur = await probeDurationMs(outFile);
      const diff = Math.abs(dur - expectedMs);
      checks.push({
        name: 'duration',
        ok: diff <= 500,
        detail: `${dur}ms vs 时间线 ${expectedMs}ms（差 ${diff}ms）`,
      });
    } catch (e) {
      checks.push({ name: 'duration', ok: false, detail: (e as Error).message });
    }
    // V-RND-003：分辨率 + 可解码校验
    try {
      const size = await probeSize(outFile);
      checks.push({ name: 'resolution', ok: true, detail: `${size.width}x${size.height}` });
    } catch (e) {
      checks.push({ name: 'resolution', ok: false, detail: (e as Error).message });
    }
    checks.push({ name: 'nonempty', ok: existsSync(outFile), detail: outFile });
    return checks;
  }
}

async function binExists(bin: string): Promise<boolean> {
  try {
    await execFileP(bin, ['-version']);
    return true;
  } catch {
    return false;
  }
}

// Chrome 检查（docs/09）：系统 Chrome 或 hyperframes 内置 chromium 任一可用即可
async function chromeAvailable(): Promise<boolean> {
  const candidates = [
    process.env['ProgramFiles'] && `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['LOCALAPPDATA'] && `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['LOCALAPPDATA'] && `${process.env['LOCALAPPDATA']}\\ms-playwright`,
  ].filter(Boolean) as string[];
  return candidates.some((p) => existsSync(p)) || (await binExists('chrome'));
}

async function hyperframesAvailable(): Promise<boolean> {
  try {
    await runNpx(['--yes', `hyperframes@${HYPERFRAMES_VERSION}`, '--version'], {
      timeout: 120000,
    });
    return true;
  } catch {
    return false;
  }
}

export function renderSpecFor(aspect: '16:9' | '9:16'): RenderSpec {
  const size = ASPECT_SIZE[aspect];
  return { width: size.width, height: size.height, fps: FPS, codec: CODEC };
}
