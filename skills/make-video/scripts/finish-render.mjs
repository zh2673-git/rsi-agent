// 渲染收尾：V-RND-003 输出校验 + 状态机推进到 done
import fs from 'node:fs';
import path from 'node:path';
import { HyperFramesRenderer } from '../src/infrastructure/hyperframes-renderer.js';
import { ProjectStore } from '../src/infrastructure/project-store.js';

const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/finish-render.mjs <project-id>');
  process.exit(1);
}
const root = process.cwd();
const store = new ProjectStore(root);
const project = await store.load(id);
const renderer = new HyperFramesRenderer();
const outFile = path.join(store.projectDir(id), 'out', `${id}.mp4`);
const totalMs = project.timeline?.shots.reduce((a, s) => a + s.durationMs, 0) ?? 0;
const checks = await renderer.validateOutput(outFile, totalMs);
for (const c of checks) console.log(`${c.ok ? 'OK ' : 'BAD'} ${c.name}: ${c.detail}`);
if (checks.some((c) => !c.ok)) process.exit(1);
for (const shot of project.shots) shot.state = 'ready';
project.stage = 'done';
await store.save(project);
console.log('stage = done');
