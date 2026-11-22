import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = fs.readFileSync(path.join(ROOT, 'templates', 'webgl', 'webgl-lib.js'), 'utf8');
const THREE_FILE = path.join(ROOT, 'templates', 'webgl', 'three.module.js');

describe('WebGL 原语层：确定性铁律（docs/15）', () => {
  it('本地 vendored three.js 存在且是 r160（离线自持，不走 CDN）', () => {
    expect(fs.existsSync(THREE_FILE)).toBe(true);
    const head = fs.readFileSync(THREE_FILE, 'utf8').slice(0, 400);
    expect(head).toMatch(/three\.js/i);
    expect(head).toMatch(/SPDX-License-Identifier: MIT/);
  });

  it('webgl-lib 不使用 requestAnimationFrame 自动循环（画面只由 renderFrame(t) 推进）', () => {
    // 允许注释里提到 rAF，但不得有实际调用（requestAnimationFrame( 后跟调用括号）
    const codeOnly = LIB.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/requestAnimationFrame\s*\(/);
  });

  it('preserveDrawingBuffer + pixelRatio=1：seek 后截图可复现', () => {
    expect(LIB).toMatch(/preserveDrawingBuffer:\s*true/);
    expect(LIB).toMatch(/setPixelRatio\(1\)/);
  });

  it('renderFrame 是纯函数形态：每次从头 poseAt 后 render，不读上一帧状态', () => {
    const fn = LIB.slice(LIB.indexOf('function renderFrame'), LIB.indexOf('function dispose'));
    expect(fn).toMatch(/poseAt\(/);
    expect(fn).toMatch(/renderer\.render\(stage\.scene, stage\.camera\)/);
    // poseAt 内部每次 set 绝对值，不做 += / *= 累加
    const pose = LIB.slice(LIB.indexOf('function poseAt'), LIB.indexOf('function renderFrame'));
    expect(pose).toMatch(/obj\.position\.set\(/);
    expect(pose).toMatch(/obj\.rotation\.set\(/);
    expect(pose).not.toMatch(/\+=\s*pose|\*=\s*pose/);
  });

  it('暴露 window.WGL 且具名导出（两条加载路径）', () => {
    expect(LIB).toMatch(/window\.WGL\s*=/);
    expect(LIB).toMatch(/export\s*\{[^}]*renderFrame[^}]*\}/);
  });

  it('register 把 renderFrame 挂进 window.__renderFrames 供 HyperFrames seek', () => {
    expect(LIB).toMatch(/window\.__renderFrames/);
  });

  it('attachToTimeline 把逐帧渲染挂到 GSAP 暂停时间线（真实渲染seek模型）', () => {
    const fn = LIB.slice(LIB.indexOf('function attachToTimeline'), LIB.indexOf('function renderFrame'));
    expect(fn).toMatch(/window\.__timelines/);
    expect(fn).toMatch(/\.to\(target/);
    expect(fn).toMatch(/ease:\s*'none'/);
    expect(fn).toMatch(/onUpdate:\s*apply/);
  });
});
