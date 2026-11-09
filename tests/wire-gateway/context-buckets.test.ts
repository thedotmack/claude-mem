import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  IMAGE_TOKEN_ESTIMATE,
  WIRE_CONTEXT_PART_KINDS,
  contextBreakdownOfRequest,
  contextBucketsOf,
  estimateTextTokens,
  filesReadByCommand,
  summarizeAgentContext,
  type WireContextBreakdown,
  type WireContextPartKind,
} from '../../src/services/wire-gateway/metrics/context-buckets.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';

// Phase 10 task 7: magpie's prompt_test.go (internal/gateway/prompt_test.go,
// MIT, Copyright (c) 2026 yetone) on its fixtures, plus the memory-heavy tag.

const contextFixtures = join(import.meta.dir, '..', 'fixtures', 'wire-gateway', 'magpie', 'context');
const encoder = new TextEncoder();

function breakdownOf(protocol: WireProtocol, body: string | Uint8Array): WireContextBreakdown {
  const breakdown = contextBreakdownOfRequest(protocol, typeof body === 'string' ? encoder.encode(body) : body);
  if (!breakdown) throw new Error('no breakdown');
  return breakdown;
}

function itemOf(breakdown: WireContextBreakdown, kind: WireContextPartKind, name: string) {
  return breakdown.parts.find(part => part.kind === kind)?.items.find(item => item.name === name);
}

describe('context buckets', () => {
  it('reads a Claude Code request as magpie does (TestPromptOfClaudeCode)', () => {
    const breakdown = breakdownOf('anthropic', readFileSync(join(contextFixtures, 'claude-code.json')));
    expect(breakdown.parts.map(part => part.kind)).toEqual(['system', 'tools', 'memory', 'files', 'results', 'chat']);
    expect(itemOf(breakdown, 'memory', '/home/dev/.claude/CLAUDE.md')?.tag).toBe('user');
    expect(itemOf(breakdown, 'memory', '/home/dev/proj/CLAUDE.md')?.tag).toBe('project');
    expect(itemOf(breakdown, 'memory', 'reminders')).toBeDefined();
    expect(itemOf(breakdown, 'tools', 'linear')).toMatchObject({ tag: 'mcp', count: 3 });
    expect(itemOf(breakdown, 'tools', 'Bash')).toBeDefined();
    for (const file of ['/home/dev/proj/main.go', '/home/dev/proj/reconcile.go']) expect(itemOf(breakdown, 'files', file)?.tag).toBe('read');
    expect(itemOf(breakdown, 'results', 'Bash')?.tag).toBe('result');
    expect(itemOf(breakdown, 'system', 'environment')).toBeDefined();
    expect(breakdown.turns).toBe(1);
    expect(breakdown.held).toBe(false);
    expect(breakdown.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(breakdown.tokens);
    expect(breakdown.tokens).toBeGreaterThanOrEqual(10_000);
  });

  it('reads a Codex request as magpie does (TestPromptOfCodex)', () => {
    const breakdown = breakdownOf('openai-responses', readFileSync(join(contextFixtures, 'codex.json')));
    expect(itemOf(breakdown, 'memory', '/home/dev/proj/AGENTS.md')?.tag).toBe('project');
    expect(itemOf(breakdown, 'memory', 'skills')?.tag).toBe('skills');
    const collaboration = itemOf(breakdown, 'tools', 'collaboration');
    expect(collaboration?.tag).toBe('namespace');
    expect(collaboration!.count).toBeGreaterThanOrEqual(2);
    expect(itemOf(breakdown, 'tools', 'exec')).toBeDefined();
    for (const file of ['main.go', 'reconcile.go']) expect(itemOf(breakdown, 'files', file)?.tag).toBe('shell');
    expect(itemOf(breakdown, 'system', 'environment_context')).toBeDefined();
    expect(itemOf(breakdown, 'system', 'prompt')).toBeDefined();
    expect(breakdown.turns).toBe(1);
  });

  it('groups an MCP namespace under its server (TestPromptOfCodexMCP)', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [
        { type: 'namespace', name: 'mcp__linear__', tools: [{ type: 'function', name: 'list_issues', description: 'issues '.repeat(200) }, { type: 'function', name: 'get_issue', description: 'one issue' }] },
        { type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'sleep', description: 'sleeps' }] },
      ],
    });
    const breakdown = breakdownOf('openai-responses', body);
    expect(itemOf(breakdown, 'tools', 'linear')).toMatchObject({ tag: 'mcp', count: 2 });
    expect(itemOf(breakdown, 'tools', 'clock')?.tag).toBe('namespace');
  });

  it('reads Chat Completions (TestPromptOfChat)', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are OpenCode.\nInstructions from: /p/AGENTS.md\nbe brief, always' },
        { role: 'user', content: 'look at a.go' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"filePath":"/p/a.go"}' } },
          { id: 'c2', type: 'function', function: { name: 'bash', arguments: '{"command":"go test ./..."}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'package a\nfunc A() {}' },
        { role: 'tool', tool_call_id: 'c2', content: 'ok  a 0.1s' },
        { role: 'user', content: [{ type: 'text', text: 'and this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: {} } }, { type: 'function', function: { name: 'mcp__gh__issue', parameters: {} } }],
    });
    const breakdown = breakdownOf('openai-chat', body);
    expect(breakdown.turns).toBe(2);
    expect(itemOf(breakdown, 'memory', '/p/AGENTS.md')?.tag).toBe('project');
    expect(itemOf(breakdown, 'files', '/p/a.go')).toBeDefined();
    expect(itemOf(breakdown, 'files', 'image')?.tokens).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(itemOf(breakdown, 'results', 'bash')).toBeDefined();
    expect(itemOf(breakdown, 'tools', 'gh')?.tag).toBe('mcp');
  });

  it('pairs a Gemini response to its call by name (TestPromptOfGemini)', () => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are Gemini CLI.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'read go.mod' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'go.mod' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'module x' } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'read_file', parameters: {} }] }],
    });
    const breakdown = breakdownOf('gemini', body);
    expect(breakdown.turns).toBe(1);
    expect(itemOf(breakdown, 'files', 'go.mod')).toBeDefined();
  });

  it('notes a held Responses conversation, and reads nothing from a body that is not JSON (TestPromptHeld)', () => {
    const breakdown = breakdownOf('openai-responses', '{"previous_response_id":"resp_1","input":[{"role":"user","content":"go on"}]}');
    expect(breakdown.held).toBe(true);
    expect(breakdown.turns).toBe(1);
    expect(contextBreakdownOfRequest('anthropic', encoder.encode('not json'))).toBeNull();
  });

  it('finds the files a read-only shell command reads (TestFilesOfCommand)', () => {
    const cases: Record<string, string[]> = {
      'cat main.go reconcile.go': ['main.go', 'reconcile.go'],
      'sed -n 1,80p internal/x.go': ['internal/x.go'],
      'head -n 40 README.md': ['README.md'],
      'bash -lc "nl -ba a.go"': ['a.go'],
      'cd /p && cat go.mod': ['go.mod'],
      'cat a.go | grep x': [],
      'go test ./...': [],
      ls: [],
    };
    for (const [command, files] of Object.entries(cases)) expect(filesReadByCommand(command)).toEqual(files);
  });

  it('counts about four ASCII characters a token and a token per other character', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
    expect(estimateTextTokens('漢字😀')).toBe(3);
  });

  it('gives every kind in the ledger shape', () => {
    const buckets = contextBucketsOf(breakdownOf('anthropic', '{"messages":[{"role":"user","content":"hi"}]}'));
    expect(Object.keys(buckets)).toEqual([...WIRE_CONTEXT_PART_KINDS]);
    expect(buckets.chat).toBe(1);
    expect(buckets.memory).toBe(0);
  });

  it('reads a hostile 1 MB instruction line in linear time', () => {
    const hostileLine = `Contents of x${' ((a)'.repeat(200_000)}`;
    const body = JSON.stringify({ system: `${hostileLine}\nInstructions from: ${' '.repeat(500_000)}x`, messages: [] });
    const startedAt = performance.now();
    const breakdown = breakdownOf('anthropic', body);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(breakdown.tokens).toBeGreaterThan(0);
  });

  it('trims hostile 1 MB runs of quotes, slashes and underscores in linear time', () => {
    const megabyte = 1_000_000;
    const startedAt = performance.now();
    expect(filesReadByCommand(`bash -c ${"'".repeat(megabyte)}x`)).toEqual([]);
    expect(filesReadByCommand(`cat ${'"'.repeat(megabyte)}x`)).toEqual(['x']);
    const body = JSON.stringify({
      tools: [{ type: 'namespace', name: `mcp__${'_'.repeat(megabyte)}x`, tools: [{ type: 'function', name: 'a' }] }],
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for /p${'/'.repeat(megabyte)}x\nbe kind` }] }],
    });
    expect(breakdownOf('openai-responses', body).tokens).toBeGreaterThan(0);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('agent context summary', () => {
  const buckets = (memory: number) => ({ system: 100, tools: 100, memory, files: 0, results: 0, chat: 800 - memory });

  it('tags an agent memory-heavy at a memory share of 0.10 or more', () => {
    const summaries = summarizeAgentContext([
      { agent: 'heavy', kind: 'turn', status: 200, buckets: buckets(100) },
      { agent: 'heavy', kind: 'turn', status: 200, buckets: buckets(100) },
      { agent: 'light', kind: 'turn', status: 200, buckets: buckets(99) },
      // Not counted: a failed request, a helper, a request without buckets.
      { agent: 'light', kind: 'turn', status: 500, buckets: buckets(1000) },
      { agent: 'light', kind: 'helper:title', status: 200, buckets: buckets(1000) },
      { agent: 'light', kind: 'turn', status: 200 },
    ]);
    const heavy = summaries.find(summary => summary.agent === 'heavy')!;
    const light = summaries.find(summary => summary.agent === 'light')!;
    expect(heavy.shares.memory).toBeCloseTo(0.10);
    expect(heavy.tags).toEqual(['memory-heavy']);
    expect(light.requests).toBe(1);
    expect(light.tags).toEqual([]);
  });
});
