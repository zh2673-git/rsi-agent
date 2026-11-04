import path from 'node:path';
import { promises as fs } from 'node:fs';
import { StateEngine } from '../runtime/state-engine.js';
import { indexMaterials } from '../domain/asset-sourcing.js';
import { synthesizeAll, adoptRecording } from '../domain/voice.js';
import { exists } from '../infrastructure/fs-utils.js';
import { mvError, ERR } from '../core/errors.js';
export function createEngine(root, deps) {
    return new StateEngine(root, deps);
}
export async function runProject(engine, opts) {
    return engine.run(opts);
}
export async function addMaterials(store, project, paths) {
    const index = await indexMaterials(store, project, paths);
    return index.items.length;
}
export async function useRecording(store, project, shotId, file) {
    const shot = project.shots.find((s) => s.id === shotId);
    if (!shot)
        throw mvError(ERR.PROJECT_NOT_FOUND, `镜头不存在: ${shotId}`);
    shot.voice = await adoptRecording(store, project, shotId, file);
    if (shot.state === 'pending' || shot.state === 'failed')
        shot.state = 'voiced';
    // 录音换了，旧时间线失配，作废等重排
    if (project.timeline)
        project.timeline = undefined;
    await store.save(project);
}
/** agent/人工场景接入（docs/12「LLM 生成、人可精修」）：校验+落盘；场景已变则时间线作废待重排 */
export async function adoptSceneFile(store, project, shotId, file, pack) {
    const { adoptScene } = await import('../domain/scene-forge.js');
    const r = await adoptScene(store, project, shotId, file, pack);
    if (r.adopted) {
        if (project.timeline)
            project.timeline = undefined;
        await store.save(project);
    }
    return r;
}
export async function resynthesize(store, project, tts, shotId, voice) {
    const refs = await synthesizeAll(store, project, tts, voice, shotId);
    return refs.length;
}
export async function absorbStyle(registry, llm, input) {
    const frames = [];
    if (input.referenceFiles?.length) {
        for (const f of input.referenceFiles) {
            if (exists(f))
                frames.push(path.basename(f));
        }
    }
    const analysis = (await llm.generate({
        kind: 'style-analyze',
        payload: { description: input.description, frames },
    }));
    const draft = registry.absorbDraft({
        ...analysis,
        description: input.description,
        source: input.source,
    });
    await persistDraft(registry, draft);
    return { id: draft.id, anatomy: draft.anatomy, suggestedBase: analysis.suggestedBase };
}
async function persistDraft(registry, draft) {
    const pack = draft;
    const file = path.join(registry.root, 'styles', `${pack.id}.json`);
    await fs.writeFile(file, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
}
