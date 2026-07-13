// SPDX-License-Identifier: Apache-2.0

export type OpenRouterReasoningEffort = 'none' | 'low' | 'medium' | 'high';

const OPENROUTER_REASONING_EFFORTS = new Set<OpenRouterReasoningEffort>([
  'none',
  'low',
  'medium',
  'high',
]);

const BLOCKED_EXTRA_BODY_KEYS = new Set([
  'model',
  'messages',
  'temperature',
  'max_tokens',
  'usage',
  'reasoning',
  'stream',
]);

export function parseOpenRouterReasoningEffort(value: unknown): OpenRouterReasoningEffort | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return OPENROUTER_REASONING_EFFORTS.has(normalized as OpenRouterReasoningEffort)
    ? normalized as OpenRouterReasoningEffort
    : null;
}

export function validateOpenRouterReasoningEffort(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseOpenRouterReasoningEffort(value)
    ? null
    : 'CLAUDE_MEM_OPENROUTER_REASONING_EFFORT must be one of: none, low, medium, high';
}

export function validateOpenRouterExtraBodyObject(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY must be a JSON object';
  }

  for (const key of Object.keys(value)) {
    if (BLOCKED_EXTRA_BODY_KEYS.has(key)) {
      return `CLAUDE_MEM_OPENROUTER_EXTRA_BODY cannot override core request field "${key}"`;
    }
  }

  return null;
}

export function parseOpenRouterExtraBody(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    const validationError = validateOpenRouterExtraBodyObject(parsed);
    if (validationError) {
      throw new Error(validationError);
    }
    return parsed as Record<string, unknown>;
  }

  const validationError = validateOpenRouterExtraBodyObject(value);
  if (validationError) {
    throw new Error(validationError);
  }
  return value as Record<string, unknown>;
}

export function validateOpenRouterExtraBody(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    parseOpenRouterExtraBody(value);
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY is not valid JSON';
    }
    return error instanceof Error ? error.message : 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY is invalid';
  }
}

export function buildOpenRouterRequestBody(input: {
  apiUrl: string;
  model: string;
  messages: unknown[];
  reasoningEffort?: OpenRouterReasoningEffort | null;
  extraBody?: Record<string, unknown> | null;
}): Record<string, unknown> {
  if (input.extraBody) {
    const validationError = validateOpenRouterExtraBodyObject(input.extraBody);
    if (validationError) {
      throw new Error(validationError);
    }
  }

  return {
    model: input.model,
    messages: input.messages,
    temperature: 0.3,
    max_tokens: 4096,
    ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    ...(input.apiUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
    ...(input.extraBody ?? {}),
  };
}
