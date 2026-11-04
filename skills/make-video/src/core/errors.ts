export const ERR = {
  PROJECT_EXISTS: 'ERR_PROJECT_EXISTS',
  PROJECT_NOT_FOUND: 'ERR_PROJECT_NOT_FOUND',
  SCHEMA: 'ERR_SCHEMA',
  SCHEMA_VERSION: 'ERR_SCHEMA_VERSION',
  FS: 'ERR_FS',
  ILLEGAL_TRANSITION: 'ERR_ILLEGAL_TRANSITION',
  DEADLOCK: 'ERR_DEADLOCK',
  LLM_SCHEMA: 'ERR_LLM_SCHEMA',
  LLM_RETRY_EXCEEDED: 'ERR_LLM_RETRY_EXCEEDED',
  SCRIPT_FUNCTION: 'ERR_SCRIPT_FUNCTION',
  STORYBOARD_RULE: 'ERR_STORYBOARD_RULE',
  SCENE_INVALID: 'ERR_SCENE_INVALID',
  STYLE_UNKNOWN: 'ERR_STYLE_UNKNOWN',
  STYLE_INVALID: 'ERR_STYLE_INVALID',
  ASSET_MISSING: 'ERR_ASSET_MISSING',
  CLOUD_AUTH: 'ERR_CLOUD_AUTH',
  CLOUD_FAIL: 'ERR_CLOUD_FAIL',
  IMPORT_FAIL: 'ERR_IMPORT_FAIL',
  PROBE: 'ERR_PROBE',
  TTS: 'ERR_TTS',
  VALIDATION: 'ERR_VALIDATION',
  RENDER_ENV: 'ERR_RENDER_ENV',
  RENDER_LOCKED: 'ERR_RENDER_LOCKED',
  RENDER: 'ERR_RENDER',
  RENDER_OUTPUT: 'ERR_RENDER_OUTPUT',
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

export class MvError extends Error {
  readonly code: ErrCode;
  readonly detail?: unknown;
  constructor(code: ErrCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'MvError';
    this.code = code;
    this.detail = detail;
  }
}

export function mvError(code: ErrCode, message: string, detail?: unknown): MvError {
  return new MvError(code, message, detail);
}
