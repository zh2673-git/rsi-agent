/**
 * 精修工作台 v1（T3b，2026-11-14）：motionharness「工作台」的 CLI 等价物第一版。
 *
 * 零依赖 node:http——不做前端工程，先给 agent 与人一个「可寻址、可读写」的 HTTP 面：
 *   GET  /                     状态页（镜头表 + 审计摘要 + 版本史入口）
 *   GET  /api/state            project.json 全量
 *   GET  /api/logs/:name       logs/<name>（validation.log / motion-audit.json / continuity-audit.json…）
 *   GET  /scene/:id            scenes/Scene_<id>.html 原文
 *   GET  /api/versions/:shot   该镜版本史
 *   POST /api/revise           {shot, note?|coverage?} → 复用 revise 的持久化语义
 *   POST /api/rollback         {shot, to} → 回滚到版本史条目
 *
 * marker 定点改（浏览器内点选元素回写）是 workbench v2，需要前端工程，不在这版。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../infrastructure/project-store.js';
import { StyleRegistry } from '../domain/style-registry.js';
import { mvError, ERR } from '../core/errors.js';
import { exists, readJson } from '../infrastructure/fs-utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function send(res: http.ServerResponse, code: number, body: string, type = 'application/json; charset=utf-8'): void {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface BenchOptions {
  project?: string;
  port?: number;
}

export async function startBench(opts: BenchOptions): Promise<void> {
  const store = new ProjectStore(ROOT);
  const registry = new StyleRegistry(ROOT);
  await registry.load();
  const id = await store.resolveProjectId(opts.project);
  const port = opts.port ?? 8788;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const p = url.pathname;
    try {
      const project = await store.load(id);
      const dir = store.projectDir(id);

      if (req.method === 'GET' && p === '/') {
        const rows = project.shots
          .map(
            (s) =>
              `<tr><td>${s.id}</td><td>${s.zoom}</td><td>${s.camera}</td><td>${s.state}</td>` +
              `<td>${((s.visual.params['actionSheet'] as { grammar?: string } | undefined)?.grammar ?? '-')}</td>` +
              `<td>${(s.coverage ?? []).length} 覆盖切</td></tr>`,
          )
          .join('');
        send(
          res,
          200,
          `<!doctype html><meta charset="utf-8"><title>bench · ${id}</title>` +
            `<body style="font-family:system-ui;background:#111;color:#eee;padding:24px">` +
            `<h1>${project.meta.title}</h1><p>stage=${project.stage} · shots=${project.shots.length} · style=${project.style?.id ?? '-'}</p>` +
            `<table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>镜</th><th>景别</th><th>机位</th><th>状态</th><th>语法</th><th>剪辑修订</th></tr>${rows}</table>` +
            `<p>API：/api/state · /api/logs/validation.log · /scene/s01a · /api/versions/s01a · POST /api/revise · POST /api/rollback</p></body>`,
          'text/html; charset=utf-8',
        );
        return;
      }
      if (req.method === 'GET' && p === '/api/state') {
        send(res, 200, JSON.stringify(project, null, 2));
        return;
      }
      const logMatch = p.match(/^\/api\/logs\/([\w.-]+)$/);
      if (req.method === 'GET' && logMatch) {
        const file = path.join(dir, 'logs', logMatch[1]!);
        if (!exists(file)) {
          send(res, 404, JSON.stringify({ error: `日志不存在: ${logMatch[1]}` }));
          return;
        }
        const text = await import('node:fs/promises').then((m) => m.readFile(file, 'utf8'));
        send(res, 200, JSON.stringify({ name: logMatch[1], text }, null, 2));
        return;
      }
      const sceneMatch = p.match(/^\/scene\/([\w-]+)$/);
      if (req.method === 'GET' && sceneMatch) {
        const file = path.join(dir, 'scenes', `Scene_${sceneMatch[1]}.html`);
        if (!exists(file)) {
          send(res, 404, JSON.stringify({ error: `场景不存在: ${sceneMatch[1]}` }));
          return;
        }
        const html = await import('node:fs/promises').then((m) => m.readFile(file, 'utf8'));
        send(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
      const verMatch = p.match(/^\/api\/versions\/([\w-]+)$/);
      if (req.method === 'GET' && verMatch) {
        const listFile = path.join(dir, 'scenes', '.history', 'versions.json');
        const list = exists(listFile)
          ? await readJson<Array<{ shot: string; file: string; at: string; cause: string }>>(listFile)
          : [];
        send(res, 200, JSON.stringify({ shot: verMatch[1], versions: list.filter((e) => e.shot === verMatch[1]) }, null, 2));
        return;
      }
      if (req.method === 'POST' && p === '/api/revise') {
        const body = JSON.parse(await readBody(req)) as { shot?: string; note?: string; coverage?: string };
        if (!body.shot) throw mvError(ERR.VALIDATION, '缺少 shot');
        const shot = project.shots.find((s) => s.id === body.shot);
        if (!shot) throw mvError(ERR.PROJECT_NOT_FOUND, `镜头不存在: ${body.shot}`);
        const revised: Record<string, unknown> = { shot: body.shot };
        if (body.note) {
          const params = { ...shot.visual.params } as Record<string, unknown>;
          const revisions = Array.isArray(params['revisions'])
            ? (params['revisions'] as Array<{ at: string; note: string }>)
            : [];
          revisions.push({ at: new Date().toISOString(), note: body.note });
          params['revisions'] = revisions;
          shot.visual.params = params;
          revised.revisions = revisions;
        }
        if (body.coverage) {
          let extra: Array<Record<string, unknown>> = [];
          try {
            const parsed = JSON.parse(body.coverage);
            if (!Array.isArray(parsed)) throw new Error('coverage 必须是数组');
            extra = parsed;
          } catch (e) {
            throw mvError(ERR.VALIDATION, `coverage 不是合法 JSON 数组: ${(e as Error).message}`);
          }
          const coverage = Array.isArray(shot.coverage) ? [...shot.coverage] : [];
          for (const c of extra) {
            coverage.push({
              at: Math.min(1, Math.max(0, Number(c['at'] ?? 0))),
              kind: c['kind'] === 'reframe' ? ('reframe' as const) : ('punch-in' as const),
              scale: Number(c['scale'] ?? 1.16),
              xPercent: Number(c['xPercent'] ?? 0),
              yPercent: Number(c['yPercent'] ?? 0),
              rotation: Number(c['rotation'] ?? 0),
              motivation: String(c['motivation'] ?? 'emphasis'),
            });
          }
          if (coverage.length > 3) throw mvError(ERR.VALIDATION, `覆盖切最多 3 条（当前 ${coverage.length}）`);
          shot.coverage = coverage;
          revised.coverage = coverage;
        }
        project.timeline = undefined;
        await store.save(project);
        send(res, 200, JSON.stringify({ ok: true, ...revised }, null, 2));
        return;
      }
      if (req.method === 'POST' && p === '/api/rollback') {
        const body = JSON.parse(await readBody(req)) as { shot?: string; to?: string };
        if (!body.shot || !body.to) throw mvError(ERR.VALIDATION, '缺少 shot/to');
        const { rollbackScene } = await import('../domain/scene-forge.js');
        const dest = await rollbackScene(dir, body.shot, body.to);
        send(res, 200, JSON.stringify({ ok: true, shot: body.shot, rolledBackTo: dest }, null, 2));
        return;
      }
      send(res, 404, JSON.stringify({ error: `无此路由: ${req.method} ${p}` }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: (e as Error).message }, null, 2));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  // 长驻服务：进程保持，Ctrl-C 退出。输出指向 stdout，agent 可直接读。
  console.log(`[bench] 精修工作台已启动: http://localhost:${port}/  (project=${id})`);
}
