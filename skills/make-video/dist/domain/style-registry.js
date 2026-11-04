import path from 'node:path';
import { RecipeSchema, StylePackSchema, } from '../core/schema.js';
import { RECIPES_DIR, STYLES_DIR, GENRES } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import { V } from '../core/index.js';
import { listFiles, readJson } from '../infrastructure/fs-utils.js';
export class StyleRegistry {
    root;
    packs = new Map();
    recipes = new Map();
    loaded = false;
    constructor(root) {
        this.root = root;
    }
    async ensureLoaded() {
        if (!this.loaded)
            await this.load();
    }
    async load() {
        this.loaded = true;
        this.packs.clear();
        this.recipes.clear();
        const stylesDir = path.join(this.root, STYLES_DIR);
        for (const file of await listFiles(stylesDir)) {
            if (!file.endsWith('.json'))
                continue;
            const raw = await readJson(file);
            const parsed = StylePackSchema.safeParse(raw);
            if (!parsed.success) {
                throw mvError(ERR.STYLE_INVALID, `风格包 ${file} 校验失败: ${parsed.error.message}`);
            }
            this.packs.set(parsed.data.id, parsed.data);
        }
        const recipesDir = path.join(this.root, RECIPES_DIR);
        for (const file of await listFiles(recipesDir)) {
            if (!file.endsWith('.json'))
                continue;
            const raw = await readJson(file);
            const parsed = RecipeSchema.safeParse(raw);
            if (!parsed.success) {
                throw mvError(ERR.SCHEMA, `配方 ${file} 校验失败: ${parsed.error.message}`);
            }
            this.recipes.set(parsed.data.id, parsed.data);
        }
    }
    listStyles(grade) {
        const all = [...this.packs.values()].filter((p) => p.status === 'registered');
        return grade ? all.filter((p) => p.grade === grade) : all;
    }
    getStyle(id) {
        const pack = this.packs.get(id);
        if (!pack)
            throw mvError(ERR.STYLE_UNKNOWN, `风格包不存在: ${id}`);
        return pack;
    }
    listRecipes() {
        return [...this.recipes.values()];
    }
    getRecipe(id) {
        const r = this.recipes.get(id);
        if (!r)
            throw mvError(ERR.STYLE_UNKNOWN, `类型配方不存在: ${id}`);
        return r;
    }
    findByAlias(text) {
        const t = text.toLowerCase();
        let best = null;
        for (const pack of this.packs.values()) {
            if (pack.status !== 'registered')
                continue;
            const names = [pack.userFacing.name, ...pack.userFacing.aliases, pack.id].map((s) => s.toLowerCase());
            const score = names.reduce((acc, n) => (t.includes(n) ? acc + n.length : acc), 0);
            if (score > 0 && (!best || score > best.score))
                best = { pack, score };
        }
        return best?.pack ?? null;
    }
    resolveStyle(decision) {
        const base = this.getStyle(decision.id);
        const overrides = decision.overrides;
        const issues = V.validateCombination(base, overrides, this.listStyles());
        if (V.hasError(issues)) {
            throw mvError(ERR.STYLE_INVALID, `风格组合不合法:\n${V.formatIssues(issues)}`);
        }
        const lineage = overrides['_lineage'] ?? [];
        let merged = { ...base };
        for (const id of lineage) {
            const donor = this.getStyle(id);
            merged = mergePacks(merged, donor);
        }
        const { _lineage, ...rest } = overrides;
        void _lineage;
        return { ...merged, ...rest };
    }
    classify(request) {
        const scores = this.listRecipes().map((r) => {
            let score = 0;
            const reasons = [];
            const densityRank = { low: 1, medium: 2, high: 3 };
            const wantDensity = request.infoDensity >= 4 ? 'high' : request.infoDensity <= 2 ? 'low' : 'medium';
            if (r.density === wantDensity) {
                score += 2;
                reasons.push(`信息密度匹配(${r.density})`);
            }
            if (request.narrative >= 4 && (r.id === 'story-narrative' || r.id === 'kids-education')) {
                score += 3;
                reasons.push('强叙事');
            }
            if (request.narrative <= 2 && r.id !== 'story-narrative')
                score += 1;
            if (request.intent === 'teach' && (r.id === 'tutorial-howto' || r.id === 'kids-education')) {
                score += 3;
                reasons.push('教学意图');
            }
            if (request.intent === 'persuade' && r.id === 'product-promo') {
                score += 3;
                reasons.push('说服意图');
            }
            if (request.intent === 'inform' && r.id === 'science-explainer') {
                score += 2;
                reasons.push('告知意图');
            }
            if (request.intent === 'entertain' && r.id === 'science-explainer')
                score += 1;
            if (request.mood === 'slow' && (r.id === 'documentary-mood' || r.id === 'story-narrative')) {
                score += 2;
                reasons.push('慢情绪');
            }
            if (request.audience === 'kids' && r.id === 'kids-education') {
                score += 3;
                reasons.push('儿童受众');
            }
            if (request.durationTier === '0-5' && r.id === 'news-brief')
                score += 1;
            return { genre: r.id, score, reason: reasons.join('；') || '默认最近' };
        });
        return scores.sort((a, b) => b.score - a.score);
    }
    absorbDraft(analysis) {
        const base = this.packs.get(analysis.suggestedBase) ?? this.listStyles()[0];
        if (!base)
            throw mvError(ERR.STYLE_UNKNOWN, '无可用 base 包');
        const id = `absorbed-${Date.now().toString(36)}`;
        const draft = {
            ...base,
            id,
            name: `沉淀风格（${analysis.source}）`,
            grade: 'B',
            status: 'draft',
            userFacing: {
                name: `待命名风格（${analysis.source}）`,
                aliases: [analysis.source],
                vibe: analysis.description.slice(0, 60),
                bestFor: [],
            },
            anatomy: { ...base.anatomy, ...analysis.anatomy },
            provenance: {
                source: 'absorbed',
                from: analysis.source,
                version: '0.1',
                absorbedAt: new Date().toISOString(),
                review: '',
            },
        };
        const issues = V.validateProvenance(draft);
        void issues;
        return draft;
    }
    registerPack(pack, opts) {
        const ready = {
            ...pack,
            status: 'registered',
            provenance: { ...pack.provenance, review: opts.review },
        };
        const issues = V.validateProvenance(ready);
        if (V.hasError(issues)) {
            throw mvError(ERR.STYLE_INVALID, `上架被拒:\n${V.formatIssues(issues)}`);
        }
        this.packs.set(ready.id, ready);
        return ready;
    }
    hasGenre(id) {
        return GENRES.includes(id) && this.recipes.has(id);
    }
}
function mergePacks(base, donor) {
    return {
        ...base,
        palette: donor.palette,
        motion: donor.motion,
        effects: { ...base.effects, ...donor.effects },
        transitions: donor.transitions,
    };
}
