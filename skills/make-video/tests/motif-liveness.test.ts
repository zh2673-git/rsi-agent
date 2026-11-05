import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'templates/motion/motion-lib.js');
const SCENES = path.join(ROOT, 'templates/scenes');

const libSrc = fs.readFileSync(LIB, 'utf8');

/** 从源码里抽出 MOTIF_KINDS 表实现了哪些 kind */
function implementedKinds(): string[] {
  const i = libSrc.indexOf('var MOTIF_KINDS');
  const j = libSrc.indexOf('MV.motifLoop = function');
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return [...libSrc.slice(i, j).matchAll(/^\s{4}([a-z]+):\s*function/gm)].map((m) => m[1]);
}

describe('母题循环：画面必须一直是活的', () => {
  it('MOTIF_KINDS 已挂到 MV 上，可被场景与测试查询', () => {
    expect(libSrc).toMatch(/MV\.MOTIF_KINDS\s*=\s*MOTIF_KINDS/);
  });

  it('模板里用到的每个 motif kind 都真的实现了', () => {
    // 回归：2026-11-05 之前模板写了 sweep/breathe/scan/drain/compress/settle/drift，
    // 库里只实现 float/pulse/rotate/shimmer，其余静默落进 else 变成 ±1.6px 位移，
    // 成片实测静止帧 88-93%——「画面死了」。这条测试就是钉住这个坑。
    const impl = implementedKinds();
    const files = fs.readdirSync(SCENES).filter((f) => f.endsWith('.html'));
    expect(files.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const f of files) {
      const html = fs.readFileSync(path.join(SCENES, f), 'utf8');
      for (const m of html.matchAll(/motifLoop\([^)]*kind:\s*'([A-Za-z]+)'/g)) {
        if (!impl.includes(m[1])) missing.push(`${f}:${m[1]}`);
      }
    }
    expect(missing, `未实现的 motif kind: ${missing.join(', ')}`).toEqual([]);
  });

  it('母题振幅看得见：位移量级不能只有几个像素', () => {
    // float 的位移是 amp*6(px)。amp=0.32 时只有 ±1.9px，720p 下等同静止。
    const m = libSrc.match(/motif:\s*\{\s*dur:\s*[\d.]+,\s*amp:\s*([\d.]+)\s*\}/);
    expect(m).toBeTruthy();
    const amp = parseFloat(m![1]);
    expect(amp).toBeGreaterThanOrEqual(0.6);
    expect(amp * 6).toBeGreaterThanOrEqual(3.6);
  });

  it('未知 kind 走显式告警，不静默降级', () => {
    expect(libSrc).toMatch(/if\s*\(!MOTIF_KINDS\[kind\]\)/);
    expect(libSrc).toMatch(/console\.warn/);
  });
});

describe('重音预算不被模板绕过（V-MOT-013）', () => {
  const ACCENT = /MV\.(slam|punch|whip)\s*\(/;

  it('除 keyframe 守卫外的重音原语调用，必须落在 accent 条件里', () => {
    // 回归：deep-stage 曾把 MV.punch('.stage') 写在 if (accent) 之外，
    // 等于每镜都推一次——composer 按 data-accent 数出来的预算全被绕过，
    // 成片就是「整片一直放大 + 每句都强调」= 没有强调。
    const files = fs.readdirSync(SCENES).filter((f) => f.endsWith('.html'));
    const offenders: string[] = [];
    // 守卫的两种合法写法：
    //   if (accent) ...            —— 运行时读 data-accent
    //   if ('{{ACCENT_FLAG}}' === '1') ... —— 模板变量注入（生成期就决定）
    const GUARD_OPEN = /if\s*\(\s*(accent\b|'?\{\{ACCENT_FLAG\}\}'?\s*===)/;
    for (const f of files) {
      const lines = fs.readFileSync(path.join(SCENES, f), 'utf8').split(/\r?\n/);
      let guardDepth = 0;
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const opensGuard = GUARD_OPEN.test(L);
        // 单行守卫：if (accent) MV.punch(...) —— 同一条语句自带守卫
        const inlineGuarded = opensGuard && ACCENT.test(L);
        if (opensGuard) guardDepth = 1;
        if (ACCENT.test(L) && guardDepth === 0 && !inlineGuarded) {
          offenders.push(`${f}:${i + 1} ${L.trim()}`);
        }
        if (guardDepth > 0 && /^\s*\}\s*else/.test(L)) guardDepth = 0;
        else if (guardDepth > 0 && /^\s*\}\s*$/.test(L)) guardDepth = 0;
      }
    }
    expect(offenders, `重音原语逃出 accent 守卫:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('punch 不推整屏容器（推 .stage 等于整片永久放大）', () => {
    const files = fs.readdirSync(SCENES).filter((f) => f.endsWith('.html'));
    const bad: string[] = [];
    for (const f of files) {
      const html = fs.readFileSync(path.join(SCENES, f), 'utf8');
      if (/MV\.punch\(\s*['"]\.(stage|scene|root)['"]/.test(html)) bad.push(f);
    }
    expect(bad, `punch 推整屏容器: ${bad.join(', ')}`).toEqual([]);
  });
});
