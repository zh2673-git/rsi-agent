import { promises as fs } from 'node:fs';
import { pickCanvasProgram, pickTemplateBySemantics } from '../src/domain/scene-semantics.js';

// 读指定项目的真实讲稿，report 语义分配
const id = process.argv[2];
if (!id) {
  console.error('用法: npx tsx scripts/semantics-report.ts <project-id>');
  process.exit(1);
}
const raw = JSON.parse(
  await fs.readFile(`projects/${id}/project.json`, 'utf8'),
) as { script: { segments: Array<{ id: string; text: string }> } };
const segs = raw.script.segments;
const CANVAS = ['s01', 's02', 's03', 's04', 's05', 's06', 's07', 's08'];
const MV = ['typography', 'chart', 'flow', 'comparison', 'atmosphere'];
const recent: string[] = [];
const dist = new Map<string, number>();
console.log('=== canvas 程序语义分配（cosmos-cinematic 配方） ===');
for (const s of segs) {
  const pick = pickCanvasProgram(s.text, CANVAS, recent);
  recent.push(pick.program);
  dist.set(pick.program, (dist.get(pick.program) ?? 0) + 1);
  console.log(`${s.id} → ${pick.program}${pick.score > 0 ? ` (命中${pick.score}线索)` : ' (覆盖兜底)'}  「${s.text.slice(0, 18)}」`);
}
console.log('\n分布:', Object.fromEntries([...dist.entries()].sort()));
let repeat = 0;
for (let i = 1; i < recent.length; i++) if (recent[i] === recent[i - 1]) repeat++;
console.log(`相邻重复: ${repeat}/${recent.length - 1}`);
console.log('\n=== MV 模板语义分配（science-explainer 配方对照） ===');
const tdist = new Map<string, number>();
for (const s of segs) {
  const t = pickTemplateBySemantics(s.text, MV);
  tdist.set(t, (tdist.get(t) ?? 0) + 1);
}
console.log('分布:', Object.fromEntries([...tdist.entries()].sort()));
