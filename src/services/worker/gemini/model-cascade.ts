import type { GeminiModelInfo, ModelCategory } from './types.js';

/**
 * Baseline default catalogue of Gemini and Gemma models,
 * ranked strictly from most powerful to least powerful.
 *
 * Ranking criteria:
 * 1. Parameter scale & deep reasoning capacity (Pro > Flash 3.8/3.7/3.6/3.5 > Gemma 31B/26B > Omni > Lite)
 * 2. Context window size (1M vs 256k vs 128k)
 * 3. High throughput and rate tolerance
 */
export const DEFAULT_MODEL_CASCADE: readonly GeminiModelInfo[] = [
  // --- Tier 1: Pro Models (Frontier reasoning, maximum parameter count) ---
  {
    id: 'gemini-pro-latest',
    displayName: 'Gemini Pro Latest',
    category: 'pro',
    rank: 1,
    rpmLimit: 2,
    tpmLimit: 32768,
    rpdLimit: 50,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPerpetualAlias: true,
    description: 'Perpetual alias tracking the latest GA Gemini Pro release'
  },
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    category: 'pro',
    rank: 2,
    rpmLimit: 2,
    tpmLimit: 32768,
    rpdLimit: 50,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPreview: true,
    description: 'Gemini 3.1 Pro preview for frontier reasoning and complex code architecture'
  },
  {
    id: 'gemini-3.1-pro-preview-customtools',
    displayName: 'Gemini 3.1 Pro Preview (Custom Tools)',
    category: 'pro',
    rank: 3,
    rpmLimit: 2,
    tpmLimit: 32768,
    rpdLimit: 50,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPreview: true,
    description: 'Gemini 3.1 Pro preview optimized for tool calling and structured observations'
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    category: 'pro',
    rank: 4,
    rpmLimit: 2,
    tpmLimit: 32768,
    rpdLimit: 50,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 2.5 Pro stable release with 1M context'
  },

  // --- Tier 2: Flash Flagship Models (High reasoning, high speed, 1M context) ---
  {
    id: 'gemini-flash-latest',
    displayName: 'Gemini Flash Latest',
    category: 'flash',
    rank: 5,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPerpetualAlias: true,
    description: 'Perpetual alias tracking the latest GA Gemini Flash release'
  },
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    category: 'flash',
    rank: 6,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Top-tier Gemini 3.8 Flash with state of the art reasoning and speed'
  },
  {
    id: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    category: 'flash',
    rank: 7,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 3.7 Flash with advanced reasoning and high throughput'
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    category: 'flash',
    rank: 8,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 3.6 Flash balanced model for memory compression'
  },
  {
    id: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    category: 'flash',
    rank: 9,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Proven stable Gemini 3.5 Flash release'
  },
  {
    id: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    category: 'flash',
    rank: 10,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPreview: true,
    description: 'Gemini 3 Flash preview release'
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    category: 'flash',
    rank: 11,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 2.5 Flash stable legacy release'
  },

  // --- Tier 3: Gemma Open Weights Models (Google Open Architecture on API) ---
  {
    id: 'gemma-4-31b-it',
    displayName: 'Gemma 4 31B IT',
    category: 'gemma',
    rank: 12,
    rpmLimit: 15,
    tpmLimit: 500000,
    rpdLimit: 1500,
    contextWindow: 262144,
    outputLimit: 32768,
    description: 'Flagship Gemma 4 31B instruction-tuned open weights model'
  },
  {
    id: 'gemma-4-26b-a4b-it',
    displayName: 'Gemma 4 26B A4B IT',
    category: 'gemma',
    rank: 13,
    rpmLimit: 15,
    tpmLimit: 500000,
    rpdLimit: 1500,
    contextWindow: 262144,
    outputLimit: 32768,
    description: 'Gemma 4 26B instruction-tuned reasoning model'
  },
  {
    id: 'gemma-2-27b-it',
    displayName: 'Gemma 2 27B IT',
    category: 'gemma',
    rank: 14,
    rpmLimit: 15,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 8192,
    outputLimit: 4096,
    description: 'Gemma 2 27B instruction-tuned model'
  },
  {
    id: 'gemma-2-9b-it',
    displayName: 'Gemma 2 9B IT',
    category: 'gemma',
    rank: 15,
    rpmLimit: 15,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 8192,
    outputLimit: 4096,
    description: 'Gemma 2 9B instruction-tuned model'
  },

  // --- Tier 4: Omni & Agentic Previews ---
  {
    id: 'gemini-omni-1.1-flash',
    displayName: 'Gemini Omni 1.1 Flash',
    category: 'omni',
    rank: 16,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 131072,
    outputLimit: 65536,
    description: 'Gemini Omni 1.1 Flash multimodal model'
  },
  {
    id: 'gemini-omni-flash-preview',
    displayName: 'Gemini Omni Flash Preview',
    category: 'omni',
    rank: 17,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 131072,
    outputLimit: 65536,
    isPreview: true,
    description: 'Gemini Omni Flash Preview release'
  },
  {
    id: 'antigravity-preview-05-2026',
    displayName: 'Antigravity Agent Preview',
    category: 'omni',
    rank: 18,
    rpmLimit: 10,
    tpmLimit: 250000,
    rpdLimit: 1500,
    contextWindow: 131072,
    outputLimit: 65536,
    isPreview: true,
    description: 'Agentic workflow preview model'
  },

  // --- Tier 5: Flash Lite (Highest rate tolerance, lowest latency) ---
  {
    id: 'gemini-flash-lite-latest',
    displayName: 'Gemini Flash-Lite Latest',
    category: 'lite',
    rank: 19,
    rpmLimit: 15,
    tpmLimit: 1000000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPerpetualAlias: true,
    description: 'Perpetual alias tracking the latest GA Gemini Flash Lite release'
  },
  {
    id: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash Lite',
    category: 'lite',
    rank: 20,
    rpmLimit: 15,
    tpmLimit: 1000000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 3.5 Flash Lite high-speed model'
  },
  {
    id: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    category: 'lite',
    rank: 21,
    rpmLimit: 15,
    tpmLimit: 1000000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 3.1 Flash Lite high-throughput model'
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    displayName: 'Gemini 3.1 Flash Lite Preview',
    category: 'lite',
    rank: 22,
    rpmLimit: 15,
    tpmLimit: 1000000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    isPreview: true,
    description: 'Gemini 3.1 Flash Lite Preview release'
  },
  {
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite',
    category: 'lite',
    rank: 23,
    rpmLimit: 15,
    tpmLimit: 1000000,
    rpdLimit: 500,
    contextWindow: 1048576,
    outputLimit: 65536,
    description: 'Gemini 2.5 Flash Lite stable legacy release'
  }
];

export function getModelInfo(modelId: string): GeminiModelInfo | undefined {
  return DEFAULT_MODEL_CASCADE.find(m => m.id === modelId);
}

export function classifyModelCategory(modelId: string): ModelCategory {
  const id = modelId.toLowerCase();
  if (id.includes('pro')) return 'pro';
  if (id.includes('gemma')) return 'gemma';
  if (id.includes('omni') || id.includes('antigravity') || id.includes('deep-research')) return 'omni';
  if (id.includes('lite')) return 'lite';
  return 'flash';
}

export interface TierRateLimits {
  rpmLimit: number;
  tpmLimit: number;
  rpdLimit: number;
}

/**
 * Return effective rate limits based on user tier:
 * - 'free': Official Google AI Studio Free Tier limits
 * - 'payg': Official Google Cloud / AI Studio Pay-As-You-Go (Tier 1) limits
 */
export function getTierLimits(model: GeminiModelInfo, tier: 'free' | 'payg'): TierRateLimits {
  if (tier === 'free') {
    return {
      rpmLimit: model.rpmLimit,
      tpmLimit: model.tpmLimit,
      rpdLimit: model.rpdLimit,
    };
  }

  // Pay-As-You-Go (Tier 1) limits from Google AI Studio
  switch (model.category) {
    case 'pro':
      return {
        rpmLimit: 15,
        tpmLimit: 2000000,
        rpdLimit: 1000,
      };
    case 'flash':
      return {
        rpmLimit: 30,
        tpmLimit: 4000000,
        rpdLimit: 4000,
      };
    case 'lite':
      return {
        rpmLimit: 30,
        tpmLimit: 4000000,
        rpdLimit: 4000,
      };
    case 'gemma':
      return {
        rpmLimit: 30,
        tpmLimit: 1000000,
        rpdLimit: 2000,
      };
    default:
      return {
        rpmLimit: 30,
        tpmLimit: 2000000,
        rpdLimit: 2000,
      };
  }
}
