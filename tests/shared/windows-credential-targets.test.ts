import { describe, it, expect } from 'bun:test';
import { windowsCredentialTargets } from '../../src/shared/oauth-token.js';

/**
 * The Windows reader interpolates each target into a PowerShell single-quoted literal,
 * where `'` is escaped by doubling. Escaping the username a second time before that
 * turned `O'Brien` into the literal `'Claude Code-credentials:O''''Brien'`, which
 * PowerShell parses back as `Claude Code-credentials:O''Brien` — CredRead then queried a
 * target that does not exist and the account fell through to the re-login warning.
 *
 * These tests pin the contract at the seam: the helper returns RAW targets, and exactly
 * one escaping pass survives a literal round-trip.
 */

const PLAIN = 'Claude Code-credentials';
const Q = "'";

/** What PowerShell yields for a single-quoted literal: strip the quotes, undouble `''`. */
function parsePowerShellLiteral(literal: string): string {
  return literal.slice(1, -1).split(Q + Q).join(Q);
}

/** The single escaping pass the reader applies, mirrored here. */
function toPowerShellLiteral(raw: string): string {
  return `${Q}${raw.replace(/'/g, "''")}${Q}`;
}

describe('windowsCredentialTargets', () => {
  it('returns targets raw, so the caller owns the only escaping pass', () => {
    expect(windowsCredentialTargets("O'Brien", [PLAIN])).toEqual([
      PLAIN,
      'Claude Code:credentials',
      `Claude Code-credentials:O'Brien`,
    ]);
  });

  it('survives the PowerShell literal round-trip unchanged (apostrophe username)', () => {
    for (const raw of windowsCredentialTargets("O'Brien", [PLAIN])) {
      expect(parsePowerShellLiteral(toPowerShellLiteral(raw))).toBe(raw);
    }
  });

  it('puts the config-scoped service names first', () => {
    const scoped = `${PLAIN}-deadbeef`;
    expect(windowsCredentialTargets('tester', [scoped, PLAIN]).slice(0, 2)).toEqual([
      scoped,
      PLAIN,
    ]);
  });

  it('still ends with the username-suffixed target, the pre-#3718 last resort', () => {
    const targets = windowsCredentialTargets('tester', [PLAIN]);
    expect(targets[targets.length - 1]).toBe(`${PLAIN}:tester`);
  });
});
