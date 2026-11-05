// 一次进程内合成多个项目的旁白（Qwen3-TTS 模型只加载一次）。
//
// 为什么需要：单项目前台跑会撞工具超时，后台 cmd 又握不住 stdin 管道。
// 这个脚本接受多个项目 id，模型只加载一次，逐项目跑完，边跑边落盘。
// 用法: node scripts/voice-multi.mjs <project-id> [<project-id> ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/infrastructure/project-store.js';
import { Qwen3TtsClient } from '../src/infrastructure/tts-client.js';
import { synthesizeVoice } from '../src/domain/voice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: node scripts/voice-multi.mjs <project-id> [<project-id> ...]');
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
const tts = new Qwen3TtsClient();

let total = 0;
for (const id of ids) {
  const project = await store.load(id);
  let done = 0;
  for (const shot of project.shots) {
    const voFile = path.join(store.projectDir(id), 'audio', 'vo', `${shot.id}.wav`);
    const exists = await fs.stat(voFile).then(() => true).catch(() => false);
    if (shot.voice && exists) {
      console.log(`${id}/${shot.id} skip（已有旁白 ${shot.voice.durationMs}ms）`);
      done += 1;
      continue;
    }
    const t0 = Date.now();
    const ref = await synthesizeVoice(store, project, shot, tts);
    shot.voice = ref;
    if (shot.state === 'sourced' || shot.state === 'failed') shot.state = 'voiced';
    await store.save(project);
    done += 1;
    total += 1;
    console.log(`${id}/${shot.id} ${ref.durationMs}ms（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
  project.timeline = undefined;
  await store.save(project);
  console.log(`${id} 配音完成 ${done}/${project.shots.length}`);
}
console.log(`全部完成，共合成 ${total} 句`);
