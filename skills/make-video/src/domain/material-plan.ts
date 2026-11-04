import type { Project, StylePack } from '../core/schema.js';
import type { LlmClient } from '../infrastructure/llm-client.js';
import { mvError, ERR } from '../core/errors.js';

/**
 * 素材需求单（P5-B）：检索本身交给 agent（外部时间流），
 * 引擎只输出「这一镜该找什么、什么形态、必须含/必须避、为什么」，保证回来的素材可被契约验收。
 */
export interface MaterialBrief {
  shotId: string;
  segmentId: string;
  narration: string;
  need: 'person' | 'place' | 'object' | 'background' | 'none';
  query: string;
  type: 'image' | 'video';
  mustHave: string[];
  avoid: string[];
  reason: string;
}

const NEEDS = ['person', 'place', 'object', 'background', 'none'] as const;

export async function planMaterials(
  project: Project,
  pack: StylePack,
  llm: LlmClient,
): Promise<MaterialBrief[]> {
  const shots = project.shots;
  if (shots.length === 0) throw mvError(ERR.SCHEMA, '缺少分镜，先跑 storyboard 再生成素材需求单');
  const segments = project.script?.segments ?? [];
  const payload = {
    topic: project.meta.topic,
    genre: project.meta.genre,
    styleVisual: pack.visuals,
    segments: shots.map((s) => {
      const seg = segments.find((x) => x.id === s.segmentId);
      return {
        shotId: s.id,
        segmentId: s.segmentId,
        narration: s.narration,
        emphasis: seg?.emphasis ?? [],
        zoom: s.zoom,
      };
    }),
  };
  const raw = await llm.generate({ kind: 'material-plan', payload });
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { briefs?: unknown[] })?.briefs)
      ? (raw as { briefs: unknown[] }).briefs
      : [];
  const byShot = new Map<string, unknown>();
  for (const item of list) {
    const id = String((item as { shotId?: unknown })?.shotId ?? '');
    if (id) byShot.set(id, item);
  }
  // 对齐纪律：LLM 只要给了 shotId 就按 id 严格对齐（漏掉的镜兜底 none，不顶替别人）；
  // 完全没给 id 时才按顺序对位
  const byId = list.some((item) => String((item as { shotId?: unknown })?.shotId ?? '') !== '');
  return shots.map((s, i) => normalize(byId ? byShot.get(s.id) : list[i], s, segments));
}

function normalize(
  raw: unknown,
  shot: Project['shots'][number] | undefined,
  segments: NonNullable<Project['script']>['segments'],
): MaterialBrief {
  const r = (raw ?? {}) as Partial<MaterialBrief>;
  const shotId = String(shot?.id ?? r.shotId ?? '');
  const segmentId = String(shot?.segmentId ?? r.segmentId ?? '');
  const narration = String(shot?.narration ?? r.narration ?? '');
  const emphasis = segments.find((s) => s.id === segmentId)?.emphasis ?? [];
  // 没有明确判断就退回代码绘制：重音词不等于「现实指称物」，不能据此要真实素材
  const need = (NEEDS as readonly string[]).includes(String(r.need))
    ? (r.need as MaterialBrief['need'])
    : 'none';
  const query =
    need === 'none'
      ? ''
      : String(r.query ?? '').trim() || [projectTopicFallback(narration), ...emphasis].join(' ');
  return {
    shotId,
    segmentId,
    narration,
    need,
    query,
    type: r.type === 'video' ? 'video' : 'image',
    mustHave:
      need === 'none'
        ? []
        : Array.isArray(r.mustHave)
          ? r.mustHave.map(String).filter(Boolean)
          : emphasis,
    avoid: Array.isArray(r.avoid) ? r.avoid.map(String).filter(Boolean) : ['logo', 'watermark', 'text'],
    reason: String(r.reason ?? '').trim() || (need === 'none' ? '抽象/数据段，走代码绘制' : '需要真实指称物'),
  };
}

function projectTopicFallback(narration: string): string {
  return narration.replace(/[，。！？；、,.!?;]/g, ' ').trim().slice(0, 12);
}
