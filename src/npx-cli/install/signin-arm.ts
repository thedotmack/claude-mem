import { createHash } from 'crypto';

/**
 * Deferred sign-in experiment arm, fixed per anonymous install ID.
 *   A — today's deferred link only
 *   B — link + browser auto-open on desktop
 *   C — B + the SessionStart reminder while the install is unclaimed
 * Each arm stamps its own pairing `source`, so the split is measurable in
 * cli_pairings even with telemetry off.
 */
export type SigninArm = 'A' | 'B' | 'C';

const ARMS: readonly SigninArm[] = ['A', 'B', 'C'];

export function signinArmForInstallId(installId: string): SigninArm {
  const digest = createHash('sha256').update(`signin-arm:${installId}`).digest();
  return ARMS[digest.readUInt32BE(0) % ARMS.length];
}

export function armOpensBrowser(arm: SigninArm): boolean {
  return arm !== 'A';
}

export function armShowsReminder(arm: SigninArm): boolean {
  return arm === 'C';
}

export function deferredSourceForArm(arm: SigninArm): 'npx-installer-deferred' | 'npx-installer-deferred-open' {
  return arm === 'A' ? 'npx-installer-deferred' : 'npx-installer-deferred-open';
}
