import { describe, it, expect, mock } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', emoji: 'D' },
          { id: 'discovery', emoji: 'I' },
        ],
        observation_concepts: [],
      }),
      getTypeIcon: (type: string) => type[0]?.toUpperCase() ?? '?',
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { renderDirectives } from '../../src/services/context/sections/DirectivesRenderer.js';
import { renderHeader } from '../../src/services/context/sections/HeaderRenderer.js';
import type { ContextConfig, TokenEconomics } from '../../src/services/context/types.js';
import type { Directive } from '../../src/types/database.js';

function createConfig(): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 0,
    sessionCount: 10,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: false,
    observationTypes: new Set<string>(['decision']),
    observationConcepts: new Set<string>(),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
    showDirectives: true,
    directivesMax: 25,
  };
}

function createDirective(content: string): Directive {
  return {
    id: 1,
    scope: 'global',
    project: null,
    content,
    status: 'active',
    source: 'manual',
    created_at: '2026-05-25T12:00:00.000Z',
    created_at_epoch: 1748174400000,
    updated_at_epoch: 1748174400000,
  };
}

const economics: TokenEconomics = {
  totalObservations: 1,
  totalReadTokens: 100,
  totalDiscoveryTokens: 200,
  savings: 100,
  savingsPercent: 50,
};

describe('directives ordering (truncation safety)', () => {
  it('places the directives block at output index 0, before the header', () => {
    const config = createConfig();
    const directives = [createDirective('read files in full, never grep')];

    const output: string[] = [];
    output.push(...renderDirectives(directives, config, false));
    output.push(...renderHeader('claude-mem', economics, config, false));

    expect(output[0]).toBe('⚡ STANDING DIRECTIVES — always apply, you committed to these:');
    expect(output.findIndex(line => line.includes('recent context'))).toBeGreaterThan(0);
  });
});
