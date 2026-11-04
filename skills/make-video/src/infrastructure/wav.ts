import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AUDIO_SAMPLE_RATE } from '../core/constants.js';

export function writeWav(file: string, samples: Float32Array, sampleRate = AUDIO_SAMPLE_RATE): Promise<void> {
  return fs.writeFile(file, encodeWav(samples, sampleRate));
}

export function encodeWav(samples: Float32Array, sampleRate = AUDIO_SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

export async function readWavDurationMs(file: string): Promise<number> {
  const buf = await fs.readFile(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a wav file');
  }
  const sampleRate = buf.readUInt32LE(24);
  const dataBytes = buf.readUInt32LE(40);
  if (!sampleRate || sampleRate <= 0) throw new Error('bad sample rate');
  return Math.round((dataBytes / 2 / sampleRate) * 1000);
}

export function toneSamples(
  durationMs: number,
  opts: { freq?: number; sampleRate?: number; amp?: number } = {},
): Float32Array {
  const rate = opts.sampleRate ?? AUDIO_SAMPLE_RATE;
  const n = Math.round((durationMs / 1000) * rate);
  const out = new Float32Array(n);
  const freq = opts.freq ?? 180;
  const amp = opts.amp ?? 0.0001;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const env = Math.min(1, t * 20) * Math.min(1, (n - i) / rate > 0.05 ? 1 : 0);
    out[i] = Math.sin(2 * Math.PI * freq * t) * amp * env;
  }
  return out;
}

export function wavPathFor(dir: string, id: string): string {
  return path.join(dir, `${id}.wav`);
}
