import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { writeJsonFileAtomic } from './atomic-json.js';
import { resolveDataDir } from './paths.js';

export type IntentCredentials = { install_id: string; intent_token: string };

const issuing = new Map<string, Promise<IntentCredentials>>();

function credentialPath(configPath?: string): string {
  return resolve(configPath ?? join(resolveDataDir(), 'intent-install.json'));
}

function isCredentials(value: unknown): value is IntentCredentials {
  if (!value || typeof value !== 'object') return false;
  const credentials = value as Partial<IntentCredentials>;
  // The companion endpoint specifies exactly 32/64 lowercase hex characters;
  // accepting a partial response would lose the installation's reusable proof.
  return typeof credentials.install_id === 'string'
    && /^[0-9a-f]{32}$/.test(credentials.install_id)
    && typeof credentials.intent_token === 'string'
    && /^[0-9a-f]{64}$/.test(credentials.intent_token);
}

export function readIntentCredentials(configPath?: string): IntentCredentials | null {
  const path = credentialPath(configPath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Hosted intent credentials are invalid at ${path}; refusing to create another installation identity.`);
  }

  if (value && typeof value === 'object' && (value as { state?: unknown }).state === 'pending') {
    const message = (value as { message?: unknown }).message;
    throw new Error(typeof message === 'string' && message
      ? message
      : `Hosted intent credential issuance is unfinished at ${path}; refusing to create another installation identity.`);
  }
  if (!isCredentials(value)) {
    throw new Error(`Hosted intent credentials are invalid at ${path}; refusing to create another installation identity.`);
  }

  // Correct a manually copied or older config before using its scoped secret.
  chmodSync(path, 0o600);
  return { install_id: value.install_id, intent_token: value.intent_token };
}

function reserveIssuance(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    // Reserve durably before sending: a crash or uncertain response must never
    // turn the next attempt into an issuance of a second installation identity.
    writeFileSync(fd, JSON.stringify({ state: 'pending' }) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') {
    const directoryFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

/**
 * The intent service's error codes that it sends only before anything was issued
 * (claude-mem-pro src/app/api/installer/intent/handlers.ts): the burst limit and the
 * daily-budget kill switch answer before the issuing transaction starts, and the
 * per-network daily limit is thrown inside it, which rolls it back. Every other
 * failure, the handler's catch-all `intent_install_unavailable` included, can follow
 * a committed transaction, so it does not prove that nothing was issued.
 */
const NOTHING_ISSUED_ERRORS: ReadonlySet<string> = new Set(['rate_limited', 'anonymous_daily_budget_reached', 'intent_install_limit']);

function isDefiniteRefusal(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const code = (body as { error?: unknown }).error;
  return typeof code === 'string' && NOTHING_ISSUED_ERRORS.has(code);
}

async function issueCredentials(
  path: string,
  options: { origin: string; fetch?: typeof fetch },
): Promise<IntentCredentials> {
  const existing = readIntentCredentials(path);
  if (existing) return existing;

  try {
    reserveIssuance(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another CLI/worker owns issuance. Reuse its completed result, or fail
    // visibly while its durable pending record protects against duplicate POSTs.
    const credentials = readIntentCredentials(path);
    if (credentials) return credentials;
    throw new Error(`Hosted intent credential issuance could not be reserved at ${path}.`);
  }

  const response = await (options.fetch ?? globalThis.fetch)(
    `${options.origin.replace(/\/+$/, '')}/api/installer/intent`,
    { method: 'POST' },
  );
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    // Neither a malformed success nor an unreadable failure proves that the
    // server did not issue an identity. Keep the pending reservation on disk.
  }
  if (!response.ok) {
    const serverMessage = result && typeof result === 'object'
      ? (result as { message?: unknown }).message
      : undefined;
    const message = typeof serverMessage === 'string' && serverMessage
      ? serverMessage
      : `Hosted intent credential request failed (HTTP ${response.status}).`;
    if (isDefiniteRefusal(result)) {
      // The service refused before issuing anything (NOTHING_ISSUED_ERRORS):
      // release the reservation so the next run asks again. This is not a
      // retry; this run still fails.
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`${message} The credential reservation could not be cleared at ${path}.`);
        }
      }
      throw new Error(message);
    }
    // Any other failed reply (a proxy or gateway page such as a timeout, or a
    // service error that can follow a committed issuance) does not prove the
    // service issued nothing. Retain only the controlled message,
    // never a response body or credential, and keep the reservation so a later
    // run cannot silently mint a second identity.
    try {
      writeJsonFileAtomic(path, { state: 'pending', message }, { mode: 0o600 });
    } catch {
      throw new Error(`${message} The credential issuance failure could not be saved; its pending reservation is retained.`);
    }
    throw new Error(message);
  }
  if (!isCredentials(result)) {
    throw new Error('Hosted intent service returned invalid installation credentials; issuance remains pending to prevent another identity.');
  }

  const credentials = { install_id: result.install_id, intent_token: result.intent_token };
  writeJsonFileAtomic(path, credentials, { mode: 0o600 });
  return credentials;
}

export async function getOrCreateIntentCredentials(options: {
  origin: string;
  fetch?: typeof fetch;
  configPath?: string;
}): Promise<IntentCredentials> {
  const path = credentialPath(options.configPath);
  const inFlight = issuing.get(path);
  if (inFlight) return inFlight;

  const request = issueCredentials(path, options);
  issuing.set(path, request);
  try {
    return await request;
  } finally {
    issuing.delete(path);
  }
}

export function intentCredentialHeaders(credentials: IntentCredentials | null): Record<string, string> {
  return credentials ? {
    'X-Intent-Install-Id': credentials.install_id,
    'X-Intent-Token': credentials.intent_token,
  } : {};
}
