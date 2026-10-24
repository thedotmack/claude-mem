// SPDX-License-Identifier: Apache-2.0
//
// Shared team gateway client keys (plan D15, Phase 16 tasks 2–3).
//
// - A key is `cmw_<base64url of 32 random bytes>`. It travels in the agent's
//   base URL (`/k/<key>/r/<route>/…`), so the agent's vendor credential stays
//   untouched. The raw key is shown once, by `claude-mem wire keys add`.
// - keys.json (0600) keeps only the SHA-256 digest of the whole key, looked
//   up in a map and compared with timingSafeEqual. Not a slow KDF (the plan
//   said scrypt): a slow KDF protects a guessable secret, a human password,
//   from offline guessing; a client key is 256 random bits, which no number of
//   SHA-256 guesses comes near (2^256), so scrypt bought nothing there. On the
//   request path it cost ~26 ms of CPU per wrong key that matched a stored
//   prefix, before the failed-key throttle could answer: 6,000 such requests
//   saturated every core, and a match answered ~26 ms slower than a miss, an
//   oracle for the stored prefix (.scratch/review-p16-rereview). A digest
//   lookup is microseconds for any key, right or wrong, with nothing to time.
// - Each key names where its members' memory goes: a claude-mem server
//   runtime, a project-scoped server API key and that project's id. The
//   server API key is stored because the gateway must send it; nothing else
//   about a member is stored, and never a vendor credential.
// - Each record has a random `id`. The outbox files a member's events under
//   it (outbox/<name>/<id>/), so a name removed and added again for someone
//   else never receives the first member's events.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, paths } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { withExclusiveFileLock } from '../edit/file-lock.js';
import { describeDirectHttpFailure, requestDirectlyWithOutcome, type DirectHttpOutcome, type DirectHttpRequest } from '../direct-http.js';
import { unmapAddress } from './allow-list.js';

export const WIRE_CLIENT_KEY_PREFIX = 'cmw_';
/** 32 random bytes, base64url without padding: 43 characters. */
const WIRE_CLIENT_KEY_RANDOM_BYTES = 32;
export const WIRE_CLIENT_KEY_PATTERN = /^cmw_[A-Za-z0-9_-]{43}$/;
/** Same shape as a route id (routes.ts WIRE_GATEWAY_ROUTE_ID_PATTERN): safe in logs, filenames and session ids. */
export const WIRE_CLIENT_KEY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * A server API key goes into an Authorization header: token characters only
 * (no CR/LF, no spaces). 16 is below every claude-mem key (cmem_ + 48 hex,
 * cm_ + 48 hex); 512 keeps the header line far under any server's header limit.
 */
const SERVER_API_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
/**
 * 2: keys stored as `sha256:<hex>` digests. Version 1 (scrypt hashes, written
 * only by unreleased builds of this branch) is refused with a "re-add your
 * keys" error: a scrypt hash cannot be turned into a digest without the raw
 * key, which was never stored.
 */
const WIRE_CLIENT_KEYS_VERSION = 2;
const WIRE_CLIENT_KEY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** A record's id: 16 random bytes in hex, a safe folder name (the outbox files events under it). */
const WIRE_CLIENT_KEY_RECORD_ID_BYTES = 16;
export const WIRE_CLIENT_KEY_RECORD_ID_PATTERN = /^[0-9a-f]{32}$/;
/** keys.json's stamp is looked at most this often on the request path (routes.ts uses the same 1 s for routes.json). */
const CLIENT_KEYS_RELOAD_CHECK_INTERVAL_MS = 1_000;

export interface WireClientKeyServer {
  /** The claude-mem server runtime's base URL (http or https; no credentials, query or fragment). */
  url: string;
  /** A project-scoped server API key with memories:write (cmem_… or cm_…). */
  apiKey: string;
  /** The server project the key is scoped to; /v1/events needs it in the body. */
  projectId: string;
}

export interface WireClientKeyRecord {
  /** Random, never reused: what the outbox binds a queued event to. */
  id: string;
  name: string;
  /** sha256:<hex of SHA-256 of the whole raw key> (digestOfClientKey). */
  keyDigest: string;
  createdAt: string;
  server: WireClientKeyServer;
}

interface WireClientKeysFile {
  version: typeof WIRE_CLIENT_KEYS_VERSION;
  keys: WireClientKeyRecord[];
}

/** Who a request with a valid key is: never the raw key. */
export interface WireClientKeyIdentity {
  name: string;
  /** The record's id (never the key): the outbox sends an event only while this record still holds the name. */
  keyId: string;
  server: WireClientKeyServer;
}

/** A key's record by name, as the outbox and the capture sink ask for it. */
export type WireClientKeyLookup =
  | { kind: 'found'; identity: WireClientKeyIdentity }
  /** No record has that name: it was removed. */
  | { kind: 'absent' }
  /** keys.json does not read: nobody's record is known (unknown ≠ removed). */
  | { kind: 'unreadable'; reason: string };

/** What keys.json stores for a raw key: its SHA-256, never the key (see the header for why not a slow KDF). */
export function digestOfClientKey(rawKey: string): string {
  return `sha256:${createHash('sha256').update(rawKey, 'utf8').digest('hex')}`;
}

export function createRawWireClientKey(): string {
  return `${WIRE_CLIENT_KEY_PREFIX}${randomBytes(WIRE_CLIENT_KEY_RANDOM_BYTES).toString('base64url')}`;
}

/**
 * Where a plain http:// server runtime may be: addresses no public network
 * routes, so the bearer server API key never crosses the internet in clear
 * text. Loopback (127/8, ::1), RFC 1918 (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16, fe80::/10) and RFC 4193 unique local IPv6
 * (fc00::/7, which holds Fly's private network fdaa::/16). Not RFC 6598
 * shared space (100.64/10): carrier-grade NAT puts it on the ISP's network,
 * between subscribers, so a 100.x address is not proof the key stays private.
 * Tailscale's 100.x addresses are among them; a tailnet server takes https://
 * (`tailscale serve` or `tailscale cert`), or an fd7a:115c:a1e0::/48 address.
 */
const PRIVATE_NETWORK_RANGES = (() => {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
})();

export function isPrivateNetworkAddress(address: string): boolean {
  const unmapped = unmapAddress(address);
  const family = isIP(unmapped);
  if (family === 0) return false;
  return PRIVATE_NETWORK_RANGES.check(unmapped, family === 4 ? 'ipv4' : 'ipv6');
}

const PLAIN_HTTP_PUBLIC_MESSAGE = 'an http:// --server-url must be on this host or a private network (loopback, 10/8, 172.16/12, 192.168/16, fc00::/7): the server API key would cross the internet in clear text; use https://';

/**
 * Where to send to a server URL. https:// passes untouched (TLS checks the
 * name; `connectAddress` null). A plain http:// URL's host is resolved once,
 * every address must be private, and the address checked is the one to
 * connect to (`connectAddress`, direct-http.ts): resolving again at connect
 * time could answer a public address (DNS rebinding), and the key would go
 * there in clear text.
 */
export async function resolvePlainHttpServer(
  serverUrl: string,
  resolve: (hostname: string) => Promise<string[]> = resolveAllAddresses,
): Promise<{ refusal: string } | { connectAddress: string | null }> {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return { refusal: `"${serverUrl}" is not a URL` };
  }
  if (url.protocol !== 'http:') return { connectAddress: null };
  const hostname = unmapAddress(url.hostname);
  let addresses: string[];
  try {
    addresses = isIP(hostname) !== 0 ? [hostname] : await resolve(hostname);
  } catch (error) {
    return { refusal: `${url.hostname} does not resolve (${error instanceof Error ? error.message : String(error)})` };
  }
  if (addresses.length === 0) return { refusal: `${url.hostname} resolves to no address` };
  const publicAddress = addresses.find(address => !isPrivateNetworkAddress(address));
  if (publicAddress) return { refusal: `${PLAIN_HTTP_PUBLIC_MESSAGE} (${url.hostname} is ${publicAddress})` };
  return { connectAddress: unmapAddress(addresses[0]) };
}

/** Why a server URL may not be sent the key (resolvePlainHttpServer), or null. */
export async function plainHttpServerRefusal(serverUrl: string, resolve?: (hostname: string) => Promise<string[]>): Promise<string | null> {
  const resolved = await resolvePlainHttpServer(serverUrl, resolve);
  return 'refusal' in resolved ? resolved.refusal : null;
}

async function resolveAllAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map(entry => entry.address);
}

/** A body the server's compat summarize route answers without writing anything (it skips subagent contexts). */
const SERVER_CHECK_BODY = { contentSessionId: 'claude-mem-wire-keys-add-check', agentId: 'claude-mem-wire-keys-add-check' };
/** The check is one small request; 10 s is the outbox's own per-delivery bound (server-outbox.ts OUTBOX_DELIVERY_TIMEOUT_MS). */
const SERVER_CHECK_TIMEOUT_MS = 10_000;
/** The answer is a short JSON object; a larger one is not the server runtime's. */
const SERVER_CHECK_RESPONSE_MAXIMUM_BYTES = 64 * 1024;

/**
 * `keys add` asks the server runtime whether the API key works and is
 * project-scoped before it saves anything: an unscoped key would make the
 * compat routes answer 400 and every observation and session end be
 * rejected. The request is POST /api/sessions/summarize with a subagent
 * body, which the server answers `{status: 'skipped'}` without writing
 * (SessionsSummarizeAdapter); its project check comes first. Throws why not.
 */
export async function checkServerDestination(
  server: WireClientKeyServer,
  send: (request: DirectHttpRequest) => Promise<DirectHttpOutcome> = requestDirectlyWithOutcome,
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<void> {
  assertServerDestination(server);
  const resolved = await resolvePlainHttpServer(server.url, resolve);
  if ('refusal' in resolved) throw new Error(resolved.refusal);
  const outcome = await send({
    url: `${server.url.replace(/\/+$/, '')}/api/sessions/summarize`,
    ...(resolved.connectAddress ? { connectAddress: resolved.connectAddress } : {}),
    method: 'POST',
    jsonBody: SERVER_CHECK_BODY,
    headers: { authorization: `Bearer ${server.apiKey}` },
    timeoutMs: SERVER_CHECK_TIMEOUT_MS,
    maximumResponseBytes: SERVER_CHECK_RESPONSE_MAXIMUM_BYTES,
  });
  if ('failure' in outcome) {
    throw new Error(`cannot check the server API key: ${describeDirectHttpFailure(outcome.failure, `the claude-mem server runtime at ${server.url}`)}`);
  }
  const { statusCode, bodyText } = outcome.response;
  if (statusCode >= 200 && statusCode < 300) return;
  if (statusCode === 400 && bodyText.includes('project-scoped')) {
    throw new Error('the server API key is not project-scoped: the server runtime refuses observations and session ends from it. Make one with `claude-mem server api-key create --team <team> --project <project> --scope memories:read,memories:write`');
  }
  if (statusCode === 401 || statusCode === 403) {
    throw new Error(`the server runtime at ${server.url} refused the server API key (HTTP ${statusCode}): it is wrong, revoked, or lacks memories:write`);
  }
  throw new Error(`the server runtime at ${server.url} answered the key check with HTTP ${statusCode}; is it a claude-mem server runtime?`);
}

function assertServerDestination(server: WireClientKeyServer): void {
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error(`--server-url "${server.url}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--server-url must be http:// or https://');
  const literal = unmapAddress(url.hostname);
  if (url.protocol === 'http:' && isIP(literal) !== 0 && !isPrivateNetworkAddress(literal)) {
    throw new Error(PLAIN_HTTP_PUBLIC_MESSAGE);
  }
  if (url.username || url.password) throw new Error('--server-url must not carry a user or password; the server API key is sent as a bearer token');
  if (url.search || url.hash) throw new Error('--server-url must not carry a query or fragment');
  if (!SERVER_API_KEY_PATTERN.test(server.apiKey)) {
    throw new Error('the server API key must be 16–512 token characters (letters, digits, . _ ~ + / = -), such as cmem_…');
  }
  if (server.projectId.trim() === '' || /[\u0000-\u001f\u007f]/.test(server.projectId)) {
    throw new Error('--server-project must name the server project the API key is scoped to');
  }
}

function parseClientKeysFile(raw: string, filePath: string): WireClientKeysFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = parsed as { version?: unknown; keys?: unknown } | null;
  if (file && file.version === 1) {
    throw new Error(`${filePath} is a version 1 keys file from an earlier build (scrypt-hashed keys), which this version cannot read: delete it and re-add your keys with \`claude-mem wire keys add\` (each member gets a new key)`);
  }
  if (!file || file.version !== WIRE_CLIENT_KEYS_VERSION || !Array.isArray(file.keys)) {
    throw new Error(`${filePath} is not a version ${WIRE_CLIENT_KEYS_VERSION} keys file`);
  }
  for (const record of file.keys as Array<Partial<WireClientKeyRecord> | null>) {
    if (!record || typeof record.id !== 'string' || !WIRE_CLIENT_KEY_RECORD_ID_PATTERN.test(record.id) || typeof record.name !== 'string'
      || typeof record.keyDigest !== 'string' || !WIRE_CLIENT_KEY_DIGEST_PATTERN.test(record.keyDigest)
      || !record.server || typeof record.server.url !== 'string' || typeof record.server.apiKey !== 'string' || typeof record.server.projectId !== 'string') {
      throw new Error(`${filePath} has a key entry that is not {id, name, keyDigest: "sha256:<hex>", createdAt, server: {url, apiKey, projectId}}`);
    }
  }
  return file as WireClientKeysFile;
}

/** keys.json; a missing file holds no keys. Throws when it exists but cannot be used (unknown ≠ empty). */
export function readWireClientKeysFile(filePath: string = paths.wireGatewayClientKeys()): WireClientKeysFile {
  if (!existsSync(filePath)) return { version: WIRE_CLIENT_KEYS_VERSION, keys: [] };
  return parseClientKeysFile(readFileSync(filePath, 'utf-8'), filePath);
}

function writeClientKeysFile(file: WireClientKeysFile, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
  // mode applies from the first byte written: the file holds server API keys.
  writeJsonFileAtomic(filePath, file, { mode: WIRE_GATEWAY_FILE_MODE });
}

export interface AddWireClientKeyInput {
  name: string;
  server: WireClientKeyServer;
}

/** Adds a key and returns its raw value, which is never stored or shown again. */
export function addWireClientKey(input: AddWireClientKeyInput, filePath: string = paths.wireGatewayClientKeys()): { rawKey: string; record: WireClientKeyRecord } {
  if (!WIRE_CLIENT_KEY_NAME_PATTERN.test(input.name)) {
    throw new Error(`key name "${input.name}" must be 1–64 of a-z 0-9 . _ - and start with a letter or digit`);
  }
  assertServerDestination(input.server);
  return withExclusiveFileLock(filePath, () => {
    const file = readWireClientKeysFile(filePath);
    if (file.keys.some(record => record.name === input.name)) {
      throw new Error(`a key named "${input.name}" already exists; remove it first (claude-mem wire keys remove ${input.name})`);
    }
    const rawKey = createRawWireClientKey();
    const record: WireClientKeyRecord = {
      id: randomBytes(WIRE_CLIENT_KEY_RECORD_ID_BYTES).toString('hex'),
      name: input.name,
      keyDigest: digestOfClientKey(rawKey),
      createdAt: new Date().toISOString(),
      server: { url: input.server.url.replace(/\/+$/, ''), apiKey: input.server.apiKey, projectId: input.server.projectId.trim() },
    };
    writeClientKeysFile({ version: WIRE_CLIENT_KEYS_VERSION, keys: [...file.keys, record] }, filePath);
    return { rawKey, record };
  });
}

/**
 * Removes a key; false when none had that name. A member using it is refused
 * (401) within a second, and its events still waiting in the outbox are never
 * sent (they were bound to this record, whose server API key is gone with it).
 */
export function removeWireClientKey(name: string, filePath: string = paths.wireGatewayClientKeys()): boolean {
  return withExclusiveFileLock(filePath, () => {
    const file = readWireClientKeysFile(filePath);
    const kept = file.keys.filter(record => record.name !== name);
    if (kept.length === file.keys.length) return false;
    writeClientKeysFile({ version: WIRE_CLIENT_KEYS_VERSION, keys: kept }, filePath);
    return true;
  });
}

/** What `keys list` shows: never a digest or a server API key. */
export function listWireClientKeys(filePath: string = paths.wireGatewayClientKeys()): Array<{ name: string; createdAt: string; serverUrl: string; serverProjectId: string }> {
  return readWireClientKeysFile(filePath).keys.map(record => ({
    name: record.name,
    createdAt: record.createdAt,
    serverUrl: record.server.url,
    serverProjectId: record.server.projectId,
  }));
}

export type WireClientKeyVerdict =
  | { kind: 'valid'; identity: WireClientKeyIdentity }
  | { kind: 'invalid' }
  /** keys.json cannot be read: nobody is let in (unknown ≠ empty). */
  | { kind: 'unreadable'; reason: string };

function identityOf(record: WireClientKeyRecord): WireClientKeyIdentity {
  return { name: record.name, keyId: record.id, server: { ...record.server } };
}

interface LoadedClientKeys {
  records: WireClientKeyRecord[];
  /** Records by their digest's hex: one map lookup per request, whatever the key. */
  byDigest: Map<string, WireClientKeyRecord>;
}

/**
 * keys.json as the running gateway sees it, re-read when its content changes
 * (the routes.json pattern, routes.ts WireGatewayRoutesStore). A file that
 * does not read leaves no keys known (fail closed): a botched hand edit that
 * meant to remove a key must not leave it working. A failed read is retried
 * at the next check, whether or not the file changed (a transient EIO or
 * EMFILE must not leave every member refused until someone touches the file).
 */
export class WireClientKeyStore {
  private readonly filePath: string;
  private readonly reloadCheckIntervalMs: number;
  private loaded: LoadedClientKeys | null = null;
  /** SHA-256 of the bytes last parsed (or 'absent'); null after a failed read, so the next check reads again. */
  private loadedContentStamp: string | null = null;
  private nextStampCheckAt = 0;
  private lastLoadError: string | null = null;

  constructor(options: { filePath?: string; reloadCheckIntervalMs?: number } = {}) {
    this.filePath = options.filePath ?? paths.wireGatewayClientKeys();
    this.reloadCheckIntervalMs = options.reloadCheckIntervalMs ?? CLIENT_KEYS_RELOAD_CHECK_INTERVAL_MS;
  }

  /**
   * magpie `identifyCaller`/`access.Authenticate`: the whole key's SHA-256 is
   * looked up, then compared with timingSafeEqual. The same work for every
   * key (malformed ones are digested too), so the answer's timing says
   * nothing about any stored key, and no request costs more than a digest:
   * the failed-key throttle only turns later 401s into 429s.
   */
  verify(rawKey: string): WireClientKeyVerdict {
    this.reloadIfChanged();
    const loaded = this.loaded;
    if (!loaded) return { kind: 'unreadable', reason: this.lastLoadError ?? 'keys.json could not be read' };
    const digest = digestOfClientKey(rawKey);
    const candidate = loaded.byDigest.get(digest);
    if (!candidate || !WIRE_CLIENT_KEY_PATTERN.test(rawKey)) return { kind: 'invalid' };
    // The map matched on the digest's text; the constant-time compare is what decides.
    if (!timingSafeEqual(Buffer.from(candidate.keyDigest, 'utf8'), Buffer.from(digest, 'utf8'))) return { kind: 'invalid' };
    return { kind: 'valid', identity: identityOf(candidate) };
  }

  /** A key's record by name, for the outbox and the capture sink (which know only names). */
  lookupByName(name: string): WireClientKeyLookup {
    this.reloadIfChanged();
    if (!this.loaded) return { kind: 'unreadable', reason: this.lastLoadError ?? 'keys.json could not be read' };
    const record = this.loaded.records.find(candidate => candidate.name === name);
    return record ? { kind: 'found', identity: identityOf(record) } : { kind: 'absent' };
  }

  /** How many keys keys.json holds; null when it does not read (for `wire status`). */
  keyCount(): number | null {
    this.reloadIfChanged();
    return this.loaded?.records.length ?? null;
  }

  /** The file's bytes, or null when it does not exist. */
  private readRaw(): string | null {
    try {
      return readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now < this.nextStampCheckAt) return;
    // At most once a second on the request path (abuse protection: a flood of
    // requests must not read the file once each), failed read or not.
    this.nextStampCheckAt = now + this.reloadCheckIntervalMs;
    try {
      // The content's hash, not mtime and size: a same-size rewrite within one
      // mtime tick (coarse file systems) is still seen. keys.json is a few KB.
      const raw = this.readRaw();
      const stamp = raw === null ? 'absent' : createHash('sha256').update(raw).digest('hex');
      if (stamp === this.loadedContentStamp) return;
      const records = raw === null ? [] : parseClientKeysFile(raw, this.filePath).keys;
      this.loaded = { records, byDigest: new Map(records.map(record => [record.keyDigest, record])) };
      this.loadedContentStamp = stamp;
      this.lastLoadError = null;
    } catch (error) {
      // Fail closed: no key is known until the file reads again (every keyed request is answered 503).
      const err = error instanceof Error ? error : new Error(String(error));
      this.loaded = null;
      this.loadedContentStamp = null;
      this.lastLoadError = err.message;
      logger.error('WIRE', 'keys.json could not be read; every client key is refused (503) until it reads again', { path: this.filePath }, err);
    }
  }
}
