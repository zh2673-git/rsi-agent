import path from 'node:path';
import type { AssetRef, Project, Shot } from '../core/schema.js';
import { V } from '../core/index.js';
import { mvError, ERR } from '../core/errors.js';
import type { ProjectStore } from '../infrastructure/project-store.js';
import type { BuddyCloudBridge } from '../infrastructure/buddy-cloud-bridge.js';
import { copyFile, exists, readJson, atomicWriteJson } from '../infrastructure/fs-utils.js';
import { extractFrame, probeDurationMs, probeSize, sliceClip } from '../infrastructure/ffmpeg-utils.js';
import type { MaterialIndex, MaterialIndexItem } from './storyboard.js';
import { drawScene } from './scene-forge.js';
import type { StylePack } from '../core/schema.js';

/** 素材入库输入（P5）：显式语义标签与溯源信息，避免检索素材只剩数字文件名标签 */
export interface MaterialInput {
  file: string;
  tags?: string[];
  sourceUrl?: string;
  credit?: string;
  license?: string;
}

export async function indexMaterials(
  store: ProjectStore,
  project: Project,
  paths: Array<string | MaterialInput>,
): Promise<MaterialIndex> {
  const dir = store.projectDir(project.meta.id);
  const matDir = path.join(dir, 'materials');
  const indexFile = path.join(matDir, 'index.json');
  const index: MaterialIndex = exists(indexFile)
    ? await readJson<MaterialIndex>(indexFile)
    : { items: [] };
  for (const raw of paths) {
    const input: MaterialInput = typeof raw === 'string' ? { file: raw } : raw;
    const src = input.file;
    if (!exists(src)) throw mvError(ERR.FS, `素材不存在: ${src}`);
    const base = path.basename(src);
    const dest = path.join(matDir, base);
    await copyFile(src, dest);
    const probed = await probeMaterial(dest);
    const item: MaterialIndexItem = {
      ...probed,
      tags: mergeTags(probed.tags, input.tags),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.credit ? { credit: input.credit } : {}),
      ...(input.license ? { license: input.license } : {}),
    };
    index.items = index.items.filter((i) => i.path !== dest);
    index.items.push(item);
  }
  await atomicWriteJson(indexFile, index);
  return index;
}

function mergeTags(base: string[], extra?: string[]): string[] {
  const all = [...(extra ?? []), ...base]
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return [...new Set(all)];
}

async function probeMaterial(file: string): Promise<MaterialIndexItem> {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext);
  if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
    const durationMs = await probeDurationMs(file).catch(() => undefined);
    const size = await probeSize(file).catch(() => undefined);
    return {
      path: file,
      type: 'video',
      ...(durationMs ? { durationMs } : {}),
      tags: tokenize(base),
      ...(size ? { width: size.width, height: size.height } : {}),
    };
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) {
    const size = await probeSize(file).catch(() => undefined);
    return {
      path: file,
      type: 'image',
      tags: tokenize(base),
      ...(size ? { width: size.width, height: size.height } : {}),
    };
  }
  if (['.mp3', '.wav', '.m4a', '.aac'].includes(ext)) {
    const durationMs = await probeDurationMs(file).catch(() => undefined);
    return {
      path: file,
      type: 'audio',
      ...(durationMs ? { durationMs } : {}),
      tags: tokenize(base),
    };
  }
  return { path: file, type: 'other', tags: tokenize(base) };
}

/**
 * 素材入库闸（P5-A / V-AST-006）：
 * 宽度不足 1080p 满幅是硬伤（err），放大到 1920 是画质风险（warn），
 * 比例偏离 16:9 会被 cover 裁掉构图（warn，竖构图人物照允许但需知情）。
 */
export function checkMaterial(item: MaterialIndexItem): V.Issue[] {
  const issues: V.Issue[] = [];
  if (item.type === 'audio' || item.type === 'other') return issues;
  if (!item.width || !item.height) {
    issues.push(V.warn('V-AST-006', `无法探测尺寸，按原样使用: ${item.path}`));
    return issues;
  }
  if (item.width < 1280) {
    issues.push(
      V.err('V-AST-006', `素材 ${path.basename(item.path)} 宽度 ${item.width} < 1280，1080p 满幅会明显模糊`),
    );
  } else if (item.width < 1920) {
    issues.push(
      V.warn('V-AST-006', `素材 ${path.basename(item.path)} 宽度 ${item.width} < 1920，满幅会被放大`),
    );
  }
  const deviation = Math.abs(item.width / item.height - 16 / 9) / (16 / 9);
  if (deviation > 0.12) {
    issues.push(
      V.warn(
        'V-AST-006',
        `素材 ${path.basename(item.path)} 比例偏离 16:9 ${Math.round(deviation * 100)}%，cover 裁切会损失构图（竖构图可改用 contain）`,
      ),
    );
  }
  if (item.type === 'video' && (item.durationMs ?? 0) > 0 && (item.durationMs ?? 0) < 1500) {
    issues.push(
      V.warn('V-AST-006', `视频 ${path.basename(item.path)} 时长不足 1.5s，循环播放会露出接缝`),
    );
  }
  return issues;
}

/** 把已入库素材绑定到镜头（P5 数据流转）：改视觉类型、记溯源、作废时间线 */
export function bindMaterial(
  project: Project,
  shotId: string,
  item: MaterialIndexItem,
  reason: string,
): void {
  const shot = project.shots.find((s) => s.id === shotId);
  if (!shot) throw mvError(ERR.IMPORT_FAIL, `镜头不存在: ${shotId}`);
  const meta: Record<string, unknown> = {
    type: item.type,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.credit ? { credit: item.credit } : {}),
    ...(item.license ? { license: item.license } : {}),
    ...(item.width ? { width: item.width } : {}),
    ...(item.height ? { height: item.height } : {}),
  };
  shot.visual = {
    kind: 'user-material',
    prompt: shot.visual.prompt || shot.narration.slice(0, 80),
    source: item.path,
    params: { ...shot.visual.params, material: meta },
  };
  shot.asset = {
    kind: 'user-material',
    path: item.path,
    ...(item.durationMs ? { durationMs: item.durationMs } : {}),
    ...(item.width ? { width: item.width } : {}),
    ...(item.height ? { height: item.height } : {}),
    meta: { ...meta, kenBurns: true },
  };
  shot.state = 'sourced';
  project.materialDecisions[shotId] = { kind: 'user-material', source: item.path, reason };
  project.timeline = undefined;
}

function tokenize(name: string): string[] {
  return name
    .split(/[-_.\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export async function ensureAssets(
  store: ProjectStore,
  project: Project,
  shot: Shot,
  bridge: BuddyCloudBridge,
  pack: StylePack,
  llm?: import('../infrastructure/index.js').LlmClient,
): Promise<AssetRef> {
  const dir = store.projectDir(project.meta.id);
  const kind = shot.visual.kind;
  if (kind === 'code-scene') {
    const { file } = await drawScene(store, project, shot, pack, llm);
    return { kind, path: file, meta: { scene: shot.id, kenBurns: true } };
  }
  if (kind === 'user-material') {
    const src = shot.visual.source;
    if (!src || !exists(src)) {
      throw mvError(ERR.ASSET_MISSING, `镜头 ${shot.id} 的用户素材缺失: ${src ?? '(未指定)'}`);
    }
    const dest = path.join(dir, 'assets', shot.id, path.basename(src));
    await copyFile(src, dest);
    const materialMeta = shot.visual.params['material'];
    return {
      kind,
      path: dest,
      meta: {
        source: src,
        kenBurns: true,
        ...(materialMeta && typeof materialMeta === 'object' ? { material: materialMeta } : {}),
      },
    };
  }
  if (kind === 'imported') {
    const src = shot.visual.source;
    if (!src || !exists(src)) {
      throw mvError(ERR.ASSET_MISSING, `镜头 ${shot.id} 的导入源缺失: ${src ?? '(未指定)'}`);
    }
    const outDir = path.join(dir, 'assets', shot.id);
    const range = shot.visual.params['range'] as [number, number] | undefined;
    const dest = path.join(outDir, `clip-${shot.id}.mp4`);
    if (range) {
      await sliceClip(src, range[0], range[1] - range[0], dest);
    } else {
      const destFrame = path.join(outDir, `frame-${shot.id}.png`);
      await extractFrame(src, 0, destFrame);
      return { kind, path: destFrame, meta: { source: src, kenBurns: true } };
    }
    return { kind, path: dest, meta: { source: src } };
  }
  return bridge.generate(
    { kind: 'video', prompt: shot.visual.prompt || shot.narration.slice(0, 80) },
    path.join(dir, 'assets', shot.id),
    '',
  );
}

export async function importAsset(
  store: ProjectStore,
  project: Project,
  shotId: string,
  source: string,
  mode: 'frame' | 'clip',
  range?: [number, number],
): Promise<AssetRef> {
  const dir = store.projectDir(project.meta.id);
  const outDir = path.join(dir, 'assets', shotId);
  if (!exists(source)) throw mvError(ERR.IMPORT_FAIL, `导入源不存在: ${source}`);
  if (mode === 'frame') {
    const out = path.join(outDir, `frame-${shotId}.png`);
    await extractFrame(source, range?.[0] ?? 0, out);
    return { kind: 'imported', path: out, meta: { source, kenBurns: true } };
  }
  const out = path.join(outDir, `clip-${shotId}.mp4`);
  await sliceClip(source, range?.[0] ?? 0, (range?.[1] ?? 5) - (range?.[0] ?? 0), out);
  const issues = await checkAsset(out);
  if (V.hasError(issues)) {
    throw mvError(ERR.IMPORT_FAIL, `导入资产不合格:\n${V.formatIssues(issues)}`);
  }
  return { kind: 'imported', path: out, meta: { source } };
}

async function checkAsset(file: string): Promise<V.Issue[]> {
  const issues: V.Issue[] = [];
  try {
    const dur = await probeDurationMs(file);
    if (dur <= 0) issues.push(V.err('V-AST-005', '资产时长为 0'));
  } catch (e) {
    issues.push(V.err('V-AST-005', `资产不可解码: ${(e as Error).message}`));
  }
  return issues;
}
