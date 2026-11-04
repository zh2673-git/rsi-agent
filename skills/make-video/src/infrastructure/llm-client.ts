import { mvError, ERR } from '../core/errors.js';
import { LLM_RETRY_MAX } from '../core/constants.js';
import { pickCanvasProgram, bestTemplate, pickTemplateBySemantics } from '../domain/scene-semantics.js';

export type LlmTaskKind =
  | 'script'
  | 'director-notes'
  | 'storyboard'
  | 'scene'
  | 'style-analyze'
  | 'material-plan';

export interface LlmTask {
  kind: LlmTaskKind;
  payload: Record<string, unknown>;
}

export interface LlmClient {
  readonly name: string;
  generate(task: LlmTask): Promise<unknown>;
}

export class ApiLlmClient implements LlmClient {
  readonly name = 'api';

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      model: string;
    },
  ) {}

  async generate(task: LlmTask): Promise<unknown> {
    const prompt = buildPrompt(task);
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: prompt,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    try {
      return JSON.parse(content);
    } catch {
      throw mvError(ERR.LLM_SCHEMA, 'LLM 返回非 JSON');
    }
  }
}

function buildPrompt(task: LlmTask): Array<{ role: string; content: string }> {
  const sys =
    task.kind === 'scene'
      ? SCENE_SYSTEM_PROMPT
      : task.kind === 'storyboard'
        ? STORYBOARD_SYSTEM_PROMPT
        : task.kind === 'material-plan'
          ? MATERIAL_PLAN_SYSTEM_PROMPT
          : `你是视频编译器的${task.kind}部门引擎。只输出合法 JSON，遵守给定 schema。`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: JSON.stringify(task.payload) },
  ];
}

/** 场景生成系统提示词（docs/04 美术摄影部）：按剧本语义拍，不吃大锅饭 */
const SCENE_SYSTEM_PROMPT = `你是视频编译器的美术摄影部场景画师。根据给定镜头的旁白语义与导演视觉意图，生成一个 HyperFrames 单场景 HTML。只输出合法 JSON：{"html": "<!doctype html>..."}。

硬性契约（校验器逐条把关，违反即打回）：
1. 完整骨架：<body data-scene-id="给定的sceneId"> 内有 .stage 容器；末尾 <script src="../motion/motion-lib.js"></script> 与一个 document.addEventListener('DOMContentLoaded', ...) 注册动画。
2. 画面必须表达本镜旁白的具体含义（人/物/数字/因果/过程），禁止通用装饰凑数，禁止出现旁白原文或导演指令文本。
3. 动画只用给定白名单原语 MV.enter/idle/to/from/fromTo/emphasis/performance/camera，缓动只用给定的 easing，时长只允许 200-400/400-800/300-600/1200-2000ms。
4. 主语唯一（.subject 或 .title 等恰好 1 个），辅助元素 opacity ≤ 0.7，同屏运动元素 ≤ 3、位移方向 ≤ 2。
5. 禁止属性 data-start/data-duration/data-track-index（时序只归剪辑部）；禁止 repeat:-1；位移不得 ease:'none' 急停。
6. 颜色只用给定 token（{{PRIMARY}} 等替换后的真实值），字体只用给定 fontFamily，字号用给定 px。
7. 若给了相机与景别，用 MV.camera('.stage', { move, zoom }) 表达；静态画面必须有相机运动。
8. 素材语言（payload.styleVisual）必须遵守：dimension=css3d 时至少用一个 3D 原语（MV.tilt3d/orbit/depth/card3d/spin3d），并给容器 perspective 与 transform-style:preserve-3d；dimension=2d 时禁止任何 3D 属性（perspective/rotate3d/translateZ）。motifs 是这一派允许的母题，texture 是允许的纹理层，styleVisual.note 是素材语言的一句话定义——场景必须长成这一派的样子，不能只换配色。`;

/** 分镜系统提示词（docs/04 导演部 A5）：动机是「为什么切」，不是「这镜拍什么」 */
const STORYBOARD_SYSTEM_PROMPT = `你是视频编译器的导演部（导演+分镜师）。根据讲稿段落与导演批注输出分镜数组。只输出合法 JSON 数组，每个元素是一镜。

每镜字段：
- segmentId / narration（必须原样使用该段旁白）/ visual（kind、prompt、template、params）
- zoom：ELS|LS|MS|CU|ECU；camera：push-in|pull-out|pan|pan-left|tilt-up|tilt-down|static。
  **static 是合法选择**（定格 + 镜内表演，喜剧常用），不是漏填；但全片静止镜别超过 40%，
  运镜也别每镜同一式——镜头长短决定行程：短促节拍镜别给长推轨。
- motivation：**切点动机**——只写「为什么从上一镜切到这一镜」，必须能归入下列之一：match-cut（同形接续）/ 动作接动作 / 视线接视线 / 情绪转场 / 节拍打点 / 景别跳。禁止写「静态呈现」「定场揭示」这类镜头内容描述；想不出理由就留空。
- transition：留空或 "auto"，让剪辑部按动机裁决；只有确实需要时才显式写 hard-cut/dissolve/smash-cut/wipe/whip-pan/slide。
- enterAnchor / exitAnchor：形状锚点 id（如 "circle""desk"）。相邻两镜 exitAnchor==enterAnchor 时剪辑部会自动判 match-cut 硬切。
- coverage：长镜（旁白 >4s）内的换机位点，**可选、默认不派生**，最多 3 条：{at:0-1, kind:"punch-in"|"reframe", scale:0.8-1.6, xPercent:-12~12, yPercent:-12~12, rotation:-3~3, motivation:"emphasis"}。只有你确实想在这个词上换机位时才写；不写就一镜到底。

节奏纪律：景别要有序列（ELS→LS→MS→CU→ECU 递进或跳切），相邻镜不要同景别同机位同转场；每 2-3 秒给一次视觉变化（可以是主体表演/图形动效，不必都靠机位）。

素材纪律：templates 是**风格筛过的候选池**（payload.styleVisual 说明这一派的素材语言：维度/母题/偏好/禁用），visual.template 只能从池中选；池里有 3D 形态（iso-stage/depth-layers）时，需要纵深/结构的镜头优先用它们，别全片退回平面排版。visual.params 可带 depth（0-1 纵深强度）等风格参数。`;

/**
 * 素材需求单系统提示词（P5-B）：只做「这一镜需要什么样的真实素材」，不负责找、不负责画。
 * 检索由 agent 在引擎外完成，引擎只收需求单 + 入库校验 + 绑定。
 */
const MATERIAL_PLAN_SYSTEM_PROMPT = `你是视频编译器的素材统筹。根据逐镜旁白，判断哪些镜头需要**真实素材**（照片/视频）而不是代码绘制，并为需要的镜头写检索需求单。只输出合法 JSON：{"briefs":[...]}。

判断纪律（顺序执行）：
1. 先问「这一镜能不能靠代码画准」。抽象概念、数据、流程、对比、纯排版、chart 类 → need="none"，绝不要真实素材。
2. 只有旁白在指认**具体的现实对象**（真实人物/名址/特定器物/真实场景/历史影像）时，才 need≠none。泛指概念（"人们""城市""生活"）一律 none。
3. need 取值：person（真实人物肖像/半身）、place（真实地点/建筑/街景）、object（特定实物）、background（真实环境氛围底图）、none。
4. type：需要「动作/时间流逝/过程」→ video；静态对象/肖像/地点 → image。拿不准就 image（成本低、可控）。
5. query：**给检索工具用的关键词**，中英各写一份，用 " | " 分隔，例如 "苏州平江路 清晨 | Suzhou Pingjiang Road morning"。禁止写句子，禁止写镜头语言（不要 "特写""慢推"）。
6. mustHave：必须出现在画面里的可见要素（最多 4 个，名词）。avoid：不能出现的要素（水印、人物正脸、文字招牌等，按内容判断）。
7. reason：一句话说明「为什么这一镜非真实素材不可」，写不出具体理由就改 none。

输出 schema（每个镜头一条，顺序同输入）：
{"briefs":[{"shotId":"s01","need":"place","type":"image","query":"...","mustHave":["..."],"avoid":["..."],"reason":"..."}]}`;

export interface LlmRetryClient extends LlmClient {
  readonly inner: LlmClient;
}

export class RetryingLlmClient implements LlmClient {
  readonly name: string;

  constructor(readonly inner: LlmClient) {
    this.name = `retry(${inner.name})`;
  }

  async generate(task: LlmTask): Promise<unknown> {
    let lastErr: unknown = null;
    for (let i = 1; i <= LLM_RETRY_MAX; i += 1) {
      try {
        return await this.inner.generate(task);
      } catch (e) {
        lastErr = e;
      }
    }
    throw mvError(
      ERR.LLM_RETRY_EXCEEDED,
      `LLM 任务 ${task.kind} 重试 ${LLM_RETRY_MAX} 次仍失败: ${(lastErr as Error).message}`,
    );
  }
}

export function createLlmClientFromEnv(): LlmClient {
  const baseUrl = process.env['LLM_BASE_URL'];
  const apiKey = process.env['LLM_API_KEY'];
  const model = process.env['LLM_MODEL'] ?? 'gpt-4o-mini';
  if (baseUrl && apiKey) {
    return new RetryingLlmClient(new ApiLlmClient({ baseUrl, apiKey, model }));
  }
  return new RetryingLlmClient(new TemplateLlmClient());
}

export class TemplateLlmClient implements LlmClient {
  readonly name = 'template';

  async generate(task: LlmTask): Promise<unknown> {
    switch (task.kind) {
      case 'script':
        return templateScript(task.payload);
      case 'director-notes':
        return templateDirectorNotes(task.payload);
      case 'storyboard':
        return templateStoryboard(task.payload);
      case 'scene':
        return { html: '', note: 'template-mode: 由 scene-forge 本地模板生成' };
      case 'style-analyze':
        return templateStyleAnalyze(task.payload);
      case 'material-plan':
        return templateMaterialPlan(task.payload);
      default:
        throw mvError(ERR.LLM_SCHEMA, `template 引擎不支持的任务: ${task.kind}`);
    }
  }
}

interface ScriptPayload {
  topic: string;
  beats: Array<{ id: string; name: string; function?: string; note?: string }>;
  wordsPerMin: number;
  targetSegments: number;
}

function templateScript(payload: Record<string, unknown>): unknown {
  const p = payload as unknown as ScriptPayload;
  const beats = p.beats?.length ? p.beats : [{ id: 'b1', name: '展开', function: 'inform' }];
  const target = Math.max(beats.length, p.targetSegments ?? beats.length);
  // 密度优先（V-RHY-003）：目标段数多于 beats 时循环填充，beat 覆盖率仍由前几段保证
  const segments = Array.from({ length: target }, (_, i) => {
    const b = beats[i % beats.length]!;
    return {
      id: `seg-${i + 1}`,
      text: templateSegmentText(p.topic, i),
      function: (b.function ?? 'inform') as string,
      beat: b.id,
      mood: (['curious', 'neutral', 'tense', 'awe'] as const)[i % 4],
    };
  });
  const fullText = segments.map((s) => s.text).join('');
  return { fullText, segments };
}

function templateSegmentText(topic: string, i: number): string {
  const templates = [
    `${topic}，远比表面看起来更有意思。`,
    `先从一个基本事实说起：它的核心机制可以拆成几步。`,
    `最反直觉的一点来了：关键变量常常被忽略。`,
    `把镜头拉近，细节开始显形。`,
    `再退一步看，结构就完整了。`,
    `这里有一个容易被带过的转折。`,
    `把上面连起来，脉络浮出水面。`,
    `回到最初的问题，答案已经在眼前。`,
  ];
  return templates[i % templates.length]!;
}

interface NotesPayload {
  segments: Array<{ id: string; text: string; beat?: string }>;
  recipeNotes: Array<{ beatId: string; visualIntent: string; emotionGoal: string; counterpoint: string }>;
}

function templateDirectorNotes(payload: Record<string, unknown>): unknown {
  const p = payload as unknown as NotesPayload;
  const byBeat = new Map(p.recipeNotes.map((n) => [n.beatId, n]));
  return p.segments.map((s, i) => {
    const tpl = s.beat ? byBeat.get(s.beat) : undefined;
    return {
      segmentId: s.id,
      visualIntent: tpl?.visualIntent ?? `为第 ${i + 1} 段配图：与「${s.text.slice(0, 12)}…」构成对位`,
      emotionGoal: tpl?.emotionGoal ?? '稳定推进',
      referenceMood: tpl?.visualIntent?.slice(0, 20) ?? '',
      counterpoint: tpl?.counterpoint ?? (i === 0 ? 'emotion' : 'metaphor'),
    };
  });
}

interface StoryboardPayload {
  segments: Array<{ id: string; text: string; beat?: string }>;
  directorNotes: Array<{ segmentId: string; visualIntent: string; counterpoint: string }>;
  templates: string[];
  styleVisual?: { dimension?: string; sceneBias?: string[]; sceneDeny?: string[]; motifs?: string[] };
  shotScaleBias: string[];
  materialDecisions: Array<{ segmentId: string; kind: string; source?: string; reason: string }>;
}

function templateStoryboard(payload: Record<string, unknown>): unknown {
  const p = payload as unknown as StoryboardPayload;
  const bias = p.styleVisual?.sceneBias ?? [];
  // 风格禁用的形态即使混进候选池也不选
  const deny = new Set(p.styleVisual?.sceneDeny ?? []);
  const templates = p.templates.filter((t) => !deny.has(t));
  const noteBy = new Map(p.directorNotes.map((n) => [n.segmentId, n]));
  const decBy = new Map(p.materialDecisions.map((d) => [d.segmentId, d]));
  const zooms = p.shotScaleBias.length ? p.shotScaleBias : ['MS', 'CU'];
  // 模板按旁白语义分配（禁止索引轮转——"凑镜头数"的根源）：
  // canvas 程序按内容主题选（s01 引力钩子…s08 终幕），MV 模板按叙事形式选（流程/对比/数据/氛围）
  const canvasPrograms = templates
    .filter((t) => t.startsWith('canvas:'))
    .map((t) => t.slice('canvas:'.length));
  const mvTemplates = templates.filter((t) => !t.startsWith('canvas:'));
  const recentUsed: string[] = [];
  // P2：离线分镜也要给出「为什么切」——动机由景别关系/内容线索反推，机位按叙事轮换
  const CAMERA_CYCLE = ['push-in', 'pan', 'push-in', 'pull-out', 'tilt-up', 'pan-left'];
  let prevZoom = '';
  return p.segments.map((seg, i) => {
    const note = noteBy.get(seg.id);
    const dec = decBy.get(seg.id);
    let template: string;
    if (canvasPrograms.length > 0) {
      // 混合评分：强语义 MV 形式（数据/对比 ≥2 线索命中）压过程序化背景，
      // 让数字段出真图表、对比段出真对峙卡——异质画面形式打破"暗场小元素"的同质感
      const mv = mvTemplates.length > 0 ? bestTemplate(seg.text, mvTemplates, bias) : null;
      if (mv && mv.score >= 2) {
        template = mv.template;
      } else {
        const pick = pickCanvasProgram(seg.text, canvasPrograms, recentUsed);
        recentUsed.push(pick.program);
        template = `canvas:${pick.program}`;
      }
    } else {
      template = pickTemplateBySemantics(seg.text, mvTemplates.length ? mvTemplates : ['typography'], bias);
    }
    const zoom = zooms[i % zooms.length] ?? 'MS';
    const motivation =
      i === 0 ? '' : relationReason(prevZoom, zoom, note?.counterpoint ?? 'metaphor', seg.text);
    prevZoom = zoom;
    return {
      segmentId: seg.id,
      narration: seg.text,
      visual: {
        kind: dec?.kind ?? 'code-scene',
        prompt: note?.visualIntent ?? `示意图：${seg.text.slice(0, 16)}`,
        template,
        params: { scene: `scene-${i + 1}`, side: 'center' },
        ...(dec?.source ? { source: dec.source } : {}),
      },
      zoom,
      camera: CAMERA_CYCLE[i % CAMERA_CYCLE.length] ?? 'push-in',
      motivation,
      counterpoint: note?.counterpoint ?? 'metaphor',
      // 转场留空 = auto，由剪辑部按动机裁决（P2：转场不再是索引轮转的装饰）
      transition: '',
    };
  });
}

const ZOOM_RANK: Record<string, number> = { ELS: 0, LS: 1, MS: 2, CU: 3, ECU: 4 };

/** 离线分镜的切点动机：先看客观景别关系，再看内容线索，判不出就留空（不编理由） */
function relationReason(prevZoom: string, zoom: string, counterpoint: string, text: string): string {
  const gap = Math.abs((ZOOM_RANK[prevZoom] ?? 2) - (ZOOM_RANK[zoom] ?? 2));
  if (gap >= 2) return `景别跳：${prevZoom}→${zoom}，换尺度换信息`;
  if (/(冲|甩|撞|砸|掀|推倒|跑|追|爆|抢)/.test(text)) return '动作接动作，气口不断';
  if (counterpoint === 'parody') return '接节拍：笑点落镜';
  if (/(沉默|安静|回忆|忽然|那一刻|原来|停顿|缓缓)/.test(text)) return '情绪转场，慢下来';
  return '';
}

interface StyleAnalyzePayload {
  description: string;
}

function templateStyleAnalyze(payload: Record<string, unknown>): unknown {
  const p = payload as unknown as StyleAnalyzePayload;
  const d = p.description;
  const pick = (words: string[], fallback: string): string =>
    words.find((w) => d.includes(w)) ?? fallback;
  return {
    anatomy: {
      script: pick(['三翻四抖', '包袱', '幽默'], '常规叙事结构'),
      directing: pick(['戏仿', '反差', '荒诞'], '常规对位'),
      art: pick(['霓虹', '鲜艳', '暗调', '黑白'], '中性色板'),
      camera: pick(['仰拍', '低角度', '慢动作', '推镜'], '静态为主'),
      performance: pick(['夸张', '定格', '表情'], '常规动效'),
      sourcing: '按内容类型决策',
      sound: pick(['急停', '音效', '怀旧'], '常规三层声音'),
      editing: pick(['卡点', '硬切', '快节奏'], '常规节奏'),
    },
    suggestedBase: d.includes('暗') || d.includes('黑') ? 'noir-contrast' : 'keynote-minimal',
  };
}

interface MaterialPlanPayload {
  topic?: string;
  genre?: string;
  segments?: Array<{
    shotId: string;
    segmentId: string;
    narration: string;
    emphasis?: string[];
    zoom?: string;
  }>;
}

const CONCRETE_PERSON = /(先生|老师|校长|医生|老人|孩子|母亲|父亲|工程师|运动员|作家|画家|歌手|演员|记者|工人|农民)/;
const CONCRETE_PLACE = /(街|路|桥|河|湖|山|城|镇|村|楼|塔|寺|园|站|港|遗址|故居|博物馆|学校|医院|老宅)/;
const CONCRETE_OBJECT = /(书|信|钟|笔|机器|相机|茶|碗|伞|车|船|琴|照片|手稿|标本|旗帜|印章)/;
const MOTION_CUE = /(走过|穿过|奔跑|流动|生长|翻页|转动|下雪|下雨|日落|清晨|夜晚|排队|挥手)/;

/**
 * 离线素材需求单（template 引擎）：宁可少要，也不要乱要。
 * 没有明确的现实指称物一律 none——默认走代码绘制，符合「用户没说找素材就全画」的纪律。
 */
function templateMaterialPlan(payload: Record<string, unknown>): unknown {
  const p = payload as unknown as MaterialPlanPayload;
  const briefs = (p.segments ?? []).map((s) => {
    const t = s.narration ?? '';
    let need: 'person' | 'place' | 'object' | 'background' | 'none' = 'none';
    if (CONCRETE_PERSON.test(t)) need = 'person';
    else if (CONCRETE_PLACE.test(t)) need = 'place';
    else if (CONCRETE_OBJECT.test(t)) need = 'object';
    const emphasis = s.emphasis ?? [];
    const mustHave = need === 'none' ? [] : [...new Set([...emphasis.filter((w) => w.length >= 2), ...t.match(/[\u4e00-\u9fa5]{2,6}/g)?.slice(0, 2) ?? []])].slice(0, 4);
    const query =
      need === 'none'
        ? ''
        : [...new Set([...emphasis, ...mustHave])].slice(0, 3).join(' ') || t.slice(0, 12);
    return {
      shotId: s.shotId,
      segmentId: s.segmentId,
      narration: t,
      need,
      query,
      type: need !== 'none' && MOTION_CUE.test(t) ? 'video' : 'image',
      mustHave,
      avoid: ['logo', 'watermark', 'text'],
      reason:
        need === 'none'
          ? '抽象/论述段，代码绘制更准'
          : `旁白指认了具体${need === 'person' ? '人物' : need === 'place' ? '地点' : '实物'}，需要真实影像`,
    };
  });
  return { briefs };
}
