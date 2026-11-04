// 只重绘场景 HTML（复用现有配音/素材），用于动效/样式修复后的快速重渲染
import path from 'node:path';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { StyleRegistry } from '../src/domain/style-registry.js';
import { drawScene } from '../src/domain/scene-forge.js';

const ROOT = path.resolve(process.cwd());
const id = process.argv[2];
if (!id) throw new Error('用法: tsx redraw-scenes.ts <projectId>');

const store = new ProjectStore(ROOT);
const registry = new StyleRegistry(ROOT);
await registry.load();
const project = await store.load(id);
const pack = registry.resolveStyle(project.style!);
for (const shot of project.shots) {
  const { file } = await drawScene(store, project, shot, pack);
  console.log('redrawn', shot.id, '->', file);
}
console.log('done:', project.shots.length, 'scenes');
