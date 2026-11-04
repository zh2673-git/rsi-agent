#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../infrastructure/project-store.js';
import { StyleRegistry } from '../domain/style-registry.js';
import { BuddyCloudBridge } from '../infrastructure/buddy-cloud-bridge.js';
import { HyperFramesRenderer, renderSpecFor } from '../infrastructure/hyperframes-renderer.js';
import { createTtsClient, type TtsProvider } from '../infrastructure/tts-client.js';
import { createLlmClientFromEnv } from '../infrastructure/llm-client.js';
import { StateEngine } from '../runtime/state-engine.js';
import {
  absorbStyle,
  addMaterials,
  adoptSceneFile,
  createEngine,
  resynthesize,
  runProject,
  useRecording,
} from '../application/pipeline.js';
import { buildConfirmation } from '../domain/storyboard.js';
import { V } from '../core/index.js';
import { mvError } from '../core/errors.js';
import type { Genre } from '../core/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function out(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function info(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function fail(e: unknown): never {
  const err = e as { code?: string; message: string };
  out({ error: err.code ?? 'ERR_UNKNOWN', message: err.message });
  process.exitCode = 1;
  return undefined as never;
}

function ttsProvider(): TtsProvider {
  const v = process.env['MV_TTS'] ?? 'auto';
  if (v === 'edge' || v === 'edge-py' || v === 'silent' || v === 'sovits' || v === 'qwen3' || v === 'auto') return v;
  return 'auto';
}

function makeEngine(): { engine: StateEngine; registry: StyleRegistry; store: ProjectStore } {
  const store = new ProjectStore(ROOT);
  const registry = new StyleRegistry(ROOT);
  const engine = createEngine(ROOT, {
    store,
    registry,
    llm: createLlmClientFromEnv(),
    tts: createTtsClient(ttsProvider()),
    bridge: new BuddyCloudBridge(),
    renderer: new HyperFramesRenderer(),
  });
  return { engine, registry, store };
}

async function loadRegistry(registry: StyleRegistry): Promise<void> {
  await registry.load();
}

const program = new Command();
program.name('make-video').description('代码绘制优先的视频编译器').version('0.1.0');

program
  .command('doctor')
  .description('环境体检（P 前置）')
  .action(async () => {
    try {
      const renderer = new HyperFramesRenderer();
      const checks = await renderer.doctor();
      const bridge = new BuddyCloudBridge();
      out({
        checks,
        buddyCloud: { available: bridge.available },
        tts: ttsProvider(),
        llm: process.env['LLM_BASE_URL'] ? 'api' : 'template',
      });
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
    } catch (e) {
      fail(e);
    }
  });

program
  .command('init <topic>')
  .description('创建项目（制片人工件 A1）')
  .option('--aspect <ratio>', '画幅 16:9|9:16', '16:9')
  .option('--duration-tier <tier>', '时长档位 0-5|5-10|10+', '0-5')
  .option('--genre <id>', '类型配方 id')
  .option('--style <id>', '指定风格包 id')
  .option('--script <file>', '直接提供讲稿文件（跳过编剧）')
  .option('--materials <dir>', '用户素材目录（录音/照片/视频）')
  .option('--asset-policy <policy>', 'auto|ask|code-first|real-first', 'auto')
  .action(async (topic: string, opts: Record<string, string>) => {
    try {
      const { store, registry } = makeEngine();
      await loadRegistry(registry);
      const genreOpt = opts['genre'];
      const genre =
        genreOpt && registry.hasGenre(genreOpt) ? (genreOpt as Genre) : undefined;
      const project = await store.initProject({
        topic,
        aspect: opts['aspect'] === '9:16' ? '9:16' : '16:9',
        durationTier: (opts['duration-tier'] as '0-5' | '5-10' | '10+') ?? '0-5',
        ...(genre ? { genre } : {}),
        assetPolicy: (opts['asset-policy'] as 'auto' | 'ask' | 'code-first' | 'real-first') ?? 'auto',
      });
      if (opts['materials']) {
        const { indexMaterials } = await import('../domain/asset-sourcing.js');
        const fs = await import('node:fs/promises');
        const files = (await fs.readdir(opts['materials'])).map((f) => path.join(opts['materials']!, f));
        if (files.length) await indexMaterials(store, project, files);
      }
      if (opts['script']) {
        const { readFile } = await import('node:fs/promises');
        const { ScriptSchema } = await import('../core/schema.js');
        const { validateScript, validateCharBudget } = await import('../domain/scriptwriter.js');
        const parsed = JSON.parse(await readFile(opts['script'], 'utf8')) as unknown;
        const script = ScriptSchema.parse(parsed);
        // 注入讲稿同样过编剧部校验（V-SCP-001/003/004/007 + 字数档位），不因注入路径而豁免
        const recipe = registry.getRecipe(project.meta.genre);
        const issues = [...validateScript(script, recipe), ...validateCharBudget(script, recipe, project.meta.durationTier)];
        const errs = issues.filter((i) => i.level === 'error');
        for (const w of issues.filter((i) => i.level === 'warn')) info(`⚠ ${w.message}`);
        if (errs.length > 0) {
          throw new Error(`注入讲稿未过编剧部校验:\n${errs.map((e) => e.message).join('\n')}`);
        }
        project.script = script;
        await store.save(project);
        info(`讲稿已注入（${script.segments.length} 段，跳过编剧）`);
      }
      if (opts['style']) {
        project.style = {
          id: opts['style'],
          source: 'user-specified',
          rationale: 'init 时用户指定',
          lineage: {},
          overrides: {},
        };
        await store.save(project);
      }
      out({ project: project.meta.id, dir: store.projectDir(project.meta.id) });
      info(`项目已创建: ${project.meta.id}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('add-material <files...>')
  .description('用户素材入库（复制进 materials/，自动索引；可选标签/溯源/直接绑定镜头）')
  .option('--project <id>', '项目 id')
  .option('--shot <id>', '入库后直接绑定为该镜的真实素材')
  .option('--tags <list>', '逗号分隔的语义标签（按旁白匹配时命中率更高）')
  .option('--url <url>', '素材来源页（写入溯源，成片报告可见）')
  .option('--license <text>', '素材许可证')
  .option('--credit <text>', '作者署名')
  .option('--strict', '尺寸不达标即失败（默认只告警）')
  .action(async (files: string[], opts: Record<string, string | boolean>) => {
    try {
      const { store } = makeEngine();
      const id = await store.resolveProjectId(opts['project'] as string | undefined);
      const project = await store.load(id);
      const { indexMaterials, checkMaterial, bindMaterial } = await import(
        '../domain/asset-sourcing.js'
      );
      const tags = String(opts['tags'] ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const common = {
        ...(tags.length ? { tags } : {}),
        ...(opts['url'] ? { sourceUrl: String(opts['url']) } : {}),
        ...(opts['license'] ? { license: String(opts['license']) } : {}),
        ...(opts['credit'] ? { credit: String(opts['credit']) } : {}),
      };
      const index = await indexMaterials(
        store,
        project,
        files.map((file) => ({ file, ...common })),
      );
      const added = index.items.filter((i) =>
        files.some((f) => path.basename(f) === path.basename(i.path)),
      );
      const issues = added.flatMap((i) => checkMaterial(i));
      if (opts['strict'] && V.hasError(issues)) {
        throw mvError('ERR_VALIDATION', `素材不合格:\n${V.formatIssues(issues)}`);
      }
      let bound: { shot: string; path: string } | undefined;
      const shotId = opts['shot'] as string | undefined;
      if (shotId) {
        const item = added[0];
        if (!item) throw mvError('ERR_ASSET_MISSING', '没有可绑定的入库结果');
        bindMaterial(project, shotId, item, '用户手动指定素材');
        await store.save(project);
        bound = { shot: shotId, path: item.path };
      }
      out({
        items: added.length,
        index: added.map((i) => ({
          path: i.path,
          type: i.type,
          ...(i.width ? { width: i.width } : {}),
          ...(i.height ? { height: i.height } : {}),
          ...(i.durationMs ? { durationMs: i.durationMs } : {}),
          tags: i.tags,
          ...(i.sourceUrl ? { sourceUrl: i.sourceUrl } : {}),
          ...(i.license ? { license: i.license } : {}),
        })),
        issues,
        ...(bound ? { bound } : {}),
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('stock <query>')
  .description('真实素材检索（需 MAKEVIDEO_PEXELS_API_KEY，未配置时默认关闭）')
  .option('--project <id>', '项目 id（下载/绑定时必填）')
  .option('--count <n>', '返回条数 1-20', '3')
  .option('--type <type>', 'image|video', 'image')
  .option('--download', '下载到 materials/ 并入库')
  .option('--shot <id>', '把首条结果绑定为该镜的真实素材（隐含下载）')
  .action(async (query: string, opts: Record<string, string | boolean>) => {
    try {
      const { searchStock, downloadStock, stockEnabled, STOCK_HINT } = await import(
        '../infrastructure/stock-media.js'
      );
      if (!stockEnabled()) {
        out({ enabled: false, hint: STOCK_HINT });
        return;
      }
      const type = opts['type'] === 'video' ? 'video' : 'image';
      const count = Number(opts['count'] ?? 3);
      const result = await searchStock(query, { count, type });
      const wantDownload = Boolean(opts['download'] || opts['shot']);
      if (!wantDownload) {
        out({ enabled: true, provider: result.provider, items: result.items });
        return;
      }
      const { store } = makeEngine();
      const id = await store.resolveProjectId(opts['project'] as string | undefined);
      const project = await store.load(id);
      const dir = store.projectDir(id);
      const stage = path.join(dir, 'gen', 'stock', String(Date.now()));
      const staged: string[] = [];
      for (const hit of result.items) staged.push(await downloadStock(hit, stage));
      const { indexMaterials } = await import('../domain/asset-sourcing.js');
      const index = await indexMaterials(store, project, staged);
      const fs = await import('node:fs/promises');
      await fs.rm(stage, { recursive: true, force: true });
      const downloaded = index.items
        .filter((i) => staged.some((f) => path.basename(f) === path.basename(i.path)))
        .map((i) => i.path);

      let bound: { shot: string; path: string } | undefined;
      const shotId = opts['shot'] as string | undefined;
      if (shotId) {
        const shot = project.shots.find((s) => s.id === shotId);
        if (!shot) throw new Error(`镜头不存在: ${shotId}`);
        const file = downloaded[0];
        if (!file) throw new Error('没有可用的下载结果');
        const hit = result.items[0]!;
        shot.visual = {
          kind: 'user-material',
          prompt: query,
          params: { stock: { provider: hit.provider, id: hit.id, author: hit.author, pageUrl: hit.pageUrl } },
        };
        shot.asset = {
          kind: 'user-material',
          path: file,
          meta: { stock: { provider: hit.provider, id: hit.id, author: hit.author, pageUrl: hit.pageUrl } },
        };
        shot.state = 'sourced';
        project.timeline = undefined;
        await store.save(project);
        bound = { shot: shotId, path: file };
      }
      out({ enabled: true, provider: result.provider, items: result.items, downloaded, ...(bound ? { bound } : {}) });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('storyboard')
  .description('导演批注 + 分镜 + 确认表（A3/A4/A5）')
  .option('--project <id>', '项目 id')
  .option('--style <id>', '指定风格包 id')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry, store } = makeEngine();
      await loadRegistry(registry);
      const id = await store.resolveProjectId(opts['project']);
      await engine.init(id);
      const events = await engine.run({ autoConfirm: false, userStyleId: opts['style'] });
      const p = engine.getProject();
      out({
        stage: p.stage,
        confirmed: p.confirmed,
        shots: p.shots.length,
        style: p.style?.id,
        events: events.map((e) => e.type),
        confirmation: buildConfirmation(p),
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('material-plan')
  .description('素材需求单（逐镜判断哪些镜需要真实素材，写 gen/material-plan.json）')
  .option('--project <id>', '项目 id')
  .option('--style <id>', '指定风格包 id（缺省用项目已选风格）')
  .action(async (opts: Record<string, string>) => {
    try {
      const { store, registry } = makeEngine();
      await loadRegistry(registry);
      const id = await store.resolveProjectId(opts['project']);
      const project = await store.load(id);
      if (!project.shots.length) throw mvError('ERR_VALIDATION', '缺少分镜，先跑 storyboard');
      const packId = opts['style'] ?? project.style?.id;
      if (!packId) throw mvError('ERR_STYLE_UNKNOWN', '项目还没有风格决策，先跑 storyboard 或指定 --style');
      const pack =
        !opts['style'] && project.style ? registry.resolveStyle(project.style) : registry.getStyle(packId);
      const { planMaterials } = await import('../domain/material-plan.js');
      const briefs = await planMaterials(project, pack, createLlmClientFromEnv());
      const { atomicWriteJson } = await import('../infrastructure/fs-utils.js');
      const file = path.join(store.projectDir(id), 'gen', 'material-plan.json');
      await atomicWriteJson(file, {
        generatedAt: new Date().toISOString(),
        topic: project.meta.topic,
        style: pack.id,
        briefs,
      });
      out({
        file,
        total: briefs.length,
        wanted: briefs.filter((b) => b.need !== 'none').length,
        briefs,
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('run')
  .description('全自动推进（默认在确认点暂停；--yes 自动确认）')
  .option('--project <id>', '项目 id')
  .option('--style <id>', '指定风格包 id')
  .option('--yes', '自动确认分镜表（跳过暂停）')
  .action(async (opts: Record<string, string | boolean>) => {
    try {
      const { engine, registry } = makeEngine();
      await loadRegistry(registry);
      const id = await engine.deps.store.resolveProjectId(opts['project'] as string | undefined);
      await engine.init(id);
      const events = await runProject(engine, {
        autoConfirm: Boolean(opts['yes']),
        ...(opts['style'] ? { userStyleId: String(opts['style']) } : {}),
      });
      const p = engine.getProject();
      const last = events[events.length - 1];
      out({
        stage: p.stage,
        events: events.map((e) => e.type),
        ...(last?.type === 'done' ? { outFile: last.outFile } : {}),
        ...(p.stage === 'storyboard' && !p.confirmed
          ? { hint: '已停在确认点：审阅 confirmation 后，编辑 project.json 的 confirmed=true 或用 --yes 重跑 run' }
          : {}),
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('voice')
  .description('旁白合成/重合成（TTS 或用户录音）')
  .option('--project <id>', '项目 id')
  .option('--shot <id>', '只处理某镜')
  .option('--from <file>', '采用用户录音作为该镜旁白')
  .option('--voice <name>', 'TTS 声线')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry, store } = makeEngine();
      await loadRegistry(registry);
      const id = await store.resolveProjectId(opts['project']);
      const project = await store.load(id);
      const tts = createTtsClient(ttsProvider());
      if (opts['from'] && opts['shot']) {
        await useRecording(store, project, opts['shot'], opts['from']);
        out({ shot: opts['shot'], source: 'recording', durationMs: project.shots.find((s) => s.id === opts['shot'])?.voice?.durationMs });
        return;
      }
      const n = await resynthesize(store, project, tts, opts['shot'], opts['voice']);
      out({ synthesized: n });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('scene')
  .description('agent/人工场景接入：校验外部场景 HTML 并落盘（未过校验时返回逐条反馈）')
  .option('--project <id>', '项目 id')
  .option('--shot <id>', '目标镜头 id')
  .option('--from <file>', '外部场景 HTML 文件')
  .action(async (opts: Record<string, string>) => {
    try {
      const { store, registry } = makeEngine();
      const id = await store.resolveProjectId(opts['project']);
      const project = await store.load(id);
      await registry.ensureLoaded();
      const pack = project.style ? registry.resolveStyle(project.style) : undefined;
      const r = await adoptSceneFile(store, project, opts['shot'] ?? '', opts['from'] ?? '', pack);
      out({
        shot: opts['shot'],
        adopted: r.adopted,
        ...(!r.adopted ? { feedback: V.formatIssues(r.issues) } : {}),
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('draw')
  .description('场景代码生成（美术摄影部）')  .option('--project <id>', '项目 id')
  .option('--shot <id>', '只画某镜')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry, store } = makeEngine();
      await loadRegistry(registry);
      const id = await store.resolveProjectId(opts['project']);
      const project = await store.load(id);
      const { ensureAssets } = await import('../domain/asset-sourcing.js');
      const { BuddyCloudBridge } = await import('../infrastructure/buddy-cloud-bridge.js');
      const pack = registry.resolveStyle(project.style!);
      const shots = opts['shot'] ? project.shots.filter((s) => s.id === opts['shot']) : project.shots.filter((s) => s.state === 'pending');
      const bridge = new BuddyCloudBridge();
      const done: string[] = [];
      for (const shot of shots) {
        const asset = await ensureAssets(store, project, shot, bridge, pack);
        shot.asset = asset;
        shot.state = 'sourced';
        done.push(shot.id);
      }
      await store.save(project);
      out({ drawn: done });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('import')
  .description('素材导入（外部视频抽帧/切片 → assets/）')
  .requiredOption('--shot <id>', '目标镜头')
  .requiredOption('--from <file>', '导入源（视频文件）')
  .option('--project <id>', '项目 id')
  .option('--mode <mode>', 'frame|clip', 'frame')
  .option('--at <seconds>', '抽帧时间点', '0')
  .option('--range <range>', '切片范围 起-止（秒），如 3-8')
  .action(async (opts: Record<string, string>) => {
    try {
      const { store } = makeEngine();
      const id = await store.resolveProjectId(opts['project']);
      const project = await store.load(id);
      const { importAsset } = await import('../domain/asset-sourcing.js');
      const range = opts['range']
        ? (opts['range'].split('-').map(Number) as [number, number])
        : ([Number(opts['at'] ?? 0), Number(opts['at'] ?? 0) + 5] as [number, number]);
      const asset = await importAsset(
        store,
        project,
        opts['shot']!,
        opts['from']!,
        (opts['mode'] as 'frame' | 'clip') ?? 'frame',
        range,
      );
      const shot = project.shots.find((s) => s.id === opts['shot']);
      if (shot) {
        shot.visual = { ...shot.visual, kind: 'imported', source: opts['from']! };
        shot.asset = asset;
        shot.state = 'sourced';
      }
      await store.save(project);
      out({ shot: opts['shot'], asset: asset.path });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('compose')
  .description('质量闸门 + 时间线 + HyperFrames 合成项目（剪辑部）')
  .option('--project <id>', '项目 id')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry } = makeEngine();
      await loadRegistry(registry);
      const id = await engine.deps.store.resolveProjectId(opts['project']);
      await engine.init(id);
      const { compose } = await import('../domain/composer.js');
      const p = engine.getProject();
      const pack = registry.resolveStyle(p.style!);
      const timeline = await compose(engine.deps.store, p, pack);
      out({
        shots: timeline.shots.length,
        totalMs: timeline.shots.reduce((a, s) => a + s.durationMs, 0),
        subtitles: timeline.subtitles.length,
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('render')
  .description('渲染成片（HyperFrames，锁+输出校验）')
  .option('--project <id>', '项目 id')
  .option('-o <file>', '输出文件')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry } = makeEngine();
      await loadRegistry(registry);
      const id = await engine.deps.store.resolveProjectId(opts['project']);
      await engine.init(id);
      const p = engine.getProject();
      if (!p.timeline) throw mvError('ERR_VALIDATION' as never, '尚未装配，请先 compose');
      const renderer = new HyperFramesRenderer();
      const checks = await renderer.doctor();
      const bad = checks.filter((c) => !c.ok);
      if (bad.length) throw mvError('ERR_RENDER_ENV' as never, `环境不全: ${bad.map((b) => b.name).join(', ')}`);
      const spec = renderSpecFor(p.meta.aspect);
      const outFile =
        opts['o'] ?? path.join(engine.deps.store.projectDir(p.meta.id), 'out', `${p.meta.id}.mp4`);
      const produced = await renderer.render(engine.deps.store.projectDir(p.meta.id), spec, outFile);
      const outChecks = await renderer.validateOutput(
        produced,
        p.timeline.shots.reduce((a, s) => a + s.durationMs, 0),
      );
      out({ outFile: produced, checks: outChecks });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('status')
  .description('状态视图（阶段/镜头/缺口/验收门）')
  .option('--project <id>', '项目 id')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry } = makeEngine();
      await loadRegistry(registry);
      const id = await engine.deps.store.resolveProjectId(opts['project']);
      await engine.init(id);
      out(engine.status());
    } catch (e) {
      fail(e);
    }
  });

program
  .command('retry')
  .description('局部重跑（单镜/失败集）')
  .option('--project <id>', '项目 id')
  .option('--shot <id>', '指定镜头')
  .option('--stage <stage>', '回退到指定阶段')
  .action(async (opts: Record<string, string>) => {
    try {
      const { engine, registry } = makeEngine();
      await loadRegistry(registry);
      const id = await engine.deps.store.resolveProjectId(opts['project']);
      await engine.init(id);
      const events = await engine.retry(opts['shot'], opts['stage']);
      out({ events: events.map((e) => e.type), stage: engine.getProject().stage });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('clean')
  .description('回收中间产物（保留成片与 IR）')
  .option('--project <id>', '项目 id')
  .action(async (opts: Record<string, string>) => {
    try {
      const { store } = makeEngine();
      const id = await store.resolveProjectId(opts['project']);
      const result = await store.clean(id);
      out(result);
    } catch (e) {
      fail(e);
    }
  });

const styleCmd = program.command('style').description('风格库（菜单/解剖/沉淀/上架）');

styleCmd
  .command('list')
  .description('风格菜单（用户叫法索引）')
  .option('--grade <grade>', 'A|B|C')
  .action(async (opts: Record<string, string>) => {
    try {
      const { registry } = makeEngine();
      await loadRegistry(registry);
      const packs = registry.listStyles(opts['grade'] as 'A' | 'B' | 'C' | undefined);
      out(
        packs.map((p) => ({
          id: p.id,
          name: p.userFacing.name,
          aliases: p.userFacing.aliases,
          vibe: p.userFacing.vibe,
          grade: p.grade,
          bestFor: p.userFacing.bestFor,
        })),
      );
    } catch (e) {
      fail(e);
    }
  });

styleCmd
  .command('show <id>')
  .description('解剖卡（anatomy 部门指令集）')
  .action(async (id: string) => {
    try {
      const { registry } = makeEngine();
      await loadRegistry(registry);
      const pack = registry.getStyle(id);
      out({ id: pack.id, anatomy: pack.anatomy, palette: pack.palette, motion: pack.motion, pacing: pack.pacing });
    } catch (e) {
      fail(e);
    }
  });

styleCmd
  .command('absorb')
  .description('新风格沉淀（参考素材/描述 → 草稿包）')
  .requiredOption('--from <source>', '来源标识（如 用户描述/参考视频名）')
  .requiredOption('--description <text>', '风格描述')
  .option('--files <paths...>', '参考文件（抽帧用）')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const { registry } = makeEngine();
      await loadRegistry(registry);
      const { absorbStyle } = await import('../application/pipeline.js');
      const result = await absorbStyle(registry, createLlmClientFromEnv(), {
        source: String(opts['from']),
        description: String(opts['description']),
        referenceFiles: (opts['files'] as string[] | undefined) ?? [],
      });
      out({ ...result, status: 'draft', next: 'style promote <id>（对拍通过后上架）' });
    } catch (e) {
      fail(e);
    }
  });

styleCmd
  .command('promote <id>')
  .description('candidate/draft → registered（对拍通过后）')
  .requiredOption('--review <text>', '对拍结论')
  .action(async (id: string, opts: Record<string, string>) => {
    try {
      const { registry } = makeEngine();
      await loadRegistry(registry);
      const pack = registry.getStyle(id);
      const registered = registry.registerPack(pack, { review: opts['review']! });
      const fs = await import('node:fs/promises');
      await fs.writeFile(
        path.join(ROOT, 'styles', `${registered.id}.json`),
        `${JSON.stringify(registered, null, 2)}\n`,
        'utf8',
      );
      out({ id: registered.id, status: registered.status, grade: registered.grade });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('confirm')
  .description('确认分镜表（写 confirmed=true，放行采购）')
  .option('--project <id>', '项目 id')
  .option('--allow-ai', '授权本项目使用云端 AI 生图（用户显式同意后再加，V-AI-001 闸门）')
  .action(async (opts: Record<string, string | boolean>) => {
    try {
      const { store } = makeEngine();
      const id = await store.resolveProjectId(opts['project'] as string | undefined);
      const project = await store.load(id);
      project.confirmed = true;
      if (opts['allow-ai']) project.meta.aiConsent = true;
      await store.save(project);
      out({ confirmed: true, stage: project.stage, aiConsent: project.meta.aiConsent });
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  info(`未处理错误: ${(e as Error).message}`);
  process.exit(1);
});

void V;
