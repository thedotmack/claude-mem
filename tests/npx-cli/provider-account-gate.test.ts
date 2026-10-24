import { describe, expect, it } from 'bun:test';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';
describe('personal fork provider account gate', () => {
  for (const provider of [undefined, 'claude', 'host', 'codex', 'gemini', 'openrouter', 'openai-compatible'] as const) {
    it(`does not require a cmem.ai account for ${provider ?? 'default'}`, () => {
      expect(providerNeedsAccount(provider)).toBe(false);
    });
  }
});
