import { describe, expect, it, spyOn, afterEach } from 'bun:test';
import { buildHardenedSdkOptions, resolveObserverThinkingOption } from '../../src/sdk/hardened-options.js';
import { OBSERVER_DISALLOWED_TOOLS } from '../../src/sdk/hardened-options.js';
import { logger } from '../../src/utils/logger.js';

/**
 * Regression coverage for #4732: gateways that map every `claude-*` model to an
 * always-thinking upstream reject `thinking:{type:"disabled"}` with HTTP 400
 * (code 1210), and every observer batch was dropped. The thinking param must be
 * operator-configurable (`CLAUDE_MEM_OBSERVER_THINKING =
 * disabled | enabled[:budget] | omit`, default = the historical `disabled`).
 */
describe('resolveObserverThinkingOption (#4732)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it('defaults to disabled when the setting is unset (historical behavior)', () => {
    expect(resolveObserverThinkingOption(undefined)).toEqual({ type: 'disabled' });
    expect(resolveObserverThinkingOption('')).toEqual({ type: 'disabled' });
  });

  it('keeps disabled for the explicit "disabled" spelling', () => {
    expect(resolveObserverThinkingOption('disabled')).toEqual({ type: 'disabled' });
    expect(resolveObserverThinkingOption(' DISABLED ')).toEqual({ type: 'disabled' });
  });

  it('parses "omit" as the drop-the-field sentinel', () => {
    expect(resolveObserverThinkingOption('omit')).toBe('omit');
    expect(resolveObserverThinkingOption('OMIT')).toBe('omit');
  });

  it('parses "enabled" with the 1024 default budget', () => {
    expect(resolveObserverThinkingOption('enabled')).toEqual({ type: 'enabled', budgetTokens: 1024 });
  });

  it('parses "enabled:<budget>" with an explicit positive budget', () => {
    expect(resolveObserverThinkingOption('enabled:2048')).toEqual({ type: 'enabled', budgetTokens: 2048 });
  });

  it('falls back to the default budget for a non-positive or non-numeric budget', () => {
    expect(resolveObserverThinkingOption('enabled:0')).toEqual({ type: 'enabled', budgetTokens: 1024 });
    expect(resolveObserverThinkingOption('enabled:-5')).toEqual({ type: 'enabled', budgetTokens: 1024 });
    expect(resolveObserverThinkingOption('enabled:abc')).toEqual({ type: 'enabled', budgetTokens: 1024 });
  });

  it('treats an unrecognized value as disabled and warns once per parse', () => {
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolveObserverThinkingOption('sometimes')).toEqual({ type: 'disabled' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buildHardenedSdkOptions thinking override (#4732)', () => {
  const build = (thinking: Parameters<typeof buildHardenedSdkOptions>[0]['thinking'], source: 'Observer' | 'KnowledgeAgent' = 'Observer') =>
    buildHardenedSdkOptions({
      source,
      thinking,
      model: 'claude-haiku-4-5',
      env: {} as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/usr/bin/claude',
    });

  it('drops the thinking field entirely for omit — the always-thinking gateway workaround', () => {
    expect('thinking' in build('omit')).toBe(false);
  });

  it('passes an enabled thinking option through for Observer', () => {
    expect(build({ type: 'enabled', budgetTokens: 1024 }).thinking).toEqual({ type: 'enabled', budgetTokens: 1024 });
  });

  it('still never sets thinking for KnowledgeAgent, whatever the override says', () => {
    expect('thinking' in build('omit', 'KnowledgeAgent')).toBe(false);
    expect('thinking' in build({ type: 'enabled', budgetTokens: 1024 }, 'KnowledgeAgent')).toBe(false);
  });

  it('leaves the lockdown boundary untouched when the thinking override is applied', () => {
    for (const thinking of ['omit', { type: 'enabled', budgetTokens: 4096 }] as const) {
      const opts = build(thinking);
      expect(opts.tools).toEqual([]);
      expect(opts.allowedTools).toEqual([]);
      expect(opts.disallowedTools).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
      expect(opts.permissionMode).toBe('dontAsk');
      expect(opts.mcpServers).toEqual({});
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
      expect(opts.additionalDirectories).toEqual([]);
    }
  });
});
