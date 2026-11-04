import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { BUDDY_CLOUD_SCRIPT_ENV, CLOUD_POLL_INTERVAL_MS, CLOUD_POLL_MAX_MS, CLOUD_RETRY_MAX, } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import { ensureDir, exists } from './fs-utils.js';
const execFileP = promisify(execFile);
const DEFAULT_SCRIPT_PATHS = [
    process.env[BUDDY_CLOUD_SCRIPT_ENV],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'CodeBuddy CN', 'resources', 'app', 'extensions', 'genie', 'out', 'extension', 'builtin', 'buddy-multimodal-generation', 'scripts', 'buddy-cloud.py'),
].filter((p) => Boolean(p));
export function findBuddyCloudScript() {
    for (const p of DEFAULT_SCRIPT_PATHS) {
        if (existsSync(p))
            return p;
    }
    return null;
}
export class BuddyCloudBridge {
    available;
    script;
    constructor() {
        this.script = findBuddyCloudScript();
        this.available = this.script !== null;
    }
    async generate(req, outDir, token) {
        if (!this.script) {
            throw mvError(ERR.CLOUD_AUTH, 'buddy-cloud.py 不可达（设置 BUDDY_CLOUD_SCRIPT）');
        }
        if (!token) {
            throw mvError(ERR.CLOUD_AUTH, '缺少云端凭证（connect_cloud_service）');
        }
        await ensureDir(outDir);
        let lastErr = null;
        for (let attempt = 1; attempt <= CLOUD_RETRY_MAX; attempt += 1) {
            try {
                const jobId = await this.submit(req, token);
                const url = await this.poll(jobId, req.kind, token);
                const file = path.join(outDir, `${req.kind}-${jobId}.mp4`);
                await this.download(url, file);
                return {
                    kind: 'cloud',
                    path: file,
                    meta: { provider: 'buddy-cloud', jobId, url, prompt: req.prompt },
                };
            }
            catch (e) {
                lastErr = e;
                await sleep(1000 * attempt);
            }
        }
        throw mvError(ERR.CLOUD_FAIL, `云端生成失败（重试 ${CLOUD_RETRY_MAX} 次）: ${lastErr.message}`);
    }
    async submit(req, token) {
        const args = [this.script, req.kind, req.prompt, '--token', token, '--no-poll'];
        if (req.kind === 'video-fx') {
            args.push('--template', req.template ?? 'hug', '--image', req.imageUrl ?? '');
        }
        const { stdout } = await execFileP('python', args, { maxBuffer: 16 * 1024 * 1024 });
        const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        if (!parsed.job_id) {
            throw new Error(parsed.error ?? '提交未返回 job_id');
        }
        return parsed.job_id;
    }
    async poll(jobId, kind, token) {
        const deadline = Date.now() + CLOUD_POLL_MAX_MS;
        for (;;) {
            const { stdout } = await execFileP('python', [this.script, 'status', jobId, '--type', kind, '--token', token], { maxBuffer: 16 * 1024 * 1024 });
            const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
            if (parsed.status === 'DONE' && parsed.result_url)
                return parsed.result_url;
            if (parsed.status === 'FAIL')
                throw new Error(parsed.error ?? '云端任务失败');
            if (Date.now() > deadline)
                throw new Error('云端任务超时');
            await sleep(CLOUD_POLL_INTERVAL_MS);
        }
    }
    async download(url, file) {
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`下载失败 ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(file, buf);
        if (!exists(file))
            throw new Error('下载文件为空');
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
