import { AgentRuntime } from '@elizaos/core';
import { McpService } from '@elizaos/plugin-mcp';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const { values } = parseArgs({ options: { project: { type: 'string' }, server: { type: 'string' }, worker: { type: 'string' }, 'withheld-id': { type: 'string' } }, strict: true });
if (!values.project?.trim() || !values.server || !values.worker) {
  throw new Error('Usage: node memory.mjs --project fixture --server /absolute/path/mcp-server.cjs --worker http://127.0.0.1:PORT');
}
const base = new URL(values.worker);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('Choose a credential-free loopback worker origin.');
}
const server = resolve(values.server);
if (!existsSync(server)) throw new Error('The MCP bundle does not exist. Build Claude-Mem first.');
const project = values.project;
// Optional isolation check: an observation ID saved under another project must not come back for this one.
const withheldId = values['withheld-id'] === undefined ? undefined : Number(values['withheld-id']);
if (withheldId !== undefined && !Number.isInteger(withheldId)) throw new Error('--withheld-id must be an observation ID.');
const text = 'A restore must reject snapshots missing required worker tables.';
// An explicit JSON save gives the application a stable record ID. MCP handles recall.
const savedResponse = await fetch(new URL('/api/memory/save', base), {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, title: 'elizaOS restore fixture', project, cwd: process.cwd() }),
  signal: AbortSignal.timeout(5000),
});
if (!savedResponse.ok) throw new Error(`Memory save failed: HTTP ${savedResponse.status}`);
const saved = await savedResponse.json();
if (saved.success !== true || !Number.isInteger(saved.id)) throw new Error('The worker did not confirm a saved memory.');
console.error(`Saved memory #${saved.id} in ${project}; recalling it through elizaOS MCP.`);
const runtime = new AgentRuntime({ character: { name: 'Claude-Mem example', bio: 'Synthetic explicit memory example', settings: { mcp: { servers: {
  'claude-mem': { type: 'stdio', command: process.execPath, args: [server], cwd: process.cwd(), env: { CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_URL: base.origin, CLAUDE_MEM_WORKER_PORT: base.port || '80' } },
} } } } });
const service = await McpService.start(runtime);
try {
  const connection = service.getServers().find(s => s.name === 'claude-mem');
  if (connection?.status !== 'connected') throw new Error('The elizaOS MCP service did not connect.');
  // `projects` as a one-item list keeps each read to this exact key. Without it, an MCP server started
  // inside a git worktree widens a `project` equal to that checkout's key to every key the checkout reads.
  const scope = { project, projects: JSON.stringify([project]) };
  const recall = async (name, args) => {
    const result = await service.callTool('claude-mem', name, { ...args, ...scope });
    if (result.isError) throw new Error(`Memory recall failed: ${name}`);
    const content = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    console.log(`--- ${name}\n${content}`);
    return content;
  };
  await recall('search', { query: 'restore snapshots', limit: 5 });
  await recall('timeline', { anchor: saved.id, depth_before: 1, depth_after: 1 });
  const fetched = await recall('get_observations', { ids: [saved.id] });
  if (!fetched.includes(text)) throw new Error('The fetched observation did not contain the saved text.');
  if (withheldId !== undefined) {
    const withheld = await recall('get_observations', { ids: [withheldId] });
    if (withheld.trim() !== 'No selected observations found.') throw new Error(`Observation #${withheldId} from another project was returned for ${project}.`);
  }
} finally {
  await service.stop();
}
