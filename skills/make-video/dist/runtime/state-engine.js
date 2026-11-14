import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CONCURRENCY } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import { renderSpecFor } from '../infrastructure/hyperframes-renderer.js';
import { probeDurationMs } from '../infrastructure/ffmpeg-utils.js';
import { V } from '../core/index.js';
import { writeScript } from '../domain/scriptwriter.js';
import { storyboard, buildConfirmation } from '../domain/storyboard.js';
import { ensureAssets } from '../domain/asset-sourcing.js';
import { compose } from '../domain/composer.js';
const LEGAL_SHOT_TRANSITIONS = {
    pending: ['sourcing'],
    sourcing: ['sourced', 'failed'],
    sourced: ['voicing', 'failed'],
    voicing: ['voiced', 'failed'],
    voiced: ['ready', 'failed'],
    failed: ['pending'],
    ready: [],
};
export function assertShotTransition(from, to) {
    const allowed = LEGAL_SHOT_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
        throw mvError(ERR.ILLEGAL_TRANSITION, `非法镜头状态跳转: ${from} → ${to}`);
    }
}
export class StateEngine {
    root;
    deps;
    project = null;
    stopped = false;
    events = [];
    constructor(root, deps) {
        this.root = root;
        this.deps = deps;
    }
    async init(id) {
        await this.deps.registry.ensureLoaded();
        const project = await this.deps.store.load(id);
        this.project = project;
        this.stopped = false;
        return project;
    }
    getProject() {
        if (!this.project)
            throw mvError(ERR.PROJECT_NOT_FOUND, '引擎未初始化');
        return this.project;
    }
    stop() {
        this.stopped = true;
    }
    async destroy() {
        // V-STE-005：destroy 逆序拆除——先停止调度（在途任务收在终态），再释放内存工作副本；
        // 成片 out/ 与中央 IR project.json 永不回收（store.clean 只清中间产物目录）
        this.stop();
        this.project = null;
        // P8-T0：常驻子进程资源随引擎一起释放（Qwen3 worker 不关就会一直占 GPU）
        await this.deps.tts.close?.();
    }
    transition(shot, to) {
        assertShotTransition(shot.state, to);
        shot.state = to;
        this.emit({ type: 'shot-advanced', shotId: shot.id, state: to });
    }
    /** 事件统一出口：入内存事件表 + append-only 落 logs/run.log（工程部工件） */
    emit(e) {
        this.events.push(e);
        const p = this.project;
        if (!p)
            return;
        const file = path.join(this.deps.store.projectDir(p.meta.id), 'logs', 'run.log');
        const line = JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n';
        fs.mkdir(path.dirname(file), { recursive: true })
            .then(() => fs.appendFile(file, line))
            .catch(() => {
            /* 日志失败不阻断流水线 */
        });
    }
    async run(opts = {}) {
        const p = this.getProject();
        this.events = [];
        const recipe = this.deps.registry.getRecipe(p.meta.genre);
        while (p.stage !== 'done' && !this.stopped) {
            switch (p.stage) {
                case 'init':
                case 'script': {
                    // 已提供讲稿（--script 注入或人工编写）则跳过编剧，段数即镜头数（一镜一单元）
                    if (!p.script) {
                        await writeScript(this.deps.store, p, this.deps.llm, recipe);
                    }
                    p.stage = 'storyboard';
                    this.emit({ type: 'stage-advanced', stage: 'storyboard' });
                    break;
                }
                case 'storyboard': {
                    const { readJson } = await import('../infrastructure/fs-utils.js');
                    const idxFile = path.join(this.deps.store.projectDir(p.meta.id), 'materials', 'index.json');
                    let index = { items: [] };
                    try {
                        index = await readJson(idxFile);
                    }
                    catch {
                        /* 无素材库 */
                    }
                    await storyboard(this.deps.store, p, this.deps.llm, recipe, this.deps.registry, index, opts.userStyleId);
                    this.emit({ type: 'confirm-required' });
                    // V-STYLE-003 组合确认门：自由组合（非 recipe 预绑）必须用户显式确认，
                    // autoConfirm（--yes）不能代替——先停在这里，confirm 后重跑放行
                    const styleGate = V.validateStyleGate(p);
                    if (V.hasError(styleGate)) {
                        await this.deps.store.save(p);
                        return this.events;
                    }
                    if (!p.confirmed && !opts.autoConfirm) {
                        await this.deps.store.save(p);
                        return this.events;
                    }
                    p.stage = 'sourcing';
                    this.emit({ type: 'stage-advanced', stage: 'sourcing' });
                    break;
                }
                case 'sourcing': {
                    const pack = this.deps.registry.resolveStyle(p.style);
                    await this.runBatch(p, async (shot) => {
                        this.transition(shot, 'sourcing');
                        const asset = await ensureAssets(this.deps.store, p, shot, this.deps.bridge, pack, this.deps.llm);
                        shot.asset = asset;
                        this.transition(shot, 'sourced');
                    }, 'pending');
                    if (this.hasFailed(p)) {
                        await this.deps.store.save(p);
                        return this.events;
                    }
                    p.stage = 'voice';
                    this.emit({ type: 'stage-advanced', stage: 'voice' });
                    break;
                }
                case 'voice': {
                    const fellBack = await this.runBatch(p, async (shot) => {
                        this.transition(shot, 'voicing');
                        const { synthesizeVoice } = await import('../domain/voice.js');
                        shot.voice = await synthesizeVoice(this.deps.store, p, shot, this.deps.tts);
                        this.transition(shot, 'voiced');
                    }, 'sourced');
                    if (this.hasFailed(p)) {
                        await this.deps.store.save(p);
                        return this.events;
                    }
                    if (fellBack)
                        break; // 已回退 sourcing（stage 已由 runBatch 设置），主循环重走
                    p.stage = 'compose';
                    this.emit({ type: 'stage-advanced', stage: 'compose' });
                    break;
                }
                case 'compose': {
                    const pack = this.deps.registry.resolveStyle(p.style);
                    await compose(this.deps.store, p, pack);
                    p.stage = 'render';
                    this.emit({ type: 'stage-advanced', stage: 'render' });
                    break;
                }
                case 'render': {
                    if (process.env['MV_SKIP_RENDER'] === '1') {
                        this.emit({
                            type: 'stopped',
                            reason: 'MV_SKIP_RENDER=1（测试模式跳过真实渲染；合成项目已就绪）',
                        });
                        await this.deps.store.save(p);
                        return this.events;
                    }
                    const spec = renderSpecFor(p.meta.aspect);
                    const outFile = path.join(this.deps.store.projectDir(p.meta.id), 'out', `${p.meta.id}.mp4`);
                    const checks = await this.deps.renderer.doctor();
                    const bad = checks.filter((c) => !c.ok);
                    if (bad.length > 0) {
                        this.emit({
                            type: 'stopped',
                            reason: `渲染环境不全: ${bad.map((b) => b.name).join(', ')}（合成项目已就绪，可修复环境后重试 render）`,
                        });
                        await this.deps.store.save(p);
                        return this.events;
                    }
                    const produced = await this.deps.renderer.render(this.deps.store.projectDir(p.meta.id), spec, outFile);
                    const totalMs = p.timeline?.shots.reduce((a, s) => a + s.durationMs, 0) ?? 0;
                    const outChecks = (await this.deps.renderer.validateOutput?.(produced, totalMs)) ?? [];
                    const outBad = outChecks.filter((c) => !c.ok);
                    if (outBad.length > 0) {
                        throw mvError(ERR.RENDER_OUTPUT, `输出校验失败: ${outBad.map((c) => c.detail).join('; ')}`);
                    }
                    for (const shot of p.shots) {
                        if (shot.state !== 'ready')
                            this.transition(shot, 'ready');
                    }
                    p.stage = 'done';
                    this.emit({ type: 'stage-advanced', stage: 'done' });
                    this.emit({ type: 'done', outFile: produced });
                    break;
                }
                default:
                    throw mvError(ERR.ILLEGAL_TRANSITION, `未知阶段: ${p.stage}`);
            }
            await this.deps.store.save(p);
        }
        if (this.stopped)
            this.emit({ type: 'stopped', reason: '用户停止' });
        return this.events;
    }
    /** 返回 true = 已回退上游阶段（调用方须跳过本阶段的推进，主循环重走） */
    async runBatch(p, task, entryState) {
        // V-STE-001 白名单：failed 只允许 → pending。非 pending 入口的阶段（如 voice 入口 sourced）
        // 遇失败镜头时，整批回退上游 sourcing 重做——已完成产物走幂等路径直接沿用，只重做失败镜
        const failed = p.shots.filter((s) => s.state === 'failed');
        if (failed.length > 0) {
            for (const s of failed)
                this.transition(s, 'pending');
            if (entryState !== 'pending') {
                p.stage = 'sourcing';
                this.emit({ type: 'stage-advanced', stage: 'sourcing' });
                return true;
            }
        }
        const pending = p.shots.filter((s) => s.state === entryState);
        if (pending.length === 0) {
            const stuck = p.shots.filter((s) => s.state !== 'ready' && s.state !== 'failed');
            if (stuck.length > 0) {
                throw mvError(ERR.DEADLOCK, `无可推进镜头但存在未完成: ${stuck.map((s) => s.id).join(',')}`);
            }
            return false;
        }
        for (let i = 0; i < pending.length; i += CONCURRENCY) {
            if (this.stopped)
                return false;
            const batch = pending.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (shot) => {
                await task(shot);
                // V-STE-002：状态先持久化，再派发下一任务（崩溃最多丢当前镜，不丢已完成镜）
                await this.deps.store.save(p);
            }));
            results.forEach((r, idx) => {
                const shot = batch[idx];
                if (!shot)
                    return;
                if (r.status === 'rejected') {
                    const reason = r.reason.message;
                    if (shot.state !== 'failed') {
                        try {
                            this.transition(shot, 'failed');
                        }
                        catch {
                            shot.state = 'failed';
                        }
                    }
                    shot.failReason = reason;
                    this.emit({ type: 'failed', shotId: shot.id, reason });
                }
            });
            await this.deps.store.save(p);
        }
        return false;
    }
    hasFailed(p) {
        return p.shots.some((s) => s.state === 'failed');
    }
    async retry(shotId, stage) {
        const p = this.getProject();
        // stage 级 retry = 回退到该阶段，该阶段产物全部重做（如改稿后重配音）；
        // shot 级 retry = 只重置指定镜头；无参 = 重置全部失败镜头
        let targets;
        if (shotId) {
            targets = p.shots.filter((s) => s.id === shotId);
        }
        else if (stage === 'voice') {
            targets = p.shots.filter((s) => s.voice);
        }
        else if (stage === 'sourcing') {
            targets = p.shots;
        }
        else {
            targets = p.shots.filter((s) => s.state === 'failed');
        }
        for (const s of targets) {
            s.failReason = undefined;
            if (stage === 'sourcing' || (!stage && !s.asset)) {
                s.asset = undefined;
                s.voice = undefined;
                s.state = 'pending';
            }
            else {
                s.voice = undefined;
                s.state = 'sourced';
            }
        }
        if (stage === 'sourcing' || stage === 'voice') {
            // 下游产物已失效：旧时间线基于旧配音时长，保留会让 compose 前置闸门误判音画不同步
            p.timeline = undefined;
        }
        if (stage === 'sourcing' || stage === 'voice' || stage === 'compose' || stage === 'render') {
            p.stage = stage;
        }
        else if (p.shots.some((s) => !s.asset)) {
            p.stage = 'sourcing';
        }
        else if (p.shots.some((s) => !s.voice)) {
            p.stage = 'voice';
        }
        else if (!p.timeline) {
            p.stage = 'compose';
        }
        else {
            p.stage = 'render';
        }
        await this.deps.store.save(p);
        return this.run({ autoConfirm: p.confirmed });
    }
    status() {
        const p = this.getProject();
        return {
            stage: p.stage,
            confirmed: p.confirmed,
            shots: p.shots.map((s) => ({ id: s.id, state: s.state, ...(s.failReason ? { failReason: s.failReason } : {}) })),
            ...(p.style ? { style: p.style.id } : {}),
            awaitingConfirm: p.stage === 'storyboard' && !p.confirmed,
            confirmation: buildConfirmation(p),
        };
    }
    async measureRenderOutput(file) {
        return probeDurationMs(file);
    }
}
