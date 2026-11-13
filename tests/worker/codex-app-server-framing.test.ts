import { describe, expect, it } from 'bun:test';
import { CodexAppServerClient } from '../../src/services/worker/CodexAppServerClient.js';

const MAX_LINE_BYTES = 8 * 1024 * 1024;

// Inject deterministic stdout chunk boundaries at the client's stream adapter.
// Process startup, RPC lifecycle and turn handling remain covered by the
// companion codex-app-server-client suite's real fake-child process.
interface FramingDriver {
  child: object | null;
  onStdout(child: object, chunk: string): void;
  handleMessage(message: unknown): void;
  invalidate(error: Error): Promise<void>;
}

function createDriver() {
  const client = new CodexAppServerClient() as unknown as FramingDriver;
  const child = {};
  const messages: unknown[] = [];
  const errors: Error[] = [];
  client.child = child;
  client.handleMessage = message => { messages.push(message); };
  client.invalidate = error => {
    errors.push(error);
    client.child = null;
    return Promise.resolve();
  };
  return { client, child, messages, errors, send: (chunk: string) => client.onStdout(child, chunk) };
}

function lineOfBytes(bytes: number): string {
  const prefix = '{"method":"test","params":"';
  const suffix = '"}';
  return prefix + 'x'.repeat(bytes - prefix.length - suffix.length) + suffix;
}

describe('Codex app-server stdout line framing', () => {
  it('accepts multiple individually bounded lines in a larger stdout chunk', () => {
    const driver = createDriver();
    const line = lineOfBytes(MAX_LINE_BYTES / 2 + 128);
    driver.send(`${line}\n${line}\n`);
    expect(driver.errors).toEqual([]);
    expect(driver.messages).toEqual([JSON.parse(line), JSON.parse(line)]);
  });

  it('limits a pending line independently of following complete messages', () => {
    const driver = createDriver();
    const line = lineOfBytes(MAX_LINE_BYTES - 16);
    driver.send(line.slice(0, -10));
    expect(driver.messages).toEqual([]);
    driver.send(`${line.slice(-10)}\n{"id":2,"result":"next message"}\n`);
    expect(driver.errors).toEqual([]);
    expect(driver.messages).toEqual([JSON.parse(line), { id: 2, result: 'next message' }]);
  });

  it('accepts exactly the line limit followed by its newline delimiter', () => {
    const driver = createDriver();
    const line = lineOfBytes(MAX_LINE_BYTES);
    driver.send(line);
    driver.send('\n');
    expect(driver.errors).toEqual([]);
    expect(driver.messages).toEqual([JSON.parse(line)]);
  });

  it('rejects an oversized completed line before dispatching it', () => {
    const driver = createDriver();
    driver.send(`${lineOfBytes(MAX_LINE_BYTES + 1)}\n`);
    expect(driver.messages).toEqual([]);
    expect(driver.errors).toHaveLength(1);
    expect(driver.errors[0].message).toContain('line exceeded safety limit');
  });

  it('rejects a growing unterminated line as soon as its bytes exceed the limit', () => {
    const driver = createDriver();
    driver.send('x'.repeat(MAX_LINE_BYTES));
    expect(driver.errors).toEqual([]);
    driver.send('x');
    expect(driver.messages).toEqual([]);
    expect(driver.errors).toHaveLength(1);
  });

  it('counts UTF-8 bytes rather than JavaScript characters for each line', () => {
    const driver = createDriver();
    const part = '中'.repeat(Math.floor(MAX_LINE_BYTES / 3));
    driver.send(part);
    expect(driver.errors).toEqual([]);
    driver.send('中');
    expect(driver.errors).toHaveLength(1);
    expect(driver.messages).toEqual([]);
  });

  it('preserves UTF-8, whitespace and ordering across fragmented LF/CRLF input', () => {
    const driver = createDriver();
    for (const chunk of ['\n \r\n{"id":1,"result":"', '中文😀', '"}\r', '\n{"id":2', ',"result":null}\n']) {
      driver.send(chunk);
    }
    expect(driver.errors).toEqual([]);
    expect(driver.messages).toEqual([{ id: 1, result: '中文😀' }, { id: 2, result: null }]);
  });

  it('stops dispatch after malformed JSON and ignores further output from that child', () => {
    const driver = createDriver();
    driver.send('{not json}\n{"id":2,"result":true}\n');
    driver.send('{"id":3,"result":true}\n');
    expect(driver.messages).toEqual([]);
    expect(driver.errors).toHaveLength(1);
    expect(driver.errors[0].message).toContain('malformed JSON');
  });

  it('ignores stale-child output without contaminating a live partial line', () => {
    const driver = createDriver();
    driver.send('{"id":1,');
    driver.client.onStdout({}, 'invalid\n');
    driver.send('"result":"current"}\n');
    expect(driver.errors).toEqual([]);
    expect(driver.messages).toEqual([{ id: 1, result: 'current' }]);
  });
});
