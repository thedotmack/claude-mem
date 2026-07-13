// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'bun:test';
import { resolve } from 'path';
import { loadCustomServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

const FIXTURES_DIR = resolve(import.meta.dir, '../../fixtures/custom-providers');
const EMPTY_CONTEXT = {} as ServerGenerationContext;

describe('loadCustomServerGenerationProvider', () => {
  const originalModulePath = process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE;

  afterEach(() => {
    if (originalModulePath === undefined) delete process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE;
    else process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = originalModulePath;
  });

  it('returns null when CLAUDE_MEM_CUSTOM_PROVIDER_MODULE is unset', async () => {
    delete process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE;
    expect(await loadCustomServerGenerationProvider()).toBeNull();
  });

  it('loads a module authored as a named createProvider export, and passes it the shared helpers', async () => {
    process.env.CLAUDE_MEM_CUSTOM_PROVIDER_MODULE = resolve(FIXTURES_DIR, 'named-export.mjs');
    const provider = await loadCustomServerGenerationProvider();
    expect(provider).not.toBeNull();
    const result = await provider!.generate(EMPTY_CONTEXT);
    // Confirms the factory actually received live references to this
    // server's own prompt builder and Anthropic provider class, not stubs —
    // a custom provider has no other way to reach either.
    expect(result.rawText).toBe(
      'buildServerGenerationPrompt:function ClaudeObservationProvider:function',
    );
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
