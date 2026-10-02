/**
 * The openai-compatible endpoint presets, as the settings modal lists them.
 *
 * The viewer bundle cannot import src/shared/openai-compat-presets.ts (the
 * viewer compiles on its own root), so this is a copy of the fields the form
 * needs. tests/shared/openrouter-settings-surface.test.ts keeps the two in
 * step: add a preset there and here together.
 */
export interface OpenAICompatPresetOption {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

export const OPENAI_COMPAT_PRESET_OPTIONS: readonly OpenAICompatPresetOption[] = [
  { id: 'nvidia-nim', label: 'NVIDIA NIM (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
  { id: 'orcarouter', label: 'OrcaRouter (orcarouter.ai)', baseUrl: 'https://api.orcarouter.ai/v1', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'api-route', label: 'API Route (api-route.com)', baseUrl: 'https://global.api-route.com/v1', defaultModel: '' },
  { id: 'opper', label: 'Opper (opper.ai)', baseUrl: 'https://api.opper.ai/v3/compat', defaultModel: 'gpt-5.4-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'opencode-go', label: 'OpenCode Go (opencode.ai)', baseUrl: 'https://opencode.ai/zen/go/v1', defaultModel: 'kimi-k3' },
  { id: 'opencode-zen', label: 'OpenCode Zen (opencode.ai)', baseUrl: 'https://opencode.ai/zen/v1', defaultModel: '' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: '' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', defaultModel: '' },
  { id: 'minimax', label: 'MiniMax (global)', baseUrl: 'https://api.minimax.io/v1', defaultModel: 'MiniMax-M3' },
  { id: 'minimax-cn', label: 'MiniMax (China)', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3' },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', defaultModel: '' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', defaultModel: '' },
  { id: 'vllm', label: 'vLLM (self-hosted)', baseUrl: 'http://localhost:8000/v1', defaultModel: '' },
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint', baseUrl: '', defaultModel: '' },
];

/** The preset a stored id selects: unknown or blank ids mean `custom`, as on the worker. */
export function openAICompatPresetOption(id: string | undefined): OpenAICompatPresetOption {
  const wanted = (id ?? '').trim().toLowerCase() || 'custom';
  return OPENAI_COMPAT_PRESET_OPTIONS.find(preset => preset.id === wanted)
    ?? OPENAI_COMPAT_PRESET_OPTIONS.find(preset => preset.id === 'custom')!;
}
