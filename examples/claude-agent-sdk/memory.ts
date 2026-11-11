import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const PREFIX = 'mcp__claude-mem__';
const FIELDS: Record<string, string[]> = {
  save_memory: ['text', 'title'], search: ['query', 'limit'],
  timeline: ['anchor', 'depth_before', 'depth_after'], get_observations: ['ids'],
};

/** Keep the selected project outside model control, including ID-based reads. */
export function memoryPermission(project: string, name: string, input: Record<string, unknown>): PermissionResult {
  const tool = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : '';
  if (!Object.hasOwn(FIELDS, tool)) return { behavior: 'deny', message: 'Only the four example memory tools are available.' };
  if ((input.project !== undefined && input.project !== project) || input.projectId !== undefined || input.projects !== undefined) {
    return { behavior: 'deny', message: 'This example can access only its selected local project.' };
  }
  return { behavior: 'allow', updatedInput: {
    ...Object.fromEntries(FIELDS[tool].filter(key => input[key] !== undefined).map(key => [key, input[key]])),
    project,
  } };
}

export function memoryOptions(project: string, server: string): Options {
  return {
    tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
    maxTurns: 8,
    model: process.env.CLAUDE_MEM_EXAMPLE_MODEL || 'claude-haiku-4-5-20251001',
    mcpServers: { 'claude-mem': { command: process.execPath, args: [server], env: { CLAUDE_MEM_RUNTIME: 'worker' } } },
    // Ask rules ensure even read-only MCP tools reach the project check.
    settings: { permissions: { ask: [`${PREFIX}*`] } },
    canUseTool: async (name, input) => memoryPermission(project, name, input),
  };
}

export async function runMemoryExample(project: string, server: string): Promise<void> {
  if (!project.trim()) throw new Error('Choose a nonempty project.');
  if (!existsSync(server)) throw new Error('The rebuilt mcp-server.cjs path does not exist.');
  const prompt = `In project ${JSON.stringify(project)}, explicitly save this synthetic note with title "SDK restore fixture": "A restore must reject snapshots missing required worker tables." Then search for "restore snapshots", review the matching timeline and get only that observation by ID. Quote the saved text in your final answer. Do not access any other project.`;
  const completed = new Set<string>();
  const options = memoryOptions(project, server);
  options.hooks = { PostToolUse: [{ hooks: [async input => {
    if (input.hook_event_name === 'PostToolUse') {
      const response = input.tool_response as { isError?: boolean } | undefined;
      if (response?.isError) throw new Error(`Memory tool failed: ${input.tool_name}`);
      completed.add(input.tool_name);
    }
    return {};
  }] }] };
  let success = false;
  let answer = '';
  for await (const message of query({ prompt, options })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || message.is_error) throw new Error(`Agent run failed: ${message.subtype}`);
      answer = message.result;
      success = true;
    }
  }
  if (!success) throw new Error('The agent ended without a successful result.');
  if (Object.keys(FIELDS).some(tool => !completed.has(`${PREFIX}${tool}`))) {
    throw new Error('The agent did not complete save, search, timeline and retrieval.');
  }
  console.log(answer);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { project: { type: 'string' }, server: { type: 'string' } }, strict: true });
  if (!values.project || !values.server) throw new Error('Usage: bun examples/claude-agent-sdk/memory.ts --project fixture --server /absolute/path/mcp-server.cjs');
  await runMemoryExample(values.project, resolve(values.server));
}
