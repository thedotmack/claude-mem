import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { MARKETPLACE_ROOT } from './paths.js';
import { sanitizeEnv } from '../supervisor/env-sanitizer.js';

const MCP_CLIENT_NAME = 'claude-mem-hook';
const MCP_CLIENT_VERSION = '1.0.0';
const MCP_CALL_TIMEOUT_MS = 30_000;

type TextContent = { type: 'text'; text: string };

export interface McpToolCallResult {
  text: string;
  isError?: boolean;
}

export function resolveMcpServerScriptPath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'mcp-server.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'mcp-server.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildMcpSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitizeEnv(process.env))) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.exe$/, '');
}

export function resolveNodeCommand(): string {
  if (executableName(process.execPath) === 'node') {
    return process.execPath;
  }

  const envNode = process.env.CLAUDE_MEM_NODE_PATH;
  if (envNode && executableName(envNode) === 'node' && existsSync(envNode)) {
    return envNode;
  }

  try {
    const stdout = process.platform === 'win32'
      ? execFileSync('where', ['node'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      : execFileSync('which', ['node'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (first) return first;
  } catch {
    // Fall through to PATH resolution at spawn time.
  }

  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function textFromToolResult(result: unknown): McpToolCallResult {
  if (typeof result !== 'object' || result === null) {
    throw new Error('MCP tool returned a non-object result');
  }

  const maybeResult = result as { content?: unknown; isError?: unknown };
  if (!Array.isArray(maybeResult.content)) {
    throw new Error('MCP tool result did not include content');
  }

  const text = maybeResult.content
    .filter((item): item is TextContent => (
      typeof item === 'object'
      && item !== null
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ))
    .map(item => item.text)
    .join('\n');

  return {
    text,
    ...(maybeResult.isError === true ? { isError: true } : {}),
  };
}

export async function callMcpToolOnce(
  name: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<McpToolCallResult> {
  const scriptPath = resolveMcpServerScriptPath();
  if (!scriptPath) {
    throw new Error('mcp-server.cjs not found in plugin/scripts');
  }

  const transport = new StdioClientTransport({
    command: resolveNodeCommand(),
    args: [scriptPath],
    env: buildMcpSpawnEnv(),
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );

  const timeoutMs = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`MCP tool ${name} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport);
        return await client.callTool({ name, arguments: args });
      })(),
      timeoutPromise,
    ]);
    return textFromToolResult(result);
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await client.close();
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Failed to close one-shot MCP client', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
