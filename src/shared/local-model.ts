// SPDX-License-Identifier: Apache-2.0
//
// Local-model capability detection. claude-mem can already run memory
// compression against a local OpenAI-compatible endpoint (Ollama, LM Studio)
// via CLAUDE_MEM_PROVIDER=openrouter + CLAUDE_MEM_OPENROUTER_BASE_URL — which
// makes memory processing free. This module answers two questions for the
// `claude-mem local-model` CLI: can this machine plausibly run a local model,
// and is a local runtime already installed and serving?

import * as os from 'os';

export type HardwareTier = 'insufficient' | 'small' | 'medium' | 'large';

export interface HardwareAssessment {
  ramGb: number;
  cpuCount: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  tier: HardwareTier;
  // Human-readable parameter-size guidance, e.g. "7–8B".
  recommendedParamSize: string | null;
  // A concrete Ollama model tag for the tier, used in setup hints.
  recommendedOllamaModel: string | null;
}

// RAM is the binding constraint for local inference: a q4-quantized model
// needs roughly paramCount/2 GB resident, plus the OS, plus whatever else the
// machine is doing (this worker runs NEXT TO an IDE and a browser). Tiers are
// deliberately conservative — recommending a model that swaps is worse than
// recommending none.
export function assessHardware(input?: {
  totalMemBytes?: number;
  platform?: string;
  arch?: string;
  cpuCount?: number;
}): HardwareAssessment {
  const totalMemBytes = input?.totalMemBytes ?? os.totalmem();
  const platform = input?.platform ?? process.platform;
  const arch = input?.arch ?? process.arch;
  const cpuCount = input?.cpuCount ?? os.cpus().length;

  const ramGb = Math.round(totalMemBytes / (1024 ** 3));
  const appleSilicon = platform === 'darwin' && arch === 'arm64';

  let tier: HardwareTier;
  if (ramGb < 8) tier = 'insufficient';
  else if (ramGb < 16) tier = 'small';
  else if (ramGb < 32) tier = 'medium';
  else tier = 'large';

  const recommendation: Record<HardwareTier, { size: string; ollama: string } | null> = {
    insufficient: null,
    small: { size: '3B', ollama: 'qwen2.5:3b' },
    medium: { size: '7–8B', ollama: 'qwen2.5:7b' },
    large: { size: '14B', ollama: 'qwen2.5:14b' },
  };
  const rec = recommendation[tier];

  return {
    ramGb,
    cpuCount,
    platform,
    arch,
    appleSilicon,
    tier,
    recommendedParamSize: rec?.size ?? null,
    recommendedOllamaModel: rec?.ollama ?? null,
  };
}

export interface RuntimeProbe {
  name: 'ollama' | 'lmstudio';
  detected: boolean;
  // OpenAI-compatible base URL to put in CLAUDE_MEM_OPENROUTER_BASE_URL.
  openAiBaseUrl: string;
  models: string[];
}

const PROBE_TIMEOUT_MS = 1500;

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
export const LMSTUDIO_DEFAULT_URL = 'http://127.0.0.1:1234';

export async function probeOllama(baseUrl: string = OLLAMA_DEFAULT_URL): Promise<RuntimeProbe> {
  const probe: RuntimeProbe = { name: 'ollama', detected: false, openAiBaseUrl: `${baseUrl}/v1`, models: [] };
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return probe;
    const data = await res.json() as { models?: Array<{ name?: string }> };
    probe.detected = true;
    probe.models = (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
  } catch {
    // not running — leave detected: false
  }
  return probe;
}

export async function probeLmStudio(baseUrl: string = LMSTUDIO_DEFAULT_URL): Promise<RuntimeProbe> {
  const probe: RuntimeProbe = { name: 'lmstudio', detected: false, openAiBaseUrl: `${baseUrl}/v1`, models: [] };
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return probe;
    const data = await res.json() as { data?: Array<{ id?: string }> };
    probe.detected = true;
    probe.models = (data.data ?? []).map(m => m.id ?? '').filter(Boolean);
  } catch {
    // not running — leave detected: false
  }
  return probe;
}

// The settings delta that switches memory compression to a local endpoint.
// Pure so the CLI and tests share it. The API key is intentionally left
// untouched: local OpenAI-compatible endpoints need none, and provider
// availability treats a configured base URL as sufficient.
export function localModelSettingsDelta(openAiBaseUrl: string, model: string): Record<string, string> {
  return {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_BASE_URL: openAiBaseUrl,
    CLAUDE_MEM_OPENROUTER_MODEL: model,
  };
}
