import { V } from '../src/core/index.js';
import fs from 'node:fs';

/**
 * 模板×原语覆盖矩阵体检（P8）：
 *  1. 每个模板哑值替换后过 V.validateSceneFile（error 级问题即失败）；
 *  2. 覆盖矩阵：每模板实际调用的 MV.* 原语数 ≥ 6（豁免名单内的陈述/头像/氛围镜除外）；
 *  3. V-MOT-022 预检：每个 motifLoop 调用的 amp 折算位移 ≥ 3px（动 1-2px 等于没动）。
 * 「素」的根源是模板只有 enter+idle——矩阵让增量有据可查。
 */
const MIN_PRIMITIVES = 6;
// 豁免分两类：内容中性（typography/talking-head/atmosphere——它们的语义就是「少即是多」）
// 与已被新模板替代语义位的旧模板（comparison/chart/comic-symbol/depth-layers——
// P8 新增 compare-stage/process-track/hierarchy-stack 覆盖其富编排用法；
// 旧模板保留向后兼容，不强制加原语，避免无谓的全量重渲染）
const EXEMPT = new Set([
  'typography', 'talking-head', 'atmosphere',
  'comparison', 'chart', 'comic-symbol', 'depth-layers',
]);
// amp→可见位移的折算基数（与 composer.extractMotifFacts 同一口径：位移类 ×6，缩放类按 400px 元素 ×amp/8）
const AMP_TO_PX: Record<string, number> = {
  float: 6, drift: 6,
  rotate: 50, pulse: 50, shimmer: 50, breathe: 50,
  scan: 50, sweep: 50, compress: 50, settle: 50, drain: 50,
};
const templates = fs
  .readdirSync('templates/scenes')
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace('.html', ''));
const narration = '黑洞的质量大到连光都无法逃脱，它是由大质量恒星坍缩形成的。'.repeat(3);
let failed = 0;
const matrix: string[] = [];
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
  const prims = [...new Set([...html.matchAll(/MV\.([A-Za-z]+)\(/g)].map((m) => `MV.${m[1]}`))];
  const thin = prims.length < MIN_PRIMITIVES && !EXEMPT.has(t);
  if (thin) failed += 1;
  const invisible: string[] = [];
  for (const m of html.matchAll(/MV\.motifLoop\([^)]*\)/g)) {
    const call = m[0];
    const kind = call.match(/kind:\s*'([a-z]+)'/)?.[1] ?? 'float';
    const amp = Number(call.match(/amp:\s*([\d.]+)/)?.[1] ?? 0.8);
    const px = amp * (AMP_TO_PX[kind] ?? 6);
    if (px < 3) invisible.push(`${kind}@${px.toFixed(1)}px`);
  }
  if (invisible.length) failed += 1;
  const flag = errs.length || thin || invisible.length ? 'FAIL' : 'OK';
  const note = [
    errs.length ? errs.map((i) => i.id).join(',') : '',
    thin ? `<${MIN_PRIMITIVES} 原语` : '',
    invisible.length ? `不可见母题: ${invisible.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('  ');
  matrix.push(`${t.padEnd(18)}${String(prims.length).padStart(2)} 原语  ${flag}${note ? '  ' + note : ''}`);
}
console.log(matrix.join('\n'));
console.log(`\n豁免（< ${MIN_PRIMITIVES} 原语合法）: ${[...EXEMPT].join(', ')}`);
if (failed > 0) {
  console.error(`\n${failed} 项未达标`);
  process.exit(1);
}
