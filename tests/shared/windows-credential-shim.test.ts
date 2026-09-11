import { describe, it, expect } from 'bun:test';
import {
  buildWindowsCredentialScript,
  WINDOWS_CRED_SHIM_ERROR_MARKER,
} from '../../src/shared/oauth-token.js';

/**
 * `Add-Type -Namespace N -Name X` generates the C# class `N.X`. C# rejects a class that
 * declares a member of its own name with CS0542, "member names cannot be the same as
 * their enclosing type". The shim was `-Name CredRead` declaring `public static extern
 * bool CredRead(...)`, so the type never compiled, `[ClaudeMem.CredRead]::CredRead(...)`
 * threw on every call, and both `-ErrorAction SilentlyContinue` and the script-level
 * `$ErrorActionPreference` swallowed it — the Windows keychain path was dead code that
 * reported itself as "no stored credential".
 *
 * These read the generated script rather than running PowerShell, so the rule holds on
 * the Linux CI runner too.
 */

const script = buildWindowsCredentialScript('someone');

function declaredTypeName(text: string): string {
  const match = text.match(/Add-Type\s+-Namespace\s+(\w+)\s+-Name\s+(\w+)/);
  expect(match, 'the script no longer declares a P/Invoke type').not.toBeNull();
  return match![2];
}

function declaredMemberNames(text: string): string[] {
  return [...text.matchAll(/public\s+(?:static\s+extern\s+)?[\w.<>\[\]]+\s+(\w+)\s*\(/g)].map(
    (m) => m[1],
  );
}

describe('Windows credential shim', () => {
  it('does not name the generated type after one of its own members (CS0542)', () => {
    const typeName = declaredTypeName(script);
    const members = declaredMemberNames(script);

    expect(members.length).toBeGreaterThan(0);
    expect(members).not.toContain(typeName);
  });

  it('references the type it actually declares', () => {
    const typeName = declaredTypeName(script);
    const references = [...script.matchAll(/\[ClaudeMem\.(\w+)[\]+]/g)].map((m) => m[1]);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toBe(typeName);
    }
  });

  it('reports a shim failure instead of exiting silently', () => {
    // Without this the script exits 0 with no output on a compile failure, which the
    // caller cannot tell apart from a machine that simply has no credential stored.
    expect(script).toContain(WINDOWS_CRED_SHIM_ERROR_MARKER);
    expect(script).toMatch(/Add-Type[\s\S]*?-ErrorAction Stop/);
  });

  it('escapes a single quote in the username', () => {
    const quoted = buildWindowsCredentialScript("o'brien");
    expect(quoted).toContain("Claude Code-credentials:o''brien");
  });
});
