// #2737 — a named environment spans several folders, so the SessionStart header
// says so. The name only: the glob patterns would cost tokens on every session.
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { renderHeader } from '../../../src/services/context/sections/HeaderRenderer.js';
import type { ContextConfig, TokenEconomics } from '../../../src/services/context/types.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const ENVIRONMENTS_ENV = 'CLAUDE_MEM_PROJECT_ENVIRONMENTS';
const savedEnvironments = process.env[ENVIRONMENTS_ENV];

const economics: TokenEconomics = {
  totalObservations: 0,
  totalReadTokens: 0,
  totalDiscoveryTokens: 0,
  savings: 0,
  savingsPercent: 0,
};

// Economics off, so the header is just the title, mode and legend.
const config = {
  showReadTokens: false,
  showWorkTokens: false,
  showSavingsAmount: false,
  showSavingsPercent: false,
} as ContextConfig;

// The header names the active mode.
beforeAll(() => {
  ModeManager.getInstance().loadMode('code');
});

afterEach(() => {
  if (savedEnvironments === undefined) delete process.env[ENVIRONMENTS_ENV];
  else process.env[ENVIRONMENTS_ENV] = savedEnvironments;
});

describe('SessionStart header for a named environment (#2737)', () => {
  it('labels an environment by its name only', () => {
    process.env[ENVIRONMENTS_ENV] = JSON.stringify([{ name: 'acme', patterns: ['~/work/acme/**'] }]);
    const header = renderHeader('acme', economics, config, false).join('\n');
    expect(header).toContain('# [acme (environment)] recent context');
    expect(header).not.toContain('~/work/acme');
  });

  it('leaves an ordinary project name unchanged', () => {
    process.env[ENVIRONMENTS_ENV] = JSON.stringify([{ name: 'acme', patterns: ['~/work/acme/**'] }]);
    expect(renderHeader('claude-mem', economics, config, false)[0]).toStartWith('# [claude-mem] recent context');
  });
});
