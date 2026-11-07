import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  allowedHosts,
  cwdFromRoots,
  headerCwd,
  normalizeCwd,
  parseHttpArgs,
} from '../../src/servers/mcp-http.js';

const temp = mkdtempSync(join(tmpdir(), 'cm-'));
const firstDir = join(temp, 'first project');
const secondDir = join(temp, 'second');
const file = join(temp, 'file.txt');
const missing = join(temp, 'nonexistent');
mkdirSync(firstDir);
mkdirSync(secondDir);
writeFileSync(file, 'not a directory');

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('parseHttpArgs', () => {
  it('returns null unless HTTP mode is explicitly requested', () => {
    expect(parseHttpArgs([], {})).toBeNull();
    expect(parseHttpArgs(['--port=1234'], {})).toBeNull();
    for (const value of ['0', 'true', '']) {
      expect(parseHttpArgs([], { CLAUDE_MEM_MCP_HTTP: value })).toBeNull();
    }
  });

  it('uses defaults with the flag or environment switch', () => {
    const defaults = { host: '127.0.0.1', port: 37790 };
    expect(parseHttpArgs(['--http'], {})).toEqual(defaults);
    expect(parseHttpArgs([], { CLAUDE_MEM_MCP_HTTP: '1' })).toEqual(defaults);
  });

  it('accepts both port flag forms', () => {
    for (const args of [['--port=1234'], ['--port', '1234']]) {
      expect(parseHttpArgs(['--http', ...args], {})).toEqual({ host: '127.0.0.1', port: 1234 });
    }
  });

  it('reads environment host/port and lets CLI flags override them', () => {
    const env = { CLAUDE_MEM_MCP_HTTP_HOST: 'localhost', CLAUDE_MEM_MCP_HTTP_PORT: '4321' };
    expect(parseHttpArgs(['--http'], env)).toEqual({ host: 'localhost', port: 4321 });
    for (const hostArgs of [['--host=127.0.0.1'], ['--host', '127.0.0.1']]) {
      expect(parseHttpArgs(['--http', ...hostArgs, '--port=1234'], env)).toEqual({ host: '127.0.0.1', port: 1234 });
    }
  });

  it('rejects invalid ports from flags or environment', () => {
    for (const port of ['abc', '-1', '65536', '1.5', 'NaN', 'Infinity']) {
      expect(() => parseHttpArgs(['--http', `--port=${port}`], {})).toThrow('Invalid MCP HTTP port');
      expect(() => parseHttpArgs(['--http'], { CLAUDE_MEM_MCP_HTTP_PORT: port }))
        .toThrow('Invalid MCP HTTP port');
    }
    for (const port of [0, 65535]) {
      expect(parseHttpArgs(['--http', `--port=${port}`], {})?.port).toBe(port);
    }
  });

  it('binds to loopback only and refuses every other host, token or not', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'laptop.lan', '127.0.0.2', 'localhost.evil.example']) {
      expect(() => parseHttpArgs(['--http', `--host=${host}`], {})).toThrow('loopback only');
      expect(() => parseHttpArgs(['--http'], { CLAUDE_MEM_MCP_HTTP_HOST: host, CLAUDE_MEM_MCP_HTTP_TOKEN: 'secret' }))
        .toThrow('loopback only');
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(parseHttpArgs(['--http', `--host=${host}`], {})?.host).toBe(host);
    }
    expect(parseHttpArgs(['--http', '--host=[::1]'], {})?.host).toBe('::1');
  });

  it('has no token or LAN options', () => {
    const parsed = parseHttpArgs(['--http', '--token=x', '--allowed-host=laptop.lan'], {
      CLAUDE_MEM_MCP_HTTP_TOKEN: 'secret',
      CLAUDE_MEM_MCP_HTTP_ALLOWED_HOSTS: 'laptop.lan',
    });
    expect(parsed).toEqual({ host: '127.0.0.1', port: 37790 });
  });
});

describe('normalizeCwd', () => {
  it('rejects absent, empty, relative, nonexistent, file, and NUL values', () => {
    for (const value of [undefined, null, '', '   ', 'relative', missing, file, `${firstDir}\0`]) {
      expect(normalizeCwd(value)).toBeNull();
    }
    expect(normalizeCwd('file://%')).toBeNull();
  });

  it('resolves an existing absolute directory and its file URI', () => {
    expect(normalizeCwd(firstDir)).toBe(resolve(firstDir));
    expect(normalizeCwd(join(firstDir, '..', 'first project'))).toBe(resolve(firstDir));
    expect(normalizeCwd(pathToFileURL(firstDir).href)).toBe(resolve(firstDir));
  });
});

describe('cwdFromRoots', () => {
  it('returns null for absent or entirely unusable roots', () => {
    expect(cwdFromRoots(undefined)).toBeNull();
    expect(cwdFromRoots([])).toBeNull();
    expect(cwdFromRoots([{ uri: missing }, { uri: pathToFileURL(file).href }])).toBeNull();
  });

  it('skips unusable roots and returns the first usable directory', () => {
    const roots = ['', 'relative', missing, pathToFileURL(file).href,
      pathToFileURL(firstDir).href, pathToFileURL(secondDir).href];
    expect(cwdFromRoots(roots.map((uri) => ({ uri })))).toBe(resolve(firstDir));
  });
});

describe('allowedHosts', () => {
  it('is the loopback names, with and without the port, and nothing else', () => {
    const hosts = allowedHosts(1234);
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(hosts).toContain(host);
      expect(hosts).toContain(`${host}:1234`);
    }
    expect(hosts).toHaveLength(6);
  });
});

describe('headerCwd', () => {
  it('reads the header case-insensitively and validates the directory', () => {
    expect(headerCwd({ 'x-claude-mem-cwd': firstDir })).toBe(resolve(firstDir));
    expect(headerCwd({ 'X-Claude-Mem-Cwd': [secondDir, firstDir] })).toBe(resolve(secondDir));
    expect(headerCwd({ 'x-claude-mem-cwd': missing })).toBeNull();
    expect(headerCwd({ 'x-claude-mem-cwd': 'relative' })).toBeNull();
    expect(headerCwd({ other: firstDir })).toBeNull();
    expect(headerCwd(undefined)).toBeNull();
  });
});
