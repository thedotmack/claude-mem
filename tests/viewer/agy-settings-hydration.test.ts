import { describe, expect, it } from 'bun:test';
import { hydrateAgySettings } from '../../src/ui/viewer/hooks/useSettings.js';

describe('viewer Agy settings hydration', () => {
  it('loads persisted model, path, and timeout values into modal state', () => {
    expect(hydrateAgySettings({
      CLAUDE_MEM_AGY_CLI_MODEL: 'Gemini 3.5 Flash (Medium)',
      CLAUDE_MEM_AGY_CLI_PATH: '/opt/agy',
      CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '450000',
    })).toEqual({
      CLAUDE_MEM_AGY_CLI_MODEL: 'Gemini 3.5 Flash (Medium)',
      CLAUDE_MEM_AGY_CLI_PATH: '/opt/agy',
      CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '450000',
    });
  });

  it('uses visible defaults only when values are absent', () => {
    expect(hydrateAgySettings({})).toEqual({
      CLAUDE_MEM_AGY_CLI_MODEL: '',
      CLAUDE_MEM_AGY_CLI_PATH: '',
      CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '300000',
    });
    expect(hydrateAgySettings({
      CLAUDE_MEM_AGY_CLI_MODEL: '',
      CLAUDE_MEM_AGY_CLI_PATH: '',
      CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '',
    }).CLAUDE_MEM_AGY_CLI_TIMEOUT_MS).toBe('');
  });
});
