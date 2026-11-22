# 15 · WebGL/three.js 原语层：可行性反转与实施契约（2026-11-22）

> 状态：实施中。任务 `T-20261122-12`。结论先行：P13 阶段 0–5 已全部完成，唯一未做的方向是
> WebGL/three.js。PLAN.md §P13 曾把 WebGL 作为「快照不稳定」的拒绝选项——本轮以实测证伪该前提，
> 并把 WebGL 收编为**与 canvas-lib 对等的确定性原语层**，不改变 3D 契约、不引入渲染不确定性。

## 1. 为什么现在能做：证伪「快照不稳定」

试验（`T-20261122-11`，证据 `outputs/webgl-feasibility-evidence.json`）在 three.js 0.160 + Chromium 上实测：

- 同一时间 `t`，乱序 / 重复 `renderFrame(t)` 的画面 SHA256 完全一致；
- 4 个不同 `t` 得到 4 张不同、非空白画面；
- 零 pageError。

**根因**：不确定性不来自 WebGL 本身，而来自「用 requestAnimationFrame 自然推进 + 到点截图」的写法。
只要把渲染改成**显式 `renderFrame(t)` 纯函数**（场景状态只由 t 决定、与调用顺序无关），
WebGL 快照就与 GSAP 暂停时间线一样可复现。这与本项目既有的「逐帧 seek 纯函数」铁律同构。

## 2. 不改变 3D 契约（重要边界）

- `visuals.dimension` 的枚举（`2d | css3d | mixed`）**不变**；WebGL 是 `css3d`/`mixed` 的**可选渲染实现**，
  不是新维度。2D 场景仍可用 WebGL 做程序化背景，但不因此自动变成 3D。
- `V-STYLE-008` 语义**不变**：它逐镜 warn「声明的维度与实际素材语言是否一致」，
  不是「禁 3D」。WebGL 原语沿用 `uses3d()` 的识别口径（见 §4）。
- 编导能力（P13 场层 / 调度表 / 情绪词典 / 潜台词）**已到位**，本轮不碰；瓶颈在素材语义库「内涵」，
  不在渲染——WebGL 只是多一种表达手段，不解决也不掩盖内涵问题。

## 3. 架构落点：与 canvas-lib 对等的 vendor 原语层

现状（已探明）：

- `src/domain/composer.ts:769-772` 把 `templates/motion`、`templates/canvas` 整目录复制进 `remotion/`；
- 根 `index.html`（`composer.ts:1064-1065`）加载 `motion/gsap.min.js` + `motion/motion-lib.js`；
- 场景是 HyperFrames HTML 合成工程（非 React），逐镜 `remotion/compositions/Scene_*.html` 由
  `wrapComposition()` 生成，GSAP 暂停时间线注册到 `window.__timelines`，由渲染器 seek；
- `templates/canvas/canvas-lib.js` 暴露 `window.CV`，含 `mulberry32` 种子随机与 `drawStars/drawDisk`
  等确定性程序化画面原语——这是 WebGL 原语的直接范本。

设计（最小改动，镜像上述机制）：

1. **本地依赖**：`templates/webgl/three.min.js`（three.js 0.160 UMD 构建，离线自持，
   `npx hyperframes` 的文件服务器只能读 remotion 目录内文件，不能走 CDN）。随 composer 复制进 `remotion/webgl/`。
2. **原语库**：`templates/webgl/webgl-lib.js`，暴露 `window.WGL`，提供：
   - `createStage(canvas, opts)`：创建 renderer/scene/camera，**关闭 rAF 自动循环**；
   - `renderFrame(stage, t)`：**纯函数**——由 t 计算 scene 全部状态后一次性 `renderer.render`，
     同一 t 任意调用顺序画面一致；
   - 可复用几何/材质工厂（种子随机走 `CV.mulberry32`，与 2D 库同源）；
   - `dispose(stage)`：释放 GPU 资源。
3. **契约登记**：`core/validators/scene.ts` 的 `uses3d()` 正则增加 `WGL\.` 识别，使 WebGL 场景
   被正确判为 3D（V-STYLE-008 据此对账）。仅此一处改判定，不改枚举。
4. **compose 注入**：`wrapComposition()` 生成的场景 HTML / 根 index 在检测到 WebGL 使用时注入
   `<script src="../webgl/three.min.js">` + `<script src="../webgl/webgl-lib.js">`，并把该镜的
   `renderFrame` 挂进 `window.__renderFrames[id]`，供 HyperFrames seek。
5. **测试**：新增 `tests/webgl-determinism.test.ts`——用与可行性探针同构的逻辑断言
   「同 t 乱序/重复一致、异 t 不同、非空白」，纳入 vitest；不依赖真实浏览器则标注环境门控。
6. **文档**：本文件 + PLAN §14 追记；`docs/09-工程部.md` 补 WebGL 原语的确定性约束。

## 4. 验收

- vitest 全绿（含新增确定性用例）、tsc CLEAN、doc-drift 14 绿；
- 产出约 20s 自定主题测试视频，抽帧验收：画面非空白、随时间变化、同 t 可复现；
- 仓库精确提交（工作树有大量既有 dirty，只暂存本次新增/修改文件）；
- push rsi-agent → release/tag `v0.1.18`；同步 make-video 独立仓 → release/tag `v1.4.5`。

## 5. 非目标

- 不引入在线 CDN 依赖；不把 WebGL 设为默认渲染路径（沿用 css3d/canvas 的零依赖默认）。
- 不改 P13 表达层；不新增 V-* 规则；不改 dimension 枚举。
- 不在本轮解决「素材内涵」问题——那是内容侧议题，WebGL 只提供表达手段。
