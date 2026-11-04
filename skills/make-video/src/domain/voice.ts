import path from 'node:path';
import type { Project, Shot, VoiceRef } from '../core/schema.js';
import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import type { ProjectStore } from '../infrastructure/project-store.js';
import type { TtsClient } from '../infrastructure/tts-client.js';
import { copyFile, exists } from '../infrastructure/fs-utils.js';
import { measureAudio } from '../infrastructure/ffmpeg-utils.js';

export async function synthesizeVoice(
  store: ProjectStore,
  project: Project,
  shot: Shot,
  tts: TtsClient,
  voice?: string,
): Promise<VoiceRef> {
  const dir = store.projectDir(project.meta.id);
  const voDir = path.join(dir, 'audio', 'vo');
  const ext = tts.name === 'edge-tts' ? 'mp3' : 'wav';
  const out = path.join(voDir, `${shot.id}.${ext}`);
  const result = await tts.synthesize(shot.narration, out, voice);
  const durationMs = await measureAudio(result.file).catch(() => result.durationMs);
  const ref: VoiceRef = {
    file: result.file,
    durationMs,
    voice: voice ?? tts.name,
    rate: 1,
    source: 'tts',
    estimated: false,
  };
  const issues = V.validateTimelineSync(
    [{ ...shot, voice: ref }],
    { shots: [{ shotId: shot.id, startMs: 0, durationMs, transition: 'none', coverage: [], camera: 'none', motivation: '', audioShiftMs: 0 }], subtitles: [], sfx: [] },
  );
  if (V.hasError(issues)) {
    throw mvError(ERR.TTS, `旁白时长异常:\n${V.formatIssues(issues)}`);
  }
  return ref;
}

export async function adoptRecording(
  store: ProjectStore,
  project: Project,
  shotId: string,
  srcFile: string,
): Promise<VoiceRef> {
  const dir = store.projectDir(project.meta.id);
  if (!exists(srcFile)) throw mvError(ERR.TTS, `录音文件不存在: ${srcFile}`);
  const dest = path.join(dir, 'audio', 'vo', `${shotId}${path.extname(srcFile) || '.wav'}`);
  await copyFile(srcFile, dest);
  const durationMs = await measureAudio(dest);
  return {
    file: dest,
    durationMs,
    voice: 'user-recording',
    rate: 1,
    source: 'recording',
    estimated: false,
  };
}

export async function synthesizeAll(
  store: ProjectStore,
  project: Project,
  tts: TtsClient,
  voice?: string,
  shotId?: string,
): Promise<VoiceRef[]> {
  const targets = shotId ? project.shots.filter((s) => s.id === shotId) : project.shots;
  const out: VoiceRef[] = [];
  for (const shot of targets) {
    const ref = await synthesizeVoice(store, project, shot, tts, voice);
    shot.voice = ref;
    if (shot.state === 'sourced' || shot.state === 'failed') shot.state = 'voiced';
    out.push(ref);
  }
  // 旁白时长变了，旧时间线必然失配（V-CMP-001），作废等重排
  if (out.length && project.timeline) project.timeline = undefined;
  await store.save(project);
  return out;
}
