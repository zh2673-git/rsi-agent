// 批量接入 agent 原创场景：node --run 或 npx tsx scripts/adopt-all.mts <project-id>
import fs from 'node:fs';
import path from 'node:path';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { adoptSceneFile } from '../src/application/pipeline.js';

const id = process.argv[2];
if (!id) {
  console.error('usage: npx tsx scripts/adopt-all.mts <project-id>');
  process.exit(1);
}
const store = new ProjectStore(process.cwd());
const project = await store.load(id);
let ok = 0;
const fails: string[] = [];
for (const shot of project.shots) {
  const f = path.resolve('gen-scenes', `${shot.id}.html`);
  if (!fs.existsSync(f)) {
    fails.push(`${shot.id}: 文件缺失`);
    continue;
  }
  const r = await adoptSceneFile(store, project, shot.id, f);
  if (r.adopted) {
    ok += 1;
  } else {
    fails.push(`${shot.id}: ${r.issues.map((i) => i.id).join(',')}`);
  }
}
console.log(`adopted ${ok}/${project.shots.length}`);
if (fails.length) console.log(fails.join('\n'));
