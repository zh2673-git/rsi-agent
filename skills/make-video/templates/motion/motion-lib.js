/* motion-lib：动效原语库（白名单 MV.enter/exit/emphasis/camera/performance/subtitle/timeline）
 * HyperFrames 约定：GSAP 时间线必须 {paused:true} 创建并注册到 window.__timelines[compositionId]，
 * 渲染器按时间轴寻址逐帧捕获。本库所有原语都追加到注册时间线（而非自动播放），保证确定性。
 * 无 GSAP 时降级为静态终态，保证渲染不空屏。 */
(function (global) {
  'use strict';
  var hasGsap = typeof global.gsap !== 'undefined';
  var MV = {};
  var registered = null;
  var boundId = null;
  var boundRoot = null;

  // 多合成内联（swap）时，多个场景共存于同一文档：
  // 必须由每个场景的动画入口显式绑定自己的 compositionId（MV.use），
  // 否则 querySelector('[data-composition-id]') 命中第一个（root），
  // 全部动画被错挂到根时间线，渲染器 seek 的场景时间线全空。
  MV.use = function (compositionId) {
    boundId = compositionId;
    boundRoot = document.querySelector('[data-composition-id="' + compositionId + '"]') || null;
    registered = null; // 重新绑定后切换时间线
    return MV;
  };

  function $(sel) {
    try {
      var root = boundRoot || document;
      return root.querySelectorAll(sel);
    } catch (e) {
      return [];
    }
  }

  function sceneId() {
    if (boundId) return boundId;
    // 单文档场景（无显式绑定）：优先 data-composition-id 元素
    var el = document.querySelector('[data-composition-id]');
    if (el) return el.getAttribute('data-composition-id');
    var b = document.body;
    if (!b) return 'root';
    return (
      b.getAttribute('data-composition-id') ||
      b.getAttribute('data-scene-id') ||
      'root'
    );
  }

  function ensureTimeline() {
    if (registered) return registered;
    global.__timelines = global.__timelines || {};
    var id = sceneId();
    var existing = global.__timelines[id];
    if (existing) {
      registered = existing;
      return registered;
    }
    registered = hasGsap ? global.gsap.timeline({ paused: true }) : null;
    global.__timelines[id] = registered;
    return registered;
  }

  function finalize(nodes, transform) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || !n.style) continue;
      n.style.opacity = '1';
      if (transform) n.style.transform = transform;
    }
  }

  MV.enter = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var vars = {
      opacity: 0,
      y: 40,
      duration: (opts.duration || 600) / 1000,
      ease: opts.easing || 'power3.out',
      stagger: (opts.stagger || 0) / 1000,
    };
    if (opts.from) {
      for (var k in opts.from) vars[k] = opts.from[k];
    }
    tl.from(nodes, vars, (opts.delay || 0) / 1000);
    return tl;
  };

  MV.exit = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    tl.to(
      nodes,
      {
        opacity: 0,
        y: -30,
        duration: (opts.duration || 400) / 1000,
        ease: 'power2.in',
        stagger: (opts.stagger || 0) / 1000,
      },
      (opts.delay || 0) / 1000,
    );
    return tl;
  };

  MV.emphasis = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'scale(1.06)');
      return tl;
    }
    // repeat 必须有界：无限循环会让时间线时长无穷大，渲染器无法按时间寻址
    tl.to(nodes, {
      scale: 1.06,
      duration: (opts.duration || 1200) / 2000,
      ease: 'sine.inOut',
      repeat: 8,
      yoyo: true,
    });
    return tl;
  };

  MV.camera = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var move = opts.move || 'none';
    var zoom = opts.zoom || 'MS';
    var scale = { ELS: 1.0, LS: 1.03, MLS: 1.06, MS: 1.1, MCU: 1.18, CU: 1.3, ECU: 1.5 }[zoom] || 1.1;
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'scale(' + scale.toFixed(3) + ')');
      return tl;
    }
    /* 机位运动必须从镜首开始覆盖整段：不写 position 会被 GSAP 追加到时间线末尾，
     * 等于整镜都没推进（此前实测 camera 起点被排到 46s，实际镜头只有十几秒） */
    if (move === 'push-in') {
      // Ken Burns 式缓推：覆盖镜头大部分时长（V-CAM-006 静态画面必须过相机运动）
      tl.fromTo(nodes, { scale: 1 }, { scale: scale, duration: opts.duration || 12, ease: 'none' }, 0);
    } else if (move === 'pull-out') {
      tl.fromTo(nodes, { scale: scale + 0.06 }, { scale: 1, duration: opts.duration || 12, ease: 'none' }, 0);
    } else if (move === 'pan') {
      tl.fromTo(nodes, { xPercent: -3, scale: scale }, { xPercent: 3, duration: opts.duration || 12, ease: 'none' }, 0);
    } else if (move === 'pan-left') {
      tl.fromTo(nodes, { xPercent: 3, scale: scale }, { xPercent: -3, duration: opts.duration || 12, ease: 'none' }, 0);
    } else {
      tl.set(nodes, { scale: scale }, 0);
    }
    return tl;
  };

  MV.performance = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    tl.to(nodes, { scale: 1.05, duration: 0.35, ease: 'back.out(2.2)' }).to(nodes, {
      scale: 1,
      duration: 0.6,
      ease: 'elastic.out(1.8, 0.12)',
    });
    return tl;
  };

  MV.subtitle = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = el.textContent || '';
      el.textContent = '';
      for (var c = 0; c < text.length; c++) {
        var span = document.createElement('span');
        span.textContent = text[c];
        span.style.display = 'inline-block';
        el.appendChild(span);
      }
      tl.from(
        el.querySelectorAll('span'),
        { opacity: 0, y: 20, duration: 0.12, stagger: 0.05, ease: 'power2.out' },
        0,
      );
    }
    return tl;
  };

  MV.idle = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) return tl;
    // performance 组 idle-breath（V-ACT-005：>4s 长镜主体禁死寂）。
    // repeat 有界：时间线时长必须有限，渲染器才能按时间寻址。
    tl.to(
      nodes,
      { scale: 1.015, y: -4, duration: 1.8, ease: 'sine.inOut', repeat: 24, yoyo: true },
      (opts.delay || 0) / 1000,
    );
    return tl;
  };

  MV.timeline = function () {
    return ensureTimeline();
  };

  /* ---------- 3D 原语（素材语言层：风格声明 css3d 时由场景调用） ----------
   * 全部写成「有界 repeat 的 GSAP 补间」而不是 requestAnimationFrame：
   * 渲染器逐帧 seek 时间线，动画必须是时间的纯函数，rAF 会脱离 seek 变成随机画面。
   * 依赖父级 CSS 提供 perspective / transform-style: preserve-3d（场景模板负责）。 */

  function depthOf(el) {
    var d = parseFloat(el.getAttribute && el.getAttribute('data-depth'));
    return isFinite(d) ? Math.max(0, Math.min(1, d)) : 0.5;
  }

  // 分层景深：按元素 data-depth（0 远→1 近）给不同的 z 位移与缩放，制造真纵深
  MV.depth = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var strength = opts.strength || 1;
    var dur = (opts.duration || 12000) / 1000;
    for (var i = 0; i < nodes.length; i++) {
      (function (n) {
        var d = depthOf(n);
        tl.fromTo(
          n,
          { z: -((1 - d) * 180) * strength, scale: 0.94 + d * 0.06, opacity: 0.5 + d * 0.5 },
          { z: d * 60 * strength, scale: 1 + d * 0.08, opacity: 1, duration: dur, ease: 'none' },
          0,
        );
      })(nodes[i]);
    }
    return tl;
  };

  // 透视倾斜摆动：旋转往复（有界 repeat），主体在 3D 空间里"呼吸"
  MV.tilt3d = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var amp = opts.amp || 7;
    var persp = opts.perspective || 1200;
    tl.fromTo(
      nodes,
      { rotationX: amp, rotationY: -amp, transformPerspective: persp },
      {
        rotationX: -amp * 0.4,
        rotationY: amp,
        duration: (opts.duration || 1200) / 1000,
        ease: 'sine.inOut',
        repeat: 7,
        yoyo: true,
      },
      0,
    );
    return tl;
  };

  // 转台：绕 Y 轴匀速转（有界 repeat，总长 16s 覆盖常规镜长）
  MV.orbit = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var from = opts.from || 0;
    var step = (opts.step || 45) * (opts.reverse ? -1 : 1);
    tl.fromTo(
      nodes,
      { rotationY: from, transformPerspective: opts.perspective || 1200 },
      {
        rotationY: from + step,
        duration: (opts.duration || 2000) / 1000,
        ease: 'none',
        repeat: opts.repeat === undefined ? 7 : opts.repeat,
      },
      0,
    );
    return tl;
  };

  // 卡片翻面：0 → 180，常速进出（信息揭示用）
  MV.card3d = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    tl.fromTo(
      nodes,
      { rotationY: 0, transformPerspective: opts.perspective || 1000 },
      {
        rotationY: opts.to === undefined ? 180 : opts.to,
        duration: (opts.duration || 600) / 1000,
        ease: 'power2.inOut',
      },
      (opts.delay || 0) / 1000,
    );
    return tl;
  };

  // 立方体/立体字整体转动：两轴复合，有界往复
  MV.spin3d = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var amp = opts.amp || 12;
    tl.fromTo(
      nodes,
      { rotationX: -amp, rotationY: 0, transformPerspective: opts.perspective || 1400 },
      {
        rotationX: amp,
        rotationY: amp * 2,
        duration: (opts.duration || 2000) / 1000,
        ease: 'sine.inOut',
        repeat: 4,
        yoyo: true,
      },
      0,
    );
    return tl;
  };

  global.MV = MV;
})(typeof window !== 'undefined' ? window : globalThis);
