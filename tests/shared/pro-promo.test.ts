import { describe, expect, it } from 'bun:test';
import {
  PRO_TRIAL_MAX_DAYS,
  PRO_TRIAL_PITCH,
  proTrialLine,
  proTrialUrl,
} from '../../src/shared/pro-promo.js';
import * as viewerPromo from '../../src/ui/viewer/constants/promo.js';

describe('pro trial promo copy', () => {
  it('promises "up to" the longest trial, never a fixed length', () => {
    // The server picks 3, 7, or 14 days per user at claim time.
    expect(PRO_TRIAL_MAX_DAYS).toBe(14);
    expect(PRO_TRIAL_PITCH).toContain('free for up to 14 days');
    expect(PRO_TRIAL_PITCH).not.toMatch(/\b30\b/);
  });

  it('tags links with the source only — no trial length hint', () => {
    expect(proTrialUrl('installer')).toBe('https://cmem.ai/pro?from=installer');
    expect(proTrialUrl('session-start')).not.toContain('trial=');
    expect(proTrialLine('welcome-hint')).toContain('https://cmem.ai/pro?from=welcome-hint');
  });

  it('keeps the viewer mirror in sync with the Node-side copy', () => {
    expect(viewerPromo.PRO_TRIAL_MAX_DAYS).toBe(PRO_TRIAL_MAX_DAYS);
    expect(viewerPromo.PRO_TRIAL_PITCH).toBe(PRO_TRIAL_PITCH);
    expect(viewerPromo.PRO_TRIAL_URL).toBe(proTrialUrl('viewer'));
  });
});
