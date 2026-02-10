/**
 * Tests for LLM gateway env var passthrough in EnvManager (Issue #690)
 *
 * Verifies that buildIsolatedEnv() passes through LiteLLM and other
 * LLM gateway environment variables so users with proxy gateways
 * can route API calls correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { buildIsolatedEnv } from '../../src/shared/EnvManager.js';

describe('EnvManager Gateway Support (Issue #690)', () => {
  // Save and restore original env vars
  const gatewayVars = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLOUD_ML_REGION',
  ];

  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save original values
    for (const key of gatewayVars) {
      originalValues[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore original values
    for (const key of gatewayVars) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
  });

  it('should pass through ANTHROPIC_BASE_URL when set', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://litellm-server:4000';
    const env = buildIsolatedEnv(false);  // false = don't include credential file
    expect(env.ANTHROPIC_BASE_URL).toBe('https://litellm-server:4000');
  });

  it('should pass through ANTHROPIC_AUTH_TOKEN when set', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-litellm-key';
    const env = buildIsolatedEnv(false);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-litellm-key');
  });

  it('should pass through Bedrock gateway variables', () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://litellm:4000/bedrock';
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const env = buildIsolatedEnv(false);
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBe('https://litellm:4000/bedrock');
    expect(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBe('1');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('should pass through Vertex gateway variables', () => {
    process.env.ANTHROPIC_VERTEX_BASE_URL = 'https://litellm:4000/vertex_ai/v1';
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'my-gcp-project';
    process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1';
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.CLOUD_ML_REGION = 'us-east5';
    const env = buildIsolatedEnv(false);
    expect(env.ANTHROPIC_VERTEX_BASE_URL).toBe('https://litellm:4000/vertex_ai/v1');
    expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe('my-gcp-project');
    expect(env.CLAUDE_CODE_SKIP_VERTEX_AUTH).toBe('1');
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1');
    expect(env.CLOUD_ML_REGION).toBe('us-east5');
  });

  it('should NOT include gateway vars when not set in environment', () => {
    // Ensure vars are cleared
    for (const key of gatewayVars) {
      delete process.env[key];
    }
    const env = buildIsolatedEnv(false);
    for (const key of gatewayVars) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('should still include essential system vars alongside gateway vars', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://litellm:4000';
    const env = buildIsolatedEnv(false);
    // Gateway var present
    expect(env.ANTHROPIC_BASE_URL).toBe('https://litellm:4000');
    // Essential vars still present
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
  });

  it('should NOT pass through ANTHROPIC_API_KEY from process.env (credential isolation)', () => {
    // This is the security feature from Issue #733 - API keys should NOT leak through
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-project-env';
    const env = buildIsolatedEnv(false);  // false = don't include credential file
    // API key should NOT be in the isolated env (it should only come from ~/.claude-mem/.env)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Restore
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });
});
