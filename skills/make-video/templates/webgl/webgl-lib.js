/**
 * webgl-lib.js — 确定性 WebGL/three.js 原语层（make-video docs/15）
 *
 * 铁律（与 canvas-lib.js 同源）：
 *   1. 一切随机走种子（复用 window.CV.mulberry32），渲染器按帧 seek；
 *   2. **没有 requestAnimationFrame 自动循环**——画面只由 renderFrame(stage, t) 显式推进；
 *   3. renderFrame 是纯函数：同一 stage、同一 t，任意调用顺序画面一致（SHA256 稳定）。
 *
 * 为什么不稳的是「rAF 自然推进 + 到点截图」的写法，而不是 WebGL 本身：
 * 显式 t → 场景状态 → 一次 renderer.render，就与 GSAP 暂停时间线一样可复现。
 * 证据：outputs/webgl-feasibility-evidence.json（T-20261122-11）。
 *
 * 这是 ES module，依赖同目录 three.module.js（本地自持，不走 CDN）。
 */
import * as THREE from './three.module.js';

const DEG = Math.PI / 180;

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
function seeded(seed) {
  // 优先复用 2D 库的种子函数，保证 2D/3D 同源；否则内联兜底。
  if (typeof window !== 'undefined' && window.CV && window.CV.mulberry32) return window.CV.mulberry32(seed);
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 创建舞台。opts:
 *   { width, height, background, seed, antialias }
 * 返回 stage = { renderer, scene, camera, objects, opts }。
 * 关键：preserveDrawingBuffer=true + pixelRatio=1，保证截图可复现。
 */
function createStage(opts = {}) {
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const renderer = new THREE.WebGLRenderer({
    antialias: opts.antialias === true,
    preserveDrawingBuffer: true, // seek 后截图必须有内容
    alpha: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  const canvas = renderer.domElement;
  if (opts.mount) opts.mount.appendChild(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background != null ? opts.background : 0x0a1020);
  const camera = new THREE.PerspectiveCamera(opts.fov || 50, width / height, 0.1, 100);
  camera.position.set(0, 0, opts.cameraZ || 4);
  camera.lookAt(0, 0, 0);
  const stage = {
    renderer, scene, camera,
    objects: {},
    opts: { width, height, seed: opts.seed == null ? 20261122 : opts.seed },
  };
  // 环境光默认给一盏，避免 MeshStandard 材质全黑；作者可自行增删。
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(2, 3, 4);
  scene.add(key);
  return stage;
}

/** 加一个立方体母题，返回 mesh（供 poseAt 定位） */
function addBox(stage, name, opts = {}) {
  const geo = new THREE.BoxGeometry(opts.w || 1.6, opts.h || 1.6, opts.d || 1.6);
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color != null ? opts.color : 0x33ccff,
    roughness: opts.roughness != null ? opts.roughness : 0.45,
    metalness: opts.metalness != null ? opts.metalness : 0.15,
    transparent: opts.opacity != null && opts.opacity < 1,
    opacity: opts.opacity != null ? opts.opacity : 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  stage.scene.add(mesh);
  if (name) stage.objects[name] = mesh;
  return mesh;
}

/** 加一个球母题 */
function addSphere(stage, name, opts = {}) {
  const geo = new THREE.SphereGeometry(opts.r || 1, opts.widthSegments || 32, opts.heightSegments || 24);
  const mat = new THREE.MeshStandardMaterial({
    color: opts.color != null ? opts.color : 0xffaa33,
    roughness: opts.roughness != null ? opts.roughness : 0.4,
    metalness: opts.metalness != null ? opts.metalness : 0.2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
  stage.scene.add(mesh);
  if (name) stage.objects[name] = mesh;
  return mesh;
}

/**
 * 种子粒子云（星野/尘埃）：位置只由种子决定，与时间无关；运动由 poseAt 的 spin 提供。
 */
function addPoints(stage, name, opts = {}) {
  const count = opts.count || 500;
  const rnd = seeded(opts.seed != null ? opts.seed : stage.opts.seed);
  const positions = new Float32Array(count * 3);
  const spread = opts.spread || 12;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rnd() - 0.5) * spread;
    positions[i * 3 + 1] = (rnd() - 0.5) * spread;
    positions[i * 3 + 2] = (rnd() - 0.5) * spread;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: opts.color != null ? opts.color : 0xffffff,
    size: opts.size || 0.05,
    transparent: true,
    opacity: opts.opacity != null ? opts.opacity : 0.85,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  stage.scene.add(pts);
  if (name) stage.objects[name] = pts;
  return pts;
}

/**
 * 给某个对象设置「由 t 唯一决定」的姿态。描述对象是纯数据，poseAt 每次从头 set，
 * 不依赖上一帧状态——这是 renderFrame 纯函数的关键。
 * pose: { x,y,z, rotX,rotY,rotZ (度), scale, spin:{x,y,z}(度/秒) }
 */
function poseAt(obj, t, pose = {}) {
  if (!obj) return;
  const spin = pose.spin || {};
  obj.position.set(pose.x || 0, pose.y || 0, pose.z || 0);
  const rx = (pose.rotX || 0) + (spin.x || 0) * t;
  const ry = (pose.rotY || 0) + (spin.y || 0) * t;
  const rz = (pose.rotZ || 0) + (spin.z || 0) * t;
  obj.rotation.set(rx * DEG, ry * DEG, rz * DEG);
  const s = pose.scale == null ? 1 : pose.scale;
  obj.scale.set(s, s, s);
}

/**
 * 把 WebGL 逐帧渲染挂到 make-video 的 GSAP 暂停时间线上（HyperFrames 实际 seek 的模型）。
 * 场景模块构造完 stage/frames 后调用：HyperFrames seek __timelines[id] → tween.onUpdate →
 * renderFrame(t) → 画面由 t 唯一决定。durationS 内 t 从 0 线性走到 durationS。
 *
 * frames 可为对象，或 (t)=>对象（需要轨道位移等随时间变化的 pose 时用函数形态）。
 */
function attachToTimeline(stage, frames, durationS, timelineId) {
  if (typeof window === 'undefined' || !window.gsap) return null;
  const tl = timelineId && window.__timelines ? window.__timelines[timelineId] : null;
  if (!tl) return null;
  const target = { t: 0 };
  const apply = () => renderFrame(stage, target.t, typeof frames === 'function' ? frames(target.t) : frames);
  tl.to(target, { t: durationS, ease: 'none', duration: durationS, onUpdate: apply }, 0);
  apply(); // 立即渲染 t=0，避免首帧空白
  return target;
}

/**
 * 确定性逐帧渲染：frames 是 [{ object, pose }] 或 name→pose 映射。
 * 同一 stage + 同一 t，任意乱序/重复调用，输出逐像素一致。
 */
function renderFrame(stage, t, frames) {
  if (frames) {
    if (Array.isArray(frames)) {
      for (const f of frames) poseAt(f.object, t, f.pose);
    } else {
      for (const [name, pose] of Object.entries(frames)) poseAt(stage.objects[name], t, pose);
    }
  }
  stage.renderer.render(stage.scene, stage.camera);
  return stage.renderer.domElement;
}

/** 释放 GPU 资源（切换场景/重渲染时调用） */
function dispose(stage) {
  if (!stage) return;
  stage.scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.dispose();
    }
  });
  stage.renderer.dispose();
}

/** 供 HyperFrames seek 用：把 renderFrame 注册到 window.__renderFrames[id] */
function register(id, stage, frames) {
  if (typeof window === 'undefined') return;
  window.__renderFrames = window.__renderFrames || {};
  window.__renderFrames[id] = (t) => renderFrame(stage, t, frames);
}

window.WGL = {
  THREE,
  createStage,
  addBox,
  addSphere,
  addPoints,
  poseAt,
  renderFrame,
  attachToTimeline,
  dispose,
  register,
  seeded,
  lerp,
  smooth,
  clamp01,
};

// 既挂 window.WGL（场景可用全局），也具名导出（场景可 `import { renderFrame } from '../webgl/webgl-lib.js'`）。
// 两条路并存，避免 ESM 模块执行顺序导致 window.WGL 尚未就位。
export { THREE, createStage, addBox, addSphere, addPoints, poseAt, renderFrame, attachToTimeline, dispose, register, seeded, lerp, smooth, clamp01 };
