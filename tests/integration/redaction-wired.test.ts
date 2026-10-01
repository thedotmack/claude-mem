import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { _resetRedactionConfigCache } from '../../src/utils/redaction.js';
import { stripMemoryTags, stripTags } from '../../src/utils/tag-stripping.js';
import { normalizeStoredPromptText } from '../../src/services/sqlite/prompt-storage.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const OPENAI_KEY = 'sk-ABCDEFGHIJ1234567890abcdef';

/**
 * Redaction lives inside stripTags, the one function every capture path goes
 * through (tool I/O, prompts and prompt storage, assistant messages,
 * server-beta events), so enabling it covers all of them at once.
 */
describe('redaction at the tag-stripping choke point', () => {
  let loadSpy: ReturnType<typeof spyOn> | undefined;

  function useRedactionSetting(enabled: boolean): void {
    loadSpy?.mockRestore();
    loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_REDACT_ENABLED: enabled ? 'true' : 'false',
    }));
    _resetRedactionConfigCache();
  }

  beforeEach(() => useRedactionSetting(true));

  afterEach(() => {
    loadSpy?.mockRestore();
    loadSpy = undefined;
    _resetRedactionConfigCache();
  });

  it('redacts after private tags are stripped', () => {
    const text = stripMemoryTags(`<private>hidden</private>curl -H "Authorization: Bearer ${OPENAI_KEY}" https://api`);
    expect(text).toBe(`curl -H "Authorization: Bearer <redacted type='openai_key'/>" https://api`);
  });

  it('keeps the tag counts callers rely on', () => {
    const result = stripTags(`<private>a</private> ${OPENAI_KEY}`);
    expect(result.counts.private).toBe(1);
    expect(result.stripped).toBe("<redacted type='openai_key'/>");
  });

  it('covers stored prompt text (prompt-storage), which no per-site wrap reached', () => {
    expect(normalizeStoredPromptText(`use ${OPENAI_KEY} for the call`)).toBe("use <redacted type='openai_key'/> for the call");
  });

  it('leaves a JSON-stringified tool payload parseable', () => {
    const serialized = JSON.stringify({ url: 'https://api.example.com', headers: { Authorization: `Bearer ${OPENAI_KEY}` } });
    const parsed = JSON.parse(stripMemoryTags(serialized));
    expect(parsed.headers.Authorization).toBe("Bearer <redacted type='openai_key'/>");
    expect(parsed.url).toBe('https://api.example.com');
  });

  it('is a no-op while CLAUDE_MEM_REDACT_ENABLED is false (the default)', () => {
    useRedactionSetting(false);
    expect(stripMemoryTags(`token ${OPENAI_KEY}`)).toBe(`token ${OPENAI_KEY}`);
  });
});
