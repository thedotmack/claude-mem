import { describe, expect, it } from 'bun:test';
import { diffConfigLines, formatConfigDiffLine, maskSecretLine } from '../../src/services/wire-gateway/wiring/config-diff.js';

const ONE_MEGABYTE = 1024 * 1024;

describe('wire preview masks secrets nested inside one line', () => {
  it('a compact JSON object masks its secret-named members, not only the line\'s first key', () => {
    expect(maskSecretLine('{"baseUrl":"https://api.example.com","apiKey":"sk-secret-1"}')).toBe('{"baseUrl":"https://api.example.com","apiKey":••••}');
    expect(maskSecretLine('  "provider": {"baseURL": "http://127.0.0.1:1/r/x", "api_key": "sk-secret-2"},')).toBe('  "provider": {"baseURL": "http://127.0.0.1:1/r/x", "api_key": ••••},');
  });

  it('TOML inline tables and YAML flow maps too; references, counts and non-secret keys stay', () => {
    expect(maskSecretLine('mine = { base_url = "https://x.example", api_key = "sk-secret-3" }')).toBe('mine = { base_url = "https://x.example", api_key = •••• }');
    expect(maskSecretLine('provider: {baseUrl: https://x.example, token: sk-secret-4}')).toBe('provider: {baseUrl: https://x.example, token: ••••}');
    expect(maskSecretLine('{"apiKey":"$OPENAI_API_KEY","max_tokens":5}')).toBe('{"apiKey":"$OPENAI_API_KEY","max_tokens":5}');
    expect(maskSecretLine('{"MAX_TOKENS": 4096, "auth": {"password": "hunter2"}}')).toBe('{"MAX_TOKENS": 4096, "auth": {"password": ••••}}');
  });

  it('the diff wire preview prints never shows a nested secret', () => {
    const before = '{"baseUrl":"https://api.example.com","apiKey":"sk-secret-5"}\n';
    const after = '{"baseUrl":"http://127.0.0.1:1/r/x","apiKey":"sk-secret-5"}\n';
    const printed = diffConfigLines(before, after).map(formatConfigDiffLine).join('\n');
    expect(printed).not.toContain('sk-secret-5');
    expect(printed).toContain('http://127.0.0.1:1/r/x');
  });

  it('stays linear on 1 MB hostile lines', () => {
    for (const hostile of [
      `{${'"a":'.repeat(ONE_MEGABYTE / 4)}`,
      `{"apiKey":${' '.repeat(ONE_MEGABYTE)}`,
      `{"apiKey":"${'x'.repeat(ONE_MEGABYTE)}`,
      `x = { ${'api_key = 1, '.repeat(ONE_MEGABYTE / 13)}`,
      '"'.repeat(ONE_MEGABYTE),
      'a'.repeat(ONE_MEGABYTE),
    ]) {
      const started = performance.now();
      maskSecretLine(hostile);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
