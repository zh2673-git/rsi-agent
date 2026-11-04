// 回收各项目已 mux 进成片的中间音频（audio/mix 与 remotion/audio；vo 保留可复用）
const fs = require('fs');
const path = require('path');
for (const proj of fs.readdirSync('projects')) {
  const dir = path.join('projects', proj);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const sub of [path.join('audio', 'mix'), path.join('remotion', 'audio')]) {
    const p = path.join(dir, sub);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log('回收', path.join(proj, sub));
    }
  }
}
