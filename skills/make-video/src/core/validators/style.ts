import type { Project, StyleDecision, StylePack } from '../schema.js';
import { err, warn, type Issue } from './types.js';

export function validateStyleDecision(decision: StyleDecision | undefined): Issue[] {
  const issues: Issue[] = [];
  if (!decision) {
    issues.push(err('V-STYLE-001', '缺少风格决策（无默认风格）'));
    return issues;
  }
  if (!decision.rationale || decision.rationale.trim().length < 4) {
    issues.push(err('V-STYLE-001', '风格决策必须带 source + rationale'));
  }
  if (decision.source === 'agent-chosen' && Object.keys(decision.lineage ?? {}).length === 0) {
    issues.push(err('V-STYLE-004', 'agent-chosen 风格缺少组合谱系记录'));
  }
  return issues;
}

export function validateCombination(
  base: StylePack,
  overrides: Record<string, unknown>,
  registeredPacks: StylePack[],
): Issue[] {
  const issues: Issue[] = [];
  const lineage = (overrides['_lineage'] as string[] | undefined) ?? [];
  for (const id of lineage) {
    const donor = registeredPacks.find((p) => p.id === id);
    if (!donor) {
      issues.push(err('V-STYLE-002', `组合引用了未注册的包 ${id}`));
      continue;
    }
    if (donor.grade === 'C') {
      issues.push(warn('V-STYLE-002', `包 ${id} 为 C 级（仅 pacing），组合需谨慎`));
    }
  }
  const overrideKeys = Object.keys(overrides).filter((k) => k !== '_lineage');
  const allowed = ['palette', 'type', 'layout', 'motion', 'pacing', 'effects', 'transitions'];
  for (const key of overrideKeys) {
    if (!allowed.includes(key)) {
      issues.push(err('V-STYLE-002', `不允许覆写的参数组: ${key}`));
    }
  }
  const paletteOverride = overrides['palette'] as { primary?: string } | undefined;
  if (paletteOverride?.primary && !/^#[0-9a-fA-F]{6}$/.test(paletteOverride.primary)) {
    issues.push(err('V-COL-001', '覆写主色不是合法 hex'));
  }
  return issues;
}

/**
 * V-STYLE-003 组合确认门（error：流程门）：
 * 非 recipe 预绑的组合（L2 参数覆写 / L3 自由组合谱系）必须用户显式确认；
 * user-specified = 用户亲选，不视为 agent 自由组合。agent 兜底选择（agent-chosen）
 * 带 lineage 时同样触发——逃生舱不允许 agent 静默通过。
 */
export function validateStyleGate(project: Project): Issue[] {
  const issues: Issue[] = [];
  const d = project.style;
  if (!d) return issues;
  const hasCombo =
    Object.keys(d.lineage ?? {}).length > 0 || Object.keys(d.overrides ?? {}).length > 0;
  if (hasCombo && d.source !== 'user-specified' && !project.confirmed) {
    issues.push(
      err('V-STYLE-003', `自由组合 ${d.id}（source=${d.source}）必须用户确认（make-video confirm）`),
    );
  }
  return issues;
}

export function validateProvenance(pack: StylePack): Issue[] {
  const issues: Issue[] = [];
  if (pack.status === 'registered') {
    if (!pack.provenance.from) {
      issues.push(err('V-STYLE-006', 'registered 风格包必须带 provenance.from'));
    }
    if (!pack.provenance.review && pack.provenance.source === 'absorbed') {
      issues.push(err('V-STYLE-006', '沉淀包上架必须带对拍结论 review'));
    }
  }
  return issues;
}

/**
 * V-STYLE-008 风格-素材一致性（轻闸门）：
 * 风格声明了素材语言（维度/母题/偏好/禁用），就必须真的影响素材选择与场景形态；
 * 这里只管「配置自洽 + 禁用素材没被用上」，场景 HTML 侧的维度一致由 V.validateSceneFile 管。
 */
export function validateStyleVisual(project: Project, pack: StylePack): Issue[] {
  const issues: Issue[] = [];
  const v = pack.visuals;
  // 存量测试/旧工程可能构造无 visuals 的假包：视为未声明素材语言，直接放行
  if (!v) return issues;
  const deny = new Set(v.sceneDeny);
  const conflict = v.sceneBias.filter((t) => deny.has(t));
  if (conflict.length > 0) {
    issues.push(err('V-STYLE-008', `风格 ${pack.id} 的 sceneBias 与 sceneDeny 冲突：${conflict.join('/')}`));
  }
  for (const s of project.shots) {
    const t = s.visual.template ?? '';
    if (deny.has(t)) {
      issues.push(warn('V-STYLE-008', `镜头 ${s.id} 使用了风格禁用的素材形态 ${t}`));
    }
  }
  if (v.dimension === 'css3d' && v.motifs.length === 0) {
    issues.push(warn('V-STYLE-008', `风格 ${pack.id} 声明 css3d 但未登记任何 3D 母题`));
  }
  return issues;
}
