/**
 * 元素/动作清单的应用层门面（供 CLI 调用）。
 * 组合 domain/manifest.ts 的纯逻辑 + infrastructure 的读写/抽帧。
 */
import path from 'node:path';
import { atomicWriteText, atomicWriteJson, exists } from '../infrastructure/fs-utils.js';
import { extractFrame } from '../infrastructure/ffmpeg-utils.js';
import { extractManifestsFromHtml, validateManifests, backfillVisibility, queryTimeSlice, renderManifestHtml, } from '../domain/manifest.js';
/** 读取每镜场景 HTML，反向抽取两清单（不写 project）。返回按 shotId 索引。 */
export async function extractFromProject(store, project) {
    const out = {};
    for (const shot of project.shots) {
        const htmlFile = path.join(store.projectDir(project.meta.id), 'scenes', `Scene_${shot.id}.html`);
        if (!exists(htmlFile))
            continue;
        const html = await (await import('node:fs/promises')).readFile(htmlFile, 'utf8');
        const m = extractManifestsFromHtml(html);
        out[shot.id] = m;
    }
    return out;
}
/** P1 只读导出：两清单 HTML + JSON，附关键帧（若整片存在则首/中/末三帧；否则留空）。 */
export async function exportManifestReport(store, project, opts = {}) {
    const dir = store.projectDir(project.meta.id);
    const extracted = await extractFromProject(store, project);
    const merged = {
        ...project,
        shots: project.shots.map((s) => ({
            ...s,
            elements: s.elements ?? extracted[s.id]?.elements,
            actions: s.actions ?? extracted[s.id]?.actions,
        })),
    };
    const keyFrames = {};
    if (opts.withFrames) {
        const mp4 = path.join(dir, 'out', `${project.meta.id}.mp4`);
        if (exists(mp4)) {
            for (const shot of merged.shots) {
                const tl = merged.timeline?.shots.find((t) => t.shotId === shot.id);
                if (!tl)
                    continue;
                const dur = tl.durationMs / 1000;
                const start = tl.startMs / 1000;
                const stamps = [start + 0.02, start + dur / 2, start + Math.max(dur - 0.02, 0.03)];
                const frames = [];
                for (let i = 0; i < stamps.length; i += 1) {
                    const dest = path.join(dir, 'preview', `${shot.id}-f${i}.jpg`);
                    try {
                        await extractFrame(mp4, stamps[i] ?? start, dest);
                        frames.push(path.relative(dir, dest).replace(/\\/g, '/'));
                    }
                    catch {
                        // 抽帧失败不阻断导出（方案 §5.5 退化路径：静帧缺失仍有两表）
                    }
                }
                keyFrames[shot.id] = frames;
            }
        }
    }
    const reportDir = path.join(dir, 'preview');
    const htmlFile = path.join(reportDir, 'manifest.html');
    const jsonFile = path.join(reportDir, 'manifest.json');
    await atomicWriteText(htmlFile, renderManifestHtml(merged, keyFrames));
    await atomicWriteJson(jsonFile, {
        generatedAt: new Date().toISOString(),
        shots: merged.shots.map((s) => ({ id: s.id, elements: s.elements ?? [], actions: s.actions ?? [] })),
    });
    return { html: htmlFile, json: jsonFile, issues: validateManifests(merged) };
}
/** P2 materialize：把反向抽取的两清单写入 project（只在字段缺省时填，不覆盖人工精修）。 */
export async function materializeManifests(store, project) {
    const extracted = await extractFromProject(store, project);
    let filled = 0;
    const shots = project.shots.map((s) => {
        const have = s.elements !== undefined || s.actions !== undefined;
        if (have)
            return s;
        const m = extracted[s.id];
        if (!m || (m.elements.length === 0 && m.actions.length === 0))
            return s;
        filled += 1;
        return {
            ...s,
            elements: m.elements,
            actions: m.actions,
        };
    });
    const next = { ...project, shots };
    await store.save(next);
    return { project: next, filled };
}
/** P3：由时间线回填 visibility/timing 并落盘。 */
export async function backfillAndSave(store, project) {
    const next = backfillVisibility(project);
    await store.save(next);
    return next;
}
export { validateManifests, queryTimeSlice, backfillVisibility };
