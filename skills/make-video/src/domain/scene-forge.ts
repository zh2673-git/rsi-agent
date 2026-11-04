import path from 'node:path';
import type { Project, Shot, StylePack } from '../core/schema.js';
import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import { TEMPLATES_DIR, SCENE_LLM_RETRIES } from '../core/constants.js';
import type { ProjectStore } from '../infrastructure/project-store.js';
import { atomicWriteText, exists, readJson } from '../infrastructure/fs-utils.js';

interface DesignTokens {
  primary: string;
  accent: string;
  neutral: string[];
  fontFamily: string;
  titleSize: number;
  bodySize: number;
  easing: string;
  durationMs: number;
  staggerMs: number;
  springStiffness: number;
  springDamping: number;
  maxElements: number;
  whitespace: number;
  grain: number;
  vignette: number;
  letterbox: boolean;
  dof: number;
  bloom: number;
}

export function tokensFromPack(pack: StylePack): DesignTokens {
  const fx = pack.effects as Record<string, number | boolean>;
  return {
    primary: pack.palette.primary,
    accent: pack.palette.accent,
    neutral: pack.palette.neutral,
    fontFamily: pack.type.families[0] ?? 'sans-serif',
    // type.scale 是相对画布高度的比例（如 title 0.11 → 1080p 下 119px）；此前误乘 100 导致 10px 小字
    titleSize: Math.round(pack.type.scale.title * 1080),
    bodySize: Math.round(pack.type.scale.body * 1080),
    easing: pack.motion.easing,
    durationMs: 600,
    staggerMs: pack.motion.staggerMs,
    springStiffness: pack.motion.spring.stiffness,
    springDamping: pack.motion.spring.damping,
    maxElements: pack.layout.maxElementsPerShot,
    whitespace: pack.layout.whitespace,
    grain: Number(fx['grain'] ?? 0),
    vignette: Number(fx['vignette'] ?? 0),
    letterbox: Boolean(fx['letterbox'] ?? false),
    dof: Number(fx['dof'] ?? 0),
    bloom: Number(fx['bloom'] ?? 0),
  };
}

export async function drawScene(
  store: ProjectStore,
  project: Project,
  shot: Shot,
  pack: StylePack,
  llm?: import('../infrastructure/index.js').LlmClient,
): Promise<{ file: string; issues: V.Issue[] }> {
  const dir = store.projectDir(project.meta.id);
  const out = path.join(dir, 'scenes', `Scene_${shot.id}.html`);
  // V-STE-003 任务幂等 + docs/12「人可精修」：场景文件已存在（上轮产物或 agent/人工精修版）
  // 则不再覆盖——校验通过直接沿用；违规则带反馈报错（failReason 即给 agent 的修改意见）
  if (exists(out)) {
    const existing = await readTemplate(out);
    const issues = validateSceneHtml(
      existing,
      shot,
      project,
      shot.visual.template ?? 'typography',
      pack.visuals?.dimension,
    );
    if (V.hasError(issues)) {
      throw mvError(
        ERR.SCENE_INVALID,
        `场景 ${shot.id} 已有精修版但未过校验（请修正或删除该文件后重跑）:\n${V.formatIssues(issues)}`,
      );
    }
    return { file: out, issues };
  }
  // LLM 个性化场景（docs/04：根据剧本拍电影）→ 校验失败带反馈重试 → 耗尽回退模板 forge
  if (llm) {
    const generated = await tryLlmScene(llm, project, shot, pack);
    if (generated) {
      const issues = validateSceneHtml(
        generated.html,
        shot,
        project,
        generated.template,
        pack.visuals?.dimension,
      );
      if (!V.hasError(issues)) {
        const out = path.join(dir, 'scenes', `Scene_${shot.id}.html`);
        await atomicWriteText(out, generated.html);
        await writeArtifacts(store, project, shot, 'llm');
        return { file: out, issues };
      }
    }
  }
  const templateName = shot.visual.template ?? 'typography';
  // canvas:<program> → 程序化电影场景（templates/canvas/cinema.html）
  const isCanvas = templateName.startsWith('canvas:');
  const templateFile = isCanvas
    ? path.join(store.root, TEMPLATES_DIR, 'canvas', 'cinema.html')
    : path.join(store.root, TEMPLATES_DIR, 'scenes', `${templateName}.html`);
  if (!exists(templateFile)) {
    throw mvError(ERR.SCENE_INVALID, `场景模板不存在: ${templateName}`);
  }
  const tokens = tokensFromPack(pack);
  const html = renderTemplate(await readTemplate(templateFile), {
    shot,
    project,
    tokens,
    sceneId: shot.id,
  })
    .replace('{{SCENE_PROGRAM}}', isCanvas ? templateName.slice('canvas:'.length) : '')
    .replace('{{KICKER}}', isCanvas ? escapeHtml(String(shot.visual.params?.['kicker'] ?? '')) : '')
    .replace('{{BEATS}}', isCanvas ? String(BEATS_PER_PROGRAM[templateName.slice('canvas:'.length)] ?? 6) : '')
    .replace(/\{\{STAR_SEED\}\}/g, String(hashSeed(shot.id)));
  const issues = validateSceneHtml(
    html,
    shot,
    project,
    templateName,
    pack.visuals?.dimension,
  );
  if (V.hasError(issues)) {
    throw mvError(ERR.SCENE_INVALID, `场景 ${shot.id} 校验失败:\n${V.formatIssues(issues)}`);
  }
  await atomicWriteText(out, html);
  await writeArtifacts(store, project, shot, 'forge');
  return { file: out, issues };
}

/**
 * agent/人工场景接入面（docs/12：场景 LLM 生成、人可精修）：
 * 校验外部场景 HTML → 通过则落入 scenes/Scene_<id>.html（下次 run 沿用，见 drawScene 幂等）；
 * 未过校验 → 返回 issues 作为给 agent 的修改反馈，不落盘。
 * 这就是「agent 的大模型直接承担视频个性化」的正道：agent 亲手画，skill 只把关。
 */
export async function adoptScene(
  store: ProjectStore,
  project: Project,
  shotId: string,
  file: string,
  pack?: StylePack,
): Promise<{ adopted: boolean; issues: V.Issue[] }> {
  const shot = project.shots.find((s) => s.id === shotId);
  if (!shot) throw mvError(ERR.PROJECT_NOT_FOUND, `镜头不存在: ${shotId}`);
  if (!exists(file)) throw mvError(ERR.SCENE_INVALID, `场景文件不存在: ${file}`);
  const html = await readTemplate(file);
  const issues = validateSceneHtml(
    html,
    shot,
    project,
    shot.visual.template ?? 'typography',
    pack?.visuals?.dimension,
  );
  if (V.hasError(issues)) {
    return { adopted: false, issues };
  }
  const out = path.join(store.projectDir(project.meta.id), 'scenes', `Scene_${shotId}.html`);
  await atomicWriteText(out, html);
  await writeArtifacts(store, project, shot, 'agent');
  return { adopted: true, issues };
}

/** 场景校验统一入口（LLM 与 forge 共用）；dimension 走 V-STYLE-008 素材语言一致性 */
function validateSceneHtml(
  html: string,
  shot: Shot,
  project: Project,
  templateName: string,
  dimension?: '2d' | 'css3d' | 'mixed',
): V.Issue[] {
  const issues = V.validateSceneFile(html, {
    narration: shot.narration,
    title: project.meta.title,
    dimension,
  });
  if (templateName === 'chart') {
    issues.push(...V.validateChartScene(html));
  }
  return issues;
}

/** A6 摄影计划 / A7 表演设计工件（docs/05）；origin 记录画面来源（llm/forge） */
async function writeArtifacts(
  store: ProjectStore,
  project: Project,
  shot: Shot,
  origin: 'llm' | 'forge' | 'agent',
): Promise<void> {
  const dir = store.projectDir(project.meta.id);
  const artDir = path.join(dir, 'logs', 'artifacts');
  await atomicWriteText(
    path.join(artDir, `photography-${shot.id}.json`),
    JSON.stringify(
      { shotId: shot.id, zoom: shot.zoom, camera: shot.camera, motivation: shot.motivation, transition: shot.transition, origin },
      null,
      2,
    ),
  );
  await atomicWriteText(
    path.join(artDir, `performance-${shot.id}.json`),
    JSON.stringify(
      {
        shotId: shot.id,
        counterpoint: shot.counterpoint,
        mood: project.script?.segments.find((x) => x.id === shot.segmentId)?.mood ?? 'neutral',
        emphasis: project.script?.segments.find((x) => x.id === shot.segmentId)?.emphasis ?? [],
      },
      null,
      2,
    ),
  );
}

/**
 * LLM 场景生成 + 带反馈重试（docs/04 规定的个性化接线）：
 * 旁白语义 + 导演视觉意图 + 风格 token 交给 LLM 画场景，校验器意见回传重试；
 * 重试耗尽或引擎无 scene 能力（template 模式返回空 html）→ 返回 null 由 forge 兜底。
 */
async function tryLlmScene(
  llm: import('../infrastructure/index.js').LlmClient,
  project: Project,
  shot: Shot,
  pack: StylePack,
): Promise<{ html: string; template: string } | null> {
  const tokens = tokensFromPack(pack);
  const seg = project.script?.segments.find((x) => x.id === shot.segmentId);
  const base = {
    sceneId: shot.id,
    narration: shot.narration,
    visualIntent: shot.visual.prompt,
    counterpoint: shot.counterpoint,
    mood: seg?.mood ?? 'neutral',
    emphasis: seg?.emphasis ?? [],
    camera: shot.camera === 'none' ? 'push-in' : shot.camera,
    zoom: shot.zoom,
    template: shot.visual.template ?? 'typography',
    // 风格素材语言（V-STYLE-008）：维度/母题/纹理/禁用 + 美术-摄影-表演三条部门指令，
    // 让画面长成这一派的样子，而不是只换一套配色
    styleVisual: pack.visuals,
    artDirective: pack.anatomy?.art ?? '',
    cameraDirective: pack.anatomy?.camera ?? '',
    performanceDirective: pack.anatomy?.performance ?? '',
    tokens: {
      primary: tokens.primary,
      accent: tokens.accent,
      neutral: tokens.neutral,
      fontFamily: tokens.fontFamily,
      titleSize: tokens.titleSize,
      bodySize: tokens.bodySize,
      easing: tokens.easing,
      durationMs: tokens.durationMs,
      staggerMs: tokens.staggerMs,
    },
  };
  let feedback = '';
  for (let attempt = 0; attempt <= SCENE_LLM_RETRIES; attempt += 1) {
    const res = (await llm.generate({ kind: 'scene', payload: { ...base, feedback } })) as {
      html?: string;
      note?: string;
    };
    const html = res?.html ?? '';
    if (!html) return null; // 引擎无 scene 能力（template 模式声明）→ forge 兜底
    const issues = validateSceneHtml(html, shot, project, base.template, pack.visuals?.dimension);
    if (!V.hasError(issues)) return { html, template: base.template };
    feedback = `上一版被校验器打回，逐条修复后重出完整 HTML：\n${V.formatIssues(issues)}`;
  }
  return null; // 重试耗尽 → forge 兜底（流水线不因 LLM 质量阻塞）
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

// 各画面程序的编排节拍数（V-RHY-006 每 2-3s 一次视觉变化的校验数据源）
const BEATS_PER_PROGRAM: Record<string, number> = {
  s01: 6,
  s02: 7,
  s03: 5,
  s04: 6,
  s05: 7,
  s06: 6,
  s07: 6,
  s08: 5,
};

async function readTemplate(file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(file, 'utf8');
}

interface TplCtx {
  shot: Shot;
  project: Project;
  tokens: DesignTokens;
  sceneId: string;
}

function renderTemplate(tpl: string, ctx: TplCtx): string {
  const { shot, project, tokens } = ctx;
  const vars: Record<string, string> = {
    '{{SCENE_ID}}': ctx.sceneId,
    '{{TITLE}}': escapeHtml(project.meta.title),
    // 导演提示词是给美术的指令，严禁上屏（V-CP-001：画面不得复述指令/旁白）
    '{{PROMPT}}': '',
    '{{NARRATION_HINT}}': '',
    '{{PRIMARY}}': tokens.primary,
    '{{ACCENT}}': tokens.accent,
    '{{NEUTRAL_0}}': tokens.neutral[0] ?? '#111111',
    '{{NEUTRAL_1}}': tokens.neutral[1] ?? '#333333',
    '{{NEUTRAL_2}}': tokens.neutral[2] ?? '#777777',
    '{{NEUTRAL_3}}': tokens.neutral[3] ?? '#bbbbbb',
    '{{NEUTRAL_4}}': tokens.neutral[4] ?? '#f5f5f5',
    '{{FONT}}': tokens.fontFamily,
    '{{TITLE_SIZE}}': String(tokens.titleSize),
    '{{BODY_SIZE}}': String(tokens.bodySize),
    '{{EASING}}': tokens.easing,
    '{{DURATION}}': String(tokens.durationMs),
    '{{STAGGER}}': String(tokens.staggerMs),
    '{{SPRING_STIFFNESS}}': String(tokens.springStiffness),
    '{{SPRING_DAMPING}}': String(tokens.springDamping),
    '{{ZOOM}}': shot.zoom,
    // V-CAM-006：静态画面必须过相机运动——'none' 落地为 Ken Burns 缓推
    '{{CAMERA}}': shot.camera === 'none' ? 'push-in' : shot.camera,
    '{{GRAIN}}': String(tokens.grain),
    '{{VIGNETTE}}': String(tokens.vignette),
    '{{LETTERBOX}}': tokens.letterbox ? 'block' : 'none',
    '{{DOF}}': String(tokens.dof),
    '{{BLOOM}}': String(tokens.bloom),
    '{{MAX_ELEMENTS}}': String(tokens.maxElements),
  };
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(k).join(v),
    tpl,
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function validateSceneFileFor(project: Project, shot: Shot, html: string): V.Issue[] {
  return V.validateSceneFile(html, { narration: shot.narration });
}
