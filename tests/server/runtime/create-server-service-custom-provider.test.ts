// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CUSTOM_PROVIDER_HELPERS_API_VERSION,
  loadCustomServerGenerationProvider,
} from '../../../src/server/runtime/create-server-service.js';
import { logger } from '../../../src/utils/logger.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

const FIXTURES_DIR = resolve(import.meta.dir, '../../fixtures/custom-providers');
const EMPTY_CONTEXT = {} as ServerGenerationContext;

describe('loadCustomServerGenerationProvider', () => {
  const originalModulePath = process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE;
  const originalMaxOutputTokens = process.env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS;

  afterEach(() => {
    if (originalModulePath === undefined) delete process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE;
    else process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = originalModulePath;
    if (originalMaxOutputTokens === undefined) delete process.env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS;
    else process.env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS = originalMaxOutputTokens;
  });

  it('returns null when CLAUDE_MEM_CUSTOM_PROVIDER_MODULE is unset', async () => {
    delete process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE;
    expect(await loadCustomServerGenerationProvider()).toBeNull();
  });

  it('loads a module authored as a named createProvider export, and passes it the shared helpers', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = resolve(FIXTURES_DIR, 'named-export.mjs');
    process.env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS = '8192';
    const provider = await loadCustomServerGenerationProvider();
    expect(provider).not.toBeNull();
    const result = await provider!.generate(EMPTY_CONTEXT);
    // Confirms the factory actually received live references to this
    // server's own prompt builder, Anthropic provider class, and error
    // classification, not stubs — a custom provider has no other way to
    // reach any of them. The helpers are versioned, and carry the resolved
    // output-token cap the built-in providers use.
    expect(result.rawText).toBe(
      `apiVersion:${CUSTOM_PROVIDER_HELPERS_API_VERSION} maxOutputTokens:8192 `
        + 'buildServerGenerationPrompt:function ClaudeObservationProvider:function ServerClassifiedProviderError:function',
    );
  });

  it('refuses a relative module path', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = 'tests/fixtures/custom-providers/named-export.mjs';
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(await loadCustomServerGenerationProvider()).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the resolved module path and its sha256 before loading it', async () => {
    const modulePath = resolve(FIXTURES_DIR, 'default-function-export.mjs');
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = modulePath;
    const info = spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await loadCustomServerGenerationProvider();
      const sha256 = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
      expect(info).toHaveBeenCalledWith('SYSTEM', expect.stringContaining('custom generation provider'), { modulePath, sha256 });
    } finally {
      info.mockRestore();
    }
  });

  it('loads a module authored as a default function export', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = resolve(FIXTURES_DIR, 'default-function-export.mjs');
    const provider = await loadCustomServerGenerationProvider();
    const result = await provider!.generate(EMPTY_CONTEXT);
    expect(result.rawText).toBe('default-function-export');
  });

  it('loads a module authored as a default object export with a createProvider method (CJS interop shape)', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = resolve(FIXTURES_DIR, 'default-object-export.mjs');
    const provider = await loadCustomServerGenerationProvider();
    const result = await provider!.generate(EMPTY_CONTEXT);
    expect(result.rawText).toBe('default-object-export');
  });

  it('returns null (not throw) when the module has no recognizable factory export', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = resolve(FIXTURES_DIR, 'no-factory.mjs');
    expect(await loadCustomServerGenerationProvider()).toBeNull();
  });

  it('propagates a module-not-found error (caught and logged one layer up, by buildServerGenerationProviderFromEnv)', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = resolve(FIXTURES_DIR, 'does-not-exist.mjs');
    await expect(loadCustomServerGenerationProvider()).rejects.toThrow();
  });
});
