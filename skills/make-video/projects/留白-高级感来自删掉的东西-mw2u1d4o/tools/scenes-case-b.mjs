// 案例 B 场景生成器：keynote-minimal（纯黑舞台 / 一屏一事 / 唯一强调色 / 留白即高级）
// 纪律：每镜只有一个视觉主语；#0a84ff 全片只做「指示」不做装饰；留白靠构图给，不靠加元素。
// 动效按语法落词：重音镜 slam 砸在判断词上，其余走 enter/stagger；母题循环保证不是死帧。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/ 在项目内：projects/<id>/tools → 向上三级才是 skill 根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const id = process.argv[2];
if (!id) {
  console.error('usage: node tools/scenes-case-b.mjs <project-id>');
  process.exit(1);
}

const S = {
  black: '#000000',
  ink: '#f5f5f7',
  ink2: '#86868b',
  ink3: '#48484a',
  accent: '#0a84ff',
  font: "'Microsoft YaHei','PingFang SC','SF Pro Display',sans-serif",
};

// accent=1 才砸（V-MOT-013 重音预算 ≤1/3，5 镜最多 1 个）
const SHOTS = [
  {
    accent: 0,
    kicker: '01 · HOOK',
    hero: '说不出',
    sub: '好在哪？',
    motif: 'drift',
    ring: true,
    cam: 'push-in',
  },
  {
    accent: 1,
    kicker: '02 · 答案',
    hero: '留白',
    sub: '不是配色，也不是字体',
    motif: 'breathe',
    ring: false,
    cam: 'pan',
  },
  {
    accent: 0,
    kicker: '03 · 作用',
    hero: '先看哪',
    sub: '留白替你排好了视线顺序',
    motif: 'scan',
    ring: true,
    cam: 'push-in',
  },
  {
    accent: 0,
    kicker: '04 · 反面',
    hero: '没有落点',
    sub: '挤满的屏幕没有落点',
    motif: 'compress',
    ring: false,
    cam: 'pull-out',
  },
  {
    accent: 0,
    kicker: '05 · 收束',
    hero: '一半',
    sub: '删掉的，才是被听见的那部分',
    motif: 'settle',
    ring: false,
    cam: 'tilt-up',
  },
];

function page(shotId, s) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${shotId}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  [data-scene-id] { position: relative; width: 100%; height: 100%; }
  body { font-family: ${S.font}; background: ${S.black}; color: ${S.ink}; }
  .stage {
    position: relative; width: 100%; height: 100%;
    display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
    padding: 0 12%; box-sizing: border-box;
    background: radial-gradient(ellipse at 26% 36%, rgba(10,132,255,0.10) 0%, transparent 60%), ${S.black};
  }
  /* 留白网格：极细，只当尺度参考，绝不能抢主体 */
  .hair-grid {
    position: absolute; inset: 0; pointer-events: none; opacity: 0.26;
    background-image:
      linear-gradient(to right, ${S.ink3} 1px, transparent 1px),
      linear-gradient(to bottom, ${S.ink3} 1px, transparent 1px);
    background-size: 8.3333% 12.5%;
    -webkit-mask-image: radial-gradient(ellipse at 32% 42%, #000 0%, transparent 76%);
    mask-image: radial-gradient(ellipse at 32% 42%, #000 0%, transparent 76%);
  }
  .subject {
    position: relative; z-index: 3;
    font-size: 152px; font-weight: 700; line-height: 1.02;
    letter-spacing: -0.035em; color: ${S.ink}; max-width: 88%;
  }
  .subject em {
    font-style: normal; color: ${S.ink};
    position: relative; display: inline-block; isolation: isolate;
  }
  .subject em .hl {
    position: absolute; left: -0.04em; right: -0.04em; bottom: 0.09em; height: 0.09em;
    background: ${S.accent}; opacity: 0.95; z-index: -1;
    transform-origin: 0 50%; display: block; border-radius: 2px;
  }
  .kicker {
    position: absolute; left: 12%; top: 13%; z-index: 3;
    font-size: 24px; font-weight: 600; letter-spacing: 0.30em; color: ${S.accent};
  }
  .hint {
    position: relative; z-index: 3; margin-top: 4.4vmin;
    font-size: 34px; line-height: 1.5; color: ${S.ink2}; max-width: 60%;
  }
  /* 强调用的呼吸圆环：只在 ring=true 的镜头出现，做环境循环 */
  .ring {
    position: absolute; right: 15%; top: 50%; width: 25vmin; height: 25vmin;
    margin-top: -12.5vmin; border-radius: 50%; z-index: 2;
    border: 2px solid ${S.accent}; opacity: 0.28;
  }
  /* 留白标尺：一条起自主体左侧的细线，点出「空」是有刻度的 */
  .measure {
    position: absolute; left: 12%; bottom: 17%; width: 8%; height: 2px; z-index: 3;
    background: ${S.accent}; opacity: 0.55; transform-origin: 0 50%;
  }
</style>
</head>
<body data-scene-id="${shotId}">
<div data-scene-id="${shotId}" data-beats="4" data-accent="${s.accent}">
  <div class="stage">
    <div class="hair-grid" data-motif></div>
    <div class="kicker" data-rank="tertiary">${s.kicker}</div>
    <div class="subject" data-rank="primary"><em>${s.hero}<span class="hl"></span></em></div>
    <div class="hint" data-rank="secondary">${s.sub}</div>
    ${s.ring ? '<div class="ring" data-ring></div>' : ''}
    <div class="measure" data-measure></div>
  </div>
</div>
<script src="../motion/gsap.min.js"></script>
<script src="../motion/motion-lib.js"></script>
<script>
(function () {
  function boot() {
    MV.use('scene-${shotId}');
    if (!MV.timeline()) return;
    var accentEl = document.querySelector('[data-accent]');
    var accent = accentEl ? accentEl.getAttribute('data-accent') === '1' : false;

    // 重音镜：词砸下来 + 划重点；非重音镜：静一点，只做位移与淡入
    if (accent) {
      MV.slam('.subject', { delay: 40 });
      MV.highlight('.subject em .hl', { delay: 320 });
    } else {
      MV.enter('.subject', { easing: 'power3.out', duration: 600, from: { opacity: 0, y: 44 } });
    }
    // 次级信息错峰进：kicker 先、hint 后，避免与主语同拍抢焦点
    MV.staggeredIn('.kicker, .hint', { delay: 60, secondary: 420, tertiary: 160 });
    MV.maskReveal('.measure', { dir: 'right', duration: 500, delay: 260 });
    // 环境循环：母题持续动，让「静止的一屏」也不是死帧
    MV.motifLoop('[data-motif]', { kind: '${s.motif}', amp: 0.22, span: 16 });
    ${s.ring ? "MV.motifLoop('[data-ring]', { kind: 'pulse', amp: 0.55, span: 26 });" : ''}
    // 相机：极简派靠缓慢推拉给出「在讲」的体感，不做花式运镜
    MV.camera('.stage', { move: '${s.cam}', zoom: 1.06 });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>
</body>
</html>
`;
}

const sceneDir = path.join(ROOT, 'projects', id, 'scenes');
await fs.mkdir(sceneDir, { recursive: true });
for (let i = 0; i < SHOTS.length; i += 1) {
  const shotId = `s${String(i + 1).padStart(2, '0')}`;
  await fs.writeFile(path.join(sceneDir, `Scene_${shotId}.html`), page(shotId, SHOTS[i]), 'utf8');
}
console.log(`写入 ${SHOTS.length} 个场景 → ${sceneDir}`);
