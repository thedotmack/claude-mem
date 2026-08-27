// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  buildCmemActivationSettings,
  buildNonInteractiveOpenRouterSettings,
  buildPersonalOpenRouterSettings,
  resolveCmemMemoryCredentials,
} from '../../src/npx-cli/cmem-memory-credentials.js';
import { CMEM_PRO_BASE_URL, CMEM_PRO_MODEL } from '../../src/npx-cli/cmem-pro-costs.js';

const configuredCmemSettings = {
  CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_configured',
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
  CLAUDE_MEM_OPENROUTER_MODEL: 'configured-observer',
};

describe('cmem memory credential retention', () => {
  describe('resolveCmemMemoryCredentials', () => {
    it('prefers a fresh one-shot delivery over staged and configured credentials', () => {
      const resolved = resolveCmemMemoryCredentials(
        {
          memoryKey: 'cm_pro_fresh',
          memoryBaseUrl: 'https://fresh.cmem.example/v1',
          memoryModel: 'fresh-observer',
        },
        {
          ...configuredCmemSettings,
          CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged',
          CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://staged.cmem.example/v1',
          CLAUDE_MEM_PRO_MEMORY_MODEL: 'staged-observer',
          CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T20:00:00.000Z',
        },
      );

      expect(resolved).toEqual({
        memoryKey: 'cm_pro_fresh',
        memoryBaseUrl: 'https://fresh.cmem.example/v1',
        memoryModel: 'fresh-observer',
        source: 'fresh',
        clearFallback: true,
      });
    });

    it('prefers staged one-shot credentials over an older configured gateway key', () => {
      const resolved = resolveCmemMemoryCredentials(null, {
        ...configuredCmemSettings,
        CLAUDE_MEM_PRO_MEMORY_KEY: '  cm_pro_staged  ',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: '  https://cmem.ai/staged/v1  ',
        CLAUDE_MEM_PRO_MEMORY_MODEL: '  staged-observer  ',
      });

      expect(resolved).toEqual({
        memoryKey: 'cm_pro_staged',
        memoryBaseUrl: 'https://cmem.ai/staged/v1',
        memoryModel: 'staged-observer',
        source: 'staged',
        clearFallback: true,
      });
    });

    it('uses CMEM defaults when staged endpoint metadata is absent', () => {
      const resolved = resolveCmemMemoryCredentials(null, {
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: '  ',
        CLAUDE_MEM_PRO_MEMORY_MODEL: '',
      });

      expect(resolved).toEqual({
        memoryKey: 'cm_pro_staged',
        memoryBaseUrl: CMEM_PRO_BASE_URL,
        memoryModel: CMEM_PRO_MODEL,
        source: 'staged',
        clearFallback: true,
      });
    });

    it('reuses an already-configured CMEM gateway key when no newer key exists', () => {
      const resolved = resolveCmemMemoryCredentials(null, configuredCmemSettings);

      expect(resolved).toEqual({
        memoryKey: 'cm_pro_configured',
        memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
        memoryModel: 'configured-observer',
        source: 'configured',
        clearFallback: false,
      });
    });

    it('rejects personal and deceptively CMEM-looking OpenRouter endpoints', () => {
      const rejectedBaseUrls = [
        '',
        'https://openrouter.ai/api/v1',
        'https://cmem.ai.evil.example/api/inference/v1',
        'https://cmem.ai-example.com/api/inference/v1',
        'https://cmem.ai@evil.example/api/inference/v1',
        'https://cmem.ai:444/api/inference/v1',
      ];

      for (const baseUrl of rejectedBaseUrls) {
        expect(resolveCmemMemoryCredentials(null, {
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-personal',
          CLAUDE_MEM_OPENROUTER_BASE_URL: baseUrl,
          CLAUDE_MEM_OPENROUTER_MODEL: 'personal-model',
        })).toBeNull();
      }
    });
  });

  describe('buildCmemActivationSettings', () => {
    it('moves staged credentials into the active slot and clears every staging field', () => {
      const credentials = resolveCmemMemoryCredentials(null, {
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/staged/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'staged-observer',
      });
      expect(credentials).not.toBeNull();

      const updates = buildCmemActivationSettings(credentials!);

      expect(updates).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/staged/v1',
        CLAUDE_MEM_OPENROUTER_MODEL: 'staged-observer',
        CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_staged',
        CLAUDE_MEM_PRO_MEMORY_KEY: '',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: '',
        CLAUDE_MEM_PRO_MEMORY_MODEL: '',
        CLAUDE_MEM_PRO_FALLBACK_AT: '',
      });
      expect(Object.values(updates).filter(value => value === 'cm_pro_staged')).toHaveLength(1);
    });

    it('does not clear fallback merely because an existing configured key is reused', () => {
      const credentials = resolveCmemMemoryCredentials(null, {
        ...configuredCmemSettings,
        CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T20:00:00.000Z',
      });
      expect(credentials?.source).toBe('configured');
      expect(credentials?.clearFallback).toBe(false);

      const updates = buildCmemActivationSettings(credentials!);

      expect(updates).not.toHaveProperty('CLAUDE_MEM_PRO_FALLBACK_AT');
      expect(updates.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('cm_pro_configured');
      expect(Object.values(updates).filter(value => value === 'cm_pro_configured')).toHaveLength(1);
    });

    it('preserves fallback for a staged key moved out of a rejected configured slot', () => {
      const credentials = resolveCmemMemoryCredentials(null, {
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_failed',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'cmem-observer',
        CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T20:00:00.000Z',
      });
      expect(credentials?.source).toBe('staged');
      expect(credentials?.clearFallback).toBe(false);

      const updates = buildCmemActivationSettings(credentials!);

      expect(updates).not.toHaveProperty('CLAUDE_MEM_PRO_FALLBACK_AT');
    });
  });

  describe('buildPersonalOpenRouterSettings', () => {
    it('resets the CMEM endpoint/model and moves the only CMEM key into staging', () => {
      const updates = buildPersonalOpenRouterSettings(
        '  sk-or-personal  ',
        configuredCmemSettings,
        'openrouter/default-model',
      );

      expect(updates).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-personal',
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: 'openrouter/default-model',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_configured',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'configured-observer',
      });
      expect(Object.values(updates).filter(value => value === 'cm_pro_configured')).toHaveLength(1);
      expect(Object.values(updates).filter(value => value === 'sk-or-personal')).toHaveLength(1);
    });

    it('retains a newer staged one-shot key instead of replacing it with the active CMEM key', () => {
      const updates = buildPersonalOpenRouterSettings(
        'sk-or-personal',
        {
          ...configuredCmemSettings,
          CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_one_shot',
          CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/new/v1',
          CLAUDE_MEM_PRO_MEMORY_MODEL: 'new-observer',
        },
        'openrouter/default-model',
      );

      expect(updates.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-or-personal');
      expect(updates.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('');
      expect(updates.CLAUDE_MEM_OPENROUTER_MODEL).toBe('openrouter/default-model');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('cm_pro_one_shot');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe('https://cmem.ai/new/v1');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe('new-observer');
      expect(Object.values(updates).filter(value => value === 'cm_pro_one_shot')).toHaveLength(1);
      expect(Object.values(updates)).not.toContain('cm_pro_configured');
    });

    it('does not stage a personal key from a deceptive CMEM-looking endpoint', () => {
      const updates = buildPersonalOpenRouterSettings(
        'sk-or-replacement',
        {
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-existing',
          CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/api/inference/v1',
          CLAUDE_MEM_OPENROUTER_MODEL: 'evil-model',
        },
        'openrouter/default-model',
      );

      expect(updates.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('');
      expect(updates.CLAUDE_MEM_OPENROUTER_MODEL).toBe('openrouter/default-model');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe('');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe('');
    });
  });

  describe('buildNonInteractiveOpenRouterSettings', () => {
    it('stages an active CMEM key and resets its endpoint before a personal env key can be used', () => {
      const updates = buildNonInteractiveOpenRouterSettings(
        configuredCmemSettings,
        'openrouter/default-model',
      );

      expect(updates).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_API_KEY: '',
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: 'openrouter/default-model',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_configured',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'configured-observer',
      });
    });

    it('leaves personal and custom OpenRouter configuration untouched', () => {
      expect(buildNonInteractiveOpenRouterSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-existing',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        CLAUDE_MEM_OPENROUTER_MODEL: 'existing-model',
      }, 'openrouter/default-model')).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
      });
    });
  });
});
