// 续跑指定项目（重试失败镜头并继续渲染）
import { spawn } from 'node:child_process';
const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/resume-run.mjs <project-id>');
  process.exit(1);
}
const p = spawn('npx', ['tsx', 'src/interfaces/cli.ts', 'run', '--project', id, '--yes'], { shell: true });
p.stdout.on('data', (d) => process.stdout.write(d));
p.stderr.on('data', (d) => process.stderr.write(d));
p.on('close', (code) => {
  console.log(`=== resume 退出码 ${code} ===`);
  process.exitCode = code ?? 0;
});
