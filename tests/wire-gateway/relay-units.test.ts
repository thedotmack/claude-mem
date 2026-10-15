import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'node:zlib';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import {
  StreamEndMarkerDetector,
  classifyRelaySuffix,
  type WireProtocol,
} from '../../src/services/wire-gateway/relay/protocols.js';
import { decodeRequestBodyCopy } from '../../src/services/wire-gateway/relay/request-body.js';
import { BoundedCaptureQueue } from '../../src/services/wire-gateway/relay/capture-queue.js';
import { upstreamRequestHeaders } from '../../src/services/wire-gateway/relay/relay.js';
import {
  WireGatewayRoutesStore,
  addWireGatewayRoute,
  readWireGatewayRoutesFile,
  removeWireGatewayRoute,
} from '../../src/services/wire-gateway/routes.js';
import { parseWorkerServiceCommand } from '../../src/services/worker-service.js';

const encoder = new TextEncoder();

describe('classifyRelaySuffix', () => {
  const table: Array<[string, WireProtocol | null, boolean]> = [
    ['/v1/messages', 'anthropic', true],
    ['/v1/messages/count_tokens', 'anthropic', false],
    ['/v1/chat/completions', 'openai-chat', true],
    ['/chat/completions', 'openai-chat', true],
    ['/v1/responses', 'openai-responses', true],
    ['/responses/compact', 'openai-responses', false],
    ['/v1beta/models/gemini-2.5-pro:generateContent', 'gemini', true],
    ['/v1/models/gemini-x:streamGenerateContent', 'gemini', true],
    ['/v1/models', null, false],
    ['/api/hello', null, false],
    ['', null, false],
  ];
  for (const [suffix, protocol, captured] of table) {
    it(`${suffix || '(empty)'} → ${protocol ?? 'transparent'}${captured ? ', captured' : ''}`, () => {
      expect(classifyRelaySuffix(suffix)).toEqual({ protocol, captured });
    });
  }
});

describe('StreamEndMarkerDetector', () => {
  function seesEnd(protocol: WireProtocol, chunks: string[]): boolean {
    const detector = new StreamEndMarkerDetector(protocol);
    for (const chunk of chunks) detector.observe(encoder.encode(chunk));
    return detector.hasSeenEnd;
  }

  it('Anthropic: message_stop and error, spaced or not, split across chunks', () => {
    expect(seesEnd('anthropic', ['event: message_delta\ndata: {}\n\nevent: mess', 'age_stop\ndata: {"type":"message_stop"}\n\n'])).toBe(true);
    expect(seesEnd('anthropic', ['event:message_stop\ndata:{"type": "message_stop"}\n\n'])).toBe(true);
    expect(seesEnd('anthropic', ['event: error\ndata: {"type":"error","error":{}}\n\n'])).toBe(true);
    expect(seesEnd('anthropic', ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: ping\n\n'])).toBe(false);
    // Text that says message_stop is escaped JSON, never a marker.
    expect(seesEnd('anthropic', ['data: {"delta":{"text":"say \\"type\\":\\"message_stop\\""}}\n\n'])).toBe(false);
  });

  it('Chat: [DONE] with or without the space, CRLF too', () => {
    expect(seesEnd('openai-chat', ['data: {}\n\ndata: [DO', 'NE]\n\n'])).toBe(true);
    expect(seesEnd('openai-chat', ['data: {}\r\n\r\ndata:[DONE]\r\n\r\n'])).toBe(true);
    expect(seesEnd('openai-chat', ['data: {"finish_reason":"stop"}\n\n'])).toBe(false);
  });

  it('Responses: completed, incomplete, failed, error', () => {
    for (const type of ['response.completed', 'response.incomplete', 'response.failed', 'error']) {
      expect(seesEnd('openai-responses', [`event: ${type}\ndata: {"type":"${type}"}\n\n`])).toBe(true);
    }
    expect(seesEnd('openai-responses', ['event: response.output_text.delta\ndata: {"type":"response.output_text.delta"}\n\n'])).toBe(false);
  });

  it('Gemini: a candidate finishReason', () => {
    expect(seesEnd('gemini', ['data: {"candidates":[{"content":{}}]}\n\n', 'data: {"candidates":[{"finishRea', 'son":"STOP"}]}\n\n'])).toBe(true);
    expect(seesEnd('gemini', ['data: {"candidates":[{"content":{}}],"usageMetadata":{}}\n\n'])).toBe(false);
  });

  it('a marker on the first line of the stream is seen', () => {
    expect(seesEnd('openai-chat', ['data: [DONE]\n\n'])).toBe(true);
  });
});

describe('decodeRequestBodyCopy', () => {
  const json = encoder.encode('{"a":1}');

  it('gzip decodes every member (node:zlib), not just the first', () => {
    const twoMembers = Buffer.concat([gzipSync('{"a":'), gzipSync('1}')]);
    const decoded = decodeRequestBodyCopy(new Uint8Array(twoMembers), 'gzip', 1024);
    expect(decoded.kind).toBe('decoded');
    expect(new TextDecoder().decode((decoded as { bytes: Uint8Array }).bytes)).toBe('{"a":1}');
  });

  it('zstd decodes every frame (Bun.zstdDecompressSync)', () => {
    const twoFrames = Buffer.concat([Bun.zstdCompressSync(encoder.encode('{"a":')), Bun.zstdCompressSync(encoder.encode('1}'))]);
    const decoded = decodeRequestBodyCopy(new Uint8Array(twoFrames), 'zstd', 1024);
    expect(new TextDecoder().decode((decoded as { bytes: Uint8Array }).bytes)).toBe('{"a":1}');
  });

  it('identity is a copy of the same bytes; unknown, broken and oversized copies are skipped', () => {
    const identityCopy = decodeRequestBodyCopy(json, null, 1024);
    expect(identityCopy).toMatchObject({ kind: 'decoded', bytes: json });
    expect((identityCopy as { bytes: Uint8Array }).bytes).not.toBe(json);
    expect(decodeRequestBodyCopy(json, 'deflate', 1024)).toMatchObject({ kind: 'skipped', reason: 'unknown_content_encoding' });
    expect(decodeRequestBodyCopy(json, 'gzip', 1024)).toMatchObject({ kind: 'skipped', reason: 'decode_failed' });
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(10_000)));
    expect(decodeRequestBodyCopy(bomb, 'gzip', 1_000)).toMatchObject({ kind: 'skipped', reason: 'decoded_too_large' });
    const zstdBomb = Bun.zstdCompressSync(new Uint8Array(10_000));
    expect(decodeRequestBodyCopy(zstdBomb, 'zstd', 1_000)).toMatchObject({ kind: 'skipped', reason: 'decoded_too_large' });
  });
});

describe('upstreamRequestHeaders', () => {
  it('drops hop-by-hop, content-length, host, accept-encoding and x-claude-mem-*; keeps the rest verbatim', () => {
    const forwarded = upstreamRequestHeaders(new Headers({
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      'content-length': '7',
      host: '127.0.0.1:37677',
      'accept-encoding': 'gzip',
      'x-claude-mem-route': 'x',
      authorization: 'Bearer sk-x',
      'anthropic-beta': 'a, b',
      'content-encoding': 'zstd',
      'x-claude-code-session-id': 's1',
    }));
    expect([...forwarded.keys()].sort()).toEqual(['anthropic-beta', 'authorization', 'content-encoding', 'x-claude-code-session-id']);
    expect(forwarded.get('anthropic-beta')).toBe('a, b');
  });
});

describe('BoundedCaptureQueue', () => {
  it('delivers copies off the caller path, then the finish callback', async () => {
    const delivered: string[] = [];
    const queue = new BoundedCaptureQueue(1024, chunk => delivered.push(new TextDecoder().decode(chunk)));
    const original = encoder.encode('abc');
    queue.offer(original);
    original[0] = 0x7a; // the client's buffer changing later does not change the copy
    queue.offer(encoder.encode('def'));
    const finished = new Promise<void>(resolve => queue.afterDelivered(resolve));
    expect(delivered).toEqual([]); // nothing synchronous
    await finished;
    expect(delivered).toEqual(['abc', 'def']);
  });

  it('past the cap it stops taking chunks and reports overflow, never throwing', async () => {
    const delivered: Uint8Array[] = [];
    const queue = new BoundedCaptureQueue(5, chunk => delivered.push(chunk));
    queue.offer(encoder.encode('abc'));
    queue.offer(encoder.encode('defg'));
    queue.offer(encoder.encode('h'));
    expect(queue.hasOverflowed).toBe(true);
    await new Promise<void>(resolve => queue.afterDelivered(resolve));
    expect(delivered.length).toBe(1);
  });

  it('an observer that throws never breaks delivery', async () => {
    const delivered: number[] = [];
    const queue = new BoundedCaptureQueue(1024, chunk => {
      if (chunk[0] === 0x31) throw new Error('observer bug');
      delivered.push(chunk[0]);
    });
    queue.offer(encoder.encode('1'));
    queue.offer(encoder.encode('2'));
    await new Promise<void>(resolve => queue.afterDelivered(resolve));
    expect(delivered).toEqual([0x32]);
  });
});

describe('routes.json', () => {
  const routesFile = join(WIRE_GATEWAY_DIR, 'routes-unit-test.json');
  afterAll(() => rmSync(routesFile, { force: true }));

  it('add, list and remove; written 0600 with the documented shape', () => {
    rmSync(routesFile, { force: true });
    const route = addWireGatewayRoute({ routeId: 'codex.main', agentId: 'codex', upstreamBaseUrl: 'https://api.openai.com/v1/' }, routesFile);
    expect(route.upstreamBaseUrl).toBe('https://api.openai.com/v1');
    const onDisk = JSON.parse(readFileSync(routesFile, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.routes['codex.main']).toMatchObject({ agentId: 'codex', upstreamBaseUrl: 'https://api.openai.com/v1', captureSource: 'wire', features: {} });
    expect(typeof onDisk.routes['codex.main'].createdAt).toBe('string');
    if (process.platform !== 'win32') expect(statSync(routesFile).mode & 0o777).toBe(0o600);
    expect(Object.keys(readWireGatewayRoutesFile(routesFile).routes)).toEqual(['codex.main']);
    expect(removeWireGatewayRoute('codex.main', routesFile)).toBe(true);
    expect(removeWireGatewayRoute('codex.main', routesFile)).toBe(false);
  });

  it('refuses bad ids and upstreams', () => {
    expect(() => addWireGatewayRoute({ routeId: 'Bad', agentId: 'a', upstreamBaseUrl: 'https://x' }, routesFile)).toThrow('must match');
    expect(() => addWireGatewayRoute({ routeId: '-x', agentId: 'a', upstreamBaseUrl: 'https://x' }, routesFile)).toThrow('must match');
    expect(() => addWireGatewayRoute({ routeId: 'a'.repeat(65), agentId: 'a', upstreamBaseUrl: 'https://x' }, routesFile)).toThrow('must match');
    expect(() => addWireGatewayRoute({ routeId: 'ok', agentId: 'a', upstreamBaseUrl: 'ftp://x' }, routesFile)).toThrow('http');
    expect(() => addWireGatewayRoute({ routeId: 'ok', agentId: 'a', upstreamBaseUrl: 'https://x/v1?key=1' }, routesFile)).toThrow('query');
  });

  it('the store reloads when the file changes, and keeps the last good routes when it breaks', () => {
    rmSync(routesFile, { force: true });
    addWireGatewayRoute({ routeId: 'one', agentId: 'a', upstreamBaseUrl: 'https://one.example' }, routesFile);
    const store = new WireGatewayRoutesStore({ routesFilePath: routesFile, reloadCheckIntervalMs: 0 });
    expect(store.lookup('one').kind).toBe('found');
    expect(store.lookup('two').kind).toBe('not_found');

    addWireGatewayRoute({ routeId: 'two', agentId: 'b', upstreamBaseUrl: 'https://two.example' }, routesFile);
    expect(store.lookup('two').kind).toBe('found');

    writeFileSync(routesFile, '{ not json');
    const later = new Date(Date.now() + 5_000);
    utimesSync(routesFile, later, later);
    expect(store.lookup('two').kind).toBe('found');

    const freshStore = new WireGatewayRoutesStore({ routesFilePath: routesFile, reloadCheckIntervalMs: 0 });
    expect(freshStore.lookup('two').kind).toBe('unreadable');
  });

  it('the store looks at the file at most once per interval', () => {
    rmSync(routesFile, { force: true });
    const store = new WireGatewayRoutesStore({ routesFilePath: routesFile, reloadCheckIntervalMs: 60_000 });
    expect(store.lookup('late').kind).toBe('not_found');
    addWireGatewayRoute({ routeId: 'late', agentId: 'a', upstreamBaseUrl: 'https://late.example' }, routesFile);
    expect(store.lookup('late').kind).toBe('not_found');
  });
});

describe('worker script maps `wire routes …`', () => {
  it('passes the action and flags through', () => {
    expect(parseWorkerServiceCommand(['wire', 'routes', 'add', 'codex', '--agent', 'codex', '--upstream', 'https://api.openai.com/v1'])).toEqual({
      command: 'wire-routes',
      args: ['add', 'codex', '--agent', 'codex', '--upstream', 'https://api.openai.com/v1'],
    });
  });
});
