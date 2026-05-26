import { describe, it, expect } from 'bun:test';
import { renderDirectives } from '../../src/services/context/sections/DirectivesRenderer.js';
import type { ContextConfig } from '../../src/services/context/types.js';
import type { Directive } from '../../src/types/database.js';

function createConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 0,
    sessionCount: 10,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: true,
    observationTypes: new Set<string>(),
    observationConcepts: new Set<string>(),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
    showDirectives: true,
    directivesMax: 25,
    ...overrides,
  };
}

function createDirective(content: string, overrides: Partial<Directive> = {}): Directive {
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
    ...overrides,
  };
}

describe('renderDirectives', () => {
  it('returns empty when showDirectives is false', () => {
    const config = createConfig({ showDirectives: false });
    const result = renderDirectives([createDirective('a rule')], config, false);
    expect(result).toEqual([]);
  });

  it('returns empty when there are no directives', () => {
    const config = createConfig();
    expect(renderDirectives([], config, false)).toEqual([]);
  });

  it('renders a numbered agent block with a trailing blank line', () => {
    const config = createConfig();
    const directives = [
      createDirective('read files in full, never grep'),
      createDirective('happy path first; fail loud'),
    ];

    const result = renderDirectives(directives, config, false);

    expect(result[0]).toBe('⚡ STANDING DIRECTIVES — always apply, you committed to these:');
    expect(result[1]).toBe('1. read files in full, never grep');
    expect(result[2]).toBe('2. happy path first; fail loud');
    expect(result[result.length - 1]).toBe('');
  });

  it('renders a human-colored block', () => {
    const config = createConfig();
    const result = renderDirectives([createDirective('a rule')], config, true);

    expect(result[0]).toContain('STANDING DIRECTIVES');
    expect(result[0]).toContain('\x1b[');
    expect(result[1]).toContain('a rule');
    expect(result[result.length - 1]).toBe('');
  });
});
