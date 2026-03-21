/**
 * TokenCostEstimator: Estimate USD cost for LLM API calls
 *
 * Static pricing table for known models with fallback for unknown.
 * Prices are per million tokens. Last updated: March 2026.
 */

interface ModelPricing {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens
}

// Pricing per million tokens (approximate, March 2026)
const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-5.4': { input: 3.00, output: 12.00 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o3': { input: 10.00, output: 40.00 },
  'o4-mini': { input: 1.10, output: 4.40 },
  // Claude
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'haiku': { input: 0.80, output: 4.00 },
  'sonnet': { input: 3.00, output: 15.00 },
  'opus': { input: 15.00, output: 75.00 },
  // Gemini
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'gemini-3-flash-preview': { input: 0.15, output: 0.60 },
  // Open Source / Free
  'deepseek-v3.2': { input: 0.27, output: 1.10 },
  'deepseek-r1': { input: 0.55, output: 2.19 },
  // OpenRouter prefixed
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'openai/gpt-4.1': { input: 2.00, output: 8.00 },
  'anthropic/claude-sonnet-4': { input: 3.00, output: 15.00 },
  'anthropic/claude-opus-4': { input: 15.00, output: 75.00 },
  'google/gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'deepseek/deepseek-r1': { input: 0.55, output: 2.19 },
};

// Free models (zero cost)
const FREE_MODELS = new Set([
  'xiaomi/mimo-v2-flash:free',
  'stepfun/step-3.5-flash:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'nvidia/nemotron-3-super:free',
  'moonshotai/kimi-k2.5:free',
  'minimax/minimax-m2.7:free',
  'deepseek/deepseek-v3.2-speciale:free',
  'qwen/qwen-3-235b:free',
]);

const DEFAULT_PRICING: ModelPricing = { input: 1.00, output: 3.00 }; // $1/$3 per 1M as fallback

export function estimateCostUsd(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  // Free models
  if (FREE_MODELS.has(model) || model.endsWith(':free')) {
    return 0;
  }

  // Look up pricing (try full model, then without provider prefix)
  const pricing = PRICING[model]
    || PRICING[model.replace(/^[^/]+\//, '')] // strip provider/ prefix
    || DEFAULT_PRICING;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return Math.round((inputCost + outputCost) * 10000) / 10000; // 4 decimal places
}

export function formatCost(usd: number): string {
  if (usd === 0) return 'Free';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
