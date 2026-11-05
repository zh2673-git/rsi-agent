// 一次性修复：Windows `set VAR=value &&` 会把尾随空格带进环境变量，
// 于是 style.id / rationale 末尾多了一个空格，风格注册表就查不到包。
// 用法：
//   node scripts/fix-case-json.mjs <project-id>             // 只修剪空白
//   node scripts/fix-case-json.mjs <project-id> reset-state // 顺带把镜头打回 pending（供 draw 重新登记素材）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
const mode = process.argv[3];
const file = path.join(ROOT, 'projects', id, 'project.json');
const p = JSON.parse(await fs.readFile(file, 'utf8'));

const trimAll = (v) => {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(trimAll);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = trimAll(v[k]);
    return v;
  }
  return v;
};

p.style.id = p.style.id.trim();
p.style.rationale = p.style.rationale.trim();

if (mode === 'reset-state') {
  for (const shot of p.shots) shot.state = 'pending';
  p.stage = 'sourcing';
}

await fs.writeFile(file, JSON.stringify(trimAll(p), null, 2), 'utf8');
console.log(
  'style.id =',
  JSON.stringify(p.style.id),
  '| stage =',
  p.stage,
  '| states =',
  p.shots.map((s) => s.state).join(','),
);
