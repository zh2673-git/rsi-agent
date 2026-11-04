import path from 'node:path';
import {
  ProjectSchema,
  type Project,
  type ProjectMeta,
} from '../core/schema.js';
import { PROJECTS_DIR, SCHEMA_VERSION } from '../core/constants.js';
import { mvError, ERR } from '../core/errors.js';
import {
  atomicWriteJson,
  ensureDir,
  exists,
  listSubdirs,
  readJson,
  rmrf,
  slugify,
} from './fs-utils.js';

export interface InitOptions {
  topic: string;
  id?: string;
  aspect?: ProjectMeta['aspect'];
  durationTier?: ProjectMeta['durationTier'];
  genre?: ProjectMeta['genre'];
  assetPolicy?: ProjectMeta['assetPolicy'];
}

export class ProjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  projectsDir(): string {
    return path.join(this.root, PROJECTS_DIR);
  }

  projectDir(id: string): string {
    return path.join(this.projectsDir(), id);
  }

  projectFile(id: string): string {
    return path.join(this.projectDir(id), 'project.json');
  }

  async listProjects(): Promise<string[]> {
    return (await listSubdirs(this.projectsDir())).sort();
  }

  async initProject(opts: InitOptions): Promise<Project> {
    const id = opts.id ?? `${slugify(opts.topic)}-${Date.now().toString(36)}`;
    const dir = this.projectDir(id);
    if (exists(dir)) {
      throw mvError(ERR.PROJECT_EXISTS, `项目已存在: ${id}`);
    }
    const now = new Date().toISOString();
    const project: Project = {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        id,
        title: opts.topic.slice(0, 40),
        topic: opts.topic,
        aspect: opts.aspect ?? '16:9',
        durationTier: opts.durationTier ?? '0-5',
        fps: 30,
        genre: opts.genre ?? 'science-explainer',
        assetPolicy: opts.assetPolicy ?? 'auto',
        aiConsent: false,
      },
      stage: 'init',
      directorNotes: [],
      shots: [],
      materialDecisions: {},
      confirmed: false,
    };
    await ensureDir(path.join(dir, 'scenes', 'shared'));
    await ensureDir(path.join(dir, 'materials'));
    await ensureDir(path.join(dir, 'assets'));
    await ensureDir(path.join(dir, 'audio', 'vo'));
    await ensureDir(path.join(dir, 'audio', 'bgm'));
    await ensureDir(path.join(dir, 'audio', 'sfx'));
    await ensureDir(path.join(dir, 'out'));
    await ensureDir(path.join(dir, 'logs'));
    await ensureDir(path.join(dir, 'cache'));
    await ensureDir(path.join(dir, 'remotion', 'compositions'));
    await atomicWriteJson(this.projectFile(id), project);
    await atomicWriteJson(path.join(dir, 'materials', 'index.json'), { items: [] });
    return project;
  }

  async load(id: string): Promise<Project> {
    const file = this.projectFile(id);
    if (!exists(file)) {
      throw mvError(ERR.PROJECT_NOT_FOUND, `项目不存在: ${id}`);
    }
    const raw = await readJson<unknown>(file);
    const parsed = ProjectSchema.safeParse(raw);
    if (!parsed.success) {
      throw mvError(ERR.SCHEMA, `project.json 校验失败: ${parsed.error.message}`, parsed.error);
    }
    if (parsed.data.schemaVersion > SCHEMA_VERSION) {
      throw mvError(
        ERR.SCHEMA_VERSION,
        `项目 schema 版本 ${parsed.data.schemaVersion} 高于本程序 ${SCHEMA_VERSION}`,
      );
    }
    return parsed.data;
  }

  async save(project: Project): Promise<void> {
    const parsed = ProjectSchema.safeParse(project);
    if (!parsed.success) {
      throw mvError(ERR.SCHEMA, `拒绝写入非法 IR: ${parsed.error.message}`, parsed.error);
    }
    await atomicWriteJson(this.projectFile(project.meta.id), parsed.data);
  }

  async clean(id: string): Promise<{ freed: string[] }> {
    const dir = this.projectDir(id);
    if (!exists(dir)) {
      throw mvError(ERR.PROJECT_NOT_FOUND, `项目不存在: ${id}`);
    }
    const freed: string[] = [];
    for (const sub of ['cache', 'assets', 'audio', 'scenes', 'remotion']) {
      const target = path.join(dir, sub);
      if (exists(target)) {
        await rmrf(target);
        if (!exists(target)) freed.push(sub);
      }
    }
    await ensureDir(path.join(dir, 'scenes', 'shared'));
    await ensureDir(path.join(dir, 'assets'));
    await ensureDir(path.join(dir, 'audio', 'vo'));
    await ensureDir(path.join(dir, 'audio', 'bgm'));
    await ensureDir(path.join(dir, 'audio', 'sfx'));
    await ensureDir(path.join(dir, 'remotion', 'compositions'));
    return { freed };
  }

  async resolveProjectId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const all = await this.listProjects();
    if (all.length === 1 && all[0]) return all[0];
    if (all.length === 0) {
      throw mvError(ERR.PROJECT_NOT_FOUND, '没有任何项目，请先 make-video init');
    }
    throw mvError(
      ERR.PROJECT_NOT_FOUND,
      `存在多个项目，请用 --project 指定: ${all.join(', ')}`,
    );
  }
}
