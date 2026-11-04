import path from 'node:path';
import { mvError, ERR } from '../core/errors.js';
import { AUDIO_SAMPLE_RATE, MS_PER_CHAR_CN } from '../core/constants.js';
import { ensureDir } from './fs-utils.js';
import { readWavDurationMs, toneSamples, writeWav } from './wav.js';
export class SilentTtsClient {
    name = 'silent';
    async synthesize(text, outFile, _voice) {
        await ensureDir(path.dirname(outFile));
        const durationMs = Math.max(800, text.length * MS_PER_CHAR_CN);
        await writeWav(outFile, toneSamples(durationMs), AUDIO_SAMPLE_RATE);
        return { file: outFile, durationMs: await readWavDurationMs(outFile) };
    }
}
export class EdgeTtsClient {
    opts;
    name = 'edge-tts';
    constructor(opts = {}) {
        this.opts = opts;
    }
    async synthesize(text, outFile, voice) {
        const mod = await loadEdgeTts();
        if (!mod) {
            throw mvError(ERR.TTS, 'edge-tts 模块不可用（npm i edge-tts）');
        }
        const voiceName = voice ?? this.opts.voice ?? 'zh-CN-XiaoxiaoNeural';
        const buf = await mod.tts(text, { voice: voiceName, rate: this.opts.rate });
        if (!buf || buf.length === 0)
            throw mvError(ERR.TTS, 'edge-tts 返回空音频');
        await ensureDir(path.dirname(outFile));
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outFile, buf);
        const ms = await estimateMp3DurationMs(buf);
        return { file: outFile, durationMs: ms };
    }
}
async function estimateMp3DurationMs(buf) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { writeFile, readFile, unlink } = await import('node:fs/promises');
    const tmp = `${process.cwd()}/.mv-tts-${Date.now()}.mp3`;
    await writeFile(tmp, buf);
    try {
        const { stdout } = await promisify(execFile)('ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            tmp,
        ]);
        const parsed = JSON.parse(stdout);
        return Math.round(Number(parsed.format?.duration ?? 0) * 1000);
    }
    finally {
        await unlink(tmp).catch(() => undefined);
        void readFile;
    }
}
async function loadEdgeTts() {
    try {
        // 包的 main 指向 TS 源码（Node 拒绝 strip node_modules 内类型），引编译产物；
        // 用变量 specifier 绕过 TS 对可选依赖的解析（未安装时不报错）
        const moduleName = 'edge-tts/out/index.js';
        const mod = (await import(moduleName));
        return { tts: mod.tts };
    }
    catch {
        return null;
    }
}
export class RecordingTtsClient {
    name = 'recording';
    async synthesize(_text, outFile, _voice) {
        throw mvError(ERR.TTS, `RecordingTtsClient 只支持 adopt: ${outFile}`);
    }
}
export class PythonEdgeTtsClient {
    opts;
    name = 'edge-py';
    constructor(opts = {}) {
        this.opts = opts;
    }
    async synthesize(text, outFile, voice) {
        const py = this.opts.python ?? 'python';
        const voiceName = voice ?? this.opts.voice ?? 'zh-CN-XiaoxiaoNeural';
        await ensureDir(path.dirname(outFile));
        const args = [
            '-m',
            'edge_tts',
            '--voice',
            voiceName,
            '--text',
            text,
            '--write-media',
            outFile,
        ];
        if (this.opts.rate)
            args.push('--rate', this.opts.rate);
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        try {
            await run(py, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
        }
        catch (e) {
            throw mvError(ERR.TTS, `python edge-tts 合成失败: ${e.message}`);
        }
        const ms = await ffprobeDurationMs(outFile);
        if (ms <= 0)
            throw mvError(ERR.TTS, `python edge-tts 输出异常: ${outFile}`);
        return { file: outFile, durationMs: ms };
    }
}
async function ffprobeDurationMs(file) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
        const { stdout } = await promisify(execFile)('ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            file,
        ]);
        const parsed = JSON.parse(stdout);
        return Math.round(Number(parsed.format?.duration ?? 0) * 1000);
    }
    catch {
        return 0;
    }
}
async function pythonEdgeTtsAvailable(python = 'python') {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
        await promisify(execFile)(python, ['-c', 'import edge_tts'], { timeout: 30000 });
        return true;
    }
    catch {
        return false;
    }
}
/** 惰性 TTS 客户端：首次合成时才探测线路，调用点无需改异步 */
class LazyTtsClient {
    name = 'auto';
    inner = null;
    async resolve() {
        if (!this.inner) {
            this.inner = (await pythonEdgeTtsAvailable())
                ? new PythonEdgeTtsClient()
                : (await loadEdgeTts())
                    ? new EdgeTtsClient()
                    : new SilentTtsClient();
        }
        return this.inner;
    }
    async synthesize(text, outFile, voice) {
        const inner = await this.resolve();
        return inner.synthesize(text, outFile, voice);
    }
}
/**
 * GPT-SoVITS 零样本音色（P5-F）：调本地 api_v2.py 的 /tts，
 * 参考音频 + 逐字稿即可克隆，不训练。缺配置时给出可操作报错，不静默降级。
 */
export class GptSovitsTtsClient {
    opts;
    name = 'gpt-sovits';
    constructor(opts = {}) {
        this.opts = opts;
    }
    async synthesize(text, outFile, voice) {
        const base = (this.opts.url ?? process.env['MAKEVIDEO_SOVITS_URL'] ?? 'http://127.0.0.1:9880').replace(/\/$/, '');
        // voice 传的是路径时视为本镜专用参考音频（多角色配音）
        const refAudio = (voice && /[\\/]/.test(voice) ? voice : undefined) ??
            process.env['MAKEVIDEO_SOVITS_REF_AUDIO'];
        const promptText = process.env['MAKEVIDEO_SOVITS_PROMPT_TEXT'];
        if (!refAudio || !promptText) {
            throw mvError(ERR.TTS, 'GPT-SoVITS 缺少配置：需设置 MAKEVIDEO_SOVITS_REF_AUDIO（参考音频，5-10 秒干声）' +
                '与 MAKEVIDEO_SOVITS_PROMPT_TEXT（该音频的逐字稿）。' +
                '可选 MAKEVIDEO_SOVITS_URL（默认 http://127.0.0.1:9880）、MAKEVIDEO_SOVITS_SPEED。');
        }
        const speed = Number(process.env['MAKEVIDEO_SOVITS_SPEED'] ?? 1);
        await ensureDir(path.dirname(outFile));
        const payload = {
            text,
            text_lang: process.env['MAKEVIDEO_SOVITS_TEXT_LANG'] ?? 'zh',
            ref_audio_path: refAudio,
            prompt_text: promptText,
            prompt_lang: process.env['MAKEVIDEO_SOVITS_PROMPT_LANG'] ?? 'zh',
            text_split_method: 'cut5',
            batch_size: 1,
            media_type: 'wav',
            streaming_mode: false,
            speed_factor: Number.isFinite(speed) && speed > 0 ? speed : 1,
        };
        if (process.env['MAKEVIDEO_SOVITS_GPT_WEIGHTS']) {
            payload['gpt_weights'] = process.env['MAKEVIDEO_SOVITS_GPT_WEIGHTS'];
        }
        if (process.env['MAKEVIDEO_SOVITS_SOVITS_WEIGHTS']) {
            payload['sovits_weights'] = process.env['MAKEVIDEO_SOVITS_SOVITS_WEIGHTS'];
        }
        let res;
        try {
            res = await fetch(`${base}/tts`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(180_000),
            });
        }
        catch (e) {
            throw mvError(ERR.TTS, `GPT-SoVITS 不可达（${base}）：先启动 api_v2.py（python api_v2.py -a 127.0.0.1 -p 9880）。原始错误：${e.message}`);
        }
        if (!res.ok) {
            throw mvError(ERR.TTS, `GPT-SoVITS 合成失败 HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0)
            throw mvError(ERR.TTS, 'GPT-SoVITS 返回空音频');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outFile, buf);
        const ms = await ffprobeDurationMs(outFile);
        if (ms <= 0)
            throw mvError(ERR.TTS, `GPT-SoVITS 输出不可解码: ${outFile}`);
        return { file: outFile, durationMs: ms };
    }
}
/**
 * Qwen3-TTS 零样本克隆（本地常驻进程）：模型只在首次合成时加载一次，
 * 之后通过 stdin/stdout 的 JSON 行逐句合成，避免每句都重载 0.6B 模型。
 */
export class Qwen3TtsClient {
    name = 'qwen3';
    proc = null;
    seq = 0;
    pending = new Map();
    stdoutBuf = '';
    ready = null;
    ensureWorker() {
        if (this.ready)
            return this.ready;
        this.ready = new Promise((resolve, reject) => {
            void (async () => {
                const { spawn } = await import('node:child_process');
                const python = process.env['MAKEVIDEO_QWEN3_PYTHON'] ?? 'python';
                const model = process.env['MAKEVIDEO_QWEN3_MODEL'];
                const lang = process.env['MAKEVIDEO_QWEN3_LANG'] ?? 'Chinese';
                if (!model) {
                    reject(mvError(ERR.TTS, 'Qwen3-TTS 缺少配置：需设置 MAKEVIDEO_QWEN3_MODEL（模型目录）'));
                    return;
                }
                const script = path.join(process.cwd(), 'scripts', 'qwen3_tts_worker.py');
                const proc = spawn(python, ['-u', script, model, lang], { stdio: ['pipe', 'pipe', 'pipe'] });
                this.proc = proc;
                let loaded = false;
                proc.stdout.setEncoding('utf8');
                proc.stdout.on('data', (chunk) => {
                    this.stdoutBuf += chunk;
                    const lines = this.stdoutBuf.split('\n');
                    this.stdoutBuf = lines.pop() ?? '';
                    for (const raw of lines) {
                        const text = raw.trim();
                        if (!text.startsWith('{'))
                            continue;
                        let msg;
                        try {
                            msg = JSON.parse(text);
                        }
                        catch {
                            continue;
                        }
                        if (msg.ready === true && !loaded) {
                            loaded = true;
                            resolve();
                        }
                        else if (typeof msg.id === 'number') {
                            const job = this.pending.get(msg.id);
                            this.pending.delete(msg.id);
                            if (!job)
                                continue;
                            if (msg.ok)
                                job.resolve();
                            else
                                job.reject(mvError(ERR.TTS, `Qwen3-TTS 合成失败: ${msg.error ?? '未知错误'}`));
                        }
                    }
                });
                proc.stderr.setEncoding('utf8');
                proc.stderr.on('data', (s) => {
                    if (/Traceback|Error/.test(s))
                        process.stderr.write(`[qwen3] ${s}`);
                });
                proc.on('exit', (code) => {
                    const err = mvError(ERR.TTS, `Qwen3-TTS 进程退出（code=${code}）`);
                    if (!loaded)
                        reject(err);
                    for (const job of this.pending.values())
                        job.reject(err);
                    this.pending.clear();
                    this.proc = null;
                    this.ready = null;
                });
            })();
        });
        return this.ready;
    }
    async synthesize(text, outFile, voice) {
        await ensureDir(path.dirname(outFile));
        await this.ensureWorker();
        const proc = this.proc;
        if (!proc)
            throw mvError(ERR.TTS, 'Qwen3-TTS 进程不可用');
        const refAudio = (voice && /[\\/]/.test(voice) ? voice : undefined) ?? process.env['MAKEVIDEO_QWEN3_REF_AUDIO'];
        const refText = process.env['MAKEVIDEO_QWEN3_PROMPT_TEXT'];
        if (!refAudio || !refText) {
            throw mvError(ERR.TTS, 'Qwen3-TTS 缺少配置：需设置 MAKEVIDEO_QWEN3_REF_AUDIO（参考音频）' +
                '与 MAKEVIDEO_QWEN3_PROMPT_TEXT（该音频的逐字稿），' +
                '以及 MAKEVIDEO_QWEN3_MODEL / MAKEVIDEO_QWEN3_PYTHON（venv 的 python）。');
        }
        const id = ++this.seq;
        await new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            proc.stdin.write(`${JSON.stringify({ id, text, out: outFile, ref_audio: refAudio, ref_text: refText })}\n`);
        });
        const ms = await ffprobeDurationMs(outFile);
        if (ms <= 0)
            throw mvError(ERR.TTS, `Qwen3-TTS 输出不可解码: ${outFile}`);
        return { file: outFile, durationMs: ms };
    }
}
export function createTtsClient(provider) {
    if (provider === 'qwen3')
        return new Qwen3TtsClient();
    if (provider === 'sovits')
        return new GptSovitsTtsClient();
    if (provider === 'edge-py')
        return new PythonEdgeTtsClient();
    if (provider === 'edge')
        return new EdgeTtsClient();
    if (provider === 'silent')
        return new SilentTtsClient();
    return new LazyTtsClient();
}
