import { describe, expect, it } from 'bun:test';
import {
  buildGatewaySettings,
  getGatewayProfile,
  isClassicProvider,
  isGatewayProvider,
  litellmExampleForProfile,
} from '../src/npx-cli/commands/gateway-profiles.js';

describe('gateway provider profiles', () => {
  it('routes Gemini, OpenRouter, Rapid-MLX, and custom LiteLLM through gateway mode', () => {
    expect(isGatewayProvider('gemini')).toBe(true);
    expect(isGatewayProvider('openrouter')).toBe(true);
    expect(isGatewayProvider('rapidmlx')).toBe(true);
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
});
