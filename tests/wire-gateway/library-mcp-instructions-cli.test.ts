import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import {
  ENV_REFERENCE_SYNTAX_OF_FORMAT,
  NO_ENV_REFERENCE_REFUSAL,
  encodeMcpServerEntry,
  envReferenceProblem,
  type McpServerSpec,
} from '../../src/services/wire-gateway/library/mcp-servers.js';
import { contextBlockItem, mcpMemberItem, LIBRARY_AGENT_TARGETS } from '../../src/services/wire-gateway/library/agent-library-targets.js';
import { wireMemoryInjectionReplacesInstructions, withoutInstructionsWhenWireInjects } from '../../src/services/wire-gateway/library/library-runtime.js';
import { applyLibrary } from '../../src/services/wire-gateway/library/library-engine.js';
import { runLibraryCli } from '../../src/services/wire-gateway/library/library-cli.js';
import { NATIVE_HOOK_EVENTS } from '../../src/services/wire-gateway/library/hook-commands.js';

const ROOT = join(WIRE_GATEWAY_DIR, 'tmp', `library-mcp-cli-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('${VAR} references in claude-mem\'s MCP server, per agent (plan Phase 14 task 2, Appendix B)', () => {
  const stdio: McpServerSpec = { transport: 'stdio', command: 'node', args: ['/p/mcp-server.cjs'], env: { CLAUDE_MEM_TOKEN: '${CLAUDE_MEM_TOKEN}', MODE: 'x-${MODE}' } };
  const http: McpServerSpec = { transport: 'http', url: 'http://127.0.0.1:37677/mcp', headers: { Authorization: 'Bearer ${CLAUDE_MEM_TOKEN}', 'X-Team': '${TEAM}' } };

  it('keeps ${NAME} for the claude family (claude, grok, gemini, crush, copilot, pi, omp, hermes)', () => {
    expect(encodeMcpServerEntry(stdio, 'claude')).toEqual({ command: 'node', args: ['/p/mcp-server.cjs'], env: { CLAUDE_MEM_TOKEN: '${CLAUDE_MEM_TOKEN}', MODE: 'x-${MODE}' } });
    expect(encodeMcpServerEntry(http, 'claude')).toEqual({ type: 'http', url: 'http://127.0.0.1:37677/mcp', headers: { Authorization: 'Bearer ${CLAUDE_MEM_TOKEN}', 'X-Team': '${TEAM}' } });
  });

  it('writes {env:NAME} for OpenCode and ${env:NAME} for Cursor', () => {
    expect(encodeMcpServerEntry(stdio, 'opencode')).toEqual({ type: 'local', command: ['node', '/p/mcp-server.cjs'], environment: { CLAUDE_MEM_TOKEN: '{env:CLAUDE_MEM_TOKEN}', MODE: 'x-{env:MODE}' } });
    expect(encodeMcpServerEntry(http, 'claude', { cursorSyntax: true }).headers).toEqual({ Authorization: 'Bearer ${env:CLAUDE_MEM_TOKEN}', 'X-Team': '${env:TEAM}' });
  });

  it('names whole variables in Codex\'s own keys, and refuses a value that is only part of one', () => {
    expect(encodeMcpServerEntry(http, 'codex')).toEqual({ url: 'http://127.0.0.1:37677/mcp', bearer_token_env_var: 'CLAUDE_MEM_TOKEN', env_http_headers: { 'X-Team': 'TEAM' } });
    expect(encodeMcpServerEntry({ ...stdio, env: { CLAUDE_MEM_TOKEN: '${CLAUDE_MEM_TOKEN}' } }, 'codex')).toEqual({ command: 'node', args: ['/p/mcp-server.cjs'], env_vars: ['CLAUDE_MEM_TOKEN'] });
    expect(envReferenceProblem(stdio, 'codex')).toContain('MODE is not one');
    expect(envReferenceProblem({ ...http, headers: { 'X-Team': 'team-${TEAM}' } }, 'codex')).toContain('X-Team is not one');
  });

  it('lists env_keys for Goose', () => {
    expect(encodeMcpServerEntry({ ...stdio, env: { CLAUDE_MEM_TOKEN: '${CLAUDE_MEM_TOKEN}' } }, 'goose').env_keys).toEqual(['CLAUDE_MEM_TOKEN']);
  });

  it('refuses where the token would be plain text in the agent\'s file (Kimi, Antigravity)', () => {
    for (const format of ['kimi', 'antigravity'] as const) {
      expect(ENV_REFERENCE_SYNTAX_OF_FORMAT[format]).toBe('none');
      expect(() => encodeMcpServerEntry(stdio, format)).toThrow(NO_ENV_REFERENCE_REFUSAL);
    }
    // A server with no reference is fine everywhere.
    expect(encodeMcpServerEntry({ transport: 'stdio', command: 'node', args: ['/p'] }, 'kimi')).toEqual({ type: 'stdio', command: 'node', args: ['/p'] });
  });

  it('gives agy MCP over HTTP as serverUrl', () => {
    expect(encodeMcpServerEntry({ transport: 'http', url: 'http://127.0.0.1:37677/mcp' }, 'antigravity')).toEqual({ serverUrl: 'http://127.0.0.1:37677/mcp' });
  });
});

describe('neutral hook events (Appendix B)', () => {
  it('map to each agent\'s own names', () => {
    expect(NATIVE_HOOK_EVENTS['gemini-cli']).toEqual({ 'session-start': 'SessionStart', prompt: 'BeforeAgent', 'before-tool': 'BeforeTool', 'after-tool': 'AfterTool', 'turn-end': 'AfterAgent' });
    expect(NATIVE_HOOK_EVENTS.cursor['turn-end']).toBe('stop');
  });
});

describe('no double context (plan Phase 14 task 5)', () => {
  const routesFile = join(ROOT, 'routes.json');
  const route = (agentId: string, features: Record<string, boolean> = {}) => ({ agentId, upstreamBaseUrl: 'https://generativelanguage.googleapis.com', captureSource: 'wire', features, createdAt: '2026-10-23T00:00:00.000Z' });

  it('an agent whose wire route injects memory gets no instruction-file context block', () => {
    writeFileSync(routesFile, JSON.stringify({ version: 1, routes: { agy: route('antigravity-cli') } }));
    const decision = wireMemoryInjectionReplacesInstructions('antigravity', { routesFilePath: routesFile, settings: {} });
    expect(decision).toEqual({ memoryInjectedByWire: true, note: 'wire route agy injects memory; no context block is written' });
    const file = join(ROOT, 'GEMINI.md');
    const items = withoutInstructionsWhenWireInjects('antigravity', [contextBlockItem(file, 'memory', 'after-trimmed-text'), mcpMemberItem(join(ROOT, 'mcp.json'), ['mcpServers', 'claude-mem'], { command: 'node' })], decision);
    expect(items.map((item) => item.kind)).toEqual(['mcp']);
  });

  it('a recorded block goes once the wire injects (the apply still owns the group)', () => {
    const context = { libraryDirectory: join(ROOT, 'library-task5') };
    const file = join(ROOT, 'GEMINI-recorded.md');
    writeFileSync(file, '# Rules\n');
    applyLibrary({ agentId: 'antigravity', items: [contextBlockItem(file, 'memory', 'after-trimmed-text')], ownedGroups: ['instructions'] }, context);
    expect(readFileSync(file, 'utf-8')).toContain('<claude-mem-context>');
    applyLibrary({ agentId: 'antigravity', items: [], ownedGroups: ['instructions'] }, context);
    expect(readFileSync(file, 'utf-8')).toBe('# Rules\n');
  });

  it('keeps the block when injection is off, the route is native, or the agent has no route', () => {
    writeFileSync(routesFile, JSON.stringify({ version: 1, routes: { agy: route('antigravity-cli', { memoryInjection: false }), oc: { ...route('opencode'), captureSource: 'native' } } }));
    expect(wireMemoryInjectionReplacesInstructions('antigravity', { routesFilePath: routesFile, settings: {} }).memoryInjectedByWire).toBe(false);
    expect(wireMemoryInjectionReplacesInstructions('opencode', { routesFilePath: routesFile, settings: {} }).memoryInjectedByWire).toBe(false);
    expect(wireMemoryInjectionReplacesInstructions('warp', { routesFilePath: routesFile, settings: {} }).memoryInjectedByWire).toBe(false);
    writeFileSync(routesFile, JSON.stringify({ version: 1, routes: { agy: route('antigravity-cli') } }));
    expect(wireMemoryInjectionReplacesInstructions('antigravity', { routesFilePath: routesFile, settings: { CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: 'false' } }).memoryInjectedByWire).toBe(false);
  });

  it('an unreadable routes.json decides nothing and says why', () => {
    writeFileSync(routesFile, '{ broken');
    const decision = wireMemoryInjectionReplacesInstructions('antigravity', { routesFilePath: routesFile, settings: {} });
    expect(decision.memoryInjectedByWire).toBe(false);
    expect(decision.note).toContain('could not read the wire routes');
  });
});

describe('claude-mem library status|sync|remove', () => {
  function capture() {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, errors, runtime: { writeLine: (line: string) => lines.push(line), writeError: (line: string) => errors.push(line), context: { libraryDirectory: join(ROOT, 'library-cli') } } };
  }

  it('status reports each recorded item against its file', async () => {
    const { lines, runtime } = capture();
    const file = join(ROOT, 'cli-mcp.json');
    applyLibrary({ agentId: 'goose', items: [mcpMemberItem(file, ['mcpServers', 'claude-mem'], { command: 'node' })], ownedGroups: ['mcp'] }, runtime.context);
    expect(await runLibraryCli(['status', 'goose'], runtime)).toBe(0);
    expect(lines[0]).toMatch(/^Goose \(goose\), recorded /);
    expect(lines[1]).toMatch(/^ {2}present +mcp +mcpServers\.claude-mem +.*cli-mcp\.json$/);

    const json = capture();
    json.runtime.context = runtime.context;
    expect(await runLibraryCli(['status', '--json'], json.runtime)).toBe(0);
    const report = JSON.parse(json.lines.join('\n')) as Array<{ agent: string; items: unknown[] }>;
    expect(report.map((entry) => entry.agent)).toEqual(LIBRARY_AGENT_TARGETS.map((target) => target.id));
    expect(report.find((entry) => entry.agent === 'goose')!.items).toHaveLength(1);
  });

  it('refuses an unknown agent and prints usage', async () => {
    const { errors, runtime } = capture();
    expect(await runLibraryCli(['sync', 'not-an-agent'], runtime)).toBe(1);
    expect(errors[0]).toBe('Unknown agent: not-an-agent');
    expect(await runLibraryCli(['remove'], runtime)).toBe(1);
    expect(errors.join('\n')).toContain('Usage: claude-mem library <command>');
  });
});
