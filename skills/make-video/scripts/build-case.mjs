// 案例构建器：用真实流水线（init→storyboard→confirm→voice→compose→render）出片。
// 为什么要有这个脚本而不手工敲 CLI：
//   1. 讲稿注入在 init 之后会被 storyboard 重写，所以必须在 storyboard 后回写并重建分镜；
//   2. 每一镜的场景要按语法层亲手写（SKILL.md 工作规则第 8 条铁律：逐镜原创是默认），
//      模板 forge 只是无 agent 时兜底，案例必须逐镜过校验器落盘；
//   3. 需要保证可重跑（clean → 重画 → 重合成 → 重渲），手工步骤无法复现。
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const id = process.argv[2];
if (!id) {
  console.error('usage: node tools/build-case.mjs <project-id>');
  process.exit(1);
}
const dir = path.join(ROOT, 'projects', id);

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
}

const scriptFile = path.join(dir, 'script.json');
const script = JSON.parse(await fs.readFile(scriptFile, 'utf8'));
console.log(`讲稿 ${script.segments.length} 段，${script.fullText.length} 字`);

// 1. 分镜（storyboard 会按配方重写 script，所以先跑一次把 shots 建起来）
run('npx', ['tsx', 'src/interfaces/cli.ts', 'storyboard', '--project', id]);

// 2. 回写讲稿 + 按讲稿重建 shots（一镜一段：每段就是镜，保证旁白=画面）
const projectFile = path.join(dir, 'project.json');
const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
const prevShots = project.shots;
project.script = script;
project.shots = script.segments.map((seg, i) => {
  const prev = prevShots[i] ?? {};
  return {
    id: `s${String(i + 1).padStart(2, '0')}`,
    segmentId: seg.id,
    narration: seg.text,
    visual: prev.visual ?? { kind: 'code-scene', prompt: '', template: 'typography', params: {} },
    zoom: prev.zoom ?? 'MS',
    camera: prev.camera ?? 'push-in',
    motivation: prev.motivation ?? '',
    counterpoint: prev.counterpoint ?? 'metaphor',
    gag: false,
    transition: prev.transition ?? '',
    coverage: [],
    enterAnchor: '',
    exitAnchor: '',
    audioShiftMs: 0,
    state: 'pending',
  };
});
await fs.writeFile(projectFile, JSON.stringify(project, null, 2), 'utf8');
console.log(`回写讲稿：${project.shots.length} 镜`);

// 3. 风格决策回写用户意图（storyboard 的 recommendStyle 会改回配方推荐）
project.style = {
  id: process.env.MV_STYLE ?? project.style.id,
  source: 'user-specified',
  rationale: process.env.MV_STYLE_WHY ?? '案例演示：按动效语法选型',
  lineage: {},
  overrides: {},
};
await fs.writeFile(projectFile, JSON.stringify(project, null, 2), 'utf8');
console.log(`风格：${project.style.id}`);

// 4. 确认 + 配音（克隆音色）
run('npx', ['tsx', 'src/interfaces/cli.ts', 'confirm', '--project', id]);

console.log('\n=== 下一步 ===');
console.log('1) 逐镜写场景：node tools/scenes-<case>.mjs');
console.log('2) 配音：node scripts/run-voice.mjs <id>');
console.log('3) 合成 + 渲染：make-video compose / render');
