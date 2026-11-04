import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 个性化配音：默认读 personal/profile.json 的 voice 段（Qwen3-TTS 零样本克隆）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  provider: 'qwen3',
  python: 'python',
  model: '',
  refAudio: '',
  promptText: '',
  lang: 'Chinese',
  soxDir: '',
};
let voice = { ...defaults };
const profilePath = path.join(ROOT, 'personal', 'profile.json');
if (fs.existsSync(profilePath)) {
  try {
    const p = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (p.voice) voice = { ...voice, ...p.voice };
  } catch (e) {
    console.error(`读取 personal/profile.json 失败: ${e.message}`);
  }
}

const project = process.argv[2];
if (!project) {
  console.error('用法: node scripts/run-voice.mjs <project-id> [--shot sXX]');
  process.exit(1);
}

const env = {
  ...process.env,
  MV_TTS: voice.provider,
  MAKEVIDEO_QWEN3_PYTHON: voice.python,
  MAKEVIDEO_QWEN3_MODEL: voice.model,
  MAKEVIDEO_QWEN3_REF_AUDIO: voice.refAudio,
  MAKEVIDEO_QWEN3_PROMPT_TEXT: voice.promptText,
  MAKEVIDEO_QWEN3_LANG: voice.lang,
  PATH: voice.soxDir ? `${voice.soxDir};${process.env.PATH ?? ''}` : process.env.PATH,
};

const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = path.join(ROOT, 'src', 'interfaces', 'cli.ts');
const args = [tsx, cli, 'voice', '--project', project, ...process.argv.slice(3)];
const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit', encoding: 'utf8' });
process.exit(r.status ?? 1);
