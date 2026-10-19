import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Without format=json, /api/search answers in the MCP tool shape
// ({ content: [{ type: 'text', text }] }, SearchManager.search). The CLI must
// print that rendered text, not the JSON wrapper around it.
describe('npx claude-mem search output', () => {
  async function runSearchAgainst(body: unknown): Promise<{ exitCode: number; stdout: string }> {
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-search-output-'));
    const server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const modulePath = join(import.meta.dir, '../../src/npx-cli/commands/runtime.ts');
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_MEM_DATA_DIR: root, CLAUDE_CONFIG_DIR: root,
        CLAUDE_MEM_TELEMETRY: '0', DO_NOT_TRACK: '1', CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(port) };
      const child = Bun.spawn({
        cmd: [process.execPath, '-e', `import { runSearchCommand } from ${JSON.stringify(modulePath)};
          await runSearchCommand(['auth']);`],
        cwd: join(import.meta.dir, '../..'),
        env,
        stdout: 'pipe', stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return { exitCode, stdout };
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('prints the worker\'s rendered result text', async () => {
    const text = 'Found 1 result(s) matching "auth"\n\n| ID | Time | T | Title | Read |\n| #7 | 3:00 PM | 🔵 | Fix JWT refresh | ~120 |';
    const { exitCode, stdout } = await runSearchAgainst({ content: [{ type: 'text', text }] });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(text);
  }, 30_000);

  it('exits non-zero when the worker reports an error result', async () => {
    const { exitCode, stdout } = await runSearchAgainst({ content: [{ type: 'text', text: 'Search failed: boom' }], isError: true });
    expect(exitCode).toBe(1);
    expect(stdout.trim()).toBe('Search failed: boom');
  }, 30_000);
});
