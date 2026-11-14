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

  /**
   * 重音跟随：句子里哪个词被念重了，那个词就在那一刻跳一下。
   *
   * 两种用法，语义完全不同：
   *   1) 卡点模式 `{ points: [ms, ...] }`——points 是**镜内绝对毫秒**（由字幕重音词
   *      在句内的字位比例 × 句时长换算，compose 期注入 data-emphasis-points）。
   *      每个点是一次「起跳 90ms → 回落 260ms」的短脉冲，做完即静。这就是阿杜那种
   *      「画面跟着句子里的词跳动」——不是持续呼吸，是离散落点。
   *   2) 呼吸模式（无 points，向后兼容）——低幅 yoyo，仅用于「画面别死」的兜底。
   *
   * 为什么不把卡点算作重音标点：ACCENT_PRIMITIVES 只有 slam/punch/whip，受
   * V-MOT-013「重音镜 ≤1/3」约束（全篇都加粗等于没有重点）。卡点是**跟随口播的
   * 节奏**，每镜都该有；标点是**戏剧重音**，全片只能几次。两者混算会让卡点被预算
   * 闸限流掉——这正是此前 y5 镜 6 个只有 1 个真的砸下去的原因。
   */
  MV.emphasis = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'scale(1.06)');
      return tl;
    }
    var points = opts.points;
    if (points && points.length) {
      var peak = num(opts.peak, 1.14);
      var lift = num(opts.lift, 90) / 1000;
      var back = num(opts.back, 260) / 1000;
      for (var i = 0; i < points.length; i++) {
        var at = num(points[i], -1) / 1000;
        if (at < 0) continue;
        tl.to(nodes, { scale: peak, duration: lift, ease: 'power3.out' }, at);
        tl.to(nodes, { scale: 1, duration: back, ease: 'power2.out' }, at + lift);
      }
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

  /**
   * 镜内机位。**no-zoom（2026-11-15 起）**：所有分支只做位移，scale 恒为 opts.hold。
   *
   * 用户裁决：「放大缩小的运镜能否取消掉，感觉在各个视频里这种效果都不好看」，
   * 并要求「使用移动视角的运镜」。此前 push-in/pull-out/dolly/crane/punch-in 六个分支
   * 都在改 scale —— 那是变焦，不是机位；幅度再小观众也读作「画面在放大」。
   *
   * 现在：景别（zoom）只用来定一个**恒定**过扫值 hold（保证位移时不露边），
   * 运动全交给 xPercent/yPercent。改 hold 就改全片过扫量；改分支只改移动方向。
   */
  MV.camera = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var move = opts.move || 'none';
    // 景别 → 恒定过扫（原为「放大到多少」）：近景视野窄，同样位移占比更大，
    // 故略放大一点即可，最大 1.10 —— 再多就成了用户讨厌的「贴着放大」。
    var hold = num(opts.hold, 1.06);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'scale(' + hold.toFixed(3) + ')');
      return tl;
    }
/* 机位运动必须从镜首开始覆盖整段：不写 position 会被 GSAP 追加到时间线末尾，
     * 等于整镜都没推进（此前实测 camera 起点被排到 46s，实际镜头只有十几秒）。
     *
     * 教训（2026-11-13）：此前所有分支都是 ease:'none' 匀速 + duration 默认 12s，
     * 而多数镜头只有 4-14s。结果 (a) 匀速运动被读成「机器在平移」，(b) 5-7s 的短镜
     * 运动被半途截断，(c) 每镜都只有 3-6% 的推拉，看久了就是「同一种缓慢放大」。
     * 现在：缓动走 inOut（有起有收，像人推轨），duration 缺省交给调用方按镜长给，
     * 位移幅度按 16:9 的可见下限重定（<1.5% 等于没动，>4% 就成晃动）。 */
    var dur = opts.duration || 8;
    var e = opts.ease || 'power2.inOut';
    // 所有分支：scale 恒为 hold（只 set 一次），运动只由 xPercent/yPercent 承担。
    // 行程 2.2% 是 16:9 上「看得出来又没有晃动」的实测区间（<1.5% 等于没动，>4% 成抖）。
    var T = num(opts.travel, 2.2);
    tl.set(nodes, { scale: hold }, 0);
    if (move === 'push-in') {
      // 「靠近」= 横向平移把主体带向中轴；不再放大
      tl.fromTo(nodes, { xPercent: -T * 0.6 }, { xPercent: T * 0.6, duration: dur, ease: e }, 0);
    } else if (move === 'pull-out') {
      tl.fromTo(nodes, { xPercent: T * 0.6 }, { xPercent: -T * 0.6, duration: dur, ease: e }, 0);
    } else if (move === 'pan') {
      tl.fromTo(nodes, { xPercent: -T }, { xPercent: T, duration: dur, ease: e }, 0);
    } else if (move === 'pan-left') {
      tl.fromTo(nodes, { xPercent: T }, { xPercent: -T, duration: dur, ease: e }, 0);
    } else if (move === 'tilt-up') {
      // 俯仰只给 1.6%：±3% 在 1080p 上是 32px 的整屏位移，读起来就是「画面在抖」
      tl.fromTo(nodes, { yPercent: 1.6 }, { yPercent: -1.6, duration: dur, ease: e }, 0);
    } else if (move === 'tilt-down') {
      tl.fromTo(nodes, { yPercent: -1.6 }, { yPercent: 1.6, duration: dur, ease: e }, 0);
    } else if (move === 'dolly-in') {
      // 推轨带轻微纵向：与 push-in 区分开
      tl.fromTo(nodes, { xPercent: -T * 0.7, yPercent: 0.4 }, { xPercent: T * 0.5, yPercent: -0.4, duration: dur, ease: e }, 0);
    } else if (move === 'dolly-out') {
      tl.fromTo(nodes, { xPercent: T * 0.5, yPercent: -0.4 }, { xPercent: -T * 0.7, yPercent: 0.4, duration: dur, ease: e }, 0);
    } else if (move === 'crane-up') {
      // 升降 = 纵向平移（原配反向缩放，现纯位移）
      tl.fromTo(nodes, { yPercent: 1.8 }, { yPercent: -1.4, duration: dur, ease: e }, 0);
    } else if (move === 'crane-down') {
      tl.fromTo(nodes, { yPercent: -1.4 }, { yPercent: 1.8, duration: dur, ease: e }, 0);
    } else if (move === 'punch-in') {
      // 急推标点 = 短促横移冲到位再停住（全片 ≤2 次）
      tl.fromTo(nodes, { xPercent: 0 }, { xPercent: T * 0.9, duration: opts.duration || 1.2, ease: 'expo.out' }, 0);
    } else if (move === 'whip-pan') {
      tl.fromTo(nodes, { xPercent: -14 }, { xPercent: 0, duration: opts.duration || 0.5, ease: 'power4.out' }, 0);
    } else if (move === 'drift') {
      // 漂移 1.2%：再大就是「上下浮动」，和 idle 的呼吸叠在一起会变成抖动
      tl.fromTo(nodes, { yPercent: 1.2 }, { yPercent: -1.2, duration: dur, ease: 'sine.inOut' }, 0);
    } else if (move === 'static' || move === 'none') {
      // 真静止：只落定景别，不做任何位移（镜内表演由别的原语负责）
      return tl;
    } else {
      // 未登记词：落在静态景别上，不静默退化成某个运镜
      return tl;
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
    /* performance 组 idle-breath（V-ACT-005：>4s 长镜主体禁死寂）。
     * repeat 有界：时间线时长必须有限，渲染器才能按时间寻址。
     *
     * 教训（2026-11-13）：此前固定 { scale:1.015, y:-4, duration:1.8, repeat:24, yoyo }
     * 并逐镜调用。1.8s 一个完整上下循环 = 每分钟 33 次，肉眼读到的不是「呼吸」而是
     * 「抖动」；再叠加 camera 的整屏位移，就是用户说的「很刻意的晃动」。而且 16 镜
     * 全部同一个周期，节奏完全同质化。
     * 现在：周期拉到 5.2s（真人静息呼吸约 4-6s），去掉 y 位移（位移是晃动的直接来源，
     * 呼吸只该是极轻微的缩放），幅度降到 0.6%，并按调用序号错开相位，避免全片同频。 */
    var period = num(opts.period, 5.2);
    var amp = num(opts.amp, 0.006);
    var delay = (opts.delay || 0) / 1000;
    // 相位错开：同一镜内多个 idle 也不许同频同相
    var phase = num(opts.phase, 0);
    var reps = Math.max(1, Math.round(num(opts.span, 20) / period));
    tl.fromTo(
      nodes,
      { scale: 1 },
      { scale: 1 + amp, duration: period / 2, ease: 'sine.inOut', repeat: reps * 2, yoyo: true },
      delay + phase,
    );
    return tl;
  };

  MV.timeline = function () {
    return ensureTimeline();
  };

  /* ---------- 动效语法原语（P7：吸收阿杜 adu-motion-video + 花叔 huashu-art-motion） ----------
   * 两家共同铁律，本段全部遵守：
   *   1) 动效必须有语义动机——原语只负责「怎么动」，动机由场景作者写；
   *   2) 重音是稀缺资源——slam/punch/whip 是标点，受 V-MOT-013 全片≤1/3 约束；
   *   3) 画面里一直有事发生——主体主动作 × 环境母题循环分离（motifLoop）；
   *   4) 时间纯函数——全部有界补间，逐帧 seek 可复现；无 GSAP 时降级静态终态。
   * 参数默认值的出处见 PLAN.md P7「原语增补」表（来自两家实测）。 */

  // 动效常量唯一入口：改这里等于改全片观感，不要在场景里散写魔数
  var MO = {
    slam: { dur: 0.17, from: 1.55, mid: 0.94, ease: 'power4.in' },
    stagger: { secondary: 180, tertiary: 320, dur: 0.55, ease: 'expo.out' },
    morph: { out: 0.24, resize: 0.42, inn: 0.36 },
    counter: { dur: 0.9, ease: 'quint.out' },
    highlight: { dur: 0.5, ease: 'sine.inOut' },
    cards: { lift: 0.42, amp: 1.06, neighbor: 0.97 },
    punch: { dur: 0.28, amp: 1.22, ease: 'power2.out' },
    whip: { dur: 0.28, blur: 12, ease: 'expo.inOut' },
    mask: { dur: 0.5, ease: 'power2.inOut' },
    bands: { dur: 0.32, stagger: 0.06 },
    motif: { dur: 2.4, amp: 0.8 },
  };
  MV.MO = MO;

  function num(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : def;
  }

  /** 砸入：大字/数字/盖章落下的那一下。1.55 → 0.94 → 1.0，0.17s power4.in。
   *  一镜最多一次（V-MOT-013 把它计入全片重音预算）。 */
  MV.slam = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var m = MO.slam;
    var dur = num(opts.duration, m.dur * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    tl.fromTo(
      nodes,
      { scale: num(opts.from, m.from), opacity: 0 },
      { scale: m.mid, opacity: 1, duration: dur, ease: m.ease },
      at,
    );
    tl.to(nodes, { scale: 1, duration: dur * 1.6, ease: 'back.out(2.4)' }, at + dur);
    return tl;
  };

  /** 错峰入场：按 data-rank（primary/secondary/tertiary）分级延迟。
   *  阿杜「主卡先落位、邻卡压后、配角稍后响应」——禁止所有元素同拍响。 */
  MV.staggeredIn = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var s = MO.stagger;
    var dur = num(opts.duration, s.dur * 1000) / 1000;
    var base = num(opts.delay, 0) / 1000;
    var from = opts.from || { opacity: 0, y: 38 };
    var secMs = num(opts.secondary, s.secondary);
    var terMs = num(opts.tertiary, s.tertiary);
    var rankDelay = { primary: 0, secondary: secMs / 1000, tertiary: terMs / 1000 };
    for (var i = 0; i < nodes.length; i += 1) {
      var n = nodes[i];
      var rank = (n.getAttribute && n.getAttribute('data-rank')) || 'primary';
      var at = base + (rankDelay[rank] === undefined ? rankDelay.secondary : rankDelay[rank]);
      tl.from(
        n,
        {
          opacity: from.opacity === undefined ? 0 : from.opacity,
          y: from.y === undefined ? 38 : from.y,
          duration: dur,
          ease: s.ease,
        },
        at,
      );
    }
    return tl;
  };

  /** 连续形变：同一对象「旧字先退 → 再变尺寸 → 新字后进」三步串行。
   *  阿杜要点：窗口快速缩成文件时，不能把整页正文同帧缩成小点。
   *  opts: { delay, out, resize, inn, to:{scale,width,height,opacity} } */
  MV.morphTo = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var m = MO.morph;
    var outD = num(opts.out, m.out * 1000) / 1000;
    var resizeD = num(opts.resize, m.resize * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    tl.to(nodes, { opacity: 0, duration: outD, ease: 'power2.in' }, at);
    var to = { opacity: 1, duration: resizeD, ease: 'power2.inOut' };
    if (opts.to) for (var k in opts.to) to[k] = opts.to[k];
    tl.to(nodes, to, at + outD);
    return tl;
  };

  /** 数字滚动：诚实数值 + 落定在口播说到它那一刻（花叔 t3 财经 / y5 大数字）。
   *  数值永远来自文案，动画只决定怎么出现（V-CHT-002 禁编造数据）。 */
  MV.counter = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    var from = num(opts.from, 0);
    var to = num(opts.to, 100);
    var fmt =
      typeof opts.fmt === 'function'
        ? opts.fmt
        : function (v) {
            return (opts.prefix || '') + v.toFixed(num(opts.decimals, 0)) + (opts.suffix || '');
          };
    if (!tl) {
      for (var i = 0; i < nodes.length; i += 1) if (nodes[i]) nodes[i].textContent = fmt(to);
      return tl;
    }
    var c = MO.counter;
    var dur = num(opts.duration, c.dur * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    var box = { v: from };
    tl.to(
      box,
      {
        v: to,
        duration: dur,
        ease: opts.easing || c.ease,
        onUpdate: function () {
          for (var j = 0; j < nodes.length; j += 1) if (nodes[j]) nodes[j].textContent = fmt(box.v);
        },
      },
      at,
    );
    return tl;
  };

  /** 高亮扫过：荧光笔/红线从一端画到另一端（花叔 y2「线是一顿一顿画上去的」）。
   *  用 scaleX 0→1 + transformOrigin 实现，不改元素宽度（避免重排导致 seek 抖动）。 */
  MV.highlight = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var h = MO.highlight;
    var dur = num(opts.duration, h.dur * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    tl.fromTo(
      nodes,
      { scaleX: 0, transformOrigin: opts.origin || '0% 50%' },
      { scaleX: 1, duration: dur, ease: h.ease },
      at,
    );
    return tl;
  };

  /** 卡片流转：主卡抬升、邻卡压后、被选中的接管。
   *  阿杜「主卡抬升，邻卡压后；动作、落点、读字留白分开」。 */
  MV.cards = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var c = MO.cards;
    var lift = num(opts.duration, c.lift * 1000) / 1000;
    var hero = num(opts.hero, 0);
    var at = num(opts.delay, 0) / 1000;
    var step = num(opts.neighborDelay, MO.stagger.secondary) / 1000;
    for (var i = 0; i < nodes.length; i += 1) {
      var isHero = i === hero;
      tl.to(
        nodes[i],
        {
          scale: isHero ? c.amp : c.neighbor,
          y: isHero ? -14 : 6,
          opacity: isHero ? 1 : 0.68,
          duration: lift,
          ease: isHero ? 'back.out(1.8)' : 'power2.out',
        },
        at + (isHero ? 0 : step * (i + 1)),
      );
    }
    return tl;
  };

  /** 快推标点：推近 18-32% 后**停住**（不是慢推到底）。重音专用，受 V-MOT-013 约束。 */
  MV.punch = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'scale(' + MO.punch.amp + ')');
      return tl;
    }
    var p = MO.punch;
    var dur = num(opts.duration, p.dur * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    tl.fromTo(
      nodes,
      { scale: 1, transformPerspective: 1200 },
      { scale: num(opts.amp, p.amp), duration: dur, ease: p.ease },
      at,
    );
    return tl;
  };

  /** 镜内甩镜：视线突然转移（「我打开电脑 →（屏幕）」）。带运动模糊，0.26-0.30s。
   *  与剪辑层 whip-pan 转场分工：这个在镜内，那个在镜间。 */
  MV.whip = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var w = MO.whip;
    var dur = num(opts.duration, w.dur * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    var dir = opts.dir === 'left' ? -1 : 1;
    var px = num(opts.blur, w.blur);
    tl.fromTo(
      nodes,
      { xPercent: dir * 18, filter: 'blur(' + px + 'px)', opacity: 0.3 },
      { xPercent: 0, filter: 'blur(0px)', opacity: 1, duration: dur, ease: w.ease },
      at,
    );
    return tl;
  };

  /** 慢漂：整镜 1-4%/s 匀速慢移。**只给氛围镜/艺术风格镜**——
   *  解说片里每镜都慢推几个百分点就是 PPT（花叔点名批评的那支 102 秒短片）。 */
  MV.drift = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var dur = num(opts.duration, 12000) / 1000;
    var rate = num(opts.rate, 2.5); // 整镜缩放百分比（≈1-4%/s）
    var xP = num(opts.xPercent, 0);
    if (opts.dir === 'out') {
      tl.fromTo(nodes, { scale: 1 + rate / 100, xPercent: -xP }, { scale: 1, xPercent: xP, duration: dur, ease: 'none' }, 0);
    } else {
      tl.fromTo(nodes, { scale: 1, xPercent: -xP }, { scale: 1 + rate / 100, xPercent: xP, duration: dur, ease: 'none' }, 0);
    }
    return tl;
  };

  /** 擦除揭示：内容从掩码里被「画」出来（花叔 y3 白板笔尖揭开线稿）。
   *  opts.dir: left|right|up|down|circle */
  MV.maskReveal = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var m = MO.mask;
    var dur = num(opts.duration, m.dur * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    var dir = opts.dir || 'left';
    var fromIns =
      dir === 'right' ? 'inset(0 0 0 100%)'
      : dir === 'up' ? 'inset(100% 0 0 0)'
      : dir === 'down' ? 'inset(0 0 100% 0)'
      : 'inset(0 100% 0 0)';
    var from = dir === 'circle' ? 'circle(0% at 50% 50%)' : fromIns;
    var to = dir === 'circle' ? 'circle(75% at 50% 50%)' : 'inset(0 0 0 0)';
    tl.fromTo(nodes, { clipPath: from, webkitClipPath: from }, { clipPath: to, webkitClipPath: to, duration: dur, ease: m.ease }, at);
    return tl;
  };

  /** 色带过渡：几条实色带扫过换场（花叔 y5 fillZoom / bands）。
   *  比「淡到黑再亮起」有方向感，且不丢画面。 */
  MV.bands = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var b = MO.bands;
    var dur = num(opts.duration, b.dur * 1000) / 1000;
    var step = num(opts.stagger, b.stagger * 1000) / 1000;
    var at = num(opts.delay, 0) / 1000;
    var down = opts.dir === 'down';
    for (var i = 0; i < nodes.length; i += 1) {
      tl.fromTo(
        nodes[i],
        { yPercent: down ? -100 : 100 },
        { yPercent: 0, duration: dur, ease: 'power3.inOut' },
        at + i * step,
      );
    }
    return tl;
  };

  /** 母题循环：环境层「一直是活的」——每幕一个主动作 + 若干母题循环。
   *  必须与主体动作作用在不同元素上（否则抢属性、变成整体抖动）。
   *  opts.kind: float|pulse|rotate|shimmer */
  /** 母题循环的 kind 表：每个 kind 对应一种「环境在动」的视觉语言。
   *  铁律（阿杜「每幕 2 个母题循环」+ 花叔「画要一直是活的」）：
   *  画面里必须一直有事发生，但**不能抢主体的属性**——所以每种 kind 动的是不同 CSS 属性，
   *  且幅度必须看得见（位移 ≥ 元件自身尺寸的 2%，或透明度 ≥ 0.2 的变化）。
   *  幅度定价都在一次「参数只动 0.3 时肉眼看不出来」的实测之后重定过。 */
  var MOTIF_KINDS = {
    // 上下漂浮：位移是 amp*6(px)。amp 0.3 只有 ±1.8px —— 所以默认值提到 0.8（±4.8px）
    float: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { y: amp * 6 }, { y: -amp * 6, duration: dur, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
    // 缩放呼吸：amp 0.3 → ±3.75%，看得见且不抢主体
    pulse: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { scale: 1 - amp / 8 }, { scale: 1 + amp / 8, duration: dur, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
    // 转台：amp 0.5 → ±1.5°，够了；再大就破坏版式
    rotate: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { rotation: -amp * 3 }, { rotation: amp * 3, duration: dur, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
    // 明暗闪动：透明度 0.35↔0.95，是「光在呼吸」的主来源
    shimmer: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { opacity: 0.45 }, { opacity: 0.95, duration: dur / 2, ease: 'sine.inOut', repeat: reps * 2, yoyo: true }, at);
    },
    // 扫描：整层横向掠过（网格/背景纹理专用）。走 x 而不是 y，
    // 因为横移在 16:9 里比上下抖动更像「镜头在扫」，也不会让版式上下跳。
    scan: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { x: -amp * 40, backgroundPosition: '0% 0%' },
        { x: amp * 40, backgroundPosition: '100% 0%', duration: dur, ease: 'none', repeat: reps, yoyo: true }, at);
    },
    // 光带横穿：单向匀速走完再从头（不 yoyo，像激光扫过去）
    sweep: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { xPercent: -amp * 60 }, { xPercent: amp * 180, duration: dur, ease: 'none', repeat: reps }, at);
    },
    // 缓漂：极慢的整体位移，氛围镜用；比 float 更慢更远
    drift: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { x: -amp * 22, y: amp * 8 },
        { x: amp * 22, y: -amp * 8, duration: dur * 2, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
    // 呼吸（幅度更大、周期更长，用于大块背景色块/光晕）
    breathe: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { scale: 1 - amp / 5, opacity: 0.55 },
        { scale: 1 + amp / 5, opacity: 1, duration: dur * 1.5, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
    // 挤压：纵向压缩来回（「被压紧」的感觉），只动 scaleY，不碰版式宽度
    compress: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { scaleY: 1 - amp / 4 }, { scaleY: 1 + amp / 12, duration: dur, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
    // 沉降：从略高处缓慢落下并停住感（单程 + 小幅回弹），收尾镜用
    settle: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { y: -amp * 14 }, { y: amp * 4, duration: dur * 1.5, ease: 'power2.out', repeat: reps, yoyo: true }, at);
    },
    // 排空：透明度单向衰减再回来（「被抽走」），比 shimmer 慢且单向
    drain: function (nodes, amp, dur, reps, at, tl) {
      tl.fromTo(nodes, { opacity: 1 }, { opacity: 0.35, duration: dur * 1.2, ease: 'sine.inOut', repeat: reps, yoyo: true }, at);
    },
  };
  MV.MOTIF_KINDS = MOTIF_KINDS;

  MV.motifLoop = function (sel, opts) {
    opts = opts || {};
    var nodes = $(sel);
    var tl = ensureTimeline();
    if (!tl) {
      finalize(nodes, 'none');
      return tl;
    }
    var m = MO.motif;
    var amp = num(opts.amp, m.amp);
    var dur = num(opts.duration, m.dur * 1000) / 1000;
    var kind = opts.kind || 'float';
    // 有界 repeat：镜长未知时按 16s 上限，超出部分自然静止（时间线必须有限）
    var reps = Math.max(1, Math.round(num(opts.span, 16) / dur / 2));
    var at = num(opts.delay, 0) / 1000;

    // 未实现的 kind 一律显式告警，绝不静默落进 float。
    // 教训（2026-11-05）：模板按语义写了 sweep/breathe/scan/drain/compress/settle/drift，
    // 库里只实现四种，其余全落 else 变成 ±1.6px 的 y 位移——渲染出来是「开头动一下、
    // 剩下四秒完全静止」（实测静止帧 88-93%）。静默降级比报错危险得多。
    if (!MOTIF_KINDS[kind]) {
      if (global.console && global.console.warn) {
        global.console.warn('[motion-lib] motifLoop: 未知 kind "' + kind + '"，按约定降级为 float');
      }
      kind = 'float';
    }
    MOTIF_KINDS[kind](nodes, amp, dur, reps, at, tl);
    return tl;
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
