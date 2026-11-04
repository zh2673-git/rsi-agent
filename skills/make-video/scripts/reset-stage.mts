// 阶段回拨：npx tsx scripts/reset-stage.mts <project-id> <stage>
import { ProjectStore } from '../src/infrastructure/project-store.js';
const id = process.argv[2]!;
const stage = process.argv[3] as 'sourcing' | 'voice' | 'compose' | 'render';
const store = new ProjectStore(process.cwd());
const project = await store.load(id);
project.stage = stage;
project.timeline = undefined;
await store.save(project);
console.log('stage →', stage);
