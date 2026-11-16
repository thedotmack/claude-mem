/**
 * Runs `claude-mem import` (runImportCommand) in this process against a synthetic Mem0
 * page and a fake worker, both answered by an in-process fetcher, so nothing leaves the
 * process. tests/npx-cli/import-memory.test.ts starts it with CLAUDE_MEM_DATA_DIR set to
 * an empty folder before any module loads, then checks the import wrote nothing there.
 */
import { runImportCommand } from '../../src/npx-cli/commands/import-memory.js';

const fakeEndpoints = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.mem0.ai') {
    return Response.json({ count: 1, next: null, results: [{ id: 'm1', memory: 'Synthetic memory for the data folder check.', user_id: 'fixture-user' }] });
  }
  if (url.pathname === '/api/memory/save') {
    return Response.json({ success: true, id: 1, project: JSON.parse(String(init?.body)).project });
  }
  throw new Error(`Unexpected request to ${url.origin}${url.pathname}`);
}) as typeof fetch;

await runImportCommand(process.argv.slice(2), fakeEndpoints);
