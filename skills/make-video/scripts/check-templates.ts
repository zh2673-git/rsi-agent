import { V } from '../src/core/index.js';
import fs from 'node:fs';
const templates = [
  'typography', 'chart', 'flow', 'comparison', 'atmosphere', 'comic-symbol', 'talking-head',
  'iso-stage', 'depth-layers', 'kinetic-type', 'paper-stage', 'deep-stage',
];
const narration = '黑洞的质量大到连光都无法逃脱，它是由大质量恒星坍缩形成的。'.repeat(3);
let failed = 0;
for (const t of templates) {
  const raw = fs.readFileSync('templates/scenes/' + t + '.html', 'utf8');
  // token 先替换成哑值再校验：扫描正则（如 [^}]*opacity）可能被 {{X}} 的 } 截断产生盲区
  const html = raw
    .replace(/\{\{EASING\}\}/g, 'power2.out')
    .replace(/\{\{ZOOM\}\}/g, 'MS')
    .replace(/\{\{CAMERA\}\}/g, 'push-in')
    .replace(/\{\{[^}]+\}\}/g, '1');
  const issues = V.validateSceneFile(html, { narration });
  const errs = issues.filter((i) => i.level === 'error');
  if (errs.length) failed += 1;
  console.log(
    t,
    '=>',
    issues.length ? issues.map((i) => i.id + ':' + i.message.slice(0, 70)).join(' | ') : 'OK',
  );
}
if (failed > 0) {
  console.error(`\n${failed} 个模板存在 error 级问题`);
  process.exit(1);
}
