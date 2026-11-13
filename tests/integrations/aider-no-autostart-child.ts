// Child process for the --no-auto-start contract: when install was told not
// to auto-start the worker, the Aider best-effort refresh must use a worker
// that is already running without probing to start one. Runs in its own
// process so CLAUDE_MEM_WORKER_URL and CLAUDE_MEM_DATA_DIR are set before
// any module caches settings, and so the stub worker's port is known before
// the installer module is imported.
//
// The stub answers /api/ready with a ready SSE phase (so even the old,
// probing path would find a "running" worker and never spawn a real one)
// and /api/context/inject with canned context, recording every path hit.
// The parent asserts /api/context/inject was hit and no readiness probe was.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const projectDir = process.env.AIDER_CHILD_PROJECT_DIR!;
const dataDir = process.env.AIDER_CHILD_DATA_DIR!;
process.env.CLAUDE_MEM_DATA_DIR = dataDir;

const hits: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    hits.push(url.pathname);
    if (url.pathname === '/api/ready') {
      return new Response('event: phase\ndata: {"phase":"ready"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (url.pathname === '/api/context/inject') {
      return new Response('Stubbed shared context.', { headers: { 'content-type': 'text/plain' } });
    }
    return new Response('not found', { status: 404 });
  },
});
process.env.CLAUDE_MEM_WORKER_URL = `http://127.0.0.1:${server.port}`;

const { installAiderIntegration } = await import('../../src/services/integrations/AiderInstaller.ts');
const configPath = path.join(projectDir, '.aider.conf.yml');
writeFileSync(configPath, 'model: openai/gpt-4o\n');
// Silence console output; only the JSON result line matters.
const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};
let code = -1;
try {
  code = await installAiderIntegration({ configPath, noAutoStart: true });
} finally {
  console.log = origLog;
  console.error = origError;
}
const memory = readFileSync(path.join(projectDir, '.claude-mem', 'aider-memory.md'), 'utf-8');
server.stop();
console.log(JSON.stringify({ code, memoryHasContext: memory.includes('Stubbed shared context'), hits }));
