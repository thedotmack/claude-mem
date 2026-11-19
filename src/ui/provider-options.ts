export const SELECTABLE_PROVIDERS = ['claude', 'gemini', 'openrouter', 'codex', 'openai-compatible'] as const;
export type SelectableProvider = typeof SELECTABLE_PROVIDERS[number];

export const QUOTA_FALLBACK_OFF = 'off';
export const QUOTA_FALLBACK_OPTIONS = [QUOTA_FALLBACK_OFF, ...SELECTABLE_PROVIDERS] as const;

export type QuotaFallbackOption = typeof QUOTA_FALLBACK_OPTIONS[number];
