import { describe, it, expect } from 'bun:test';
import { redactSensitive, _resetRedactionConfigCache } from '../../src/utils/redaction.js';
import { stripMemoryTagsFromPrompt } from '../../src/utils/tag-stripping.js';

describe('redaction wired into stripTags pipeline', () => {
  it('redaction runs before stripTags, producing a <redacted/> placeholder that survives stripping', () => {
    _resetRedactionConfigCache();
    const cfg = {
      enabled: true,
      disabledBuiltinPatterns: [],
      customPatterns: [],
      logMatches: false,
    };
    const input = 'curl -H "Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef" https://api';
    const redact = redactSensitive(input, cfg);
    const finalText = stripMemoryTagsFromPrompt(redact.redacted);
    expect(finalText).toContain("<redacted type='openai_key'/>");
    expect(finalText).not.toContain('sk-ABCDEFGHIJ');
  });

  it('redacted JSON-stringified payload remains parseable', () => {
    _resetRedactionConfigCache();
    const cfg = {
      enabled: true,
      disabledBuiltinPatterns: [],
      customPatterns: [],
      logMatches: false,
    };
    const payload = {
      url: 'https://api.example.com',
      headers: { Authorization: 'Bearer sk-ABCDEFGHIJ1234567890abcdef' },
    };
    const serialized = JSON.stringify(payload);
    const redacted = redactSensitive(serialized, cfg).redacted;
    // The placeholder uses single-quotes, so JSON.parse should still succeed.
    const parsed = JSON.parse(redacted);
    expect(parsed.headers.Authorization).toBe("Bearer <redacted type='openai_key'/>");
    expect(parsed.url).toBe('https://api.example.com');
  });
});
