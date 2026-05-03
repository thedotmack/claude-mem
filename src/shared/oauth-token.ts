/**
 * Read Claude Desktop's OAuth token from the platform-native credential store
 * at worker spawn-time. This avoids the staleness problem of persisting tokens
 * in EnvManager's allowlist — keychain entries are always current because
 * Claude Desktop refreshes them in place.
 *
 * Issue #2215: do NOT add CLAUDE_CODE_OAUTH_TOKEN to the persisted-key list
 * without expiry handling. OAuth tokens expire and refresh; stale tokens
 * injected days later cause 401s.
 */

import { execFile, type ExecFileException } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { userInfo } from 'os';
import { join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const READ_TIMEOUT_MS = 5000;

// Grace window: even if expiresAt is in the past by less than this, allow the
// token through. Claude Desktop typically refreshes shortly before expiry, so
// a small grace covers clock skew and refresh-in-progress windows.
const EXPIRY_GRACE_MS = 60_000;

export type OAuthTokenResult =
  | { kind: 'present'; token: string; source: 'keychain' | 'env-fallback'; expiresAt?: number }
  | { kind: 'expired'; reason: string; expiresAt?: number }
  | { kind: 'absent'; reason: string };

interface ClaudeKeychainPayload {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  };
}

/**
 * Decode a JWT's `exp` claim if the token looks like a JWT. Returns
 * milliseconds since epoch. Returns undefined if the token isn't a JWT or
 * doesn't carry an `exp` claim.
 */
export function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
    if (typeof payload.exp === 'number') {
      // JWT exp is seconds since epoch; normalize to ms.
      return payload.exp * 1000;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Determine whether `expiresAtMs` indicates an expired token, allowing for a
 * small grace window for clock skew and in-flight refreshes.
 */
function isExpired(expiresAtMs: number | undefined): boolean {
  if (expiresAtMs === undefined) return false;
  return expiresAtMs + EXPIRY_GRACE_MS < Date.now();
}

/**
 * macOS: read the JSON blob stored under "Claude Code-credentials" service in
 * the user's login keychain. The blob looks like:
 *   {"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":<ms>}}
 */
async function readMacOsKeychain(): Promise<OAuthTokenResult> {
  const account = userInfo().username;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE_NAME, '-a', account, '-w'],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
    );
    const raw = stdout.trim();
    if (!raw) {
      return { kind: 'absent', reason: 'macOS keychain returned empty value for "Claude Code-credentials"' };
    }
    return parseKeychainPayload(raw);
  } catch (error) {
    const err = error as ExecFileException;
    // `security` exits non-zero when the entry doesn't exist — fail-fast as absent.
    return {
      kind: 'absent',
      reason: `macOS keychain lookup failed for service "${KEYCHAIN_SERVICE_NAME}" (account=${account}): ${err.message ?? String(err)}`,
    };
  }
}

/**
 * Windows: Credential Manager (DPAPI). Claude Desktop on Windows stores
 * OAuth credentials under a target like "Claude Code:credentials" via the
 * Wincred API. We read it via PowerShell's CredentialManager wrapper.
 *
 * Note: `cmdkey /list` exposes target names but not secrets. Reading the
 * secret requires PowerShell + the CredentialManager module OR the Win32
 * CredRead API. We use a PowerShell snippet that calls CredRead for the
 * common target name patterns Claude Desktop is known to use.
 */
async function readWindowsCredentialManager(): Promise<OAuthTokenResult> {
  // PowerShell snippet enumerates likely target names and prints the JSON blob.
  // The exact target name on Windows is "Claude Code-credentials" or
  // "Claude Code:credentials" (Claude Desktop uses `${service}:${account}` or
  // `${service}` depending on version). This script tries both.
  // Username is escaped with PowerShell's single-quote convention (' → '') in
  // case future Windows versions or domain-joined machines permit ' in usernames.
  const psSafeUsername = userInfo().username.replace(/'/g, "''");
  const psScript = `
    $ErrorActionPreference = 'SilentlyContinue'
    $candidates = @('Claude Code-credentials', 'Claude Code:credentials', 'Claude Code-credentials:${psSafeUsername}')
    Add-Type -Namespace ClaudeMem -Name CredRead -MemberDefinition @"
      [DllImport("Advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
      public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr CredentialPtr);
      [DllImport("Advapi32.dll", SetLastError=true)]
      public static extern void CredFree(IntPtr cred);
      [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
      public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob;
        public uint Persist; public uint AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
      }
"@ -ErrorAction SilentlyContinue
    foreach ($t in $candidates) {
      $ptr = [IntPtr]::Zero
      $ok = [ClaudeMem.CredRead]::CredRead($t, 1, 0, [ref]$ptr)
      if ($ok) {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][ClaudeMem.CredRead+CREDENTIAL])
        $bytes = New-Object byte[] $cred.CredentialBlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
        [ClaudeMem.CredRead]::CredFree($ptr) | Out-Null
        [System.Text.Encoding]::Unicode.GetString($bytes)
        exit 0
      }
    }
    exit 1
  `.trim();

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
    );
    const raw = stdout.trim();
    if (!raw) {
      return { kind: 'absent', reason: 'Windows Credential Manager has no entry for "Claude Code-credentials"' };
    }
    return parseKeychainPayload(raw);
  } catch (error) {
    const err = error as ExecFileException;
    return {
      kind: 'absent',
      reason: `Windows Credential Manager read failed: ${err.message ?? String(err)}`,
    };
  }
}

/**
 * Linux: libsecret via the `secret-tool` CLI. Claude Desktop on Linux stores
 * the credential under the same service name "Claude Code-credentials" with
 * the account attribute set to the OS username.
 */
async function readLinuxLibsecret(): Promise<OAuthTokenResult> {
  const account = userInfo().username;
  try {
    const { stdout } = await execFileAsync(
      'secret-tool',
      ['lookup', 'service', KEYCHAIN_SERVICE_NAME, 'account', account],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
    );
    const raw = stdout.trim();
    if (!raw) {
      return { kind: 'absent', reason: 'Linux libsecret returned empty value for "Claude Code-credentials"' };
    }
    return parseKeychainPayload(raw);
  } catch (error) {
    const err = error as ExecFileException;
    return {
      kind: 'absent',
      reason: `Linux libsecret lookup failed (is secret-tool installed?): ${err.message ?? String(err)}`,
    };
  }
}

/**
 * The keychain payload Claude Desktop writes is a JSON blob. Parse it, extract
 * the access token, and classify based on `expiresAt`.
 */
function parseKeychainPayload(raw: string): OAuthTokenResult {
  let payload: ClaudeKeychainPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Some Claude Desktop versions might store a bare token instead of JSON.
    if (raw.startsWith('sk-ant-') || raw.split('.').length === 3) {
      const expFromJwt = decodeJwtExpMs(raw);
      if (isExpired(expFromJwt)) {
        return {
          kind: 'expired',
          reason: 'Bare keychain token has expired JWT exp claim',
          expiresAt: expFromJwt,
        };
      }
      return { kind: 'present', token: raw, source: 'keychain', expiresAt: expFromJwt };
    }
    return { kind: 'absent', reason: 'Keychain payload is neither JSON nor a recognized token shape' };
  }

  const accessToken = payload.claudeAiOauth?.accessToken;
  const expiresAt = payload.claudeAiOauth?.expiresAt;

  if (!accessToken) {
    return { kind: 'absent', reason: 'Keychain payload has no claudeAiOauth.accessToken field' };
  }

  // Prefer the SDK-provided expiresAt; fall back to JWT exp if present.
  const effectiveExpiresAt = expiresAt ?? decodeJwtExpMs(accessToken);

  if (isExpired(effectiveExpiresAt)) {
    return {
      kind: 'expired',
      reason: 'Claude Desktop OAuth token has expired — re-login via Claude Desktop to refresh',
      expiresAt: effectiveExpiresAt,
    };
  }

  return { kind: 'present', token: accessToken, source: 'keychain', expiresAt: effectiveExpiresAt };
}

/**
 * Sidecar metadata file: when a fallback token is provided via env (CI, headless,
 * keychain-blocked environments), a sibling JSON file at
 * `${DATA_DIR}/oauth-token-meta.json` may carry the token's expiresAt timestamp.
 * This lets us refuse stale-token injection in environments where keychain
 * access is blocked.
 */
function readSidecarExpiresAt(): number | undefined {
  const sidecarPath = join(paths.dataDir(), 'oauth-token-meta.json');
  if (!existsSync(sidecarPath)) return undefined;
  try {
    const raw = readFileSync(sidecarPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.expiresAt === 'number') return parsed.expiresAt;
  } catch {
    // Malformed sidecar — treat as absent and let fall-through happen.
  }
  return undefined;
}

/**
 * Read Claude Desktop's OAuth token, preferring the platform-native credential
 * store. Falls back to the CLAUDE_CODE_OAUTH_TOKEN environment variable only
 * when the keychain has no entry — env-as-primary is intended for CI/headless
 * setups where no keychain exists.
 */
export async function readClaudeOAuthToken(): Promise<OAuthTokenResult> {
  let keychainResult: OAuthTokenResult;

  switch (process.platform) {
    case 'darwin':
      keychainResult = await readMacOsKeychain();
      break;
    case 'win32':
      keychainResult = await readWindowsCredentialManager();
      break;
    case 'linux':
      keychainResult = await readLinuxLibsecret();
      break;
    default:
      keychainResult = {
        kind: 'absent',
        reason: `Unsupported platform: ${process.platform}`,
      };
  }

  // If keychain produced a present or expired result, that's authoritative.
  // Expired wins over env-fallback: a known-stale keychain entry is a clearer
  // signal than an env var of unknown freshness.
  if (keychainResult.kind === 'present' || keychainResult.kind === 'expired') {
    return keychainResult;
  }

  // Keychain absent: try env-fallback for CI/headless. Refuse if the sidecar
  // metadata indicates the env-provided token is stale.
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    const sidecarExpiresAt = readSidecarExpiresAt();
    const jwtExpiresAt = decodeJwtExpMs(envToken);
    const effectiveExpiresAt = sidecarExpiresAt ?? jwtExpiresAt;

    if (isExpired(effectiveExpiresAt)) {
      return {
        kind: 'expired',
        reason: 'CLAUDE_CODE_OAUTH_TOKEN env var expired (per sidecar/JWT) — re-login via Claude Desktop',
        expiresAt: effectiveExpiresAt,
      };
    }

    return {
      kind: 'present',
      token: envToken,
      source: 'env-fallback',
      expiresAt: effectiveExpiresAt,
    };
  }

  return keychainResult;
}

/**
 * Marker file pattern: when a recent spawn returned `expired`, write a marker
 * at `${DATA_DIR}/oauth-stale.marker` so the session-start hook can surface a
 * clear "re-login via Claude Desktop" message to the user. The marker is
 * cleared once the token is refreshed and a `present` result is observed.
 */
export function writeStaleMarker(reason: string): void {
  try {
    const dir = paths.dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const markerPath = join(dir, 'oauth-stale.marker');
    writeFileSync(markerPath, reason, { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    logger.warn('OAUTH', 'Failed to write oauth-stale marker', {}, error instanceof Error ? error : new Error(String(error)));
  }
}

export function clearStaleMarker(): void {
  try {
    const markerPath = join(paths.dataDir(), 'oauth-stale.marker');
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }
  } catch {
    // Best-effort: if we can't clear the marker, the session-start hook will
    // surface a stale message even though the token is actually fresh. The
    // next successful spawn will overwrite the marker.
  }
}

export function readStaleMarker(): string | undefined {
  try {
    const markerPath = join(paths.dataDir(), 'oauth-stale.marker');
    if (!existsSync(markerPath)) return undefined;
    return readFileSync(markerPath, 'utf-8');
  } catch {
    return undefined;
  }
}
