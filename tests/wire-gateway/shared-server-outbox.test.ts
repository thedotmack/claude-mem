import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as nodeCrypto from 'crypto';
import * as nodeFs from 'fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Server as BunServer } from 'bun';
import pg from 'pg';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { CreateAgentEventSchema } from '../../src/core/schemas/agent-event.js';
import { buildAgentEventIdempotencyKey } from '../../src/storage/postgres/agent-events.js';
import { requestDirectlyWithOutcome, type DirectHttpOutcome, type DirectHttpRequest } from '../../src/services/wire-gateway/direct-http.js';
import { parseAllowList, isAllowedByList, unmapAddress } from '../../src/services/wire-gateway/shared/allow-list.js';
import { AUTH_FAIL_BURST, FailedKeyThrottle } from '../../src/services/wire-gateway/shared/auth-throttle.js';
import {
  WIRE_CLIENT_KEY_PATTERN,
  WireClientKeyStore,
  addWireClientKey,
  checkServerDestination,
  isPrivateNetworkAddress,
  listWireClientKeys,
  plainHttpServerRefusal,
  readWireClientKeysFile,
  removeWireClientKey,
  type WireClientKeyIdentity,
  type WireClientKeyLookup,
} from '../../src/services/wire-gateway/shared/client-keys.js';
import { runWireKeysCli } from '../../src/services/wire-gateway/shared/keys-cli.js';
import { OutboxFullError, WireServerOutbox, serverOutboxActivity } from '../../src/services/wire-gateway/shared/server-outbox.js';
import { createSharedModeCaptureEventSink, identityForClientKey, isSessionCapturableInSharedMode, splitClientKeySessionId } from '../../src/services/wire-gateway/shared/shared-capture.js';
import { redactClientKeyPaths } from '../../src/services/wire-gateway/shared/shared-admission.js';
import { validateWireGatewayListenSettings } from '../../src/services/wire-gateway/config.js';
import { redactWireClientKeys } from '../../src/utils/logger.js';
import { redactSecrets } from '../../src/services/telemetry/error-scrub.js';
import { logger } from '../../src/utils/logger.js';

const testRoot = join(WIRE_GATEWAY_DIR, 'shared-server-outbox-test');
const DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('allow list (magpie allow.go port)', () => {
  it('no list lets every address in', () => {
    expect(isAllowedByList(parseAllowList(''), '203.0.113.7')).toBe(true);
  });

  it('IPs and CIDR ranges, v4 and v6, comma or space separated; IPv4-mapped peers are unmapped', () => {
    const list = parseAllowList('10.0.0.0/8 192.168.1.5,fd00::/8');
    expect(isAllowedByList(list, '10.200.0.1')).toBe(true);
    expect(isAllowedByList(list, '::ffff:192.168.1.5')).toBe(true);
    expect(isAllowedByList(list, 'fd12::1')).toBe(true);
    expect(isAllowedByList(list, '192.168.1.6')).toBe(false);
    expect(isAllowedByList(list, '203.0.113.7')).toBe(false);
    expect(unmapAddress('[::ffff:10.0.0.1]')).toBe('10.0.0.1');
  });

  it('loopback is always let in; an unknown peer never is', () => {
    const list = parseAllowList('10.0.0.0/8');
    expect(isAllowedByList(list, '127.0.0.1')).toBe(true);
    expect(isAllowedByList(list, '::1')).toBe(true);
    expect(isAllowedByList(list, null)).toBe(false);
    expect(isAllowedByList(list, 'not-an-ip')).toBe(false);
  });

  it('a malformed entry lets nothing in, keeps the list on, and is logged', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      for (const malformed of ['10.0.0.0/33', 'banana', '10.0.0.0/x', '::/129']) {
        const list = parseAllowList(malformed);
        expect(list.malformedEntries).toEqual([malformed]);
        expect(isAllowedByList(list, '10.1.2.3')).toBe(false);
        expect(isAllowedByList(list, '203.0.113.7')).toBe(false);
        expect(isAllowedByList(list, '127.0.0.1')).toBe(true);
      }
      // A good entry beside a bad one still works.
      expect(isAllowedByList(parseAllowList('banana 10.0.0.0/8'), '10.1.2.3')).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('failed-key throttle (magpie auththrottle.go port)', () => {
  it('a burst of 50, then 429 until one token refills per second', () => {
    let nowMs = 0;
    const throttle = new FailedKeyThrottle(() => nowMs);
    expect(AUTH_FAIL_BURST).toBe(50);
    for (let attempt = 0; attempt < AUTH_FAIL_BURST; attempt++) expect(throttle.chargeFailure().throttled).toBe(false);
    expect(throttle.chargeFailure()).toEqual({ throttled: true, retryAfterSeconds: 2 });
    nowMs += 1_000;
    expect(throttle.chargeFailure().throttled).toBe(false);
    expect(throttle.chargeFailure().throttled).toBe(true);
    nowMs += 3_600_000;
    for (let attempt = 0; attempt < AUTH_FAIL_BURST; attempt++) expect(throttle.chargeFailure().throttled).toBe(false);
    expect(throttle.chargeFailure().throttled).toBe(true);
  });
});

describe('client keys (keys.json)', () => {
  const keysFilePath = join(testRoot, 'keys-unit', 'keys.json');
  const server = { url: 'https://team.example.com/', apiKey: 'cmem_serverkey0000000000000000', projectId: 'project-1' };
  beforeEach(() => rmSync(join(testRoot, 'keys-unit'), { recursive: true, force: true }));

  it('add makes a cmw_ key of 32 random bytes, stored only as its SHA-256 digest, in a 0600 file, with a random record id', () => {
    const { rawKey, record } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    expect(rawKey).toMatch(WIRE_CLIENT_KEY_PATTERN);
    expect(Buffer.from(rawKey.slice(4), 'base64url')).toHaveLength(32);
    const fileText = readFileSync(keysFilePath, 'utf-8');
    expect(fileText).not.toContain(rawKey);
    const stored = readWireClientKeysFile(keysFilePath).keys[0];
    expect(stored.keyDigest).toBe(`sha256:${nodeCrypto.createHash('sha256').update(rawKey).digest('hex')}`);
    expect(fileText).not.toContain('scrypt');
    expect(fileText).not.toContain(rawKey.slice(0, 10));
    expect(stored.id).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.id).toBe(record.id);
    expect(stored.server).toEqual({ url: 'https://team.example.com', apiKey: server.apiKey, projectId: 'project-1' });
    if (process.platform !== 'win32') expect(statSync(keysFilePath).mode & 0o777).toBe(0o600);
    // Removed and added again under the same name: a new record, a new id.
    removeWireClientKey('alice', keysFilePath);
    expect(addWireClientKey({ name: 'alice', server }, keysFilePath).record.id).not.toBe(record.id);
  });

  it('verify: the key is valid, a wrong one is not, and a removed one stops working', async () => {
    const { rawKey, record } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    const store = new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 0 });
    const verdict = await store.verify(rawKey);
    expect(verdict.kind).toBe('valid');
    if (verdict.kind === 'valid') expect(verdict.identity).toMatchObject({ name: 'alice', keyId: record.id });
    expect(await store.verify(`${rawKey.slice(0, -1)}${rawKey.endsWith('A') ? 'B' : 'A'}`)).toEqual({ kind: 'invalid' });
    expect(await store.verify('cmw_short')).toEqual({ kind: 'invalid' });
    expect(removeWireClientKey('alice', keysFilePath)).toBe(true);
    expect((await store.verify(rawKey)).kind).toBe('invalid');
    expect(store.lookupByName('alice')).toEqual({ kind: 'absent' });
  });

  it('every key costs one digest and a map lookup: no slow KDF, the match compared with timingSafeEqual', () => {
    const { rawKey } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    const store = new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 0 });
    const constantTime = spyOn(nodeCrypto, 'timingSafeEqual');
    const slowHash = spyOn(nodeCrypto, 'scrypt');
    const slowHashSync = spyOn(nodeCrypto, 'scryptSync');
    try {
      const samePrefixWrongKey = `${rawKey.slice(0, 10)}${rawKey.slice(10).split('').reverse().join('')}`;
      expect(samePrefixWrongKey).not.toBe(rawKey);
      expect(store.verify(samePrefixWrongKey)).toEqual({ kind: 'invalid' });
      expect(store.verify('cmw_short')).toEqual({ kind: 'invalid' });
      expect(constantTime).toHaveBeenCalledTimes(0);
      expect(store.verify(rawKey).kind).toBe('valid');
      expect(constantTime).toHaveBeenCalledTimes(1);
      expect(slowHash).not.toHaveBeenCalled();
      expect(slowHashSync).not.toHaveBeenCalled();
    } finally {
      constantTime.mockRestore();
      slowHash.mockRestore();
      slowHashSync.mockRestore();
    }
  });

  it('no timing oracle: a wrong key that shares a stored key\'s prefix costs what any wrong key costs (microseconds)', () => {
    const { rawKey } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    const store = new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 60_000 });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tail = (length: number) => Array.from({ length }, () => alphabet[Math.floor(Math.random() * 64)]).join('');
    const timeOf = (makeKey: () => string): number => {
      const keys = Array.from({ length: 300 }, makeKey);
      const startedAt = performance.now();
      for (const key of keys) expect(store.verify(key).kind).toBe('invalid');
      return (performance.now() - startedAt) / keys.length;
    };
    store.verify(rawKey);
    const samePrefixMs = timeOf(() => `${rawKey.slice(0, 10)}${tail(37)}`);
    const otherMs = timeOf(() => `cmw_${tail(43)}`);
    // scrypt took ~26 ms per same-prefix key (.scratch/review-p16-rereview); a digest takes microseconds.
    expect(samePrefixMs).toBeLessThan(0.5);
    expect(otherMs).toBeLessThan(0.5);
  });

  it('a keys.json from the scrypt build (version 1) is refused with a re-add message, and fails closed', () => {
    mkdirSync(join(testRoot, 'keys-unit'), { recursive: true });
    writeFileSync(keysFilePath, JSON.stringify({ version: 1, keys: [{ id: 'a'.repeat(32), name: 'alice', keyHash: 'scrypt$16384$00$00', keyPrefix: 'cmw_abcdef', createdAt: '', server }] }));
    expect(() => readWireClientKeysFile(keysFilePath)).toThrow('re-add your keys');
    expect(() => addWireClientKey({ name: 'bob', server }, keysFilePath)).toThrow('version 1');
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      expect(new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 0 }).verify(`cmw_${'A'.repeat(43)}`).kind).toBe('unreadable');
    } finally {
      error.mockRestore();
    }
  });

  it('a read that fails once is retried at the next check, though the file never changed', () => {
    const { rawKey } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    const store = new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 0 });
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    const realReadFileSync = nodeFs.readFileSync;
    let failNextRead = true;
    const reads = spyOn(nodeFs, 'readFileSync').mockImplementation(((path: Parameters<typeof nodeFs.readFileSync>[0], ...rest: unknown[]) => {
      if (failNextRead && String(path) === keysFilePath) {
        failNextRead = false;
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      }
      return (realReadFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as never);
    try {
      expect(store.verify(rawKey).kind).toBe('unreadable');
      expect(store.verify(rawKey).kind).toBe('valid');
    } finally {
      reads.mockRestore();
      error.mockRestore();
    }
  });

  it('a same-size rewrite within one mtime tick is seen (the content is compared, not mtime and size)', () => {
    const { rawKey } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    // One whole-second mtime for both versions: what a coarse file system records for two writes in one tick.
    const tick = Math.floor(Date.now() / 1000);
    utimesSync(keysFilePath, tick, tick);
    const store = new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 0 });
    expect(store.verify(rawKey).kind).toBe('valid');
    const before = statSync(keysFilePath);
    const text = readFileSync(keysFilePath, 'utf-8');
    // The same bytes but the record renamed to one of the same length: alice is gone.
    writeFileSync(keysFilePath, text.replace('"name": "alice"', '"name": "zelda"'));
    utimesSync(keysFilePath, tick, tick);
    expect(statSync(keysFilePath).size).toBe(before.size);
    expect(statSync(keysFilePath).mtimeMs).toBe(before.mtimeMs);
    expect(store.lookupByName('alice')).toEqual({ kind: 'absent' });
  });

  it('keys.json that stops reading fails closed: the last good keys are dropped, nobody is let in', async () => {
    const { rawKey } = addWireClientKey({ name: 'alice', server }, keysFilePath);
    const store = new WireClientKeyStore({ filePath: keysFilePath, reloadCheckIntervalMs: 0 });
    expect((await store.verify(rawKey)).kind).toBe('valid');
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      writeFileSync(keysFilePath, '{"version":1,"keys":[{"name":"alice"');
      expect((await store.verify(rawKey)).kind).toBe('unreadable');
      expect(store.lookupByName('alice').kind).toBe('unreadable');
      expect(store.keyCount()).toBeNull();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('refuses bad names, duplicate names, and server settings that could leak or break a header', () => {
    addWireClientKey({ name: 'alice', server }, keysFilePath);
    expect(() => addWireClientKey({ name: 'alice', server }, keysFilePath)).toThrow('already exists');
    expect(() => addWireClientKey({ name: 'Alice Smith', server }, keysFilePath)).toThrow('key name');
    expect(() => addWireClientKey({ name: 'bob', server: { ...server, url: 'https://u:p@team.example.com' } }, keysFilePath)).toThrow('user or password');
    expect(() => addWireClientKey({ name: 'bob', server: { ...server, url: 'ftp://team.example.com' } }, keysFilePath)).toThrow('http');
    expect(() => addWireClientKey({ name: 'bob', server: { ...server, apiKey: 'cmem_abc\r\nx: y' } }, keysFilePath)).toThrow('token characters');
  });

  it('an http:// server must be on this host or a private network, at add and as resolved', async () => {
    expect(() => addWireClientKey({ name: 'bob', server: { ...server, url: 'http://8.8.8.8:3000' } }, keysFilePath)).toThrow('private network');
    expect(() => addWireClientKey({ name: 'bob', server: { ...server, url: 'http://[2001:4860::8888]:3000' } }, keysFilePath)).toThrow('private network');
    for (const privateUrl of ['http://127.0.0.1:3000', 'http://10.0.0.5', 'http://172.20.0.1', 'http://192.168.1.9', 'http://[fdaa::3]:8080', 'http://[::1]:1']) {
      expect(await plainHttpServerRefusal(privateUrl)).toBeNull();
    }
    expect(await plainHttpServerRefusal('https://8.8.8.8')).toBeNull();
    expect(await plainHttpServerRefusal('http://memory.internal:3000', async () => ['fdaa:0:1::2'])).toBeNull();
    expect(await plainHttpServerRefusal('http://memory.example.com', async () => ['10.0.0.2', '93.184.216.34'])).toContain('93.184.216.34');
    expect(await plainHttpServerRefusal('http://nowhere.invalid', async () => { throw new Error('ENOTFOUND'); })).toContain('does not resolve');
    expect(isPrivateNetworkAddress('::ffff:10.1.1.1')).toBe(true);
    expect(isPrivateNetworkAddress('172.32.0.1')).toBe(false);
    // RFC 6598 shared space (carrier-grade NAT) crosses the ISP's network: not private.
    expect(isPrivateNetworkAddress('100.100.1.1')).toBe(false);
    expect(await plainHttpServerRefusal('http://100.64.0.1:3000')).toContain('private network');
    expect(() => addWireClientKey({ name: 'bob', server: { ...server, url: 'http://100.100.1.1:3000' } }, keysFilePath)).toThrow('private network');
  });

  it('`wire keys add|list|remove`: add checks the server first; the key is printed once; list never prints a key, hash or server API key', async () => {
    const out: string[] = [];
    const errors: string[] = [];
    const checks: DirectHttpRequest[] = [];
    let serverAnswer: DirectHttpOutcome = { response: { statusCode: 200, bodyText: '{"status":"skipped","reason":"subagent_context"}' } };
    const cli = (args: string[], env: Record<string, string> = {}) => runWireKeysCli(args, {
      config: { shared: true, sharedHost: '0.0.0.0', sharedPort: 8080, retentionDays: 7 }, keysFilePath, env,
      send: async request => { checks.push(request); return serverAnswer; },
      writeLine: line => out.push(line), writeError: line => errors.push(line),
    });
    expect(await cli(['add', 'carol', '--server-url', 'https://team.example.com', '--server-project', 'p1'], { CLAUDE_MEM_WIRE_SERVER_API_KEY: server.apiKey })).toBe(0);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ url: 'https://team.example.com/api/sessions/summarize', method: 'POST', headers: { authorization: `Bearer ${server.apiKey}` } });
    expect((checks[0].jsonBody as { agentId?: string }).agentId).toBeDefined();
    const printedKey = out.join('\n').match(/cmw_[A-Za-z0-9_-]{43}/)?.[0];
    expect(printedKey).toBeDefined();
    expect(out.join('\n')).toContain(`/k/${printedKey}/r/<route>`);
    expect(out.join('\n')).toContain('http://0.0.0.0:8080');
    out.length = 0;
    expect(await cli(['list'])).toBe(0);
    const listed = out.join('\n');
    expect(listed).toContain('carol');
    expect(listed).not.toContain('cmw_');
    expect(listed).not.toContain('sha256');
    expect(listed).not.toContain(server.apiKey);
    expect(listWireClientKeys(keysFilePath)).toHaveLength(1);
    expect(await cli(['add', 'dave', '--server-url', 'https://team.example.com'])).toBe(1);
    // An unscoped server key is refused before anything is saved.
    serverAnswer = { response: { statusCode: 400, bodyText: '{"error":"BadRequest","message":"Legacy /api/sessions/summarize requires a project-scoped API key"}' } };
    expect(await cli(['add', 'erin', '--server-url', 'https://team.example.com', '--server-project', 'p1', '--server-api-key', server.apiKey])).toBe(1);
    expect(errors.join('\n')).toContain('not project-scoped');
    serverAnswer = { response: { statusCode: 403, bodyText: '{"error":"Forbidden"}' } };
    expect(await cli(['add', 'erin', '--server-url', 'https://team.example.com', '--server-project', 'p1', '--server-api-key', server.apiKey])).toBe(1);
    expect(errors.join('\n')).toContain('refused the server API key');
    serverAnswer = { failure: { reason: 'unreachable', detail: 'ECONNREFUSED' } };
    expect(await cli(['add', 'erin', '--server-url', 'https://team.example.com', '--server-project', 'p1', '--server-api-key', server.apiKey])).toBe(1);
    expect(listWireClientKeys(keysFilePath).map(key => key.name)).toEqual(['carol']);
    out.length = 0;
    expect(await cli(['remove', 'carol'])).toBe(0);
    expect(out.join('\n')).toContain('never sent');
    expect(out.join('\n')).toContain('rejected/');
    expect(out.join('\n')).not.toContain('expired/');
    expect(await cli(['remove', 'carol'])).toBe(1);
    expect(errors.join('\n')).not.toContain('cmw_');
  });
});

describe('shared mode: settings, session namespacing, redaction', () => {
  it('the loopback listener is always loopback; the team listener needs its own port', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '0.0.0.0' })).toContain('loopback');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '0.0.0.0', CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'false' })).toContain('loopback');
    // Shared mode never moves the keyless listener off loopback.
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '0.0.0.0', CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'true', CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST: '0.0.0.0', CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: '8080' })).toContain('loopback');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'true', CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST: '0.0.0.0', CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: '' })).toContain('SHARED_PORT must be set');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_PORT: '37677', CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'true', CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST: '0.0.0.0', CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: '37677' })).toContain('must differ');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '127.0.0.1', CLAUDE_MEM_WIRE_GATEWAY_PORT: '37677', CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'true', CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST: '0.0.0.0', CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: '8080' })).toBeNull();
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'true', CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST: '::', CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: '8080' })).toBeNull();
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_SHARED: 'yes' })).toContain('"true" or "false"');
  });

  it('only client-named sessions are capturable in shared mode', () => {
    expect(isSessionCapturableInSharedMode({ sessionSource: 'fingerprint' })).toBe(false);
    for (const source of ['named', 'header', 'body', 'launch'] as const) expect(isSessionCapturableInSharedMode({ sessionSource: source })).toBe(true);
  });

  it('a keyed session id is namespaced by key name and record id, and split back', () => {
    const keyId = 'a'.repeat(32);
    const identity = identityForClientKey({ sessionId: 's1', parentSessionId: 'p1', sessionSource: 'header' } as never, { name: 'alice', keyId });
    expect(identity.sessionId).toBe(`key:alice/${keyId}:s1`);
    expect(identity.parentSessionId).toBe(`key:alice/${keyId}:p1`);
    expect(splitClientKeySessionId(`key:alice/${keyId}:s:with:colons`)).toEqual({ keyName: 'alice', keyId, sessionId: 's:with:colons' });
    expect(splitClientKeySessionId('codex-thread-1')).toBeNull();
  });

  it('the capture sink queues a keyed event only while the same key record holds the name', () => {
    const queued: Array<{ identity: WireClientKeyIdentity; kind: string }> = [];
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    let lookup: WireClientKeyLookup = { kind: 'found', identity: { name: 'alice', keyId: 'a'.repeat(32), server: { url: 'https://x.example.com', apiKey: 'cmem_x0000000000000000', projectId: 'p' } } };
    const sink = createSharedModeCaptureEventSink({
      localSink: { emit: () => { throw new Error('a keyed event must not reach the local worker'); } },
      outbox: { enqueue: (identity: WireClientKeyIdentity, kind: string) => { queued.push({ identity, kind }); return 'queued'; } } as never,
      lookupKey: () => lookup,
    });
    try {
      sink.emit('session_end', { contentSessionId: `key:alice/${'a'.repeat(32)}:s1`, platformSource: 'codex' });
      expect(queued).toHaveLength(1);
      // alice was removed and added again (a new record): the first member's session never goes to the new one.
      lookup = { kind: 'found', identity: { name: 'alice', keyId: 'b'.repeat(32), server: { url: 'https://y.example.com', apiKey: 'cmem_y0000000000000000', projectId: 'q' } } };
      sink.emit('session_end', { contentSessionId: `key:alice/${'a'.repeat(32)}:s2`, platformSource: 'codex' });
      expect(queued).toHaveLength(1);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('paths, log lines and telemetry never carry a client key; the log redaction matches only the real key shape', () => {
    const key = `cmw_${'Z9'.repeat(21)}x`;
    expect(key).toMatch(WIRE_CLIENT_KEY_PATTERN);
    expect(redactClientKeyPaths(`/k/${key}/r/claude/v1/messages`)).toBe('/k/[REDACTED]/r/claude/v1/messages');
    expect(redactWireClientKeys(`GET https://gw.example.com/k/${key}/r/x and ${key}`)).toBe('GET https://gw.example.com/k/[REDACTED]/r/x and cmw_[REDACTED]');
    // Ordinary paths and names that only look alike are left alone.
    expect(redactWireClientKeys('/Users/k/project/a.ts')).toBe('/Users/k/project/a.ts');
    expect(redactWireClientKeys('call cmw_helper_function now')).toBe('call cmw_helper_function now');
    expect(redactWireClientKeys(`${key}x`)).toBe(`${key}x`);
    expect(redactSecrets(`failed for ${key}`)).not.toContain(key);
    expect(redactSecrets('failed for cmw_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq')).not.toContain('cmw_abcdefgh');
  });

  it('telemetry masks a key that ends in - or _ to its last character', () => {
    for (const tail of ['-', '--', '_', '-_']) {
      const key = `cmw_${'k'.repeat(43 - tail.length)}${tail}`;
      const scrubbed = redactSecrets(`failed for ${key} then more`);
      expect(scrubbed).not.toContain(tail === '-' ? 'k-' : `k${tail}`);
      expect(scrubbed).toMatch(/failed for \S+ then more$/);
      expect(scrubbed.split(' ')[2]).not.toMatch(/[-_]$/);
    }
  });
});

// ---------------------------------------------------------------------------
// A faithful fake of the claude-mem server runtime's write routes, built from
// its own code: the bearer-key check of server/middleware/postgres-auth.ts
// (401 no key, 403 wrong key), the compat routes' project-scope check
// (400 for an unscoped key) and subagent skip, CreateAgentEventSchema for
// /v1/events, and the idempotency key every stored event gets
// (storage/postgres/agent-events.ts buildAgentEventIdempotencyKey: the
// compat observation route keys by tool_use_id as sourceEventId, /v1/events
// by its content). `ON CONFLICT (idempotency_key)` becomes a Map.

interface FakeServerRuntime {
  url: string;
  port: number;
  storedEvents: Map<string, unknown>;
  endedSessions: string[];
  requestCount: number;
  /** The next N writes are stored but answered 500 (a response lost on the way back). */
  loseNextResponses: number;
  stop(): Promise<void>;
  start(): void;
}

const FAKE_TEAM_ID = 'team-1';
const FAKE_PROJECT_ID = 'project-a';
const FAKE_SERVER_API_KEY = 'cmem_fakeserverkey0000000000000';
const FAKE_UNSCOPED_SERVER_API_KEY = 'cmem_fakeunscopedkey00000000000';

function startFakeServerRuntime(port = 0): FakeServerRuntime {
  const runtime: FakeServerRuntime = {
    url: '', port: 0, storedEvents: new Map(), endedSessions: [], requestCount: 0, loseNextResponses: 0,
    stop: async () => undefined,
    start: () => undefined,
  };
  let server: BunServer<undefined> | null = null;
  const handle = async (request: Request): Promise<Response> => {
    runtime.requestCount++;
    // The runtime's express.json({ limit: '5mb' }) (worker/http/middleware.ts createMiddleware): 413 above it.
    if (Number(request.headers.get('content-length') ?? 0) > 5 * 1024 * 1024) return Response.json({ error: 'PayloadTooLargeError' }, { status: 413 });
    const authorization = request.headers.get('authorization') ?? '';
    const rawKey = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : request.headers.get('x-api-key');
    if (!rawKey) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (rawKey !== FAKE_SERVER_API_KEY && rawKey !== FAKE_UNSCOPED_SERVER_API_KEY) return Response.json({ error: 'Forbidden' }, { status: 403 });
    const scoped = rawKey === FAKE_SERVER_API_KEY;
    const body = await request.json() as Record<string, unknown>;
    const { pathname } = new URL(request.url);
    let stored: { key: string; value: unknown } | null = null;
    if (pathname === '/v1/events') {
      const parsed = CreateAgentEventSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: 'ValidationError', issues: parsed.error.issues }, { status: 400 });
      if (parsed.data.projectId !== FAKE_PROJECT_ID) return Response.json({ error: 'Forbidden' }, { status: 403 });
      stored = {
        key: buildAgentEventIdempotencyKey({
          teamId: FAKE_TEAM_ID, projectId: parsed.data.projectId, sourceAdapter: parsed.data.sourceType,
          contentSessionId: parsed.data.contentSessionId ?? null, eventType: parsed.data.eventType,
          platformSource: parsed.data.platformSource ?? null, occurredAt: parsed.data.occurredAtEpoch, payload: (parsed.data.payload ?? {}) as never,
        }),
        value: parsed.data,
      };
    } else if (pathname === '/api/sessions/observations') {
      if (typeof body.contentSessionId !== 'string' || typeof body.tool_name !== 'string') return Response.json({ error: 'ValidationError' }, { status: 400 });
      if (!scoped) return Response.json({ error: 'BadRequest', message: 'Legacy /api/sessions/observations requires a project-scoped API key' }, { status: 400 });
      stored = {
        key: buildAgentEventIdempotencyKey({
          teamId: FAKE_TEAM_ID, projectId: FAKE_PROJECT_ID, sourceAdapter: 'claude-code-compat',
          sourceEventId: (body.tool_use_id as string | undefined) ?? null, eventType: 'tool_use',
          platformSource: (body.platformSource as string | undefined) ?? null, occurredAt: Date.now(), payload: body as never,
        }),
        value: body,
      };
    } else if (pathname === '/api/sessions/summarize') {
      if (typeof body.contentSessionId !== 'string') return Response.json({ error: 'ValidationError' }, { status: 400 });
      if (!scoped) return Response.json({ error: 'BadRequest', message: 'Legacy /api/sessions/summarize requires a project-scoped API key' }, { status: 400 });
      if (body.agentId) return Response.json({ status: 'skipped', reason: 'subagent_context' });
      runtime.endedSessions.push(String(body.contentSessionId));
    } else {
      return Response.json({ error: 'NotFound' }, { status: 404 });
    }
    if (stored && !runtime.storedEvents.has(stored.key)) runtime.storedEvents.set(stored.key, stored.value);
    if (runtime.loseNextResponses > 0) {
      runtime.loseNextResponses--;
      return Response.json({ error: 'InternalError' }, { status: 500 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
  runtime.start = () => {
    server = Bun.serve({ hostname: '127.0.0.1', port: runtime.port || port, fetch: handle });
    runtime.port = server.port!;
    runtime.url = `http://127.0.0.1:${runtime.port}`;
  };
  runtime.stop = async () => {
    await server?.stop(true);
    server = null;
  };
  runtime.start();
  return runtime;
}

const ALICE_KEY_ID = 'a1'.repeat(16);
const alice: WireClientKeyIdentity = { name: 'alice', keyId: ALICE_KEY_ID, server: { url: '', apiKey: FAKE_SERVER_API_KEY, projectId: FAKE_PROJECT_ID } };

function aliceAt(serverUrl: string, overrides: Partial<WireClientKeyIdentity> = {}): WireClientKeyIdentity {
  return { ...alice, ...overrides, server: { ...alice.server, url: serverUrl, ...overrides.server } };
}

function outboxFor(directory: string, serverUrl: string, extra: Partial<ConstructorParameters<typeof WireServerOutbox>[0]> = {}): WireServerOutbox {
  return new WireServerOutbox({
    directory,
    lookupKey: name => (name === 'alice' ? { kind: 'found', identity: aliceAt(serverUrl) } : { kind: 'absent' }),
    retentionMs: 7 * DAY_MS,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 50,
    tickIntervalMs: 20,
    ...extra,
  });
}

function enqueueTurn(outbox: WireServerOutbox, serverUrlOrIdentity: string | WireClientKeyIdentity, sessionId = 's1'): void {
  const identity = typeof serverUrlOrIdentity === 'string' ? aliceAt(serverUrlOrIdentity) : serverUrlOrIdentity;
  outbox.enqueue(identity, 'session_init', { contentSessionId: sessionId, platformSource: 'codex', prompt: 'list the files', nativePromptId: 'turn-1' });
  outbox.enqueue(identity, 'observation', { contentSessionId: sessionId, platformSource: 'codex', toolName: 'shell', toolInput: { cmd: 'ls' }, toolResponse: 'a.ts', toolUseId: 'call_1' });
  outbox.enqueue(identity, 'summarize', { contentSessionId: sessionId, platformSource: 'codex', lastAssistantMessage: 'Two files.' });
  outbox.enqueue(identity, 'session_end', { contentSessionId: sessionId, platformSource: 'codex' });
}

/** A queue's delivered markers: the event ids in its delivered.log. */
function deliveredLines(directory: string, keyId = ALICE_KEY_ID, keyName = 'alice'): string[] {
  const path = join(directory, keyName, keyId, 'delivered.log');
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => line.slice(line.indexOf(' ') + 1)) : [];
}

/** A queue's files in one state (outbox/<name>/<record id>/<state>). */
function filesIn(directory: string, state: string, keyId = ALICE_KEY_ID, keyName = 'alice'): string[] {
  const path = join(directory, keyName, keyId, state);
  return existsSync(path) ? readdirSync(path) : [];
}

describe('outbox to the server runtime (faithful fake built from its route code)', () => {
  const directory = join(testRoot, 'outbox-fake');
  let fakeServer: FakeServerRuntime;
  const spies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    rmSync(directory, { recursive: true, force: true });
    fakeServer = startFakeServerRuntime();
    spies.push(spyOn(logger, 'warn').mockImplementation(() => {}), spyOn(logger, 'debug').mockImplementation(() => {}));
  });
  afterEach(async () => {
    await fakeServer.stop();
    spies.splice(0).forEach(spy => spy.mockRestore());
  });

  it('survives a server outage and a gateway restart, then delivers every event exactly once, in order', async () => {
    await fakeServer.stop(); // the outage: connection refused
    const first = outboxFor(directory, fakeServer.url);
    first.start();
    enqueueTurn(first, fakeServer.url);
    await first.drainNow();
    await sleep(100); // several retry ticks against a server that is down
    expect(first.pendingCount('alice')).toBe(4);
    expect(fakeServer.requestCount).toBe(0);
    await first.stop(); // the gateway restarts while the server is still down

    fakeServer.start(); // same port, back up
    const second = outboxFor(directory, fakeServer.url);
    second.start();
    for (let waited = 0; second.pendingCount('alice') > 0 && waited < 3_000; waited += 20) await sleep(20);
    await second.stop();

    expect(second.pendingCount('alice')).toBe(0);
    expect(deliveredLines(directory)).toHaveLength(4);
    expect(filesIn(directory, 'delivered')).toEqual([]);
    expect(fakeServer.storedEvents.size).toBe(3); // session_init, observation, summarize
    expect(fakeServer.endedSessions).toEqual(['s1']);
    const types = [...fakeServer.storedEvents.values()].map(event => (event as { eventType?: string; tool_name?: string }).eventType ?? (event as { tool_name: string }).tool_name);
    expect(types).toEqual(['session_init', 'shell', 'summarize']);

    // The same events emitted again (an assembler replay) are duplicates, never re-sent.
    const requestsBefore = fakeServer.requestCount;
    const third = outboxFor(directory, fakeServer.url);
    enqueueTurn(third, fakeServer.url);
    await third.drainNow();
    expect(fakeServer.requestCount).toBe(requestsBefore);
    expect(fakeServer.storedEvents.size).toBe(3);
  });

  it('a response lost on the way back is retried with the identical body, and the server keeps one event', async () => {
    fakeServer.loseNextResponses = 2;
    const outbox = outboxFor(directory, fakeServer.url);
    outbox.start();
    enqueueTurn(outbox, fakeServer.url);
    for (let waited = 0; outbox.pendingCount('alice') > 0 && waited < 3_000; waited += 20) await sleep(20);
    await outbox.stop();
    expect(fakeServer.requestCount).toBe(6); // 4 events, the first answered 500 twice
    expect(fakeServer.storedEvents.size).toBe(3);
    expect(deliveredLines(directory)).toHaveLength(4);
    expect(filesIn(directory, 'delivered')).toEqual([]);
  });

  it('two sessions with the same tool id (Gemini fallback ids, per-session numbering) are both stored: the id sent is session-scoped', async () => {
    const outbox = outboxFor(directory, fakeServer.url);
    const identity = aliceAt(fakeServer.url);
    for (const sessionId of ['session-one', 'session-two']) {
      outbox.enqueue(identity, 'observation', { contentSessionId: sessionId, platformSource: 'gemini-cli', toolName: 'read_file', toolInput: { path: 'a.ts' }, toolResponse: 'x', toolUseId: 'gemini-0123456789abcdef0123456789abcdef' });
    }
    await outbox.drainNow();
    expect(fakeServer.storedEvents.size).toBe(2);
    const ids = [...fakeServer.storedEvents.values()].map(event => (event as { tool_use_id: string }).tool_use_id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}-gemini-0123456789abcdef0123456789abcdef$/);
  });

  it('a wrong server API key (403) or an unscoped one (400 project-scoped) keeps events waiting; another 400 moves to rejected/, never deleted', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      for (const apiKey of ['cmem_wrongkey00000000000000000', FAKE_UNSCOPED_SERVER_API_KEY]) {
        const keyDirectory = join(directory, apiKey);
        const waiting = new WireServerOutbox({
          directory: keyDirectory,
          lookupKey: () => ({ kind: 'found', identity: aliceAt(fakeServer.url, { server: { apiKey } as never }) }),
          retentionMs: DAY_MS,
          retryBaseDelayMs: 10,
          retryMaxDelayMs: 50,
        });
        waiting.enqueue(aliceAt(fakeServer.url, { server: { apiKey } as never }), 'observation', { contentSessionId: 's1', platformSource: 'codex', toolName: 'shell', toolInput: {}, toolResponse: 'x', toolUseId: 'call_1' });
        await waiting.drainNow();
        expect(waiting.pendingCount('alice')).toBe(1);
        expect(filesIn(keyDirectory, 'rejected')).toEqual([]);
      }
      expect(error.mock.calls.some(call => String(call[1]).includes('not project-scoped'))).toBe(true);

      const wrongProject = new WireServerOutbox({
        directory: join(directory, 'second'),
        lookupKey: () => ({ kind: 'found', identity: aliceAt(fakeServer.url, { server: { projectId: '' } as never }) }),
        retentionMs: DAY_MS,
      });
      // An empty project id fails CreateAgentEventSchema (projectId min 1): 400, moved aside.
      wrongProject.enqueue(aliceAt(fakeServer.url, { server: { projectId: '' } as never }), 'session_init', { contentSessionId: 's1', platformSource: 'codex', prompt: 'x', nativePromptId: 'n1' });
      await wrongProject.drainNow();
      expect(wrongProject.pendingCount('alice')).toBe(0);
      expect(filesIn(join(directory, 'second'), 'rejected')).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  it('an event not accepted within the retry window moves to expired/ with an error log', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      let nowMs = 1_000;
      await fakeServer.stop();
      const outbox = outboxFor(directory, fakeServer.url, { now: () => nowMs, retryWindowMs: 60_000 });
      enqueueTurn(outbox, fakeServer.url);
      await outbox.drainNow();
      nowMs += 60_001;
      await outbox.drainNow();
      expect(outbox.pendingCount('alice')).toBe(0);
      expect(filesIn(directory, 'expired')).toHaveLength(4);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('sends the server API key as a bearer header over a plain socket for http:// (no proxy)', async () => {
    const seen: DirectHttpRequest[] = [];
    const outbox = outboxFor(directory, fakeServer.url, {
      send: (request: DirectHttpRequest): Promise<DirectHttpOutcome> => { seen.push(request); return requestDirectlyWithOutcome(request); },
    });
    enqueueTurn(outbox, fakeServer.url);
    await outbox.drainNow();
    expect(seen.map(request => request.headers)).toEqual(Array(4).fill({ authorization: `Bearer ${FAKE_SERVER_API_KEY}` }));
    expect(seen.every(request => request.timeoutMs === 10_000)).toBe(true);
    expect(fakeServer.storedEvents.size).toBe(3);
  });

  it('`keys add`\'s check passes for a scoped key and refuses an unscoped or wrong one, writing nothing on the server', async () => {
    await checkServerDestination({ url: fakeServer.url, apiKey: FAKE_SERVER_API_KEY, projectId: FAKE_PROJECT_ID });
    let message = '';
    try { await checkServerDestination({ url: fakeServer.url, apiKey: FAKE_UNSCOPED_SERVER_API_KEY, projectId: FAKE_PROJECT_ID }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('not project-scoped');
    message = '';
    try { await checkServerDestination({ url: fakeServer.url, apiKey: 'cmem_wrongkey00000000000000000', projectId: FAKE_PROJECT_ID }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('refused the server API key');
    expect(fakeServer.storedEvents.size).toBe(0);
    expect(fakeServer.endedSessions).toEqual([]);
  });
});

describe('outbox: each event is bound to the key record that queued it', () => {
  const directory = join(testRoot, 'outbox-binding');
  beforeEach(() => rmSync(directory, { recursive: true, force: true }));

  it('a name removed and added again for someone else never receives the first member\'s events; they move to rejected/, unsent', async () => {
    const sent: DirectHttpRequest[] = [];
    const oldAlice = aliceAt('https://old-alice.example.com');
    let lookup: WireClientKeyLookup = { kind: 'found', identity: oldAlice };
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    const warns = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const outbox = new WireServerOutbox({
        directory, lookupKey: () => lookup, retentionMs: DAY_MS, retryBaseDelayMs: 1, retryMaxDelayMs: 1,
        send: async (request): Promise<DirectHttpOutcome> => { sent.push(request); return { response: { statusCode: 503, bodyText: 'down' } }; },
      });
      outbox.enqueue(oldAlice, 'observation', { contentSessionId: 's1', platformSource: 'claude-code', toolName: 'Read', toolInput: { secret: 'old alice private' }, toolResponse: 'x', toolUseId: 'tu1' });
      await outbox.drainNow();
      expect(sent.map(request => request.url)).toEqual(['https://old-alice.example.com/api/sessions/observations']);
      // keys remove alice; keys add alice (a new person, another server): a new record id.
      lookup = { kind: 'found', identity: { name: 'alice', keyId: 'b2'.repeat(16), server: { url: 'https://new-alice.example.com', apiKey: 'cmem_newaliceserverkey0000', projectId: 'new' } } };
      const orphanedBefore = serverOutboxActivity.orphaned;
      await outbox.drainNow();
      expect(sent.every(request => !request.url.includes('new-alice'))).toBe(true);
      expect(outbox.pendingCount('alice')).toBe(0);
      expect(filesIn(directory, 'rejected')).toHaveLength(1);
      expect(serverOutboxActivity.orphaned).toBe(orphanedBefore + 1);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('a removed key\'s events are never sent; an unreadable keys.json only makes them wait', async () => {
    const sent: DirectHttpRequest[] = [];
    let lookup: WireClientKeyLookup = { kind: 'unreadable', reason: 'not JSON' };
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    const warns = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const outbox = new WireServerOutbox({
        directory, lookupKey: () => lookup, retentionMs: DAY_MS, retryBaseDelayMs: 1, retryMaxDelayMs: 1,
        send: async (request): Promise<DirectHttpOutcome> => { sent.push(request); return { response: { statusCode: 201, bodyText: '{}' } }; },
      });
      outbox.enqueue(aliceAt('https://a.example.com'), 'session_end', { contentSessionId: 's1', platformSource: 'codex' });
      await outbox.drainNow();
      expect(outbox.pendingCount('alice')).toBe(1);
      lookup = { kind: 'absent' };
      await outbox.drainNow();
      expect(sent).toEqual([]);
      expect(outbox.pendingCount('alice')).toBe(0);
      expect(filesIn(directory, 'rejected')).toHaveLength(1);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('an http:// server that resolves to a public address is never sent the server API key', async () => {
    const sent: DirectHttpRequest[] = [];
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const publicHttp = aliceAt('http://memory.example.com');
      const outbox = new WireServerOutbox({
        directory, lookupKey: () => ({ kind: 'found', identity: publicHttp }), retentionMs: DAY_MS,
        resolveHost: async () => ['93.184.216.34'],
        send: async (request): Promise<DirectHttpOutcome> => { sent.push(request); return { response: { statusCode: 201, bodyText: '{}' } }; },
      });
      outbox.enqueue(publicHttp, 'session_end', { contentSessionId: 's1', platformSource: 'codex' });
      await outbox.drainNow();
      expect(sent).toEqual([]);
      expect(outbox.pendingCount('alice')).toBe(1);
      expect(errors.mock.calls.some(call => String(call[1]).includes('not on this host or a private network'))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('outbox: delivery per key, streaming, limits and retention', () => {
  const directory = join(testRoot, 'outbox-limits');
  beforeEach(() => rmSync(directory, { recursive: true, force: true }));

  it('a hung server delays only its own key: another key is delivered meanwhile', async () => {
    const bob: WireClientKeyIdentity = { name: 'bob', keyId: 'c3'.repeat(16), server: { url: 'https://bob.example.com', apiKey: 'cmem_bob0000000000000000', projectId: 'pb' } };
    const hung = aliceAt('https://hung.example.com');
    let releaseHung: () => void = () => {};
    const hungUntil = new Promise<void>(resolve => { releaseHung = resolve; });
    const delivered: string[] = [];
    const outbox = new WireServerOutbox({
      directory, retentionMs: DAY_MS,
      lookupKey: name => ({ kind: 'found', identity: name === 'bob' ? bob : hung }),
      send: async (request): Promise<DirectHttpOutcome> => {
        if (request.url.startsWith('https://hung.example.com')) await hungUntil;
        delivered.push(request.url);
        return { response: { statusCode: 201, bodyText: '{}' } };
      },
    });
    outbox.enqueue(hung, 'session_end', { contentSessionId: 's1', platformSource: 'codex' });
    outbox.enqueue(bob, 'session_end', { contentSessionId: 's2', platformSource: 'codex' });
    for (let waited = 0; outbox.pendingCount('bob') > 0 && waited < 2_000; waited += 10) await sleep(10);
    expect(outbox.pendingCount('bob')).toBe(0);
    expect(delivered).toEqual(['https://bob.example.com/api/sessions/summarize']);
    expect(outbox.pendingCount('alice')).toBe(1);
    releaseHung();
    await outbox.drainNow();
    expect(outbox.pendingCount('alice')).toBe(0);
  });

  it('the retry pass reads one pending file at a time, in queue order', async () => {
    const identity = aliceAt('https://a.example.com');
    const pendingDirectory = join(directory, 'alice', ALICE_KEY_ID, 'pending');
    // Queue 20 events while no pass can run (a stopped outbox queues but does not drain), then a fresh outbox delivers them.
    const queueing = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }) });
    await queueing.stop();
    for (let index = 0; index < 20; index++) queueing.enqueue(identity, 'session_end', { contentSessionId: `s${String(index).padStart(2, '0')}`, platformSource: 'codex' });
    expect(readdirSync(pendingDirectory)).toHaveLength(20);
    // Calls through to the real readFileSync; only counts.
    const reads = spyOn(nodeFs, 'readFileSync');
    const pendingReads = () => reads.mock.calls.filter(call => String(call[0]).startsWith(pendingDirectory)).length;
    const readsAtEachSend: number[] = [];
    const sentSessions: string[] = [];
    try {
      const delivering = new WireServerOutbox({
        directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }),
        send: async (request): Promise<DirectHttpOutcome> => {
          readsAtEachSend.push(pendingReads());
          sentSessions.push((request.jsonBody as { contentSessionId: string }).contentSessionId);
          return { response: { statusCode: 201, bodyText: '{}' } };
        },
      });
      await delivering.drainNow();
    } finally {
      reads.mockRestore();
    }
    expect(sentSessions).toEqual(Array.from({ length: 20 }, (_, index) => `s${String(index).padStart(2, '0')}`));
    expect(readsAtEachSend).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('a key\'s pending/ is bounded: past the limit an event is refused loudly, never dropped silently', () => {
    const identity = aliceAt('https://a.example.com');
    const outbox = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }), maxBytesPerKey: 1_000 });
    void outbox.stop();
    const refusedBefore = serverOutboxActivity.refusedFull;
    let queued = 0;
    let refusal: unknown = null;
    for (let index = 0; index < 50 && !refusal; index++) {
      try {
        outbox.enqueue(identity, 'session_end', { contentSessionId: `s${index}`, platformSource: 'codex' });
        queued++;
      } catch (error) {
        refusal = error;
      }
    }
    expect(refusal).toBeInstanceOf(OutboxFullError);
    expect(queued).toBeGreaterThan(0);
    expect(serverOutboxActivity.refusedFull).toBe(refusedBefore + 1);
    // A fresh outbox over the same folder counts the bytes already there.
    const again = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }), maxBytesPerKey: 1_000 });
    void again.stop();
    expect(() => again.enqueue(identity, 'session_end', { contentSessionId: 'one-more', platformSource: 'codex' })).toThrow(OutboxFullError);
  });

  it('retention: rejected/ and expired/ are pruned, time-free markers are pruned, /v1/events markers are kept (a re-emit stays a duplicate)', async () => {
    let nowMs = Date.now();
    const identity = aliceAt('https://a.example.com');
    const sent: string[] = [];
    let answer = 201;
    const outbox = new WireServerOutbox({
      directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }), now: () => nowMs,
      send: async (request): Promise<DirectHttpOutcome> => { sent.push(new URL(request.url).pathname); return { response: { statusCode: answer, bodyText: '{}' } }; },
    });
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      enqueueTurn(outbox, identity);
      await outbox.drainNow();
      expect(deliveredLines(directory)).toHaveLength(4);
      answer = 422;
      outbox.enqueue(identity, 'observation', { contentSessionId: 's9', platformSource: 'codex', toolName: 'x', toolInput: {}, toolResponse: 'private tool output', toolUseId: 'refused' });
      await outbox.drainNow();
      expect(filesIn(directory, 'rejected')).toHaveLength(1);
      const usedBefore = outbox.usedBytes();
      // Everything is older than the retention.
      const old = (nowMs - 2 * DAY_MS) / 1000;
      for (const file of filesIn(directory, 'rejected')) utimesSync(join(directory, 'alice', ALICE_KEY_ID, 'rejected', file), old, old);
      nowMs += 2 * DAY_MS;
      outbox.prune();
      expect(filesIn(directory, 'rejected')).toEqual([]);
      expect(deliveredLines(directory).map(eventId => eventId.split('-')[0]).sort()).toEqual(['session_init', 'summarize']);
      expect(outbox.usedBytes()).toBeLessThan(usedBefore);
      // The assembler re-emits the turn days later: the prompt and the summary stay duplicates (their server key holds
      // the first occurredAt); the observation and the session end are sent again, which their time-free server keys absorb.
      nowMs += 3 * DAY_MS;
      answer = 201;
      sent.length = 0;
      enqueueTurn(outbox, identity);
      await outbox.drainNow();
      expect(sent.sort()).toEqual(['/api/sessions/observations', '/api/sessions/summarize']);
    } finally {
      errors.mockRestore();
    }
  });

  it('delivered markers are lines of one index per key (no inode per event), bounded: past the cap the oldest half goes, loudly', async () => {
    const identity = aliceAt('https://a.example.com');
    const warnings: string[] = [];
    const warn = spyOn(logger, 'warn').mockImplementation(((_component: string, message: string) => { warnings.push(message); }) as never);
    let nowMs = 1_000_000;
    try {
      const outbox = new WireServerOutbox({
        directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }), now: () => nowMs++,
        deliveredIndexMaxBytesPerKey: 4_000,
        send: async () => ({ response: { statusCode: 201, bodyText: '{}' } }),
      });
      const droppedBefore = serverOutboxActivity.deliveredMarkersDropped;
      for (let turn = 0; turn < 200; turn++) {
        outbox.enqueue(identity, 'session_init', { contentSessionId: 's1', platformSource: 'codex', prompt: `prompt ${turn}`, nativePromptId: `turn-${turn}` });
        await outbox.drainNow();
      }
      // One file holds every marker: the queue folder never grows an entry per event.
      expect(readdirSync(join(directory, 'alice', ALICE_KEY_ID)).sort()).toEqual(['delivered.log', 'pending']);
      expect(statSync(join(directory, 'alice', ALICE_KEY_ID, 'delivered.log')).size).toBeLessThanOrEqual(4_000);
      expect(serverOutboxActivity.deliveredMarkersDropped).toBeGreaterThan(droppedBefore);
      expect(warnings.some(message => message.includes('delivered index reached its limit'))).toBe(true);
      // The newest markers are kept: the last turn is still a duplicate.
      expect(outbox.enqueue(identity, 'session_init', { contentSessionId: 's1', platformSource: 'codex', prompt: 'prompt 199', nativePromptId: 'turn-199' })).toBe('duplicate');
      // A fresh outbox reads the index back.
      const again = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }), send: async () => ({ response: { statusCode: 201, bodyText: '{}' } }) });
      expect(again.enqueue(identity, 'session_init', { contentSessionId: 's1', platformSource: 'codex', prompt: 'prompt 199', nativePromptId: 'turn-199' })).toBe('duplicate');
      await again.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejected/ and expired/ count toward the key\'s byte cap: a server that refuses everything cannot fill the disk', async () => {
    const identity = aliceAt('https://a.example.com');
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const outbox = new WireServerOutbox({
        directory, retentionMs: 7 * DAY_MS, lookupKey: () => ({ kind: 'found', identity }), maxBytesPerKey: 200_000,
        send: async () => ({ response: { statusCode: 422, bodyText: '{"error":"ValidationError"}' } }),
      });
      const big = 'x'.repeat(30_000);
      let refusal: unknown = null;
      for (let index = 0; index < 20 && !refusal; index++) {
        try {
          outbox.enqueue(identity, 'observation', { contentSessionId: 's', platformSource: 'claude-code', toolName: 'Read', toolResponse: big, toolUseId: `t${index}` });
        } catch (error) {
          refusal = error;
        }
        await outbox.drainNow();
      }
      expect(refusal).toBeInstanceOf(OutboxFullError);
      expect(String((refusal as Error).message)).toContain('rejected or expired');
      const rejectedBytes = filesIn(directory, 'rejected').reduce((total, file) => total + statSync(join(directory, 'alice', ALICE_KEY_ID, 'rejected', file)).size, 0);
      expect(rejectedBytes).toBeLessThanOrEqual(200_000);
      // A fresh outbox over the same folder counts what rejected/ already holds.
      const again = new WireServerOutbox({ directory, retentionMs: 7 * DAY_MS, lookupKey: () => ({ kind: 'found', identity }), maxBytesPerKey: 200_000 });
      await again.stop();
      expect(() => again.enqueue(identity, 'observation', { contentSessionId: 's', platformSource: 'claude-code', toolName: 'Read', toolResponse: big, toolUseId: 'one-more' })).toThrow(OutboxFullError);
    } finally {
      errors.mockRestore();
    }
  });

  it('every key together is bounded too: many keys cannot fill the disk', () => {
    const keyOf = (index: number): WireClientKeyIdentity => ({ name: `member${index}`, keyId: String(index).padStart(32, '0'), server: { url: 'https://a.example.com', apiKey: 'cmem_x000000000000000000', projectId: 'p' } });
    const outbox = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'absent' }), maxBytesPerKey: 10_000, maxBytesTotal: 25_000 });
    void outbox.stop();
    let refusal: unknown = null;
    let index = 0;
    for (; index < 20 && !refusal; index++) {
      try {
        outbox.enqueue(keyOf(index), 'observation', { contentSessionId: 's', platformSource: 'codex', toolName: 'x', toolResponse: 'y'.repeat(8_000), toolUseId: 't' });
      } catch (error) {
        refusal = error;
      }
    }
    expect(refusal).toBeInstanceOf(OutboxFullError);
    expect(String((refusal as Error).message)).toContain('every client key together');
    expect(index).toBe(3);
    expect(outbox.usedBytes()).toBeLessThanOrEqual(25_000);
  });

  it('an event over the server\'s request limit is cut to fit (marked) and delivered, not refused 413 and lost', async () => {
    const fakeServer = startFakeServerRuntime();
    const spies = [spyOn(logger, 'warn').mockImplementation(() => {}), spyOn(logger, 'error').mockImplementation(() => {})];
    try {
      const identity = aliceAt(fakeServer.url);
      const outbox = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }) });
      const trimmedBefore = serverOutboxActivity.trimmedToFit;
      const hugeOutput = `${'é'.repeat(2 * 1024 * 1024)}tail-of-the-output`; // 4 MiB of UTF-8, 6 MiB with the input below
      outbox.enqueue(identity, 'observation', { contentSessionId: 's1', platformSource: 'claude-code', toolName: 'Read', toolInput: { content: 'i'.repeat(2 * 1024 * 1024) }, toolResponse: hugeOutput, toolUseId: 'big' });
      await outbox.drainNow();
      expect(filesIn(directory, 'rejected')).toEqual([]);
      expect(outbox.pendingCount('alice')).toBe(0);
      expect(serverOutboxActivity.trimmedToFit).toBe(trimmedBefore + 1);
      const stored = [...fakeServer.storedEvents.values()][0] as { tool_response: string; tool_input: { content: string } };
      expect(stored.tool_response).toMatch(/…\[truncated: \d+ bytes\]$/);
      expect(stored.tool_response.startsWith('éé')).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(5 * 1024 * 1024);
      // A small event goes as it came.
      outbox.enqueue(identity, 'observation', { contentSessionId: 's1', platformSource: 'claude-code', toolName: 'Read', toolResponse: 'small', toolUseId: 'small' });
      await outbox.drainNow();
      expect([...fakeServer.storedEvents.values()].some(event => (event as { tool_response: string }).tool_response === 'small')).toBe(true);
    } finally {
      spies.forEach(spy => spy.mockRestore());
      await fakeServer.stop();
    }
  });

  it('a key removed during a delivery pass has nothing more sent: the record is looked up before every event', async () => {
    const identity = aliceAt('https://a.example.com');
    let lookup: WireClientKeyLookup = { kind: 'found', identity };
    const sent: string[] = [];
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      // Queued while no pass can run (a stopped outbox queues but does not drain).
      const queueing = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => lookup });
      await queueing.stop();
      for (const sessionId of ['s1', 's2', 's3']) queueing.enqueue(identity, 'session_end', { contentSessionId: sessionId, platformSource: 'codex' });
      const delivering = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => lookup, send: async (request): Promise<DirectHttpOutcome> => {
        sent.push((request.jsonBody as { contentSessionId: string }).contentSessionId);
        lookup = { kind: 'absent' }; // `keys remove alice` while the first event is in flight
        return { response: { statusCode: 201, bodyText: '{}' } };
      } });
      await delivering.drainNow();
      expect(sent).toEqual(['s1']);
      expect(filesIn(directory, 'rejected')).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });

  it('an http:// server is connected to at the address its private-network check resolved (no second lookup)', async () => {
    const seen: DirectHttpRequest[] = [];
    const identity = aliceAt('http://memory.internal:3000');
    let resolutions = 0;
    const errors = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const queueing = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }) });
      await queueing.stop();
      queueing.enqueue(identity, 'session_end', { contentSessionId: 's1', platformSource: 'codex' });
      queueing.enqueue(identity, 'session_end', { contentSessionId: 's2', platformSource: 'codex' });
      const outbox = new WireServerOutbox({
        directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }),
        // A rebinding resolver: private when checked, public on any later lookup.
        resolveHost: async () => (resolutions++ === 0 ? ['10.0.0.7'] : ['93.184.216.34']),
        send: async (request): Promise<DirectHttpOutcome> => { seen.push(request); return { response: { statusCode: 201, bodyText: '{}' } }; },
      });
      await outbox.drainNow();
      // One check per pass, and every event of the pass goes to the address it checked.
      expect(seen.map(request => request.connectAddress)).toEqual(['10.0.0.7', '10.0.0.7']);
      expect(resolutions).toBe(1);
      // The next pass checks again; a public answer then sends nothing.
      outbox.enqueue(identity, 'session_end', { contentSessionId: 's3', platformSource: 'codex' });
      await outbox.drainNow();
      expect(seen).toHaveLength(2);
      expect(outbox.pendingCount('alice')).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('a session that ends, resumes and ends again sends one session end (the server keeps one end and one summary per session)', async () => {
    const identity = aliceAt('https://a.example.com');
    const outbox = new WireServerOutbox({ directory, retentionMs: DAY_MS, lookupKey: () => ({ kind: 'found', identity }), send: async () => ({ response: { statusCode: 201, bodyText: '{}' } }) });
    expect(outbox.enqueue(identity, 'session_end', { contentSessionId: 's1', platformSource: 'codex' })).toBe('queued');
    await outbox.drainNow();
    expect(outbox.enqueue(identity, 'session_end', { contentSessionId: 's1', platformSource: 'codex' })).toBe('duplicate');
  });
});

describe('direct http: connectAddress pins the connection', () => {
  it('connects to the given address and still names the URL\'s host (no DNS lookup of the name)', async () => {
    let seenHost = '';
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => { seenHost = request.headers.get('host') ?? ''; return Response.json({ ok: true }); } });
    try {
      // .invalid never resolves (RFC 6761): only the pinned address can be reached.
      const outcome = await requestDirectlyWithOutcome({ url: `http://memory.invalid:${server.port}/x`, connectAddress: '127.0.0.1', timeoutMs: 5_000 });
      expect('response' in outcome && outcome.response.statusCode).toBe(200);
      expect(seenHost).toBe(`memory.invalid:${server.port}`);
    } finally {
      await server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The real claude-mem server runtime (Postgres), in process: the same route
// classes ServerService mounts. Runs when CLAUDE_MEM_TEST_POSTGRES_URL is set,
// like tests/compat/sessions-observations-adapter.test.ts.

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('outbox to the real server runtime (Postgres)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  const directory = join(testRoot, 'outbox-real');
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let schemaName: string;
  let server: import('../../src/services/server/Server.js').Server;
  let serverUrl: string;
  let identity: WireClientKeyIdentity;
  let unscopedRawKey: string;
  const spies: Array<ReturnType<typeof spyOn>> = [];

  beforeAll(async () => {
    spies.push(...(['info', 'warn', 'error', 'debug'] as const).map(level => spyOn(logger, level).mockImplementation(() => {})));
    rmSync(directory, { recursive: true, force: true });
    const { Server } = await import('../../src/services/server/Server.js');
    const { ServerV1PostgresRoutes } = await import('../../src/server/routes/v1/ServerV1PostgresRoutes.js');
    const { SessionsObservationsAdapter } = await import('../../src/server/compat/SessionsObservationsAdapter.js');
    const { SessionsSummarizeAdapter } = await import('../../src/server/compat/SessionsSummarizeAdapter.js');
    const { bootstrapServerPostgresSchema, createPostgresStorageRepositories } = await import('../../src/storage/postgres/index.js');
    const { DisabledServerQueueManager } = await import('../../src/server/runtime/types.js');
    const { quoteIdentifier, newApiKey } = await import('../sdk/pg-isolation.js');

    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_p16_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client as never);
    pool.on('connect', poolClient => { poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {}); });
    const storage = createPostgresStorageRepositories(client as never);
    const team = await storage.teams.create({ name: 'team-p16' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p16-project' });
    const key = newApiKey();
    await storage.auth.createApiKey({ keyHash: key.hash, teamId: team.id, projectId: project.id, actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    const unscoped = newApiKey();
    await storage.auth.createApiKey({ keyHash: unscoped.hash, teamId: team.id, projectId: null, actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    unscopedRawKey = unscoped.raw;

    const queue = () => ({ async add() {}, async getJob() { return null; }, async remove() {} }) as never;
    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    const v1Routes = new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled in tests'), authMode: 'api-key',
      getEventQueue: queue, getSummaryQueue: queue,
    } as never);
    server.registerRoutes(v1Routes);
    server.registerRoutes(new SessionsObservationsAdapter({ pool: pool as never, ingestEvents: v1Routes.getIngestEventsService(), authMode: 'api-key' }));
    server.registerRoutes(new SessionsSummarizeAdapter({ pool: pool as never, endSession: v1Routes.getEndSessionService(), authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    serverUrl = `http://127.0.0.1:${address.port}`;
    identity = { name: 'alice', keyId: ALICE_KEY_ID, server: { url: serverUrl, apiKey: key.raw, projectId: project.id } };
  });

  afterAll(async () => {
    try { await server?.close(); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    const { quoteIdentifier } = await import('../sdk/pg-isolation.js');
    await client?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client?.release();
    await pool?.end();
    spies.forEach(spy => spy.mockRestore());
  });

  it('an outage, then lost responses: every event lands exactly once in agent_events', async () => {
    let serverDown = true;
    let responsesToLose = 2;
    const outbox = new WireServerOutbox({
      directory,
      lookupKey: () => ({ kind: 'found', identity }),
      retentionMs: 7 * DAY_MS,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 50,
      send: async (request): Promise<DirectHttpOutcome> => {
        if (serverDown) return { failure: { reason: 'unreachable', detail: 'connect ECONNREFUSED (simulated outage)' } };
        const outcome = await requestDirectlyWithOutcome(request);
        // The server stored it; the answer is lost on the way back.
        if (responsesToLose > 0 && 'response' in outcome && outcome.response.statusCode < 300) {
          responsesToLose--;
          return { failure: { reason: 'timeout', timeoutMs: request.timeoutMs } };
        }
        return outcome;
      },
    });
    enqueueTurn(outbox, identity);
    await outbox.drainNow();
    expect(outbox.pendingCount('alice')).toBe(4);
    serverDown = false;
    for (let attempt = 0; outbox.pendingCount('alice') > 0 && attempt < 200; attempt++) await outbox.drainNow();
    expect(outbox.pendingCount('alice')).toBe(0);
    expect(responsesToLose).toBe(0);

    const rows = await client.query<{ event_type: string; source_event_id: string | null }>('SELECT event_type, source_event_id FROM agent_events ORDER BY received_at');
    expect(rows.rows.map(row => row.event_type)).toEqual(['session_init', 'tool_use', 'summarize']);
    expect(rows.rows[1].source_event_id).toMatch(/^[0-9a-f]{64}-call_1$/);
    const sessions = await client.query<{ ended_at: Date | null }>('SELECT ended_at FROM server_sessions');
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0].ended_at).not.toBeNull();

    // An assembler replay is a duplicate in the outbox; a direct re-send of the same body is a duplicate on the server.
    enqueueTurn(outbox, identity);
    await outbox.drainNow();
    const again = await client.query('SELECT count(*)::int AS count FROM agent_events');
    expect(again.rows[0].count).toBe(3);
  });

  it('the same tool id in two sessions is stored twice (the server dedupes by tool id without the session)', async () => {
    const outbox = new WireServerOutbox({ directory: join(directory, 'two-sessions'), lookupKey: () => ({ kind: 'found', identity }), retentionMs: 7 * DAY_MS });
    for (const sessionId of ['gemini-session-1', 'gemini-session-2']) {
      outbox.enqueue(identity, 'observation', { contentSessionId: sessionId, platformSource: 'gemini-cli', toolName: 'read_file', toolInput: { path: 'a.ts' }, toolResponse: 'x', toolUseId: 'gemini-fedcba9876543210fedcba9876543210' });
    }
    await outbox.drainNow();
    expect(outbox.pendingCount('alice')).toBe(0);
    const rows = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM agent_events WHERE source_event_id LIKE '%-gemini-fedcba9876543210fedcba9876543210'`);
    expect(rows.rows[0].count).toBe(2);
  });

  it('a tool output past the runtime\'s 5 MiB body limit is cut to fit and stored, not answered 413 and lost', async () => {
    const outbox = new WireServerOutbox({ directory: join(directory, 'large-output'), lookupKey: () => ({ kind: 'found', identity }), retentionMs: 7 * DAY_MS });
    outbox.enqueue(identity, 'observation', { contentSessionId: 'large-output-session', platformSource: 'claude-code', toolName: 'Read', toolInput: { path: 'big.log' }, toolResponse: `${'L'.repeat(6 * 1024 * 1024)}end`, toolUseId: 'large_1' });
    await outbox.drainNow();
    expect(outbox.pendingCount('alice')).toBe(0);
    expect(existsSync(join(directory, 'large-output', 'alice', ALICE_KEY_ID, 'rejected'))).toBe(false);
    const rows = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM agent_events WHERE source_event_id LIKE '%-large_1'`);
    expect(rows.rows[0].count).toBe(1);
  });

  it('`keys add`\'s check: the scoped key passes, the unscoped key is refused, and nothing is written', async () => {
    const before = await client.query<{ count: number }>('SELECT (SELECT count(*) FROM agent_events)::int + (SELECT count(*) FROM server_sessions)::int AS count');
    await checkServerDestination(identity.server);
    let message = '';
    try { await checkServerDestination({ ...identity.server, apiKey: unscopedRawKey }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('not project-scoped');
    const after = await client.query<{ count: number }>('SELECT (SELECT count(*) FROM agent_events)::int + (SELECT count(*) FROM server_sessions)::int AS count');
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
