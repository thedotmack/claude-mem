import { describe, expect, it } from 'bun:test';
import {
  PRO_TRIAL_MAX_DAYS,
  PRO_TRIAL_LABEL,
  PRO_TRIAL_PITCH,
  proTrialLine,
  proTrialUrl,
} from '../../src/shared/pro-promo.js';
import * as viewerPromo from '../../src/ui/viewer/constants/promo.js';

describe('pro trial promo copy', () => {
  it('presents the standard 30 Day Free Trial without hedging its duration', () => {
    expect(PRO_TRIAL_MAX_DAYS).toBe(30);
    expect(PRO_TRIAL_LABEL).toBe('30 Day Free Trial');
    expect(PRO_TRIAL_PITCH).toContain('30 Day Free Trial');
    expect(PRO_TRIAL_PITCH).not.toMatch(/free for up to|\b14 days\b/i);
  });

  it('tags links with the source only — no trial length hint', () => {
    expect(proTrialUrl('installer')).toBe('https://cmem.ai/pro?from=installer');
    expect(proTrialUrl('session-start')).not.toContain('trial=');
    expect(proTrialLine('welcome-hint')).toContain('https://cmem.ai/pro?from=welcome-hint');
  });

  it('keeps the viewer mirror in sync with the Node-side copy', () => {
    expect(viewerPromo.PRO_TRIAL_MAX_DAYS).toBe(PRO_TRIAL_MAX_DAYS);
    expect(viewerPromo.PRO_TRIAL_LABEL).toBe(PRO_TRIAL_LABEL);
    expect(viewerPromo.PRO_TRIAL_PITCH).toBe(PRO_TRIAL_PITCH);
    expect(viewerPromo.PRO_TRIAL_SHORT).toBe(PRO_TRIAL_LABEL);
    expect(viewerPromo.PRO_TRIAL_URL).toBe(proTrialUrl('viewer'));
  });
});
