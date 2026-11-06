/**
 * 能力清单（单一事实源 / Single Source of Truth）。
 *
 * 为什么需要这个文件：动效原语一共有 5 份引用点——
 *   ① `validators/scene.ts` MOTION_WHITELIST（校验器认什么）
 *   ② `templates/motion/motion-lib.js` 的 `MV.x = function`（真的实现了什么）
 *   ③ `composer.ts` 的 `hasMain` 正则（哪些算主动作）
 *   ④ `motion-grammar.ts` 的 REQUIRED_BY_GRAMMAR（语法骨架点名什么）
 *   ⑤ 文档 / SKILL.md 里手写的数字（"九种语法"、"12 个动效原语"）
 *
 * 这五份以前各自手写，于是漂移过三次（白名单漏 drift、文档写 9 种语法实为 11、
 * SKILL 风格菜单 16 条实际只有 9 个包）。本文件把「数量与名单」收成唯一出处，
 * 其余位置一律从这里派生；`tests/catalog.test.ts` 再把它钉在实现与文档上。
 *
 * 纪律：本文件只允许放**名单与常量**，不放逻辑——逻辑留在各自的 domain 文件里，
 * 否则它会长成第二个四不像。
 */
import { GRAMMARS, type GrammarSpec } from '../domain/motion-grammar.js';
import { ACCENT_PRIMITIVES, CAMERA_MOVES, MOTION_WHITELIST } from './validators/scene.js';

/**
 * 不算「主动作」的原语。
 *
 * 判据：它们要么是基础设施（装配时间轴/引入库），要么是**持续层**而非一次动作
 * （母题循环保证画面不死，但本身不承担叙事主动作），要么由别的闸门单独管
 * （字幕走 V-CAP，机位走 V-CAM，退场只是收尾）。
 * 主动作的定义是「这一镜里能被看见的一次叙事性运动」，所以下面这些排除在外。
 */
export const NON_ACTION_PRIMITIVES = [
  'MV.use', // 装配：引入 composition
  'MV.timeline', // 装配：建时间轴
  'MV.subtitle', // 字幕：V-CAP-001/002 单独管
  'MV.camera', // 机位：V-CAM-002 单独管
  'MV.exit', // 收尾：退场不是主动作
  'MV.idle', // 待机呼吸：低幅持续层
  'MV.motifLoop', // 母题循环：V-MOT-021 单独管，且它是「持续」不是「一次」
] as const;

/**
 * 算主动作的原语 = 白名单 − 非主动作。
 *
 * composer 的 `hasMain` 从这里派生（以前是手写正则枚举 18 个，漏了 drift）。
 * `drift` 归入主动作：它是**刻意选择**的匀速慢移（v1.1.1 专为氛围镜加的），
 * 与「没填机位」不同——`static/none` 才是真的不动机位。
 */
export const MAIN_ACTION_PRIMITIVES: readonly string[] = MOTION_WHITELIST.filter(
  (p) => !(NON_ACTION_PRIMITIVES as readonly string[]).includes(p),
);

/** 语法 id 名单（从 GRAMMARS 派生，禁止手写） */
export const GRAMMAR_IDS: readonly string[] = GRAMMARS.map((g) => g.id);

/** 能力清单的结构：`make-video capability --json` 的输出契约 */
export interface CapabilityManifest {
  version: {
    schema: number;
    /** 动效原语总数（白名单口径） */
    primitives: number;
    /** 其中算主动作的 */
    mainActions: number;
    /** 重音类（受 V-MOT-013 1/3 预算约束） */
    accents: number;
    /** 镜头语法 */
    grammars: number;
    /** 机位 move 词表 */
    cameraMoves: number;
  };
  primitives: {
    all: readonly string[];
    mainActions: readonly string[];
    nonActions: readonly string[];
    accents: readonly string[];
  };
  grammars: readonly GrammarSpec[];
  cameraMoves: readonly string[];
}

/** 生成能力清单（纯函数，不读盘——风格包/模板/配方要读盘，由 cli 补） */
export function buildCapability(): CapabilityManifest {
  return {
    version: {
      schema: 1,
      primitives: MOTION_WHITELIST.length,
      mainActions: MAIN_ACTION_PRIMITIVES.length,
      accents: ACCENT_PRIMITIVES.length,
      grammars: GRAMMARS.length,
      cameraMoves: CAMERA_MOVES.length,
    },
    primitives: {
      all: MOTION_WHITELIST,
      mainActions: MAIN_ACTION_PRIMITIVES,
      nonActions: NON_ACTION_PRIMITIVES,
      accents: ACCENT_PRIMITIVES,
    },
    grammars: GRAMMARS,
    cameraMoves: CAMERA_MOVES,
  };
}
