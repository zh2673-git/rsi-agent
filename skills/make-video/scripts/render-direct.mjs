// 前台阻塞渲染（诊断 render_cancelled_parent_exited）：node scripts/render-direct.mjs <project-id>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/render-direct.mjs <project-id>');
  process.exit(1);
}
const dir = path.resolve('projects', id);
const out = path.join(dir, 'out', `${id}.mp4`);
const q = (x) => (/\s/.test(x) ? `"${x}"` : x);
const args = ['--yes', 'hyperframes@0.8.173', 'render', q(path.join(dir, 'remotion')), '-o', q(out), '-f', '30', '-q', 'standard'];
console.log('spawn:', 'npx', args.join(' '));
const t0 = Date.now();
const p = spawn('npx', args, { shell: true, cwd: process.cwd() });
let outBuf = '';
p.stdout.on('data', (d) => {
  outBuf += d;
});
p.stderr.on('data', (d) => {
  outBuf += d;
});
const beat = setInterval(() => {
  console.log(`[beat ${((Date.now() - t0) / 1000) | 0}s] alive, buffer ${outBuf.length} bytes`);
}, 30000);
p.on('close', (code) => {
  clearInterval(beat);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.appendFileSync(path.join(dir, 'logs', 'render.log'), outBuf);
  fs.writeFileSync(path.join(dir, 'logs', 'render-exit.txt'), String(code));
  console.log(`=== exit ${code}, ${(Date.now() - t0) / 1000 | 0}s ===`);
  console.log(outBuf.slice(-800));
});
