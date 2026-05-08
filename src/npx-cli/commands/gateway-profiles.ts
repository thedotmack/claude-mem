export type GatewayProviderId =
  | 'gemini'
  | 'openrouter'
  | 'rapidmlx'
  | 'apple'
  | 'ollama'
  | 'lmstudio'
  | 'litellm';
export type ClassicProviderId = 'gemini-classic' | 'openrouter-classic';
export type ProviderId = 'claude' | GatewayProviderId | ClassicProviderId;

export interface GatewayProfile {
  id: GatewayProviderId;
  label: string;
  optionLabel: string;
  defaultGatewayUrl: string;
  defaultModelAlias: string;
  setupHint: string;
}

export const DEFAULT_LITELLM_GATEWAY_URL = 'http://127.0.0.1:4000';
export const LITELLM_CHAT_COMPLETIONS_FOR_ANTHROPIC_MESSAGES_ENV =
  'LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES=true';

export const GATEWAY_PROFILES: Record<GatewayProviderId, GatewayProfile> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    optionLabel: 'Gemini via LiteLLM gateway',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-gemini',
    setupHint: 'Configure LiteLLM with a Gemini upstream and expose this alias.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    optionLabel: 'OpenRouter via LiteLLM gateway',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-openrouter',
    setupHint: 'Configure LiteLLM with an OpenRouter upstream and expose this alias.',
  },
  rapidmlx: {
    id: 'rapidmlx',
    label: 'Rapid-MLX',
    optionLabel: 'Rapid-MLX local model (Apple Silicon, fastest path)',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-rapidmlx',
    setupHint: 'Run Rapid-MLX on http://127.0.0.1:8000/v1, then point LiteLLM at it.',
  },
  apple: {
    id: 'apple',
    label: 'Apple Intelligence',
    optionLabel: 'Apple Intelligence local model (macOS 26+, experimental)',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-apple',
    setupHint: 'Run an Apple Foundation Models OpenAI-compatible proxy on http://127.0.0.1:11435/v1, then point LiteLLM at it.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    optionLabel: 'Ollama local model via LiteLLM gateway',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-ollama',
    setupHint: 'Run Ollama on http://127.0.0.1:11434, pull a small instruct model, then expose it through LiteLLM.',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    optionLabel: 'LM Studio local model via LiteLLM gateway',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-lmstudio',
    setupHint: 'Start the LM Studio local server on http://127.0.0.1:1234/v1, then point LiteLLM at it.',
  },
  litellm: {
    id: 'litellm',
    label: 'LiteLLM/custom',
    optionLabel: 'Custom LiteLLM gateway',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-haiku-4-5-20251001',
    setupHint: 'Use any LiteLLM model alias your gateway exposes.',
  },
};

const REMOTE_GATEWAY_PROVIDERS: GatewayProviderId[] = ['gemini', 'openrouter'];
const CUSTOM_GATEWAY_PROVIDERS: GatewayProviderId[] = ['litellm'];

export function gatewayProvidersForPlatform(platform: string = process.platform): GatewayProviderId[] {
  const localProviders: GatewayProviderId[] = platform === 'darwin'
    ? ['rapidmlx', 'apple', 'ollama', 'lmstudio']
    : ['ollama', 'lmstudio'];

  return [
    ...localProviders,
    ...REMOTE_GATEWAY_PROVIDERS,
    ...CUSTOM_GATEWAY_PROVIDERS,
  ];
}

export function isGatewayProvider(provider: ProviderId): provider is GatewayProviderId {
  return provider in GATEWAY_PROFILES;
}

export function isClassicProvider(provider: ProviderId): provider is ClassicProviderId {
  return provider === 'gemini-classic' || provider === 'openrouter-classic';
}

export function getGatewayProfile(provider: GatewayProviderId): GatewayProfile {
  return GATEWAY_PROFILES[provider];
}

export function buildGatewaySettings(modelAlias: string): Record<string, string> {
  return {
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'gateway',
    CLAUDE_MEM_MODEL: modelAlias,
  };
}

export function litellmExampleForProfile(
  profile: GatewayProfile,
  modelAlias: string = profile.defaultModelAlias,
): string {
  switch (profile.id) {
    case 'gemini':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: gemini/gemini-2.5-flash-lite',
        '      api_key: os.environ/GEMINI_API_KEY',
      ].join('\n');
    case 'openrouter':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: openrouter/xiaomi/mimo-v2-flash:free',
        '      api_key: os.environ/OPENROUTER_API_KEY',
      ].join('\n');
    case 'rapidmlx':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: openai/default',
        '      api_base: http://127.0.0.1:8000/v1',
        '      api_key: not-needed',
      ].join('\n');
    case 'apple':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: openai/apple_local',
        '      api_base: http://127.0.0.1:11435/v1',
        '      api_key: not-needed',
      ].join('\n');
    case 'ollama':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: ollama_chat/qwen2.5:3b',
        '      api_base: http://127.0.0.1:11434',
      ].join('\n');
    case 'lmstudio':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: openai/local-model',
        '      api_base: http://127.0.0.1:1234/v1',
        '      api_key: not-needed',
      ].join('\n');
    case 'litellm':
      return [
        'model_list:',
        `  - model_name: ${modelAlias}`,
        '    litellm_params:',
        '      model: openai/gpt-4o-mini',
        '      api_key: os.environ/OPENAI_API_KEY',
      ].join('\n');
  }
}

export function litellmStartHintForProfile(profile: GatewayProfile): string {
  const baseCommand = 'litellm --config litellm-config.yaml --host 127.0.0.1 --port 4000';

  switch (profile.id) {
    case 'rapidmlx':
    case 'apple':
    case 'lmstudio':
      return [
        'Start LiteLLM with Anthropic messages routed through OpenAI chat completions:',
        `${LITELLM_CHAT_COMPLETIONS_FOR_ANTHROPIC_MESSAGES_ENV} ${baseCommand}`,
      ].join('\n');
    default:
      return `Start LiteLLM: ${baseCommand}`;
  }
}
