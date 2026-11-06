import path from 'node:path';
import type { Project, Shot, StylePack } from '../core/schema.js';
import { V } from '../core/index.js';
import { allocateAccentShots, accentAllowedFor } from './accent-budget.js';
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
  const budget = allocateAccentShots(project);
  const accentAllowed = budget.allowed.has(shot.id);
  // V-STE-003 任务幂等 + docs/12「人可精修」：场景文件已存在（上轮产物或 agent/人工精修版）
  // 则不再覆盖——校验通过直接沿用；违规则带反馈报错（failReason 即给 agent 的修改意见）
  if (exists(out)) {
    let existing = await readTemplate(out);
    // 存量项目同样要过规范化：重音预算（V-MOT-013）是后来才有的判据，
    // 旧场景文件按旧提示词生成，超标是必然。就地降级后写回，
    // 让「已有精修版」与「新生成」收敛到同一条规则（幂等：合规文件不改动）。
    const fixed = normalizeSceneHtml(existing, { accentAllowed });
    if (fixed !== existing) {
      await atomicWriteText(out, fixed);
      existing = fixed;
    }
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
    if (generated.ok) {
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
      // 走到这里说明「生成成功但终审又不过」——与内部重试的判据不同，必须留痕
      await logSceneOrigin(store, project, shot.id, 'forge', `终审打回：${V.formatIssues(issues)}`);
    } else {
      // v1.1.2：回退必须可见。旧实现静默 forge 兜底，30 镜只有 8 镜是 LLM 画的，
      // 而所有日志、所有校验、所有审计全绿——「整片降级成拼字板」在流水线上看不见。
      await logSceneOrigin(store, project, shot.id, 'forge', generated.reason);
    }
  } else {
    await logSceneOrigin(store, project, shot.id, 'forge', '未接 LLM（template 模式）');
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
  // 重音预算（V-MOT-013）：按镜序号确定性地挑约 1/3 的镜头带标点。
  // 为什么在 forge 里分而不是在模板里随手砸：标点是全片资源，单镜看不见全片。
  // 为什么用镜序号的哈希而不是「每 3 镜一次」：固定节拍就是节拍器，
  // 打散后观众感觉不到规律，但总量仍受预算约束。
  const accentOn = accentBudget(project, shot.id);
  const html = renderTemplate(await readTemplate(templateFile), {
    shot,
    project,
    tokens,
    sceneId: shot.id,
  })
    .replace('{{SCENE_PROGRAM}}', isCanvas ? templateName.slice('canvas:'.length) : '')
    .replace('{{KICKER}}', isCanvas ? escapeHtml(String(shot.visual.params?.['kicker'] ?? '')) : '')
    .replace('{{BEATS}}', isCanvas ? String(BEATS_PER_PROGRAM[templateName.slice('canvas:'.length)] ?? 6) : '')
    .replace('{{ACCENT_FLAG}}', accentOn ? '1' : '0')
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
  opts: { enforceActionSheet?: boolean } = {},
): V.Issue[] {
  const issues = V.validateSceneFile(html, {
    narration: shot.narration,
    title: project.meta.title,
    dimension,
  });
  if (templateName === 'chart') {
    issues.push(...V.validateChartScene(html));
  }
  // P8-T5：动作谱变约束——只在 LLM 施工路径强制。理由：LLM 的 payload 里带了动作谱，
  // 「写了 requiredPrimitives 却不调用」是施工缺陷；而 forge 路径的画面来自模板文件，
  // 模板选型（TEMPLATE_CUES）与语法选型（pickGrammar）是两条链，模板自带编舞已由
  // V-MOT-021 等把关，拿语法表硬套模板会把正常流水线整片打回。
  // 既有精修文件（existed 分支）同此豁免——老项目不因 P8 升级而无法续跑。
  if (opts.enforceActionSheet && shot.visual.kind === 'code-scene') {
    const sheet = shot.visual.params['actionSheet'] as { requiredPrimitives?: string[] } | undefined;
    for (const prim of sheet?.requiredPrimitives ?? []) {
      if (!html.includes(prim)) {
        issues.push(
          V.err(
            'V-MOT-023',
            `场景缺少语法要求的原语 ${prim}（动作谱 requiredPrimitives）：动作谱写了就要做到，否则选型是空话`,
          ),
        );
      }
    }
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
): Promise<{ ok: true; html: string; template: string } | { ok: false; reason: string }> {
  const tokens = tokensFromPack(pack);
  const seg = project.script?.segments.find((x) => x.id === shot.segmentId);
  const accentBudget = allocateAccentShots(project);
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
    // P8-T5：动作谱交给场景画师——语法选型在分镜期已定，LLM 照动作谱施工，
    // 校验器按 requiredPrimitives 验收（写了 requiredPrimitives 却不调用会被打回）
    actionSheet: shot.visual.params['actionSheet'],
    // V-MOT-013 是全片预算，但场景画师逐镜独立生成、看不到别人的 HTML。
    // 不告诉它「这一镜有没有资格用重音」，它只能凭直觉往每镜塞 slam（实测 50%）。
    // 预算由 allocateAccentShots 确定性算出（纯函数，不依赖生成顺序），这里只传结论。
    accentAllowed: accentBudget.allowed.has(shot.id),
    accentCap: accentBudget.cap,
    shotCount: accentBudget.totalShots,
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
  let lastIssues: V.Issue[] = [];
  for (let attempt = 0; attempt <= SCENE_LLM_RETRIES; attempt += 1) {
    let res: { html?: string; note?: string };
    try {
      res = (await llm.generate({ kind: 'scene', payload: { ...base, feedback } })) as {
        html?: string;
        note?: string;
      };
    } catch (e) {
      // 生成抛错（超时/接口 5xx/JSON 坏）同样算回退原因，不能和「引擎无能力」混为一谈
      return { ok: false, reason: `LLM 调用失败（第 ${attempt + 1} 次）：${(e as Error).message}` };
    }
    const html = res?.html ?? '';
    if (!html) {
      return { ok: false, reason: `引擎未返回 html（${res?.note ?? 'template 模式无 scene 能力'}）` };
    }
    // 先做机械可修项的规范化，再校验。
    //
    // 为什么不是「不合格就重画」：V-COMP-001（主语唯一）、V-SCENE-005（画面复述旁白）
    // 这类判据的失败原因是**标记与措辞**，不是画面构思错了。模型一镜要 60-70s，
    // 为「少写一个 class」重画整镜，等于把 30 镜的成片时间从 12 分钟拉到 40 分钟，
    // 而且重画后可能又踩另一条——v1.1.2 实测：s01 因主语 0 个连打回 3 次，
    // 而 s02 同一提示词下自己带了 subject。这是采样随机性，不是能力问题。
    // 因此把「能确定性修好的」就地修好，只把真正需要重新构思的问题留给重试。
    const normalized = normalizeSceneHtml(html, { accentAllowed: base.accentAllowed });
    const issues = validateSceneHtml(normalized, shot, project, base.template, pack.visuals?.dimension, {
      enforceActionSheet: true, // LLM 拿着动作谱施工 → 按谱验收（V-MOT-023）
    });
    if (!V.hasError(issues)) return { ok: true, html: normalized, template: base.template };
    lastIssues = issues;
    feedback = `上一版被校验器打回，逐条修复后重出完整 HTML：\n${V.formatIssues(issues)}`;
  }
  // 重试耗尽 → forge 兜底（流水线不因 LLM 质量阻塞），但把最后一批意见带出去留痕
  return {
    ok: false,
    reason: `重试 ${SCENE_LLM_RETRIES + 1} 次仍被打回：\n${V.formatIssues(lastIssues)}`,
  };
}

/**
 * 场景 HTML 规范化：只做**确定性可修**的修补，不改变画面构思。
 *
 * 当前处理两类：
 *  1. V-COMP-001 主语数量 ≠ 1
 *     - 0 个：模型把主角当普通 div 写了。取 .stage 下第一个有内容的非装饰元素补上 subject 类。
 *     - >1 个：模型给多个元素都打了主语标记。只保留第一个，其余降级为 deco。
 *  2. 把模型常见的 `<div class='...'>` 单引号写法统一（校验正则只认双引号），
 *     否则「明明写了 subject 却被判 0 个」。
 */
export function normalizeSceneHtml(html: string, opts: { accentAllowed?: boolean } = {}): string {
  let out = html;
  // 单引号 class → 双引号（只动 class 属性，避免误伤 JS 字符串）
  out = out.replace(/class='([^']*)'/g, 'class="$1"');

  // 重音预算（V-MOT-013）就地降级：本镜没有预算却写了 slam/punch/whip。
  // 这三者与 MV.enter 签名相同（sel, opts），降级后元素照样出现、动作照样发生，
  // 只是不再是一次「重音标点」——画面结构不变，不占全片预算。
  // 这就是「机械可修」的判据：改动是确定性的、不涉及重新构思画面。
  if (opts.accentAllowed === false) {
    out = out.replace(/\bMV\.(slam|punch|whip)\s*\(/g, 'MV.enter(');
  }

  const subjectRe = /class="[^"]*\b(subject|title|hero)\b[^"]*"/g;
  const found = out.match(subjectRe) ?? [];
  if (found.length === 1) return out;

  if (found.length === 0) {
    // 补主语：在 .stage 内找第一个「有文字内容」的元素；找不到文字就取第一个非装饰 div
    const stageIdx = out.indexOf('class="stage"');
    const from = stageIdx >= 0 ? stageIdx : 0;
    const head = out.slice(0, from);
    const body = out.slice(from);
    const decoRe = /\b(bg|deco|grain|vignette|letterbox|spotlight|shade|texture|halo|aura|glow)\b/;
    let patched = false;
    // 优先：带文字的元素（含中文/字母数字）
    const textEl = /<([a-z][a-z0-9]*)\s+class="([^"]*)"([^>]*)>([^<]{1,200})<\/\1>/i;
    const m = textEl.exec(body);
    if (m && !decoRe.test(m[2]!)) {
      const replaced = `<${m[1]} class="${m[2]} subject"${m[3]}>${m[4]}</${m[1]}>`;
      out = head + body.replace(m[0], replaced);
      patched = true;
    }
    if (!patched) {
      // 退而求其次：第一个不带装饰类名的 div
      const divRe = /<div\s+class="([^"]*)"([^>]*)>/g;
      let d: RegExpExecArray | null;
      while ((d = divRe.exec(body))) {
        if (decoRe.test(d[1]!) || /\bstage\b/.test(d[1]!)) continue;
        const replaced = `<div class="${d[1]} subject"${d[2]}>`;
        out = head + body.replace(d[0], replaced);
        patched = true;
        break;
      }
    }
    if (!patched) return html; // 实在找不到（canvas 程序镜等）→ 原样交给校验器判
    return out;
  }

  // >1 个主语：保留第一个，其余降级为 deco（同屏只能有一个最大对比元素）
  let seen = 0;
  out = out.replace(subjectRe, (full, word: string) => {
    seen += 1;
    if (seen === 1) return full;
    return full.replace(new RegExp(`\\b${word}\\b`), 'deco');
  });
  return out;
}

/** 场景来源留痕（logs/scene-origin.log）：llm/forge 各占多少，是「整片是否降级」的唯一证据 */
async function logSceneOrigin(
  store: ProjectStore,
  project: Project,
  shotId: string,
  origin: 'llm' | 'forge',
  reason: string,
): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(store.projectDir(project.meta.id), 'logs'), { recursive: true });
  await fs.appendFile(
    path.join(store.projectDir(project.meta.id), 'logs', 'scene-origin.log'),
    `[${origin}] ${shotId}: ${reason.replace(/\n/g, ' | ')}\n`,
  );
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

/**
 * 重音预算分配（V-MOT-013）：全片约 1/3 的镜头带标点（slam/punch/whip）。
 *
 * 唯一事实源已迁到 accent-budget.ts（LLM 场景与 forge 模板共用同一份分配），
 * 这里保留薄封装以兼容既有调用点。
 */
export function accentBudget(project: Project, shotId: string): boolean {
  return accentAllowedFor(project, shotId);
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
