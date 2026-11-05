// 常驻配音：一个进程里合成全部镜头（Qwen3-TTS 模型只加载一次）。
//
// 为什么不用 `make-video voice`：CLI 每次调用都新建 TtsClient，等于每次都重载
// 0.6B 模型（约 25s）；7 镜 × 25s 起不来，还会撞上前台命令的超时窗口。
// 这个脚本直接持有 Qwen3TtsClient，逐句合成，最后一次性落 project.json。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { Qwen3TtsClient } from '../src/infrastructure/tts-client.js';
import { synthesizeVoice } from '../src/domain/voice.js';

// fileURLToPath 处理空格与盘符（手写 replace 会在 %20 上翻车）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/voice-all.mjs <project-id>');
  process.exit(1);
}

const profile = JSON.parse(await fs.readFile(path.join(ROOT, 'personal', 'profile.json'), 'utf8'));
const v = profile.voice ?? {};
process.env['MAKEVIDEO_QWEN3_PYTHON'] = v.python;
process.env['MAKEVIDEO_QWEN3_MODEL'] = v.model;
process.env['MAKEVIDEO_QWEN3_REF_AUDIO'] = v.refAudio;
process.env['MAKEVIDEO_QWEN3_PROMPT_TEXT'] = v.promptText;
process.env['MAKEVIDEO_QWEN3_LANG'] = v.lang ?? 'Chinese';
if (v.soxDir) process.env['PATH'] = `${v.soxDir};${process.env['PATH'] ?? ''}`;

const store = new ProjectStore(ROOT);
const project = await store.load(id);
const tts = new Qwen3TtsClient();

let done = 0;
for (const shot of project.shots) {
  const voFile = path.join(store.projectDir(id), 'audio', 'vo', `${shot.id}.wav`);
  const exists = await fs.stat(voFile).then(() => true).catch(() => false);
  if (shot.voice && exists) {
    console.log(`${shot.id} skip（已有旁白 ${shot.voice.durationMs}ms）`);
    done += 1;
    continue;
  }
  const t0 = Date.now();
  const ref = await synthesizeVoice(store, project, shot, tts);
  shot.voice = ref;
  if (shot.state === 'sourced' || shot.state === 'failed') shot.state = 'voiced';
  await store.save(project); // 每镜落盘：中途挂了也不丢已完成的部分
  done += 1;
  console.log(`${shot.id} ${ref.durationMs}ms（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}
project.timeline = undefined; // 旁白时长定了，旧时间线作废
await store.save(project);
console.log(`配音完成 ${done}/${project.shots.length}`);
