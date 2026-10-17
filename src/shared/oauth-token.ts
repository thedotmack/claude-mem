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

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { userInfo } from 'os';
import { join } from 'path';
import { paths, CLAUDE_CONFIG_DIR, DEFAULT_CLAUDE_CONFIG_DIR, expandTilde } from './paths.js';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const READ_TIMEOUT_MS = 5000;

/**
 * #4037 — Claude Code (measured in 2.1.268 `pk()`) only accepts keychain
 * account names matching `/^[a-zA-Z0-9._-]+$/`. A Unix username that fails
 * that test (MDM Macs named after an email, e.g. `first.last@example.com`)
 * is stored and read as the literal `claude-code-user`. We must query the
 * same account Claude Code wrote, or the lookup permanently misses.
 */
const MACOS_KEYCHAIN_ACCOUNT_SAFE = /^[a-zA-Z0-9._-]+$/;
const MACOS_KEYCHAIN_ACCOUNT_FALLBACK = 'claude-code-user';

/**
 * Map a Unix username to the macOS keychain `-a` account Claude Code uses.
 * Exported so tests can pin the charset rule independently of `security`.
 */
export function sanitizeMacOsKeychainAccount(username: string): string {
  return MACOS_KEYCHAIN_ACCOUNT_SAFE.test(username) ? username : MACOS_KEYCHAIN_ACCOUNT_FALLBACK;
}

/**
 * #2753 — resolve the effective CLAUDE_CONFIG_DIR for the keychain lookup +
 * SDK subprocess env, honoring the precedence: the
 * CLAUDE_MEM_CLAUDE_CONFIG_DIR setting > process.env.CLAUDE_CONFIG_DIR >
 * default (~/.claude). `paths.CLAUDE_CONFIG_DIR` already folds in
 * process.env/default, so once the setting is empty this just returns that.
 *
 * The setting is human-typed (settings.json, or POSTed through the settings
 * HTTP route), so a leading `~` is expanded the same way every other
 * user-typed path setting in this codebase already is (CLAUDE_CODE_PATH via
 * SettingsRoutes, CLAUDE_MEM_DATA_DIR via paths.ts's resolveDataDir) —
 * otherwise a literal `~` reaches sha256() unexpanded in
 * deriveMacKeychainServiceName, producing a suffix that never matches the
 * real keychain entry Claude Code stores under the expanded absolute path.
 * process.env.CLAUDE_CONFIG_DIR itself is left untouched: a shell-exported
 * env var is already tilde-expanded by the shell before this process sees it.
 *
 * Round 3 fix: a trailing path separator is ALSO stripped, from both the
 * setting branch and the CLAUDE_CONFIG_DIR fallback branch. `path.join`
 * (which both `expandTilde` and `CLAUDE_CONFIG_DIR`'s own derivation in
 * paths.ts route through) preserves a trailing separator rather than
 * normalizing it away, so a very plausible human/shell-completion input like
 * `~/.claude/` — typed to mean "my default profile" — survives expansion as
 * "<home>/.claude/" and then fails deriveMacKeychainServiceName's bare
 * `=== DEFAULT_CLAUDE_CONFIG_DIR` string comparison, silently deriving a
 * WRONG suffixed keychain service name instead of the bare default one. The
 * same divergence hits a `CLAUDE_CONFIG_DIR` shell export with a trailing
 * slash. Stripping here — the single point every consumer (keychain lookup,
 * the SDK-subprocess env, the profile label) resolves through — fixes all of
 * them at once instead of re-normalizing at each comparison site.
 */
export function resolveEffectiveClaudeConfigDir(settingValue?: string): string {
  const trimmed = settingValue?.trim();
  if (trimmed) return stripTrailingSep(expandTilde(trimmed));
  return stripTrailingSep(CLAUDE_CONFIG_DIR);
}

/**
 * Strip one or more trailing `/` or `\` characters. Never reduces a bare
 * separator-only string (e.g. "/") to "" — not a real config dir in
 * practice, but a defensive no-op is cheaper than returning an empty path.
 */
function stripTrailingSep(dir: string): string {
  const stripped = dir.replace(/[/\\]+$/, '');
  return stripped.length > 0 ? stripped : dir;
}

/**
 * The Claude Code credential profile the worker and its SDK child must agree on.
 * `explicitConfigDir` is whether Claude Code treats the profile as explicitly
 * configured: only then does the child carry CLAUDE_CONFIG_DIR and does the
 * macOS keychain entry carry a suffix.
 */
export interface ClaudeCredentialProfile {
  configDir: string;
  explicitConfigDir: boolean;
}

/**
 * #4149 — Claude Code decides whether a profile is the default from whether
 * CLAUDE_CONFIG_DIR is SET, not from its value (CLI 2.1.285:
 * `isDefault = !process.env.CLAUDE_CONFIG_DIR`). A user who exports
 * CLAUDE_CONFIG_DIR=~/.claude therefore logs in under the SUFFIXED keychain
 * entry, while a user with nothing exported logs in under the bare one.
 *
 *   - Setting non-empty: the setting names the profile; it is explicit unless
 *     it resolves to the default dir (`~/.claude` typed in settings means
 *     "my normal profile").
 *   - Setting empty: mirror the CLI — explicit iff the inherited
 *     CLAUDE_CONFIG_DIR is set to a non-empty value.
 *
 * Both the SDK child env (EnvManager.buildIsolatedEnv) and the keychain read
 * (deriveMacKeychainServiceName) consume this one result, so they cannot
 * disagree about which credential the child will look for.
 */
export function resolveClaudeCredentialProfile(settingValue?: string): ClaudeCredentialProfile {
  const configDir = resolveEffectiveClaudeConfigDir(settingValue);
  const explicitConfigDir = settingValue?.trim()
    ? configDir !== DEFAULT_CLAUDE_CONFIG_DIR
    : Boolean(process.env.CLAUDE_CONFIG_DIR);
  return { configDir, explicitConfigDir };
}

/**
 * #2753 — macOS derivation, empirically verified on the Studio (see #2756/
 * #2753 background table): Claude Code stores credentials under
 * 'Claude Code-credentials' for the default profile, and under
 * 'Claude Code-credentials-<suffix>' (suffix = first 8 hex chars of
 * sha256(NFC config dir path)) for an explicitly configured one — including
 * an explicit export of the default path (#4149).
 *
 * Windows/Linux are NOT covered by this function — see readWindowsCredentialManager /
 * readLinuxLibsecret for why those two paths are left on the bare service
 * name (no verified evidence in this repo of their suffix scheme).
 */
export function deriveMacKeychainServiceName(profile: ClaudeCredentialProfile): string {
  if (!profile.explicitConfigDir) return KEYCHAIN_SERVICE_NAME;
  const suffix = createHash('sha256').update(profile.configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE_NAME}-${suffix}`;
}

// Grace window: even if expiresAt is in the past by less than this, allow the
// token through. Claude Desktop typically refreshes shortly before expiry, so
// a small grace covers clock skew and refresh-in-progress windows.
const EXPIRY_GRACE_MS = 60_000;

export type OAuthTokenResult =
  | { kind: 'present'; token: string; source: 'keychain' | 'env-fallback' | 'credentials-file'; expiresAt?: number }
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
    // [ANTI-PATTERN IGNORED]: tokens are not guaranteed to be JWTs; base64/JSON
    // decode failure is expected for opaque tokens and the fallback is undefined.
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
 * macOS: read the JSON blob stored under the given service name (the default
 * "Claude Code-credentials", or a per-config-dir suffixed variant — see
 * deriveMacKeychainServiceName, #2753) in the user's login keychain. The blob
 * looks like:
 *   {"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":<ms>}}
 *
 * `execImpl` is an injectable seam for tests: promisify(execFile) is captured
 * once at import time as the module-level `execFileAsync`, so tests cannot
 * intercept the real one post-hoc (see tests/shared/oauth-token.test.ts for
 * the fuller explanation) — passing a fake here lets a test fake two
 * different keychain responses keyed by service-name argument without
 * touching the real `security` binary. Exported (not just internal to
 * readClaudeOAuthToken) specifically so tests can drive it directly with a
 * fake execImpl.
 *
 * `username` is the same kind of test seam for #4037: `userInfo()` is also
 * captured at call time from the host OS, so tests pass a raw Unix username
 * here and assert the `-a` account that actually gets queried. Production
 * call sites omit it and we read `userInfo().username`.
 */
export async function readMacOsKeychain(
  serviceName: string,
  execImpl: typeof execFileAsync = execFileAsync,
  username: string = userInfo().username,
): Promise<OAuthTokenResult> {
  const account = sanitizeMacOsKeychainAccount(username);
  let stdout: string;
  try {
    ({ stdout } = await execImpl(
      'security',
      ['find-generic-password', '-s', serviceName, '-a', account, '-w'],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
    ));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // `security` exits non-zero when the entry doesn't exist — fail-fast as absent.
    logger.warn('OAUTH', 'macOS keychain lookup failed', { service: serviceName, account }, err);
    return {
      kind: 'absent',
      reason: `macOS keychain lookup failed for service "${serviceName}" (account=${account}): ${err.message}`,
    };
  }
  const raw = stdout.trim();
  if (!raw) {
    return { kind: 'absent', reason: `macOS keychain returned empty value for "${serviceName}"` };
  }
  return parseKeychainPayload(raw);
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
 *
 * #2753: deliberately NOT given a per-config-dir suffixed service/target
 * name like the macOS branch (deriveMacKeychainServiceName). There is no
 * verified evidence in this repo of whether Windows Credential Manager
 * target names follow the same sha256(configDir)[:8] suffix scheme as
 * macOS's keychain — this always reads the bare `KEYCHAIN_SERVICE_NAME`
 * candidates until that is confirmed on an actual Windows box.
 */
/**
 * Printed by the snippet below when the P/Invoke shim itself fails to compile.
 *
 * Without it a shim failure is indistinguishable from an empty read — the script exits 0
 * with no output, and the caller reports "no entry for Claude Code-credentials", sending
 * anyone debugging it to look for a credential that is in fact present.
 */
export const WINDOWS_CRED_SHIM_ERROR_MARKER = '__CLAUDEMEM_CRED_SHIM_ERROR__';

/**
 * Build the PowerShell snippet that reads the OAuth blob out of Credential Manager.
 *
 * Exported so the shim can be checked without a Windows host. `Add-Type -Name <X>`
 * generates a C# class `<X>`, and C# rejects a class containing a member of its own name
 * with CS0542, "member names cannot be the same as their enclosing type". The shim was
 * `-Name CredRead` declaring `CredRead`, so the type never compiled, every call threw,
 * and the two SilentlyContinue settings swallowed it.
 */
export function buildWindowsCredentialScript(username: string): string {
  // PowerShell snippet enumerates likely target names and prints the JSON blob.
  // The exact target name on Windows is "Claude Code-credentials" or
  // "Claude Code:credentials" (Claude Desktop uses `${service}:${account}` or
  // `${service}` depending on version). This script tries both.
  // Username is escaped with PowerShell's single-quote convention (' → '') in
  // case future Windows versions or domain-joined machines permit ' in usernames.
  const psSafeUsername = username.replace(/'/g, "''");
  return `
    $ErrorActionPreference = 'SilentlyContinue'
    $candidates = @('Claude Code-credentials', 'Claude Code:credentials', 'Claude Code-credentials:${psSafeUsername}')
    try {
      Add-Type -Namespace ClaudeMem -Name CredApi -MemberDefinition @"
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
"@ -ErrorAction Stop
    } catch {
      Write-Output "${WINDOWS_CRED_SHIM_ERROR_MARKER} $($_.Exception.Message)"
      exit 0
    }
    foreach ($t in $candidates) {
      $ptr = [IntPtr]::Zero
      $ok = [ClaudeMem.CredApi]::CredRead($t, 1, 0, [ref]$ptr)
      if ($ok) {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][ClaudeMem.CredApi+CREDENTIAL])
        $bytes = New-Object byte[] $cred.CredentialBlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
        [ClaudeMem.CredApi]::CredFree($ptr) | Out-Null
        [System.Text.Encoding]::Unicode.GetString($bytes)
        exit 0
      }
    }
    exit 0
  `.trim();
}

/**
 * #4246: Claude Code on Windows keeps its live login in
 * `${configDir}/.credentials.json`, so readClaudeOAuthToken only reaches this
 * when that file is absent. An entry here can belong to a previous account,
 * and must never shadow the live login.
 *
 * `execImpl` is the same injectable seam readMacOsKeychain exposes, so tests
 * can fake a Credential Manager response without a Windows host.
 */
async function readWindowsCredentialManager(
  execImpl: typeof execFileAsync = execFileAsync,
): Promise<OAuthTokenResult> {
  const psScript = buildWindowsCredentialScript(userInfo().username);

  let stdout: string;
  try {
    ({ stdout } = await execImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
    ));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('OAUTH', 'Windows Credential Manager read failed', { service: KEYCHAIN_SERVICE_NAME }, err);
    return {
      kind: 'absent',
      reason: `Windows Credential Manager read failed: ${err.message}`,
    };
  }
  const raw = stdout.trim();
  if (raw.startsWith(WINDOWS_CRED_SHIM_ERROR_MARKER)) {
    // The lookup never ran, so nothing here says anything about whether a credential
    // exists. Reporting "no entry" would be a wrong answer rather than a missing one.
    const detail = raw.slice(WINDOWS_CRED_SHIM_ERROR_MARKER.length).trim();
    logger.warn('OAUTH', 'Windows Credential Manager shim failed to compile', {
      service: KEYCHAIN_SERVICE_NAME,
      detail,
    });
    return {
      kind: 'absent',
      reason: `Windows Credential Manager could not be queried: the CredRead shim failed to compile (${detail})`,
    };
  }
  if (!raw) {
    return { kind: 'absent', reason: 'Windows Credential Manager has no entry for "Claude Code-credentials"' };
  }
  return parseKeychainPayload(raw);
}

/**
 * Linux: libsecret via the `secret-tool` CLI, under the service name
 * "Claude Code-credentials" with the account attribute set to the OS username.
 *
 * #4348: Claude Code on Linux keeps its login in
 * `${configDir}/.credentials.json`, never in libsecret, so readClaudeOAuthToken
 * only reaches this legacy store when that file is absent, and a miss here is
 * the normal case: it is logged at DEBUG, without telling users to install a
 * package that cannot help.
 *
 * #2753: same rationale as readWindowsCredentialManager above — left on the
 * bare KEYCHAIN_SERVICE_NAME. No verified evidence in this repo of Linux's
 * per-config-dir suffix scheme; do not guess-extend deriveMacKeychainServiceName's
 * logic here without separate verification on an actual Linux box.
 *
 * `execImpl` is the same injectable seam readMacOsKeychain exposes, exported
 * alongside it so tests can fake a libsecret response without a Linux host
 * or a real secret-tool binary.
 */
export async function readLinuxLibsecret(
  execImpl: typeof execFileAsync = execFileAsync,
): Promise<OAuthTokenResult> {
  const account = userInfo().username;
  let stdout: string;
  try {
    ({ stdout } = await execImpl(
      'secret-tool',
      ['lookup', 'service', KEYCHAIN_SERVICE_NAME, 'account', account],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
    ));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug('OAUTH', 'Linux libsecret lookup failed', { service: KEYCHAIN_SERVICE_NAME, account }, err);
    return {
      kind: 'absent',
      reason: `Linux libsecret lookup failed: ${err.message}`,
    };
  }
  const raw = stdout.trim();
  if (!raw) {
    return { kind: 'absent', reason: 'Linux libsecret returned empty value for "Claude Code-credentials"' };
  }
  return parseKeychainPayload(raw);
}

/**
 * #4348 — On-disk credentials file. Claude Code stores OAuth credentials at
 * `${configDir}/.credentials.json` (configDir defaults to ~/.claude) with the
 * same shape the keychain blobs carry:
 *   {"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":<ms>}}
 *
 * This is where Claude Code keeps the live login on every platform but macOS,
 * so readClaudeOAuthToken reads it first there (#4348 Linux, #4246 Windows);
 * on macOS it is the fallback after a keychain miss. Populates the same OAuth
 * token record the keychain path produces (token + expiresAt), so expiry
 * checks downstream see the real credential. Exported so tests can drive it
 * against fixture files.
 *
 * Read/parse failures fall through to `absent` with a DEBUG note — never
 * thrown — so the env-fallback branch in readClaudeOAuthToken can still run.
 */
export function readClaudeCredentialsFile(configDir: string): OAuthTokenResult {
  const credentialsPath = join(configDir, '.credentials.json');
  if (!existsSync(credentialsPath)) {
    return { kind: 'absent', reason: `No credentials file at ${credentialsPath}` };
  }
  let raw: string;
  try {
    raw = readFileSync(credentialsPath, 'utf-8');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug('OAUTH', 'Failed to read credentials file', { credentialsPath }, err);
    return { kind: 'absent', reason: `Could not read ${credentialsPath}: ${err.message}` };
  }
  const parsed = parseKeychainPayload(raw.trim());
  if (parsed.kind === 'present') {
    logger.debug('OAUTH', 'OAuth token read from credentials file', { credentialsPath, expiresAt: parsed.expiresAt });
    return { ...parsed, source: 'credentials-file' };
  }
  // File existed but carried no usable token (corrupt JSON, no
  // claudeAiOauth.accessToken, expired) — note it and fall through.
  logger.debug('OAUTH', 'Credentials file unusable, falling through', { credentialsPath, reason: parsed.reason });
  return parsed;
}

/**
 * The keychain payload Claude Desktop writes is a JSON blob. Parse it, extract
 * the access token, and classify based on `expiresAt`.
 */
function parseKeychainPayload(raw: string): OAuthTokenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // [ANTI-PATTERN IGNORED]: the keychain blob is JSON-parsed opportunistically —
    // some Claude Desktop versions store a bare token instead of JSON, so parse
    // failure is expected and recovery is the token-shape fallback below.
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

  // JSON.parse also accepts `null`, numbers, strings and arrays. Only an
  // object can carry claudeAiOauth, and `null.claudeAiOauth` would throw past
  // every fallback, the env token included.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'absent', reason: 'Credential payload is not a JSON object' };
  }
  const payload = parsed as ClaudeKeychainPayload;

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
      // The Claude Code CLI writes and refreshes this entry (`claude auth
      // login`, /login); re-logging into Claude Desktop never repairs it (#4150).
      reason: 'The Claude Code login in the credential store has expired',
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
 * The CLAUDE_CODE_OAUTH_TOKEN environment variable, for CI/headless setups.
 * Expired when the sidecar metadata or the token's own JWT `exp` says so.
 */
function readEnvOAuthToken(): OAuthTokenResult {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!envToken || envToken.trim().length === 0) {
    return { kind: 'absent', reason: 'CLAUDE_CODE_OAUTH_TOKEN is not set' };
  }
  const sidecarExpiresAt = readSidecarExpiresAt();
  const jwtExpiresAt = decodeJwtExpMs(envToken);
  const effectiveExpiresAt = sidecarExpiresAt ?? jwtExpiresAt;

  if (isExpired(effectiveExpiresAt)) {
    return {
      kind: 'expired',
      reason: 'CLAUDE_CODE_OAUTH_TOKEN env var expired (per sidecar/JWT)',
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

/**
 * The login Claude Code itself keeps for this profile: the macOS keychain on
 * darwin, and `${configDir}/.credentials.json` everywhere else (#4348 Linux,
 * #4246 Windows). The other store is consulted only when the primary one has
 * no entry at all — a present or expired primary result is authoritative, so
 * a stale Windows Credential Manager entry from a previous account can no
 * longer shadow the live login.
 */
async function readStoredClaudeCredential(
  profile: ClaudeCredentialProfile,
  execImpl: typeof execFileAsync,
): Promise<OAuthTokenResult> {
  if (process.platform === 'darwin') {
    const keychainResult = await readMacOsKeychain(deriveMacKeychainServiceName(profile), execImpl);
    if (keychainResult.kind !== 'absent') return keychainResult;
    const fileResult = readClaudeCredentialsFile(profile.configDir);
    if (fileResult.kind !== 'absent') return fileResult;
    return { kind: 'absent', reason: `${keychainResult.reason}; ${fileResult.reason}` };
  }

  const fileResult = readClaudeCredentialsFile(profile.configDir);
  if (fileResult.kind !== 'absent') return fileResult;

  let legacyStoreResult: OAuthTokenResult;
  switch (process.platform) {
    case 'win32':
      legacyStoreResult = await readWindowsCredentialManager(execImpl);
      break;
    case 'linux':
      legacyStoreResult = await readLinuxLibsecret(execImpl);
      break;
    default:
      return { kind: 'absent', reason: `Unsupported platform: ${process.platform} has no OS credential store; ${fileResult.reason}` };
  }
  if (legacyStoreResult.kind !== 'absent') return legacyStoreResult;
  return { kind: 'absent', reason: `${fileResult.reason}; ${legacyStoreResult.reason}` };
}

/**
 * Read the Claude Code OAuth token the SDK child should run with.
 *
 *   1. The login Claude Code keeps for this profile (readStoredClaudeCredential).
 *      A present result wins.
 *   2. CLAUDE_CODE_OAUTH_TOKEN, for CI/headless setups. A usable env token
 *      beats an EXPIRED stored credential (plan-19 item 4, #3121), so an old
 *      login left on disk or in the keychain cannot block a working token.
 *   3. Nothing usable: the stored credential's expiry (it drives the
 *      "run /login" marker), else the env token's, else the stored miss.
 *
 * `execImpl` is the same injectable seam `readMacOsKeychain` exposes (see its
 * doc comment) — threaded through here, not just down at readMacOsKeychain,
 * so a test can drive this function end-to-end and assert the darwin branch
 * actually derives and passes the config-dir-suffixed service name, rather
 * than only exercising deriveMacKeychainServiceName/readMacOsKeychain as
 * standalone units. Defaults to the real execFileAsync for every production
 * call site (only src/shared/EnvManager.ts calls this today, with no args).
 */
export async function readClaudeOAuthToken(
  execImpl: typeof execFileAsync = execFileAsync,
): Promise<OAuthTokenResult> {
  // #2753 / #4149 — resolve the credential profile (setting > env > default)
  // once per call. Its config dir locates `.credentials.json` on every
  // platform; only the macOS keychain also derives a service name from it.
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  const credentialProfile = resolveClaudeCredentialProfile(settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR);

  const storedResult = await readStoredClaudeCredential(credentialProfile, execImpl);
  if (storedResult.kind === 'present') return storedResult;

  const envResult = readEnvOAuthToken();
  if (envResult.kind === 'present') return envResult;

  if (storedResult.kind === 'expired') return storedResult;
  if (envResult.kind === 'expired') return envResult;
  return storedResult;
}

/**
 * Marker file pattern: when a recent spawn returned `expired`, write a marker
 * at `${DATA_DIR}/oauth-stale.marker` so the session-start hook can surface a
 * clear "run /login in Claude Code" message to the user. The marker is
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
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('OAUTH', 'Failed to read oauth-stale marker', {}, err);
    return undefined;
  }
}
