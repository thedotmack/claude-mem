// Local API token mode (#5141): the OpenCode plugin sends the token to a local worker, and only to one.
// The plugin reads settings when its module loads, so each case runs in a child process that
// starts with CLAUDE_MEM_DATA_DIR already pointing at a settings.json.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';

const TOKEN = 'opencode-owner-test-secret';
const core = pathToFileURL(join(import.meta.dir, '../../src/integrations/opencode-plugin/core.ts')).href;

let dataDir: string;

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cm-opencode-owner-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

/** The headers of the worker request the plugin makes for a user prompt, given these settings. */
function headersSentWith(settings: Record<string, string>): Record<string, string> {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
  const script = `
    import { createCore } from '${core}';
    let seen = null;
    globalThis.fetch = async (_url, init) => { seen = init?.headers ?? null; return Response.json({ ok: true }); };
    await createCore({ directory: '/work/local-api-token' }).captureUserPrompt('local-api-token-session', 'hello');
    process.stdout.write(JSON.stringify(seen));
  `;
  // An inherited value would override the file, so the child must not have one.
  const { CLAUDE_MEM_LOCAL_API_TOKEN: _inherited, CLAUDE_MEM_WORKER_HOST: _host, ...inherited } = process.env;
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    env: { ...(inherited as Record<string, string>), CLAUDE_MEM_DATA_DIR: dataDir },
    stderr: 'pipe',
  });
  expect(child.stderr.toString()).not.toContain('error');
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString());
}

describe('OpenCode plugin local API token', () => {
  it('sends the token to the local worker, beside its own headers', () => {
    const headers = headersSentWith({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN });
    expect(headers[LOCAL_API_TOKEN_HEADER]).toBe(TOKEN);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends no token header when settings.json has none', () => {
    expect(headersSentWith({})).toEqual({ 'Content-Type': 'application/json' });
  });

  it('never sends the token to a worker host that is not loopback', () => {
    const headers = headersSentWith({ CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN, CLAUDE_MEM_WORKER_HOST: 'worker.example.com' });
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
