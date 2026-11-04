// 镜头级重置 + 续跑：node scripts/retry-shot.mjs <project-id> <shot-id>
import { spawn } from 'node:child_process';
const [id, shot] = process.argv.slice(2);
if (!id || !shot) {
  console.error('usage: node scripts/retry-shot.mjs <project-id> <shot-id>');
  process.exit(1);
}
function run(args) {
  return new Promise((resolve) => {
    const p = spawn('npx', ['tsx', 'src/interfaces/cli.ts', ...args], { shell: true });
    p.stdout.on('data', (d) => process.stdout.write(d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', (code) => resolve(code));
  });
}
const c1 = await run(['retry', '--project', id, '--shot', shot]);
console.log('=== retry 退出码', c1, '===');
if (c1 === 0) {
  const c2 = await run(['run', '--project', id, '--yes']);
  console.log('=== run 退出码', c2, '===');
}
process.exitCode = 0;
