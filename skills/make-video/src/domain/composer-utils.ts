import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists } from '../infrastructure/fs-utils.js';

export async function copyDir(src: string, dest: string): Promise<void> {
  if (!exists(src)) return;
  await fs.cp(src, dest, { recursive: true });
}

export function hfTime(ms: number): string {
  return (ms / 1000).toFixed(3);
}

export function relPath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}
