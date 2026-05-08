import { describe, expect, it } from 'bun:test';
import {
  buildGatewaySettings,
  gatewayProvidersForPlatform,
  getGatewayProfile,
  isClassicProvider,
  isGatewayProvider,
  litellmExampleForProfile,
} from '../src/npx-cli/commands/gateway-profiles.js';

describe('gateway provider profiles', () => {
  it('routes hosted, local, and custom choices through gateway mode', () => {
    expect(isGatewayProvider('gemini')).toBe(true);
    expect(isGatewayProvider('openrouter')).toBe(true);
    expect(isGatewayProvider('rapidmlx')).toBe(true);
    expect(isGatewayProvider('apple')).toBe(true);
    expect(isGatewayProvider('ollama')).toBe(true);
    expect(isGatewayProvider('lmstudio')).toBe(true);
    expect(isGatewayProvider('litellm')).toBe(true);
  });

  it('keeps classic REST providers explicit and separate', () => {
    expect(isGatewayProvider('gemini-classic')).toBe(false);
    expect(isGatewayProvider('openrouter-classic')).toBe(false);
    expect(isClassicProvider('gemini-classic')).toBe(true);
    expect(isClassicProvider('openrouter-classic')).toBe(true);
  });

  it('builds the single runtime path settings for gateway profiles', () => {
    expect(buildGatewaySettings('claude-mem-rapidmlx')).toEqual({
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'gateway',
      CLAUDE_MEM_MODEL: 'claude-mem-rapidmlx',
    });
  });

  it('documents Rapid-MLX as an OpenAI-compatible upstream behind LiteLLM', () => {
    const profile = getGatewayProfile('rapidmlx');
    const example = litellmExampleForProfile(profile);

    expect(profile.defaultModelAlias).toBe('claude-mem-rapidmlx');
    expect(example).toContain('model: openai/default');
    expect(example).toContain('api_base: http://127.0.0.1:8000/v1');
    expect(example).toContain('api_key: not-needed');
  });

  it('puts Mac-native local runtimes first on macOS', () => {
    expect(gatewayProvidersForPlatform('darwin')).toEqual([
      'rapidmlx',
      'apple',
      'ollama',
      'lmstudio',
      'gemini',
      'openrouter',
      'litellm',
    ]);
  });

  it('puts cross-platform local runtimes first off macOS', () => {
    expect(gatewayProvidersForPlatform('linux')).toEqual([
      'ollama',
      'lmstudio',
      'gemini',
      'openrouter',
      'litellm',
    ]);
    expect(gatewayProvidersForPlatform('win32')).toEqual([
      'ollama',
      'lmstudio',
      'gemini',
      'openrouter',
      'litellm',
    ]);
  });

  it('documents Apple Intelligence, Ollama, and LM Studio local gateway shapes', () => {
    expect(litellmExampleForProfile(getGatewayProfile('apple'))).toContain('model: openai/apple_local');
    expect(litellmExampleForProfile(getGatewayProfile('apple'))).toContain('api_base: http://127.0.0.1:11435/v1');
    expect(litellmExampleForProfile(getGatewayProfile('ollama'))).toContain('model: ollama_chat/qwen2.5:3b');
    expect(litellmExampleForProfile(getGatewayProfile('ollama'))).toContain('api_base: http://127.0.0.1:11434');
    expect(litellmExampleForProfile(getGatewayProfile('lmstudio'))).toContain('api_base: http://127.0.0.1:1234/v1');
  });
});
