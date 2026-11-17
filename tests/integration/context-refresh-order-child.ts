import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A separate process sets DATA_DIR before the integrations import paths.ts.
// Responses stay pending until the test releases them; no timing sleeps or
// mocked fetches are needed to reproduce two summaries completing out of order.
const root = process.env.CONTEXT_REFRESH_ROOT!;
const integration = process.env.CONTEXT_REFRESH_INTEGRATION!;
const scenario = process.env.CONTEXT_REFRESH_SCENARIO!;
const workspace = path.join(root, 'project');
mkdirSync(workspace, { recursive: true });

const responses: ServerResponse[] = [];
const arrivals: Array<() => void> = [];
const server = createServer((request, response) => {
  if (!request.url?.startsWith('/api/context/inject?')) {
    response.writeHead(404).end();
    return;
  }
  responses.push(response);
  arrivals.shift()?.();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No HTTP port');
process.env.CLAUDE_MEM_WORKER_URL = `http://127.0.0.1:${address.port}`;

const waitForRequest = async (count: number): Promise<void> => {
  while (responses.length < count) await new Promise<void>((resolve) => arrivals.push(resolve));
};
const respond = (index: number, body: string, status = 200): void => {
  responses[index].writeHead(status, { 'Content-Type': 'text/plain' }).end(body);
};

let refresh: (dir: string) => Promise<void>;
let file: (dir: string) => string;
let install: (dir: string) => void;
if (integration === 'cursor') {
  const cursor = await import('../../src/services/integrations/CursorHooksInstaller.js');
  install = (dir) => cursor.registerCursorProject(path.basename(dir), dir);
  refresh = (dir) => cursor.updateCursorContextForProject(path.basename(dir));
  file = (dir) => path.join(dir, '.cursor', 'rules', 'claude-mem-context.mdc');
} else {
  const grok = await import('../../src/services/integrations/GrokBuildRules.js');
  const { getProjectContext } = await import('../../src/utils/project-name.js');
  install = (dir) => { grok.installGrokBuildContext(dir); };
  refresh = (dir) => grok.updateGrokContextForProject(getProjectContext(dir).primary);
  file = grok.grokRulesFile;
}

try {
  install(workspace);
  mkdirSync(path.dirname(file(workspace)), { recursive: true });
  writeFileSync(file(workspace), 'initial context');

  const older = refresh(workspace);
  await waitForRequest(1);
  const other = scenario === 'independent' ? path.join(root, 'other') : workspace;
  if (other !== workspace) {
    mkdirSync(other, { recursive: true });
    install(other);
  }
  const newer = refresh(other);
  await waitForRequest(2);

  if (scenario === 'ordered') {
    respond(0, 'older snapshot');
    await older;
    respond(1, 'newer snapshot');
    await newer;
  } else if (scenario === 'three') {
    const newest = refresh(workspace);
    await waitForRequest(3);
    respond(2, 'newest snapshot');
    await newest;
    respond(1, 'newer snapshot');
    await newer;
    respond(0, 'older snapshot');
    await older;
  } else {
    if (scenario === 'write-failure') {
      rmSync(file(workspace));
      mkdirSync(file(workspace));
    }
    respond(1, scenario === 'empty' ? '   ' : 'newer snapshot', scenario === 'http-error' ? 503 : 200);
    await newer;
    if (scenario === 'write-failure') {
      rmSync(file(workspace), { recursive: true });
      writeFileSync(file(workspace), 'initial context');
    }
    respond(0, 'older snapshot');
    await older;
  }

  const afterOverlap = readFileSync(file(workspace), 'utf-8');
  const otherContext = other === workspace ? null : readFileSync(file(other), 'utf-8');
  // Finishing all in-flight requests must not block a later normal refresh.
  const count = responses.length;
  const subsequent = refresh(workspace);
  await waitForRequest(count + 1);
  respond(count, 'subsequent snapshot');
  await subsequent;
  console.log(JSON.stringify({ afterOverlap, otherContext, afterSubsequent: readFileSync(file(workspace), 'utf-8') }));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
