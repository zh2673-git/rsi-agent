/**
 * 模板契约层（L4 模板的「参数契约 + 语法归属 + 母题 + 机位 + 容量」）。
 *
 * 为什么要这一层（2026-11-16，P12 阶段1）：
 *
 * 本项目此前只有「模板 HTML」这一个事实源，没有「模板声明了什么」的契约层。
 * 后果不是文档不好看，而是**三个真实的静默失效**：
 *
 *   ① 模板里写了 {{HERO_WORD}} 这类占位符，但渲染期根本没人填它 →
 *      画面上出现字面量 `{{HERO_WORD}}`，且 `<script>` 里的 `{{FIGURE_TO}}`
 *      是**非法的 JS 语法**（对象字面量缺键名），整个 script 块抛异常 →
 *      **该镜所有动画都不发生**。实测 15 个模板有 6 个中招（kinetic-type /
 *      compare-stage / deep-stage / hierarchy-stack / paper-stage / process-track）。
 *
 *   ② 模板传了 `zoom:` 给 MV.camera，但 motion-lib 只读 `hold` → 景别死参数。
 *   ③ 模板传了 `stiffness/damping` 给 MV.performance，但原语硬编码缓动 → 风格包
 *      的 `motion.spring` 全网无效。
 *
 * ①②③ 是同一类病：**声明了但没人兑现**。本模块把「模板声明什么」变成**可机检的契约**：
 *
 *   - `params`：每个占位符的类型/默认值/枚举/范围。渲染前校验，非法值直接报错。
 *   - `grammar`：该模板实现了哪些语法（反查「哪个语法没有模板可落」）。
 *   - `motifs`：该模板用的母题 kind（与风格包 `visuals.motifs` 对账）。
 *   - `camera`：该模板的机位语汇（与 `CAMERA_MOVES` 对账）。
 *   - `capacity`：容量上限（超限明确失败，不静默缩字）。
 *   - `materials`：素材槽（语义角色 + 缺素材策略）。
 *   - `variants`：同镜型的不同画法（换预设，不换模板）。
 *
 * 对标：阿杜 motiongit 的 `guide.json` + `params.schema.json`（职责对齐，不搬包结构）。
 * 边界见 PLAN.md §10.7：`.motion` 与本项目架构同构、层次不同，只对齐契约层。
 *
 * 数据归属：`templates/scenes/<kind>.meta.json` 是模板契约的**唯一真源**；
 * 本模块只定义 schema、加载、校验与装配，不复制任何声明。
 */

import path from 'node:path';
import { exists, listFiles, readJson } from '../infrastructure/fs-utils.js';
import { TEMPLATES_DIR } from '../core/constants.js';

// ---------------------------------------------------------------------------
// 参数契约
// ---------------------------------------------------------------------------

/**
 * 参数类型。刻意只有四种——参数表是给人和 LLM 看的，
 * 类型越花哨，越容易「声明了但实现不了」。
 */
export type ParamType = 'string' | 'number' | 'boolean' | 'enum';

export interface ParamSpec {
  /** 参数名（占位符名，不含 {{}}） */
  name: string;
  type: ParamType;
  /** 缺省值；缺省时渲染成空串（字符串）或跳过注入 */
  default?: string | number | boolean;
  /** 枚举值（type='enum' 时必填） */
  enum?: readonly string[];
  /** 数值范围（type='number' 时可选） */
  min?: number;
  max?: number;
  /**
   * 占位符出现在哪个上下文：
   *   - `text`：HTML 文本位置 → 需要 HTML 转义
   *   - `code`：JS/CSS 表达式位置 → 需要原样注入（转义会破坏代码）
   *   - `both`：两种位置都有（极少用，需人工确认）
   *
   * 这个区分是**必须的**：`{{HERO_WORD}}` 在文本里要转义（防 XSS），
   * 而 `duration: {{DURATION}}` 在 JS 里不能转义——把 `600` 转义成 `600` 没问题，
   * 但把 `"a'b"` 转义进 JS 字符串就会炸。所以按位置分，而不是一刀切。
   */
  context: 'text' | 'code' | 'both';
  /** 说明（给 LLM 的施工指引） */
  note?: string;
}

/** 素材槽：语义角色 + 缺素材策略（阿杜 guide.json.materials 的职责） */
export interface MaterialSlot {
  /** 语义角色，如 `image.presenter` / `video.screen` / `text.hero` */
  role: string;
  /** 是否必填 */
  required: boolean;
  /**
   * 缺素材时的确定行为：
   *   - `ask`：采集阶段必须问用户（不能猜）
   *   - `skip`：跳过该槽（画面相应部分不出现）
   *   - `placeholder`：用样例素材占位（必须打 data-film-sample 标记）
   */
  ifMissing: 'ask' | 'skip' | 'placeholder';
  /** 样例素材路径（ifMissing='placeholder' 时必填） */
  sample?: string;
  /** 槽位能容纳的最大字符数（容量上限） */
  maxChars?: number;
}

/** 容量上限：超限明确失败，绝不静默缩字/裁信息/冻结画面凑时长 */
export interface Capacity {
  /** 单个文本槽的最大字符数 */
  maxChars?: number;
  /** 该模板能承载的最多元素数 */
  maxElements?: number;
  /** 最长挂帧（毫秒）；超过说明这一镜撑不住，应拆镜 */
  maxHoldMs?: number;
}

/** 变体：同一镜型的不同画法（阿杜 P3：风格分支只换预设，动效差异升版本） */
export interface VariantSpec {
  id: string;
  name: string;
  /** 该变体覆盖的参数（与默认 params 合并） */
  params?: Record<string, string | number | boolean>;
  /** 一句话说明这版画法差在哪 */
  note?: string;
}

/** 模板契约本体 */
export interface TemplateContract {
  /** 模板 id（= 文件名，不含 .html） */
  id: string;
  /** 中文名（给人看） */
  name: string;
  /** 该模板实现的语法 id 列表（用于「哪个语法没有模板可落」反查） */
  grammar: string[];
  /** 该模板使用的母题 kind（与风格包 visuals.motifs 对账） */
  motifs: string[];
  /** 该模板的机位语汇（与 CAMERA_MOVES 对账） */
  camera: string[];
  /** 参数契约：占位符 → 规格 */
  params: ParamSpec[];
  /** 素材槽 */
  materials: MaterialSlot[];
  /** 容量上限 */
  capacity: Capacity;
  /** 变体 */
  variants: VariantSpec[];
}

export interface ParamIssue {
  param: string;
  problem: string;
  fix: string;
}

/**
 * 校验一个参数值是否符合规格。
 * 返回空数组 = 合法。
 */
export function validateParamValue(spec: ParamSpec, value: unknown): ParamIssue[] {
  const issues: ParamIssue[] = [];
  const fix = `检查模板 ${spec.name} 的参数声明（params/${spec.name}）`;
  if (spec.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      issues.push({ param: spec.name, problem: `期望数字，实得 ${JSON.stringify(value)}`, fix });
      return issues;
    }
    if (spec.min !== undefined && n < spec.min) {
      issues.push({ param: spec.name, problem: `${n} < 最小值 ${spec.min}`, fix });
    }
    if (spec.max !== undefined && n > spec.max) {
      issues.push({ param: spec.name, problem: `${n} > 最大值 ${spec.max}`, fix });
    }
  }
  if (spec.type === 'enum') {
    const allowed = spec.enum ?? [];
    if (!allowed.includes(String(value))) {
      issues.push({
        param: spec.name,
        problem: `「${value}」不在枚举 [${allowed.join('/')}]`,
        fix,
      });
    }
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      issues.push({ param: spec.name, problem: `期望布尔，实得 ${JSON.stringify(value)}`, fix });
    }
  }
  if (spec.type === 'string') {
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
      issues.push({ param: spec.name, problem: `期望字符串，实得 ${typeof value}`, fix });
    }
  }
  return issues;
}

/**
 * 参数契约装配：把「规格」变成「实际要注入的值」。
 *
 * 这里是**参数契约真正生效**的地方：以前占位符的值是散落在
 * `renderTemplate` 的一张大 map 里（谁想加参数就往 map 里塞一行），
 * 现在改成「规格声明 → 本函数解析 → 渲染注入」。
 *
 * `overrides` 来自 project.json 的 `shots[].visual.params`——那是导演的显式覆盖，
 * 优先级最高；越界（非法枚举/超范围）**报错而不是静默夹取**：
 * 静默夹取会让导演写的 `duration: 99999` 变成 800，而画面看起来「正常」，
 * 没人知道有个值被吞了。
 */
export function resolveParams(
  contract: TemplateContract,
  overrides: Record<string, unknown> = {},
): { values: Record<string, string | number | boolean>; issues: ParamIssue[] } {
  const values: Record<string, string | number | boolean> = {};
  const issues: ParamIssue[] = [];
  for (const spec of contract.params) {
    const raw = overrides[spec.name];
    if (raw === undefined || raw === null || raw === '') {
      if (spec.default !== undefined) values[spec.name] = spec.default;
      continue;
    }
    const v = validateParamValue(spec, raw);
    if (v.length > 0) {
      issues.push(...v);
      continue;
    }
    values[spec.name] = raw as string | number | boolean;
  }
  // 契约外的覆盖：允许（导演可能加自定义参数），但记一条提示而不是报错——
  // 模板契约是「下限」不是「上限」，新增模板参数时先改契约更好，但不强制。
  const known = new Set(contract.params.map((p) => p.name));
  const extra = Object.keys(overrides).filter((k) => !known.has(k) && k !== 'actionSheet');
  if (extra.length > 0) {
    // 不报错：params 里还有 kicker/actionSheet/energy 等系统字段，不在契约内是正常的。
    // 真正的死参数问题由「占位符解析器」负责——模板里写了 {{X}} 但契约和注入表都没有 X，
    // 那个才会漏。
    void extra;
  }
  return { values, issues };
}

// ---------------------------------------------------------------------------
// 占位符解析（本阶段最要紧的一件：治「整镜无动画」）
// ---------------------------------------------------------------------------

export interface PlaceholderHit {
  name: string;
  /** 在模板里出现的次数 */
  count: number;
}

/** 扫出模板里所有 {{NAME}} 占位符 */
export function scanPlaceholders(html: string): PlaceholderHit[] {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 判断某个位置的占位符处于「代码上下文」还是「文本上下文」。
 *
 * 判据：看该位置之前最近的 `<script>` / `<style>` 开闭标签。
 *   - 在 `<script>` 内 → JS 代码位置 → **不能转义**（`duration: 600` 转义就坏了）
 *   - 在 `<style>` 内  → CSS 代码位置 → **不能转义**（`font-family: 'YaHei'` 转义就坏了）
 *   - 其余            → HTML 文本位置 → **必须转义**（防 XSS）
 *
 * 为什么要**逐个出现位置**判定而不是「按名字统一判」：
 * 同一个占位符可能同时出现在代码与文本里——`{{SCENE_ID}}` 既是 HTML 属性
 * `data-scene-id="{{SCENE_ID}}"`，又是 JS 里的 `MV.use('scene-{{SCENE_ID}}')`。
 * 按名字统一判会让其中一个位置拿到错误的转义策略。
 */
export function contextAt(html: string, index: number): 'text' | 'code' {
  const before = html.slice(0, index);
  const lastScript = before.lastIndexOf('<script');
  const lastScriptEnd = before.lastIndexOf('</script>');
  const lastStyle = before.lastIndexOf('<style');
  const lastStyleEnd = before.lastIndexOf('</style>');
  return lastScript > lastScriptEnd || lastStyle > lastStyleEnd ? 'code' : 'text';
}

/**
 * 占位符在模板里的上下文（供契约校验用：声明的 context 与实际位置是否一致）。
 *
 * 与 contextAt 的区别：这里是「这个占位符**有没有**出现在代码位置」，
 * 用于检查契约声明——如果契约说 context='text' 但模板实际把它放在 JS 里，
 * 那就是契约写错了（该声明成 code）。
 */
export function placeholderContext(html: string, name: string): 'text' | 'code' {
  const re = new RegExp(`\\{\\{${name}\\}\\}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (contextAt(html, m.index) === 'code') return 'code';
  }
  return 'text';
}

/**
 * 注入占位符。
 *
 * @param html  模板原文
 * @param values 参数名 → 值（**裸名**，不带 {{}}；值必须是原始值，不要提前转义）
 * @param escapeText 文本位置的转义函数
 *
 * 关键行为：
 *   ① **逐个出现位置**判定上下文并分别转义（见 contextAt 的说明）；
 *   ② **未提供的占位符替换成空串**，而不是留着 `{{X}}`。
 *      留着 `{{X}}` 在 HTML 文本里只是难看，在 `<script>` 里是**语法错误**——
 *      后者会让整镜动画全灭（实测 6/15 模板）。所以这里必须清干净。
 */
export function injectPlaceholders(
  html: string,
  values: Record<string, string | number | boolean>,
  escapeText: (s: string) => string,
): string {
  // 一次性扫出所有占位符位置，倒序替换（避免替换后位置偏移）
  const hits: Array<{ name: string; index: number; length: number }> = [];
  for (const m of html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)) {
    hits.push({ name: m[1]!, index: m.index, length: m[0].length });
  }
  let out = html;
  for (const hit of hits.reverse()) {
    const raw = values[hit.name];
    const text = raw === undefined || raw === null ? '' : String(raw);
    const ctx = contextAt(out, hit.index);
    const replacement = ctx === 'code' ? text : escapeText(text);
    out = out.slice(0, hit.index) + replacement + out.slice(hit.index + hit.length);
  }
  return out;
}

/** 渲染后残留的占位符（应当为空） */
export function leftoverPlaceholders(html: string): string[] {
  return [...new Set([...html.matchAll(/\{\{([A-Z_][A-Z_0-9]*)\}\}/g)].map((m) => m[1]!))].sort();
}

// ---------------------------------------------------------------------------
// 契约加载与登记
// ---------------------------------------------------------------------------

const CONTRACT_SUFFIX = '.meta.json';

function contractPathFor(root: string, templateId: string): string {
  return path.join(root, TEMPLATES_DIR, 'scenes', `${templateId}${CONTRACT_SUFFIX}`);
}

/**
 * 加载全部模板契约。
 * 没有契约文件的模板**不报错**——老模板先跑起来，契约是逐步补齐的。
 * 但 `hasContract=false` 的模板在「契约覆盖率」统计里会被记为缺契约。
 */
export async function loadTemplateContracts(root: string): Promise<Map<string, TemplateContract>> {
  const out = new Map<string, TemplateContract>();
  const scenesDir = path.join(root, TEMPLATES_DIR, 'scenes');
  for (const file of await listFiles(scenesDir)) {
    if (!file.endsWith(CONTRACT_SUFFIX)) continue;
    const raw = await readJson<unknown>(file);
    const contract = raw as TemplateContract;
    if (!contract || typeof contract.id !== 'string') continue;
    out.set(contract.id, contract);
  }
  return out;
}

/** 契约文件是否存在（用于覆盖率统计与守卫） */
export function contractExists(root: string, templateId: string): boolean {
  return exists(contractPathFor(root, templateId));
}

/** 模板 HTML 文件名（不含扩展名） */
export function templateIdFromFile(file: string): string {
  return file.replace(/\.html$/, '');
}
