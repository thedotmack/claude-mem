import { describe, it, expect } from 'bun:test';
import { PrivacyCheckValidator } from '../../src/services/worker/validation/PrivacyCheckValidator';

function storeReturning(value: string | null) {
  return { getUserPrompt: (_s: string, _n: number) => value } as any;
}

describe('PrivacyCheckValidator (issue #2794)', () => {
  it('ALLOWS ingestion when the user_prompts row is absent (null) — not a privacy signal', () => {
    const d = PrivacyCheckValidator.checkUserPromptPrivacy(
      storeReturning(null), 'session-x', 0, 'observation', 1
    );
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.prompt).toBe('');
  });

  it('SUPPRESSES when the row exists but is empty after privacy stripping', () => {
    expect(PrivacyCheckValidator.checkUserPromptPrivacy(
      storeReturning(''), 'session-x', 1, 'observation', 1
    ).allow).toBe(false);

    expect(PrivacyCheckValidator.checkUserPromptPrivacy(
      storeReturning('   \n  '), 'session-x', 1, 'summarize', 1
    ).allow).toBe(false);
  });

  it('ALLOWS and returns the prompt when present and non-empty', () => {
    const d = PrivacyCheckValidator.checkUserPromptPrivacy(
      storeReturning('fix the bug'), 'session-x', 1, 'observation', 1
    );
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.prompt).toBe('fix the bug');
  });
});
