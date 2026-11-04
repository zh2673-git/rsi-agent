// 项目瘦身：回收中间产物（cache/assets/audio/scenes/remotion），保留 out/ 成片与 project.json
import { ProjectStore } from '../src/infrastructure/project-store.js';
const store = new ProjectStore(process.cwd());
const ids = process.argv.slice(2);
for (const id of ids) {
  try {
    const { freed } = await store.clean(id);
    console.log(id, '→ 回收:', freed.join(', '));
  } catch (e) {
    console.log(id, '→ 跳过:', (e as Error).message);
  }
}
