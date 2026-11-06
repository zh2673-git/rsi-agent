import type { LlmClient, LlmTask } from '../src/infrastructure/llm-client.js';
import { TemplateLlmClient } from '../src/infrastructure/llm-client.js';

/**
 * 测试用「有内容」讲稿替身（v1.1.1）。
 *
 * 为什么需要它：离线 TemplateLlmClient 从 v1.1.1 起只输出占位骨架（V-SCP-015 硬拒），
 * 而端到端/工程纪律测试要验的是「流水线能否跑通」，不是「讲稿写得好不好」。
 * 所以这里给一份**结构合法、内容唯一、主题落地**的合成讲稿：
 * 每段互不重复、含数字锚点，能过 V-SCP-011/012/013。
 *
 * 非 script 任务（导演批注/分镜/素材单）仍交给 TemplateLlmClient——
 * 那些属于结构决策，离线模板本来就够用，且下游会基于这里给出的真实旁白重算。
 */
export class ContentLlmStub implements LlmClient {
  readonly name = 'content-stub';
  private readonly inner = new TemplateLlmClient();

  constructor(private readonly lines: string[] = defaultLines()) {}

  async generate(task: LlmTask): Promise<unknown> {
    if (task.kind === 'storyboard') return this.storyboard(task);
    if (task.kind !== 'script') return this.inner.generate(task);
    const beats = (task.payload['beats'] as Array<{ id: string; function?: string }> | undefined) ?? [
      { id: 'hook' },
    ];
    const topic = (task.payload['topic'] as string | undefined) ?? '主题';
    const target = Math.max(
      beats.length,
      (task.payload['targetSegments'] as number | undefined) ?? beats.length,
    );
    const segments = Array.from({ length: target }, (_, i) => {
      const b = beats[i % beats.length]!;
      // 每句都带上主题标题，保证 V-SCP-013 主题指纹 100% 命中——
      // 真实 LLM 会自然复述主题词，stub 用最直接的方式满足同一判据。
      const line = this.lines[i % this.lines.length] ?? `第 ${i + 1} 段的具体内容`;
      // emphasis：V-RHY-004 需要"字幕高亮"这一路载体，真实 LLM 会从本句挑重音词。
      // 超长句会被 storyboard 拆成 a/b 两镜，任一镜都要能命中关键词 —— 定点取值必然漏，
      // 故对整句做 2-gram 全覆盖（composer 用 sentence.includes(w) 判定命中）。
      const emphasis: string[] = [];
      for (let k = 0; k + 2 <= line.length && emphasis.length < 40; k += 1) {
        emphasis.push(line.slice(k, k + 2));
      }
      const topicHead = topic.slice(0, Math.min(3, topic.length));
      if (topicHead.length >= 2 && !emphasis.includes(topicHead)) emphasis.push(topicHead);
      // line 自带句末标点；再拼一个「。」会在文本里产生纯标点句 "。"——
      // storyboard 拆 a/b 镜后，b 镜拿到 "。" → 无任何关键词 → V-RHY-004 字幕高亮载体丢失。
      const sentence = /[。！？]$/.test(line) ? line : `${line}。`;
      return {
        id: `seg-${i + 1}`,
        text: `${topic}的${sentence}`,
        function: (b.function ?? 'advance') as string,
        beat: b.id,
        mood: (['curious', 'neutral', 'tense', 'awe'] as const)[i % 4],
        emphasis,
      };
    });
    // 段数可能超过台词库：超过部分补唯一后缀，避免判重失败
    for (let i = this.lines.length; i < target; i += 1) {
      const base = this.lines[i % this.lines.length] ?? `第 ${i + 1} 段的具体内容`;
      segments[i]!.text = `${topic}的${base}（第 ${i + 1} 条）。`;
    }
    return { fullText: segments.map((s) => s.text).join(''), segments };
  }

  /**
   * 分镜：模板池里按镜头顺序轮转取用（不是同一形态铺满）。
   * 真实 LLM 会按语义选型；stub 只保证「形态有变化」这一形式判据，让 V-RHY-011 不被误触发。
   * 池足够大时每镜不同，池小于镜数时用错位轮转避免形成短周期。
   */
  private storyboard(task: LlmTask): unknown {
    const segments =
      (task.payload['segments'] as Array<{ id: string; text: string; beat?: string }> | undefined) ?? [];
    const pool = ((task.payload['templates'] as string[] | undefined) ?? ['typography']).filter(Boolean);
    const zooms = ['ELS', 'LS', 'MS', 'MCU', 'CU'];
    return segments.map((seg, i) => ({
      segmentId: seg.id,
      narration: seg.text,
      visual: {
        kind: 'code-scene',
        prompt: seg.text,
        template: pool.length > 0 ? pool[i % pool.length] : 'typography',
        params: {},
      },
      zoom: zooms[i % zooms.length],
      camera: ['push-in', 'pull-out', 'pan-left', 'tilt-up'][i % 4],
      motivation: '',
      counterpoint: 'metaphor',
      transition: '',
      coverage: [],
      enterAnchor: '',
      exitAnchor: '',
      audioShiftMs: 0,
    }));
  }
}

/**
 * 默认台词库：主题无关的通用占位——**只保证唯一且有数字锚点**。
 * 内容门要求 ≥80% 唯一 + 至少一处数字/专有名词，这些句子满足形式判据。
 */
function defaultLines(): string[] {
  const stems = [
    '流水线把一条指令拆成五个阶段并行推进',
    '取指阶段从缓存读取下一条指令',
    '译码阶段把机器码翻译成控制信号',
    '执行阶段由算术单元完成运算',
    '访存阶段读写数据缓存',
    '写回阶段把结果写进寄存器',
    '数据冒险会让后一条指令等待前一条',
    '转发技术可以绕过寄存器直接传结果',
    '分支预测猜错时要清空整条流水线',
    '超标量架构每个周期发射多条指令',
    '乱序执行按数据依赖重排指令顺序',
    '超标量宽度从 2 路扩展到 6 路',
  ];
  return stems.map((s, i) => (i === 0 ? s : `${s}，这是第 ${i + 1} 个环节`)).map((s) => `${s}。`);
}
