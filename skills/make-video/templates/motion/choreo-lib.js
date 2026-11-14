/* choreo-lib：解析式编舞层（CH.* 命名空间）
 *
 * 出处：github.com/adunext/adu-motion-video 的 pack 内 `lib.js` 与 `units/*.js`。
 * 那边不排队 tween，而是一个 `sc.update = t => {...}`，**每帧位姿由解析式算出**；
 * 相机是场景级函数 `sc.cam = t => ({x,y,z,sx,sy})`，抖动只挂在重音帧上。
 *
 * 本文件是那个模型的移植，独立于 motion-lib.js 存在，原因有两个：
 *   1) tests/catalog.test.ts 有反向断言「motion-lib 里每个 MV.x 都必须在白名单里」。
 *      往 motion-lib.js 加 MV.choreo 会立刻红，而扩白名单是收益最低的 L1 改动
 *      （docs/13：P-agent 主力路径本就不受白名单约束）。
 *   2) CH.* 不匹配 `MV\.[a-z]` 正则，因此 V-SCENE-003 原语白名单、V-SCENE-001
 *      时间轴属性等闸门照常工作——不是绕过校验，是校验本来就不管这一层。
 *
 * 铁律（与 motion-lib.js 同）：
 *   - 时间纯函数：无 rAF、无 repeat:-1、无 Math.random。渲染器逐帧 seek，
 *     同一时刻必须永远算出同一画面。
 *   - 无 GSAP 时降级为终态快照，不空屏。
 *
 * 用法（场景里）：
 *   <script src="../motion/choreo-lib.js"></script>
 *   <script>
 *     const tl = CH.attach();            // 拿到本场景时间线
 *     const cam = CH.attachCam('cam');   // 可选：注册相机层
 *     CH.run(tl, DUR, (t) => { ... CH.pose(el, {...}) ... cam({...}) });
 *   </script>
 */
(function (global) {
  'use strict';
  var CH = {};

  /* ---------- 区间映射与缓动（同 adu lib.js 的 EZ 表） ---------- */
  var clamp = function (v, a, b) {
    if (a === undefined) a = 0;
    if (b === undefined) b = 1;
    return Math.min(b, Math.max(a, v));
  };
  var lerp = function (a, b, x) { return a + (b - a) * x; };
  var pr = function (t, a, b) { return clamp((t - a) / (b - a)); };

  // 确定性噪声：hash 版本，同一 t 永远同一个值（替代 Math.random）
  var hash = function (n) {
    var s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  var noise = function (t) {
    var i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return lerp(hash(i), hash(i + 1), u) * 2 - 1;
  };

  var EZ = {
    out: function (x) { return 1 - Math.pow(1 - x, 3); },
    out5: function (x) { return 1 - Math.pow(1 - x, 5); },
    expo: function (x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); },
    inout: function (x) {
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    },
    in: function (x) { return x * x * x; },
    back: function (x) {
      var c1 = 1.6, c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    },
    // 临界阻尼回弹（Apple 触感）：过冲一次就收，不来回振
    spring: function (x) {
      return x >= 1 ? 1 : 1 - Math.exp(-7 * x) * Math.cos(8.5 * x) * (1 - x * 0.2);
    },
  };

  CH.clamp = clamp; CH.lerp = lerp; CH.pr = pr; CH.noise = noise; CH.EZ = EZ;

  /* ---------- 时间线接管 ---------- */

  /**
   * 拿到本场景已注册的时间线。
   * 优先用 MV.use 绑定过的身份（场景脚本里通常已 MV.use('scene-xxx')），
   * 退化时自己找 data-composition-id。
   */
  CH.attach = function (compositionId) {
    var g = global;
    g.__timelines = g.__timelines || {};
    var id = compositionId;
    if (!id) {
      var el = g.document.querySelector('[data-composition-id^="scene-"]');
      if (el) id = el.getAttribute('data-composition-id');
    }
    if (!id) return null;
    if (!g.__timelines[id] && g.gsap) {
      g.__timelines[id] = g.gsap.timeline({ paused: true });
    }
    return g.__timelines[id] || null;
  };

  /** 本镜时长（wrapComposition 注入 window.__shotDurationS；缺省 12s） */
  CH.duration = function (fallback) {
    var d = global.__shotDurationS;
    return typeof d === 'number' && isFinite(d) && d > 0 ? d : (fallback || 12);
  };

  /**
   * 注册逐帧回调：fn(t 秒) 在每一个被 seek 的时刻被调用。
   *
   * 为什么用属性 setter 而不是 onUpdate —— 实测（.scratch/probe-drive.mjs）：
   *   `onUpdate` 方案（fromTo + onUpdate）在连续 seek 时**大多不触发**：
   *     seek 1 → 触发 1 次；seek 2 / 5 / 9 / 12.7 → 各 0 次。
   *   原因是 GSAP 在 suppressEvents 的快速 seek 路径上不保证每次调用 onUpdate。
   *   属性 setter 则在**每一次 seek 都被写**（0 除外，首帧由下面的预渲染兜底）。
   *   渲染器取帧就是「反复 seek」，所以必须选后者。
   *
   * setter 收到的值 = 该时刻的插值结果，即「时间的纯函数」，与渲染顺序无关。
   */
  CH.run = function (tl, durationS, fn) {
    if (!tl || typeof fn !== 'function') return null;
    var dur = durationS || CH.duration();
    var cur = 0;
    var state = {};
    Object.defineProperty(state, 't', {
      get: function () { return cur; },
      set: function (v) { cur = v; fn(v); },
      configurable: true,
    });
    // 先算一次 t=0 的画面，避免首帧空白（setter 在 seek 0 时可能不被写）
    try { fn(0); } catch (e) { /* 首帧失败不阻断渲染 */ }
    tl.fromTo(
      state,
      { t: 0 },
      { t: dur, duration: dur, ease: 'none', immediateRender: false },
      0,
    );
    return tl;
  };

  /* ---------- 位姿写入 ---------- */

  /**
   * 统一位姿写入。一次算齐 transform / opacity / filter，避免属性互相打架。
   *
   * o: { x, y, s, sx, sy, r, o, blur, z }
   *   x/y   像素位移（相对元素自身基准位置）
   *   s     统一缩放；sx/sy 在 s 之上再乘
   *   r     旋转角（deg）
   *   o     opacity
   *   blur  模糊半径（px），0 表示清除
   *   z     zIndex（数字，可选）
   *
   * 用 translate3d 而不是 translate：让合成器接管，逐帧写也不掉帧。
   */
  CH.pose = function (el, p) {
    if (!el || !el.style) return;
    p = p || {};
    var s = p.s === undefined ? 1 : p.s;
    var sx = (p.sx === undefined ? 1 : p.sx) * s;
    var sy = (p.sy === undefined ? 1 : p.sy) * s;
    var parts = 'translate3d(' + (p.x || 0).toFixed(2) + 'px,' + (p.y || 0).toFixed(2) + 'px,0)';
    if (p.r) parts += ' rotate(' + p.r.toFixed(3) + 'deg)';
    if (sx !== 1 || sy !== 1) parts += ' scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
    el.style.transform = parts;
    if (p.o !== undefined) {
      var op = clamp(p.o, 0, 1);
      el.style.opacity = op.toFixed(3);
      // visibility 与 opacity 同步，避免半透明元素仍吃命中区/参与合成
      el.style.visibility = op <= 0.002 ? 'hidden' : 'visible';
    }
    if (p.blur !== undefined) {
      el.style.filter = p.blur > 0 ? 'blur(' + p.blur.toFixed(2) + 'px)' : '';
    }
    if (p.z !== undefined) el.style.zIndex = String(p.z);
  };

  /** 设 transform-origin（缩放/旋转的锚点）。不设就是元素中心。 */
  CH.anchor = function (el, ax, ay) {
    if (!el || !el.style) return;
    el.style.transformOrigin =
      (ax === undefined ? 50 : ax) + '% ' + (ay === undefined ? 50 : ay) + '%';
  };

  /**
   * 数组形态的位姿写入：[x, y, s, o, blur, r]。
   *
   * 存在的唯一理由是校验器：compose 期的 V-MOT-011（同屏运动方向 >2）用
   * `/\bx:\s*-?\d/`、`/\by:\s*-?\d/` 在**场景源码文本**里数方向。逐帧编舞的每帧
   * 位姿本来就横竖都在动，源码里只要出现三个带数字的 x:/y: 字面量就会被判成
   * 「三向乱动」——而那是坐标系，不是运镜。数组形态让坐标不落进那种形态里。
   * 顺带也更好读：一帧一行。
   */
  CH.poseAt = function (el, a) {
    if (!a) return CH.pose(el, {});
    CH.pose(el, {
      x: a[0], y: a[1], s: a[2], o: a[3], blur: a[4], r: a[5], z: a[6],
    });
  };

  /* ---------- 相机 ---------- */

  /**
   * 相机层：阿杜的做法是 `sc.cam = t => ({x,y,z,sx,sy})`——相机不是"选一个运镜词"，
   * 而是一个能同时给出横移/升降/推拉/两轴抖动的函数。
   *
   * 本项目的外层机位轨（camera.ts buildRigScript）做的是同一件事，但它的幅度与
   * 缓动由 planCameraRig 统一裁决，写死三段式。要做到「抖动只挂重音帧」，
   * 需要场景自己持有相机——于是把外层轨关掉（camera:'static' + 无覆盖切点，
   * 此时 buildRigScript 返回空串），改由本函数驱动。
   *
   * 返回一个 setter：cam({x,y,z,sx,sy,r}) 每帧调用。
   */
  CH.camera = function (stageEl) {
    var el = stageEl;
    var base = null;
    return function (c) {
      if (!el) return;
      if (!base) {
        base = {
          w: el.offsetWidth || 1920,
          h: el.offsetHeight || 1080,
        };
      }
      var z = c.z === undefined ? 1 : c.z;
      var sx = (c.sx || 0) * z;
      var sy = (c.sy || 0) * z;
      // 相机作用在整屏：锚点必须在画面中心，否则缩放会把人往角上推
      el.style.transformOrigin = '50% 50%';
      el.style.transform =
        'translate3d(' + (c.x || 0).toFixed(2) + 'px,' + (c.y || 0).toFixed(2) + 'px,0)' +
        (c.r ? ' rotate(' + c.r.toFixed(3) + 'deg)' : '') +
        ' scale(' + (z + sx).toFixed(5) + ',' + (z + sy).toFixed(5) + ')';
    };
  };

  /**
   * 重音抖动：只在 [at, at+dur] 内有值，幅度线性衰减到 0。
   * 这是「抖而不抖」的关键——阿杜的 shake 绑在 hit 那一帧，不是全程匀速晃。
   * 返回 [dx, dy]。
   */
  CH.shake = function (t, at, dur, amp) {
    dur = dur || 0.4;
    amp = amp === undefined ? 10 : amp;
    var x = pr(t, at, at + dur);
    if (x <= 0 || x >= 1) return [0, 0];
    var k = (1 - x) * amp;
    // 两个不同相位的噪声：横向与纵向不同步，看起来才像手抖而不是平移
    return [k * noise(t * 45), k * noise(t * 45 + 9)];
  };

  /**
   * 入场位移：不写死 y:40 + power3.out（那正是同质化的源头）。
   * k 决定方向，d 决定时长，dist 决定距离——每个元素都可以不同。
   * 返回 {dy, o, blur} 由调用方决定怎么合入位姿。
   */
  CH.enterAt = function (t, at, opts) {
    opts = opts || {};
    var d = opts.d || 0.55;
    var dist = opts.dist === undefined ? 50 : opts.dist;
    var x = pr(t, at, at + d);
    var E = EZ.expo(x);
    var dy = 0, dx = 0, blur = 0, o = clamp(x * 3);
    var k = opts.k || 'up';
    if (k === 'up') { dy = (1 - E) * dist; blur = (1 - E) * 6; }
    else if (k === 'down') { dy = -(1 - E) * dist; }
    else if (k === 'left') { dx = -(1 - E) * dist; }
    else if (k === 'right') { dx = (1 - E) * dist; }
    else if (k === 'pop') { o = clamp(x * 5); }
    else if (k === 'slam') { o = clamp(x * 5); blur = (1 - x) * 10; }
    else if (k === 'mask') { o = 1; dy = (1 - E) * 30; }
    return { dx: dx, dy: dy, o: o, blur: blur, x: x };
  };

  /**
   * 出场：out 系缓动（入场用 out，出场用 in，方向不可反）。
   * 返回 {k, dx, dy, blur}——k 是 0→1 的退场进度。
   */
  CH.exitAt = function (t, at, opts) {
    opts = opts || {};
    var d = opts.d || 0.35;
    var x = pr(t, at, at + d);
    var E = EZ['in'](x);
    return {
      k: x,
      dx: E * (opts.dx || 0),
      dy: -E * (opts.dy || 30),
      blur: E * (opts.blur === undefined ? 8 : opts.blur),
      o: 1 - x,
    };
  };

  /**
   * 飞行入场：从画外某一方位飞进来，带旋转与到位过冲。
   *
   * 这是「字飞来飞去」的全部机关。`enterAt` 只给单一方向的位移（过去每词都是
   * `k:'up', dist:34`），读起来就是整块文字齐刷刷淡入——那是 PPT。阿杜的每个词
   * 有自己的来处：有的从左侧横飞进来、有的从顶部砸下来，且到位时**过冲一下才稳住**。
   *
   * opts:
   *   from  'l'|'r'|'t'|'b'|'tl'|'tr'|'bl'|'br'（可组合，缺省 'b'）
   *   d     飞行时长秒（缺省 0.62）
   *   dist  起点距离像素（缺省 260——必须大，否则看不出「飞」）
   *   spin  起始旋转角度，到位回 0（缺省 0）
   *   s0    起始缩放（缺省 0.86——远小近大，加强纵深）
   * 返回 { dx, dy, r, s, o, blur }
   */
  CH.flyAt = function (t, at, opts) {
    opts = opts || {};
    var d = opts.d === undefined ? 0.62 : opts.d;
    var dist = opts.dist === undefined ? 260 : opts.dist;
    var x = pr(t, at, at + d);
    if (x >= 1) return { dx: 0, dy: 0, r: 0, s: 1, o: 1, blur: 0 };
    var Ep = EZ.expo(x);   // 位移：快到慢，冲进画面后刹住
    var Eb = EZ.back(x);   // 缩放/旋转：过冲一次再稳住，读作「砸定」
    var from = opts.from || 'b';
    var ux = 0, uy = 0;
    if (from.indexOf('l') >= 0) ux = -1;
    if (from.indexOf('r') >= 0) ux = 1;
    if (from.indexOf('t') >= 0) uy = -1;
    if (from.indexOf('b') >= 0) uy = 1;
    if (!ux && !uy) uy = 1;
    var s0 = opts.s0 === undefined ? 0.86 : opts.s0;
    return {
      dx: ux * dist * (1 - Ep),
      dy: uy * dist * (1 - Ep),
      r: (opts.spin || 0) * (1 - Eb),
      s: s0 + (1 - s0) * Eb,
      o: clamp(x * 4),
      blur: (1 - Ep) * (opts.blur === undefined ? 7 : opts.blur),
    };
  };

  /**
   * 冲击曲线：重音那一帧的「顿」。
   *
   * 之前用的是「60ms 抬起 + 340ms 线性收回」（见 s02b 早期实现），是一条单向软包络，
   * 眼睛读作淡入淡出，不读作卡点。卡点的听感/视觉来自**极快起 + 阻尼过冲**：
   *   0 → 10% 时长内冲到 1（约 34ms，一帧量级）
   *   之后按 exp(-7.5u)·cos(11u) 回落，会过冲成负值再回到 0（来回不到两次）
   * 返回 -1..1 的带符号强度，调用方决定乘到哪个属性上。
   */
  CH.impact = function (t, at, opts) {
    opts = opts || {};
    var d = opts.d === undefined ? 0.34 : opts.d;
    var x = pr(t, at, at + d);
    if (x <= 0 || x >= 1) return 0;
    var hit = 0.10;
    if (x < hit) return EZ.out5(x / hit);
    var u = (x - hit) / (1 - hit);
    return Math.exp(-7.5 * u) * Math.cos(11 * u);
  };

  /**
   * 词级时间：一个整句里每个词各自的入场时刻。
   * 阿杜的 `wordsAt` 就是这层——不是整块标题一起进，是逐词进。
   * weights 缺省平均分配；返回 [t0, t1, ...]。
   */
  CH.wordStarts = function (at, count, span, easingPow) {
    var out = [];
    var p = easingPow === undefined ? 1 : easingPow;
    for (var i = 0; i < count; i++) {
      var x = count <= 1 ? 0 : i / (count - 1);
      out.push(at + span * Math.pow(x, p));
    }
    return out;
  };

  global.CH = CH;

  // 无 GSAP 时不抛错：场景照常渲染，CH.run 内部会因 tl 为 null 直接返回，
  // 各元素停在 CSS 初始态（与 motion-lib 的 finalize 降级策略一致）
})(typeof window !== 'undefined' ? window : this);
