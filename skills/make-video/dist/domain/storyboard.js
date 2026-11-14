import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import { applyStyleVisualPool, pickTemplateBySemantics } from './scene-semantics.js';
import { pickGrammar, actionSheet, defaultCameraFor, varyCameraFor } from './motion-grammar.js';
import { parseEnergyCurve, energyAt } from './continuity.js';
export async function writeDirectorNotes(project, llm, recipe) {
    if (!project.script)
        throw mvError(ERR.SCHEMA, '缺少讲稿，无法写导演批注');
    const raw = await llm.generate({
        kind: 'director-notes',
        payload: {
            segments: project.script.segments,
            recipeNotes: recipe.directorialNotes,
            genre: recipe.id,
        },
    });
    const notes = raw.map((n, i) => {
        const note = n;
        if (!note.segmentId || !note.visualIntent) {
            throw mvError(ERR.LLM_SCHEMA, `导演批注第 ${i + 1} 条缺字段`);
        }
        return {
            segmentId: note.segmentId,
            visualIntent: note.visualIntent,
            emotionGoal: note.emotionGoal ?? '稳定推进',
            referenceMood: note.referenceMood ?? '',
            counterpoint: note.counterpoint ?? 'metaphor',
        };
    });
    project.directorNotes = notes;
    return notes;
}
export function decideMaterials(segments, index, policy) {
    return segments.map((seg) => {
        const hit = matchMaterial(index, seg.text);
        if (hit) {
            return {
                kind: 'user-material',
                source: hit.path,
                reason: `具体指称物命中用户素材（${hit.tags.join('/') || hit.type}）`,
            };
        }
        if (policy === 'code-first' || policy === 'auto') {
            return { kind: 'code-scene', reason: '抽象概念/数据 → 代码绘制（默认）' };
        }
        if (policy === 'real-first') {
            return { kind: 'cloud', reason: 'real-first 策略且库存无匹配 → 云端生成' };
        }
        return { kind: 'code-scene', reason: 'ask 策略默认先画，确认表可改' };
    });
}
export function matchMaterial(index, text) {
    const t = text.toLowerCase();
    let best = null;
    for (const item of index.items) {
        if (item.type === 'audio')
            continue;
        const score = item.tags.reduce((acc, tag) => (t.includes(tag.toLowerCase()) ? acc + 2 : acc), 0);
        if (score > 0 && (!best || score > best.score))
            best = { item, score };
    }
    return best?.item ?? null;
}
export function decideStyle(registry, recipe, userStyleId) {
    if (userStyleId) {
        const pack = registry.getStyle(userStyleId);
        return {
            id: pack.id,
            source: 'user-specified',
            rationale: `用户指定风格 ${pack.userFacing.name}（${pack.userFacing.vibe}）`,
            lineage: {},
            overrides: {},
        };
    }
    const recommended = recipe.style.recommended.find((id) => {
        try {
            registry.getStyle(id);
            return true;
        }
        catch {
            return false;
        }
    });
    if (recommended) {
        const pack = registry.getStyle(recommended);
        return {
            id: pack.id,
            source: 'recipe-recommended',
            rationale: `${recipe.name}配方推荐：${recipe.style.rationale}`,
            lineage: {},
            overrides: {},
        };
    }
    const fallback = registry.listStyles()[0];
    if (!fallback)
        throw mvError(ERR.STYLE_UNKNOWN, '风格库为空');
    return {
        id: fallback.id,
        source: 'agent-chosen',
        rationale: `配方推荐不可用，按分类轴选择最近包 ${fallback.id}`,
        lineage: { base: fallback.id },
        overrides: {},
    };
}
export async function storyboard(store, project, llm, recipe, registry, materialIndex, userStyleId) {
    if (!project.script)
        throw mvError(ERR.SCHEMA, '缺少讲稿，无法分镜');
    if (project.directorNotes.length === 0) {
        await writeDirectorNotes(project, llm, recipe);
    }
    // init --style 已经把用户指定写进 project.style；storyboard 不传 --style 时必须沿用它，
    // 否则 decideStyle 会退回 recipe 推荐，把用户在 init 时的显式选择静默覆盖掉。
    const styleDecision = decideStyle(registry, recipe, userStyleId ?? project.style?.id);
    if (project.style && project.style.id === styleDecision.id && project.style.source === 'user-specified') {
        styleDecision.source = 'user-specified';
        styleDecision.rationale = project.style.rationale;
    }
    const stylePack = registry.resolveStyle(styleDecision);
    const decisions = decideMaterials(project.script.segments.map((s) => ({ id: s.id, text: s.text })), materialIndex, project.meta.assetPolicy);
    // 风格决定素材池：sceneDeny 剔除、sceneBias 前置（V-STYLE-008）
    const templatePool = applyStyleVisualPool(recipe.templates, stylePack.visuals);
    const raw = await llm.generate({
        kind: 'storyboard',
        payload: {
            segments: project.script.segments,
            directorNotes: project.directorNotes,
            templates: templatePool,
            styleVisual: stylePack.visuals,
            shotScaleBias: stylePack.shotScaleBias,
            materialDecisions: decisions,
        },
    });
    const shots = raw.map((s, i) => {
        const shot = s;
        if (!shot.narration || !shot.visual) {
            throw mvError(ERR.LLM_SCHEMA, `分镜第 ${i + 1} 条缺字段`);
        }
        // V-COL-002 色彩脚本：按 cool→neutral→warm 循环分配色温（三幕冷暖节奏）
        const colorTemp = ['cool', 'neutral', 'warm'][i % 3];
        const visual = { ...shot.visual, params: { ...(shot.visual.params ?? {}) } };
        // 风格素材池是硬边界：LLM 选了池外形态（含被 sceneDeny 的）就回退到池内语义选择，
        // 否则「风格决定素材」只是一句口号，画面仍可漂回风格之外
        if (!templatePool.includes(visual.template ?? '')) {
            visual.template = pickTemplateBySemantics(shot.narration, templatePool, stylePack.visuals?.sceneBias ?? []);
        }
        // canvas 程序化场景：kicker = 该段 beat 的名称（观众可读的章节标签）
        if ((visual.template ?? '').startsWith('canvas:')) {
            const seg = project.script?.segments.find((x) => x.id === (shot.segmentId ?? project.script?.segments[i]?.id));
            const beatName = recipe.beats.find((b) => b.id === seg?.beat)?.name;
            visual.params['kicker'] = beatName ?? visual.params['kicker'] ?? '';
        }
        return {
            id: `s${String(i + 1).padStart(2, '0')}`,
            segmentId: shot.segmentId ?? project.script?.segments[i]?.id ?? `seg-${i + 1}`,
            narration: shot.narration,
            visual,
            zoom: shot.zoom ?? 'MS',
            // V-CAM-006：静态画面必须过相机运动——分镜层默认缓推，禁止 none 蒙混
            camera: shot.camera && shot.camera !== 'none' ? shot.camera : 'push-in',
            motivation: shot.motivation ?? '',
            counterpoint: shot.counterpoint ?? 'metaphor',
            gag: shot.counterpoint === 'parody' ? true : false,
            colorTemp,
            // 导演显式给了转场就尊重；留空 = auto，交给剪辑部按切点动机裁决
            transition: shot.transition ?? stylePack.transitions[i % stylePack.transitions.length] ?? 'dissolve',
            // docs/04 A5：镜头内覆盖 / match-cut 锚点 / J-L cut 音频偏移（LLM 可给，缺省由合成阶段派生）
            coverage: normalizeCoverage(shot.coverage),
            enterAnchor: shot.enterAnchor ?? '',
            exitAnchor: shot.exitAnchor ?? '',
            audioShiftMs: typeof shot.audioShiftMs === 'number' ? shot.audioShiftMs : 0,
            state: 'pending',
        };
    });
    // P8-T6 超长镜切分：旁白 >8s（花叔「一镜 2-6s」硬档 + V-MOT-017 上限 6.5s）的镜
    // 按句号/问号切成两镜以上——拆开的是「一镜装一段话」的 PPT 拍法；
    // 拆出的镜共用原 segmentId（配音按镜旁白合成，素材沿用由 narration 变化自然失效）。
    const LONG_SHOT_CHARS = 36; // 36 字 × 220ms ≈ 7.9s
    const splitShots = [];
    for (const shot of shots) {
        const sentences = shot.narration.split(/(?<=[。！？!?])/).filter((s) => s.trim().length > 0);
        if (shot.narration.length <= LONG_SHOT_CHARS || sentences.length < 2) {
            splitShots.push(shot);
            continue;
        }
        // 尽量均匀分给前半/后半（长句优先在前，与口播语序一致）
        const target = Math.ceil(shot.narration.length / 2);
        let acc = 0;
        let cut = 1;
        for (let k = 0; k < sentences.length - 1; k += 1) {
            acc += sentences[k].length;
            if (acc >= target) {
                cut = k + 1;
                break;
            }
            cut = k + 1;
        }
        const partA = sentences.slice(0, cut).join('');
        const partB = sentences.slice(cut).join('');
        if (!partA.trim() || !partB.trim()) {
            splitShots.push(shot);
            continue;
        }
        const mk = (narration, suffix, extraCoverage = false) => ({
            ...shot,
            id: `${shot.id}${suffix}`,
            narration,
            // 拆出的两半必须是各自独立的 visual/params：直接 ...shot 会让 a/b 共用同一个对象引用，
            // 于是后面写 a 镜的 actionSheet 时 b 镜也「看起来已经有了」（declared.grammar 命中即跳过），
            // 结果是 b 镜动作谱与文案全部沿用 a 镜（实测 8 个 b 镜 actionSheet.line 都等于同段 a 镜旁白）。
            visual: { ...shot.visual, params: { ...shot.visual.params } },
            // 拆出的后半镜换构图（V-MOT-020）：景别进一档，后半比前半更近
            zoom: extraCoverage ? nextZoomIn(shot.zoom) : shot.zoom,
            coverage: extraCoverage ? shot.coverage : shot.coverage,
            // 死板清除 X1（2026-11-14）：b 镜机位不再照抄 a 镜——`...shot` 让 b 镜继承 camera，
            // 实测 8 对拆分镜 4 对机位全同（s01a/b 同 push-in…），观众看到同一动作播两遍。
            // 这里先置 none 交给下方兜底循环按「与 a 镜不同」的变奏规则重取。
            camera: extraCoverage ? 'none' : shot.camera,
        });
        splitShots.push(mk(partA, 'a'), mk(partB, 'b', true));
    }
    shots.length = 0;
    shots.push(...splitShots);
    // P8-T2 语法前移：动效语法在分镜期选定（而不是 compose 期补记录）——
    // 语法要约束 LLM 场景生成（payload 带动作谱）与模板语义归位，晚于分镜就失去约束力。
    // compose 期 composer 只沿用既有 actionSheet，不再重算（导演/人工可改，改了就算数）。
    const grammarRecent = [];
    let y5Count = 0;
    // T1c 能量曲线：风格包 pacing.curve（或项目 overrides）→ 每镜能量目标，喂给选型
    const energyCurve = parseEnergyCurve(stylePack.pacing?.curve);
    shots.forEach((shot, idx) => {
        shot.visual.params['energy'] = energyCurve ? energyAt(shots.length, idx, energyCurve) : undefined;
    });
    for (const shot of shots) {
        const declared = shot.visual.params['actionSheet'];
        if (declared?.grammar) {
            grammarRecent.push(declared.grammar);
            if (declared.grammar === 'y5_kinetic_type')
                y5Count += 1;
            continue;
        }
        // P8-T6 文字主导闸：前文 y5 已超 40% 配额 → 抑制 y5（重音是稀缺资源，全片都砸=没有重点）
        const suppress = y5Count / Math.max(1, grammarRecent.length) > 0.4 && grammarRecent.length >= 3;
        // 死板清除 X2：上一镜已落 b_roll → 本镜抑制 b_roll 兜底（成对氛围镜=默认不会选型）
        const lastGrammar = grammarRecent.at(-1);
        const g = pickGrammar(shot.narration, {
            recent: grammarRecent.slice(-2),
            hasRealMaterial: shot.visual.kind === 'user-material' || shot.visual.kind === 'imported',
            singleNumber: (shot.narration.match(/\d+/g) ?? []).length === 1,
            suppressTextLed: suppress,
            suppressBroll: lastGrammar === 'b_roll',
            energy: energyCurve ? energyAt(shots.length, shots.indexOf(shot), energyCurve) : undefined,
        });
        grammarRecent.push(g.id);
        if (g.id === 'y5_kinetic_type')
            y5Count += 1;
        shot.visual.params['actionSheet'] = actionSheet(shot, g);
    }
    // V-CAM-006 兜底修正（I-05）：缺省机位不再一律 push-in，按各镜语法取机位偏好
    // （b_roll→drift、y4→static、y2→pan…）。「static 是合法选择」的提示词承诺
    // 由兜底兑现，而不是只出现在文案里。导演显式给了机位的镜不受影响。
    // 死板清除 X1：同语法相邻镜（splitShots 的 a/b 对）机位变奏——b 镜在语法机位
    // 偏好里取一个与 a 镜不同的值，拆分镜不再「同一动作播两遍」。
    for (let i = 0; i < shots.length; i += 1) {
        const shot = shots[i];
        const declared = shot.visual.params['actionSheet'];
        if (shot.camera && shot.camera !== 'none')
            continue;
        const prev = shots[i - 1];
        const sameGrammar = prev &&
            prev.visual.params['actionSheet']?.grammar ===
                declared?.grammar;
        shot.camera = (sameGrammar ? varyCameraFor(declared?.grammar, prev.camera) : defaultCameraFor(declared?.grammar));
    }
    // 重跑分镜不该无差别清空已完成产物：旁白原文没变的镜头照旧沿用配音与素材，
    // 否则每次 --script 微调或 storyboard 重进都要重配音（0.6B 模型几分钟起步）。
    const prevById = new Map(project.shots.map((s) => [s.id, s]));
    for (const shot of shots) {
        const prev = prevById.get(shot.id);
        if (!prev || prev.narration.trim() !== shot.narration.trim())
            continue;
        if (prev.voice) {
            shot.voice = prev.voice;
            if (shot.state === 'pending')
                shot.state = 'voiced';
        }
        if (prev.asset)
            shot.asset = prev.asset;
    }
    project.shots = shots;
    project.style = styleDecision;
    project.materialDecisions = Object.fromEntries(shots.map((s, i) => [s.id, decisions[i] ?? { kind: 'code-scene', reason: '默认' }]));
    project.stage = 'storyboard';
    const issues = [...V.validateStoryboard(project), ...V.validateRhythmPeriodicity(project)];
    if (V.hasError(issues)) {
        throw mvError(ERR.STORYBOARD_RULE, `分镜校验失败:\n${V.formatIssues(issues)}`);
    }
    await store.save(project);
    return shots;
}
// LLM 分镜里的覆盖条目是外部输入：只收 0-1 时间比、限 3 条，其余字段补默认
function normalizeCoverage(raw) {
    return (raw ?? [])
        .filter((c) => c && Number.isFinite(c.at) && c.at >= 0 && c.at <= 1)
        .slice(0, 3)
        .map((c) => ({
        at: c.at,
        kind: c.kind === 'reframe' ? 'reframe' : 'punch-in',
        scale: Number.isFinite(c.scale) ? c.scale : 1.16,
        xPercent: Number.isFinite(c.xPercent) ? c.xPercent : 0,
        yPercent: Number.isFinite(c.yPercent) ? c.yPercent : 0,
        rotation: Number.isFinite(c.rotation) ? c.rotation : 0,
        motivation: c.motivation || 'emphasis',
    }));
}
/** 景别序列进一档（P8-T6 超长镜切分：后半镜比前半近，制造推近叙事） */
const ZOOM_LADDER = ['ELS', 'LS', 'MLS', 'MS', 'MCU', 'CU', 'ECU'];
function nextZoomIn(zoom) {
    const i = ZOOM_LADDER.indexOf(zoom);
    return ZOOM_LADDER[Math.min(ZOOM_LADDER.length - 1, i + 1)] ?? 'MS';
}
export function buildConfirmation(project) {
    const lines = [];
    lines.push('=== 分镜前确认表（素材决策 + 风格决策 + 导演批注摘要）===');
    if (project.style) {
        lines.push(`风格：${project.style.id}（${project.style.source}）—— ${project.style.rationale}`);
    }
    for (const shot of project.shots) {
        const dec = project.materialDecisions[shot.id];
        const note = project.directorNotes.find((n) => n.segmentId === shot.segmentId);
        lines.push(`  ${shot.id} [${shot.zoom}/${shot.camera}] ${dec?.kind ?? 'code-scene'}：${dec?.reason ?? ''}`);
        lines.push(`      对位=${shot.counterpoint} 批注：${note?.visualIntent ?? '-'}`);
    }
    lines.push('确认后进入采购阶段；修改请直接编辑 project.json 或重跑 storyboard。');
    return lines.join('\n');
}
