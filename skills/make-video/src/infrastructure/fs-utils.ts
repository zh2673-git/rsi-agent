import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mvError, ERR } from '../core/errors.js';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function exists(p: string): boolean {
  return existsSync(p);
}

let tmpSeq = 0;
// Windows 下并发 rename 同一目标文件会 EPERM（另一写者持有目标句柄）：
// 按目标文件路径串行化原子写，并对 rename 做 EPERM 退避重试
const writeChains = new Map<string, Promise<unknown>>();

async function doAtomicWrite(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
  await fs.writeFile(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES') && attempt < 4) {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

export function atomicWriteText(file: string, text: string): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(
    () => doAtomicWrite(file, text),
    () => doAtomicWrite(file, text),
  );
  writeChains.set(file, next);
  return next;
}

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function readJson<T>(file: string): Promise<T> {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text) as T;
}

export async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}

export async function rmrf(dir: string): Promise<void> {
  // Windows 下偶发 EBUSY/EPERM（杀软扫描、句柄延迟释放）：退避重试，避免静默残留
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= 3 || !exists(dir)) return;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

export async function listSubdirs(dir: string): Promise<string[]> {
  if (!exists(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function listFiles(dir: string): Promise<string[]> {
  if (!exists(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
}

export function slugify(text: string, maxLen = 24): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii.slice(0, maxLen) || 'project';
}

export function wrapFsError(e: unknown, message: string): never {
  throw mvError(ERR.FS, `${message}: ${(e as Error).message}`);
}
