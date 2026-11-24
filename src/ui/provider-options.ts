export const SELECTABLE_PROVIDERS = ['claude', 'gemini', 'openrouter', 'codex', 'openai-compatible'] as const;
export type SelectableProvider = typeof SELECTABLE_PROVIDERS[number];

export const QUOTA_FALLBACK_OFF = 'off';
export const QUOTA_FALLBACK_OPTIONS = [QUOTA_FALLBACK_OFF, ...SELECTABLE_PROVIDERS] as const;

export type QuotaFallbackOption = typeof QUOTA_FALLBACK_OPTIONS[number];

export const OPENAI_COMPAT_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type OpenAICompatReasoningEffort = typeof OPENAI_COMPAT_REASONING_EFFORTS[number];

export function parseOpenAICompatReasoningEffort(value: unknown): OpenAICompatReasoningEffort | undefined {
  return OPENAI_COMPAT_REASONING_EFFORTS.find(effort => effort === value);
}
