import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  allowedHosts,
  cwdFromRoots,
  isAuthorized,
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
    const defaults = { host: '127.0.0.1', port: 37790, token: undefined };
    expect(parseHttpArgs(['--http'], {})).toEqual(defaults);
    expect(parseHttpArgs([], { CLAUDE_MEM_MCP_HTTP: '1' })).toEqual(defaults);
  });

  it('accepts both port flag forms', () => {
    for (const args of [['--port=1234'], ['--port', '1234']]) {
      expect(parseHttpArgs(['--http', ...args], {})).toEqual({
        host: '127.0.0.1', port: 1234, token: undefined,
      });
    }
  });

  it('reads environment host/port and lets CLI flags override them', () => {
    const env = { CLAUDE_MEM_MCP_HTTP_HOST: 'localhost', CLAUDE_MEM_MCP_HTTP_PORT: '4321' };
    expect(parseHttpArgs(['--http'], env)).toEqual({
      host: 'localhost', port: 4321, token: undefined,
    });
    for (const hostArgs of [['--host=127.0.0.1'], ['--host', '127.0.0.1']]) {
      expect(parseHttpArgs(['--http', ...hostArgs, '--port=1234'], env)).toEqual({
        host: '127.0.0.1', port: 1234, token: undefined,
      });
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

  it('requires an environment token for non-loopback hosts', () => {
    for (const token of [undefined, '', '   ']) {
      expect(() => parseHttpArgs(['--http', '--host=0.0.0.0'], {
        CLAUDE_MEM_MCP_HTTP_TOKEN: token,
      })).toThrow('CLAUDE_MEM_MCP_HTTP_TOKEN');
    }
    expect(parseHttpArgs(['--http', '--host=0.0.0.0'], {
      CLAUDE_MEM_MCP_HTTP_TOKEN: ' secret ',
    })).toEqual({ host: '0.0.0.0', port: 37790, token: 'secret' });
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(parseHttpArgs(['--http', `--host=${host}`], {})?.host).toBe(host);
    }
  });

  it('reads tokens only from the environment, never CLI flags', () => {
    for (const args of [['--token=cli-secret'], ['--token', 'cli-secret']]) {
      expect(parseHttpArgs(['--http', ...args], {})?.token).toBeUndefined();
      expect(parseHttpArgs(['--http', ...args], {
        CLAUDE_MEM_MCP_HTTP_TOKEN: 'env-secret',
      })?.token).toBe('env-secret');
      expect(() => parseHttpArgs(['--http', '--host=0.0.0.0', ...args], {}))
        .toThrow('CLAUDE_MEM_MCP_HTTP_TOKEN');
    }
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
  it('includes loopback and bind hosts with and without the port', () => {
    const hosts = allowedHosts('0.0.0.0', 1234);
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']) {
      expect(hosts).toContain(host);
      expect(hosts).toContain(`${host}:1234`);
    }
  });
});

describe('isAuthorized', () => {
  it('allows any authorization when no token is configured', () => {
    for (const header of [undefined, 'Basic abc', 'Bearer wrong']) {
      expect(isAuthorized(header, undefined)).toBe(true);
    }
  });

  it('rejects missing, Basic, wrong, and different-length tokens', () => {
    for (const header of [undefined, 'Basic secret', 'Bearer secrew', 'Bearer x', 'Bearer secret-long']) {
      expect(isAuthorized(header, 'secret')).toBe(false);
    }
  });

  it('accepts correct Bearer tokens with case-insensitive scheme', () => {
    for (const header of ['Bearer secret', 'bearer secret', 'bEaReR secret']) {
      expect(isAuthorized(header, 'secret')).toBe(true);
    }
  });
});
