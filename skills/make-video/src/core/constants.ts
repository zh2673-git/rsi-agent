export const SCHEMA_VERSION = 1;

export const PROJECTS_DIR = 'projects';
export const TEMPLATES_DIR = 'templates';
export const STYLES_DIR = 'styles';
export const RECIPES_DIR = 'recipes';

export const ASPECTS = ['16:9', '9:16'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const DURATION_TIERS = ['0-5', '5-10', '10+'] as const;
export type DurationTier = (typeof DURATION_TIERS)[number];

export const ASPECT_SIZE: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

export const FPS = 30;
export const CODEC = 'h264';

export const CONCURRENCY = 3;
export const LLM_RETRY_MAX = 3;
// LLM 场景生成带反馈重试次数（校验器意见回传）；耗尽后回退本地模板 forge
export const SCENE_LLM_RETRIES = 2;
export const CLOUD_RETRY_MAX = 3;
export const CLOUD_POLL_INTERVAL_MS = 5000;
export const CLOUD_POLL_MAX_MS = 600000;

export const HYPERFRAMES_VERSION = '0.8.173';
export const BUDDY_CLOUD_SCRIPT_ENV = 'BUDDY_CLOUD_SCRIPT';

export const AUDIO_SAMPLE_RATE = 24000;
export const MS_PER_CHAR_CN = 220;

export const DUCK_RATIO = 0.175;
export const SYNC_TOLERANCE_MS = 100;

export const GENRES = [
  'science-explainer',
  'story-narrative',
  'product-promo',
  'tutorial-howto',
  'news-brief',
  'opinion-essay',
  'documentary-mood',
  'kids-education',
  'cosmos-cinematic',
] as const;
export type Genre = (typeof GENRES)[number];

export const ANATOMY_KEYS = [
  'script',
  'directing',
  'art',
  'camera',
  'performance',
  'sourcing',
  'sound',
  'editing',
] as const;
export type AnatomyKey = (typeof ANATOMY_KEYS)[number];
