import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';

const [action, project, ...values] = process.argv.slice(2);
const server = process.env.CLAUDE_MEM_MCP_SERVER;
const validId = value => /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value));
const valid = project?.trim() && (
  (action === 'save' && values.length === 2 && values.every(value => value.trim()))
  || (action === 'search' && values.length === 1 && values[0].trim())
  || (['timeline', 'show'].includes(action) && values.length === 1 && validId(values[0]))
);
if (!valid || !server || !isAbsolute(server) || !existsSync(server)) {
  console.error('Set CLAUDE_MEM_MCP_SERVER to the installed absolute mcp-server.cjs path.');
  console.error('Usage: node memory.mjs save PROJECT TITLE TEXT | search PROJECT QUERY | timeline PROJECT ID | show PROJECT ID');
  process.exitCode = 1;
} else {
  let client;
  try {
    client = await createMCPClient({
      transport: new StdioMCPTransport({
        command: process.execPath,
        args: [server],
        env: { ...process.env, CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_AUTOSTART: 'false' },
        stderr: 'ignore',
      }),
      initializationOptions: { timeout: 10_000 },
      maxRetries: 0,
      clientName: 'claude-mem-vercel-example',
    });
    // Convert only the memory tools this workflow uses. The resulting tools
    // have the AI SDK's execute(input, options) and toModelOutput interfaces.
    const names = ['save_memory', 'search', 'timeline', 'get_observations'];
    const definitions = await client.listTools({ options: { timeout: 10_000 } });
    const tools = client.toolsFromDefinitions({
      ...definitions,
      tools: definitions.tools.filter(tool => names.includes(tool.name)),
    });
    const operations = {
      save: ['save_memory', {
        project, title: values[0], text: values[1],
        metadata: {
          platformSource: 'vercel-ai-sdk',
          sourceFingerprint: `vercel-ai-sdk:${createHash('sha256').update(JSON.stringify([project, ...values])).digest('hex')}`,
        },
      }],
      // An explicit list prevents checkout inheritance from widening reads
      // when this client is launched inside a Git worktree.
      search: ['search', { project, projects: [project], query: values[0], type: 'observations', limit: 10 }],
      timeline: ['timeline', { project, projects: [project], anchor: Number(values[0]), depth_before: 2, depth_after: 2 }],
      show: ['get_observations', { project, projects: [project], ids: [Number(values[0])] }],
    };
    const [name, input] = operations[action];
    if (!tools[name]) throw new Error('Required memory tool was not discovered');
    const result = await tools[name].execute(input, {
      toolCallId: `memory-${action}`,
      messages: [],
      abortSignal: AbortSignal.timeout(15_000),
    });
    if (result.isError) throw new Error('Memory tool returned an error');
    for (const block of result.content ?? []) {
      if (block.type === 'text') console.log(block.text);
    }
  } catch {
    console.error('Memory request failed. Check the worker with `npx claude-mem status` and verify its data directory and port.');
    console.error('A timed-out save may have completed. Repeating the same project, title and text uses the same note identity.');
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
}
