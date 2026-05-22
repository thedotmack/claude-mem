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
    expect(finalText).toContain('<redacted type="openai_key"/>');
    expect(finalText).not.toContain('sk-ABCDEFGHIJ');
  });
});
