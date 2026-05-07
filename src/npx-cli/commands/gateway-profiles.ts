export type GatewayProviderId = 'gemini' | 'openrouter' | 'rapidmlx' | 'litellm';
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
    optionLabel: 'Rapid-MLX local model via LiteLLM gateway',
    defaultGatewayUrl: DEFAULT_LITELLM_GATEWAY_URL,
    defaultModelAlias: 'claude-mem-rapidmlx',
    setupHint: 'Run Rapid-MLX on http://127.0.0.1:8000/v1, then point LiteLLM at it.',
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
