import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 把 personal/ 里的头像装进某个工程：复制为 canvas/avatar_orig.png 并注册进 dd-kit 预加载清单
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profilePath = path.join(ROOT, 'personal', 'profile.json');

const projectId = process.argv[2];
if (!projectId) {
  console.error('用法: node scripts/apply-personal.mjs <project-id>');
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const card = path.join(ROOT, profile.avatar.card);
if (!fs.existsSync(card)) {
  console.error(`头像卡片不存在: ${card}`);
  process.exit(1);
}

const canvasDir = path.join(ROOT, 'projects', projectId, 'canvas');
fs.mkdirSync(canvasDir, { recursive: true });
const dest = path.join(canvasDir, profile.avatar.canvasName || 'avatar_orig.png');
fs.copyFileSync(card, dest);

// dd-kit 的图像预加载清单是硬编码的，缺注册就会只画白卡
const kitPath = path.join(canvasDir, 'dd-kit.js');
if (fs.existsSync(kitPath)) {
  let src = fs.readFileSync(kitPath, 'utf8');
  const name = profile.avatar.canvasName || 'avatar_orig.png';
  if (!src.includes(`'${name}'`)) {
    src = src.replace("'avatar.png',", `'avatar.png', '${name}',`);
    fs.writeFileSync(kitPath, src);
  }
}

// 同步到通用 canvas 模板：compose 会把 templates/canvas 复制进每个工程的 remotion/canvas
const tplDir = path.join(ROOT, 'templates', 'canvas', 'personal');
fs.mkdirSync(tplDir, { recursive: true });
const tpl = path.join(tplDir, 'presenter.png');
fs.copyFileSync(card, tpl);

console.log(JSON.stringify({ project: projectId, avatar: dest, template: tpl }, null, 2));
