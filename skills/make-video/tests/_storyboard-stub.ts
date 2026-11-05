import type { LlmClient, LlmTask } from '../src/infrastructure/llm-client.js';

/**
 * 只喂分镜的最小 LLM 替身：把给定旁白切成逐镜，模板取风格池里第一个。
 * 用于验证「重跑分镜是否沿用上游产物」这类纯领域行为，不触网、不依赖模板库。
 */
export class StoryboardLlmStub implements LlmClient {
  readonly name = 'storyboard-stub';

  constructor(private readonly lines: string[]) {}

  async generate(task: LlmTask): Promise<unknown> {
    if (task.kind !== 'storyboard') return { html: '<!doctype html><body></body>' };
    const templates = (task.payload['templates'] as string[] | undefined) ?? ['kinetic-type'];
    return this.lines.map((narration, i) => ({
      segmentId: `seg-${i + 1}`,
      narration,
      visual: { kind: 'code-scene', prompt: narration, template: templates[i % templates.length], params: {} },
      zoom: 'MS',
      camera: 'push-in',
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
