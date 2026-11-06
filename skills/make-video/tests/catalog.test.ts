/**
 * 能力地图的防腐断言（2026-02 新增）。
 *
 * 为什么单独一个测试文件：本项目的失效模式从来不是「写错代码」，而是
 * **三份手写清单互相漂移**——白名单加了原语但 motion-lib 没实现（静默走 else）、
 * 文档写「九种语法」实际 11 种、SKILL 菜单列 16 个风格但 styles/ 只有 9 个包。
 * 这类错误 tsc 与功能测试都抓不到，只有「拿两份清单对表」才能抓。
 *
 * 三条断言对应三个已发生的真实事故：
 *   ① 白名单 ↔ motion-lib 实现：钉住「有词无实现」静默降级
 *   ② 语法 ↔ 骨架/收势登记：钉住新增语法漏登记（以前是 `?? 默认值` 静默兜底）
 *   ③ 文档声明 ↔ 实际数量：钉住文档虚标（数字一律不手写，交给断言）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRAMMAR_IDS,
  MAIN_ACTION_PRIMITIVES,
  NON_ACTION_PRIMITIVES,
  buildCapability,
} from '../src/core/catalog.js';
import { REQUIRED_BY_GRAMMAR, SETTLE_BY_GRAMMAR } from '../src/domain/motion-grammar.js';
import { ACCENT_PRIMITIVES, CAMERA_MOVES, MOTION_WHITELIST } from '../src/core/validators/scene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

describe('① 白名单 ↔ motion-lib 实现（钉住「有词无实现」静默降级）', () => {
  const lib = read('templates/motion/motion-lib.js');

  it('白名单里每个原语在 motion-lib.js 都有 `MV.x = function` 实现', () => {
    const missing = MOTION_WHITELIST.filter(
      (p) => !new RegExp(`MV\\.${p.slice(3)}\\s*=\\s*function`).test(lib),
    );
    expect(missing, `白名单有、motion-lib 没实现（会静默走 else）：${missing.join(', ')}`).toEqual([]);
  });

  it('motion-lib.js 的每个 `MV.x = function` 都在白名单里（钉住反向漏登记）', () => {
    const implemented = [...lib.matchAll(/MV\.([a-zA-Z][a-zA-Z0-9]*)\s*=\s*function/g)].map(
      (m) => `MV.${m[1]}`,
    );
    const unlisted = implemented.filter((p) => !MOTION_WHITELIST.includes(p));
    expect(
      unlisted,
      `motion-lib 实现了但白名单没登记（校验器会拦下合法调用）：${unlisted.join(', ')}`,
    ).toEqual([]);
  });

  it('主动作名单 = 白名单 − 非主动作，且非主动作都在白名单里', () => {
    const stray = (NON_ACTION_PRIMITIVES as readonly string[]).filter(
      (p) => !MOTION_WHITELIST.includes(p),
    );
    expect(stray, `NON_ACTION_PRIMITIVES 里有白名单外的名字：${stray.join(', ')}`).toEqual([]);
    expect(MAIN_ACTION_PRIMITIVES.length + NON_ACTION_PRIMITIVES.length).toBe(
      MOTION_WHITELIST.length,
    );
    expect(MAIN_ACTION_PRIMITIVES).toContain('MV.drift');
  });

  it('composer 的 hasMain 判据覆盖全部主动作原语（含 drift，历史漏项）', () => {
    const composer = read('src/domain/composer.ts');
    expect(composer).toContain('MAIN_ACTION_RE');
    expect(composer).not.toMatch(/MV\\\.\(enter\|slam\|staggeredIn/);
  });
});

describe('② 语法 ↔ 骨架/收势登记（钉住新增语法漏登记）', () => {
  it('GRAMMARS 每条语法都在 REQUIRED_BY_GRAMMAR 里', () => {
    const missing = GRAMMAR_IDS.filter((id) => !REQUIRED_BY_GRAMMAR[id]);
    expect(
      missing,
      `语法没登记必选原语骨架（会退化成「只有 motifLoop」且无人知道）：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('GRAMMARS 每条语法都在 SETTLE_BY_GRAMMAR 里', () => {
    const missing = GRAMMAR_IDS.filter((id) => !SETTLE_BY_GRAMMAR[id]);
    expect(missing, `语法没登记收势措辞（会静默变成「减速落定」）：${missing.join(', ')}`).toEqual([]);
  });

  it('骨架表里没有已删除语法的幽灵条目', () => {
    const ghosts = Object.keys(REQUIRED_BY_GRAMMAR).filter((id) => !GRAMMAR_IDS.includes(id));
    expect(ghosts, `REQUIRED_BY_GRAMMAR 里有不存在的语法：${ghosts.join(', ')}`).toEqual([]);
  });

  it('每条语法的骨架原语都必须存在于白名单，且必含 motifLoop', () => {
    const bad: string[] = [];
    for (const [id, prims] of Object.entries(REQUIRED_BY_GRAMMAR)) {
      for (const p of prims) if (!MOTION_WHITELIST.includes(p)) bad.push(`${id}→${p}`);
      if (!prims.includes('MV.motifLoop')) bad.push(`${id}→缺 motifLoop`);
    }
    expect(bad, `骨架点名了白名单外的原语或漏了 motifLoop：${bad.join(', ')}`).toEqual([]);
  });

  it('重音原语都在白名单里（ACCENT_PRIMITIVES 是白名单子集）', () => {
    const stray = (ACCENT_PRIMITIVES as readonly string[]).filter(
      (p) => !MOTION_WHITELIST.includes(p),
    );
    expect(stray).toEqual([]);
  });

  it('机位词表与 motion-lib 的 if 分支一致（拼错会静默 set scale）', () => {
    const lib = read('templates/motion/motion-lib.js');
    const branches = new Set(
      [...lib.matchAll(/move === '([a-z-]+)'/g)].map((m) => m[1] as string),
    );
    // motion-lib 里 static/none 走同一个分支，drift 各自独立
    const missing = CAMERA_MOVES.filter(
      (m) => !branches.has(m) && !(m === 'none' && branches.has('static')),
    );
    expect(missing, `机位词在白名单但 motion-lib 没分支：${missing.join(', ')}`).toEqual([]);
  });
});

describe('③ 文档声明 ↔ 实际数量（钉住文档虚标）', () => {
  const cap = buildCapability();

  /**
   * 只校验**带数字的硬声明**。措辞类（"九种"）由人工改一次即可，
   * 这里钉住的是容易被复制粘贴带偏的写法：`N 种语法` / `N 个动效原语`。
   */
  it('SKILL.md 若有「N 种语法」，N 必须等于实际语法数', () => {
    const doc = read('SKILL.md');
    const m = doc.match(/([一二三四五六七八九十百\d]+)\s*种(?:镜头)?语法/);
    if (!m) return; // 不写数字就不校验（推荐做法）
    const zh: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
    };
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : zh[m[1]!];
    expect(n, `SKILL.md 声称 ${m[1]} 种语法，实际 ${cap.version.grammars} 种`).toBe(
      cap.version.grammars,
    );
  });

  it('SKILL.md/README 若有「N 个动效原语」，N 必须等于实际原语数', () => {
    const zh: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
      十三: 13, 十四: 14, 十五: 15, 二十: 20, 二十四: 24, 二十五: 25, 二十六: 26,
    };
    for (const doc of ['SKILL.md', 'README.md']) {
      if (!existsSync(path.join(ROOT, doc))) continue;
      const m = read(doc).match(/([一二三四五六七八九十百\d]+)\s*个(?:动效)?原语/);
      if (!m) continue;
      const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : zh[m[1]!];
      expect(n, `${doc} 声称 ${m[1]} 个原语，实际 ${cap.version.primitives} 个`).toBe(
        cap.version.primitives,
      );
    }
  });

  it('SKILL.md 风格菜单里点名的风格 id 必须都真实存在（钉住幽灵风格）', () => {
    const doc = read('SKILL.md');
    const styleDir = path.join(ROOT, 'styles');
    const real = new Set(
      readdirSync(styleDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(path.join(styleDir, f), 'utf8')).id as string),
    );
    // 只扫风格菜单那一段：从「## 风格菜单」到下一个二级标题，避免把正文里的
    // CLI 参数、CSS 属性（preserve-3d）、命令名（material-plan）误判成风格 id。
    const menu = doc.split('## 风格菜单')[1]?.split('\n## ')[0] ?? '';
    expect(menu, 'SKILL.md 里找不到「## 风格菜单」段').not.toBe('');
    // 菜单表格第 2 列 = style id
    const claimed = [...menu.matchAll(/^\|[^|\n]*\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1] as string);
    expect(claimed.length, '风格菜单表格没解析出任何 style id').toBeGreaterThan(0);
    const ghosts = claimed.filter((id) => !real.has(id));
    expect(ghosts, `SKILL.md 菜单点名了不存在的风格 id（会 STYLE_UNKNOWN）：${ghosts.join(', ')}`).toEqual(
      [],
    );
  });

  it('styles/ 里每个真实风格包都在 SKILL.md 菜单里（钉住反向漏收录）', () => {
    const doc = read('SKILL.md');
    const styleDir = path.join(ROOT, 'styles');
    const real = readdirSync(styleDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(styleDir, f), 'utf8')).id as string);
    const menu = doc.split('## 风格菜单')[1]?.split('\n## ')[0] ?? '';
    const unlisted = real.filter((id) => !menu.includes(`\`${id}\``));
    expect(unlisted, `存在风格包但菜单没收录（用户说不出名字就选不到）：${unlisted.join(', ')}`).toEqual(
      [],
    );
  });
});
