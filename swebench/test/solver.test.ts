import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { solveInstance, type SolveEvent } from '../src/solver.ts';
import { MemSearchClient } from '../src/mem-tools.ts';
import type { ChatCompletion, ChatMessage, ChatProvider, ToolDefinition } from '../src/types.ts';
import type { SweBenchInstance } from '../src/types.ts';

let repoDir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'cmem-solver-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  // Buggy source: add() is off by one.
  writeFileSync(join(repoDir, 'calculator.py'), 'def add(a, b):\n    return a + b + 1\n');
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(join(repoDir, 'tests', 'test_calc.py'), 'from calculator import add\n\n\ndef test_add():\n    assert add(2, 2) == 4\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

/**
 * Scripts a fixed tool sequence: recall via mem_search, fix the bug with bash,
 * then submit. Mirrors the intended agent workflow so the loop, tool dispatch,
 * and patch extraction are all exercised offline.
 */
class MockProvider implements ChatProvider {
  readonly modelName = 'mock/model';
  private calls = 0;
  complete(_input: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<ChatCompletion> {
    this.calls++;
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const call = (id: string, name: string, args: unknown): ChatCompletion => ({
      message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finishReason: 'tool_calls',
      usage,
    });
    if (this.calls === 1) return Promise.resolve(call('c1', 'mem_search', { query: 'add off by one' }));
    if (this.calls === 2) {
      const fix = "cat > calculator.py <<'PYEOF'\ndef add(a, b):\n    return a + b\nPYEOF";
      return Promise.resolve(call('c2', 'bash', { command: fix }));
    }
    return Promise.resolve(call('c3', 'submit', { notes: 'fixed off-by-one' }));
  }
}

const instance: SweBenchInstance = {
  instance_id: 'example__demo-1',
  repo: 'example/demo',
  base_commit: 'HEAD',
  problem_statement: 'add(2,2) returns 5 instead of 4',
};

describe('solveInstance (offline, mock provider)', () => {
  test('primes, recalls, fixes, and extracts a patch', async () => {
    const memFetch = (async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: '| #1 | prior off-by-one fix |' }] }), { status: 200 })) as unknown as typeof fetch;
    const memClient = new MemSearchClient({ baseUrl: 'http://127.0.0.1:1' }, memFetch);

    const events: SolveEvent[] = [];
    const result = await solveInstance({
      instance,
      repoDir,
      provider: new MockProvider(),
      memClient,
      onEvent: (e) => events.push(e),
      learnOptions: { maxFiles: 50 },
    });

    expect(result.succeeded).toBe(true);
    expect(result.patch).toContain('calculator.py');
    // A unified diff shows the buggy line removed and the fixed line added.
    expect(result.patch).toContain('-    return a + b + 1');
    expect(result.patch).toContain('+    return a + b');
    expect(result.memSearchCalls).toBe(1);
    expect(result.toolCallCounts.bash).toBe(1);
    expect(result.toolCallCounts.submit).toBe(1);
    expect(result.toolCallCounts.mem_search).toBe(1);
    expect(result.turns).toBe(3);
    expect(result.usage.totalTokens).toBe(45);

    // Priming ran and read the source file.
    const priming = events.find((e) => e.type === 'priming');
    expect(priming && priming.type === 'priming' && priming.filesRead).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'submit')).toBe(true);
  });

  test('without a mem client, mem tools are not offered', async () => {
    // A provider that immediately submits; no mem calls possible.
    class NoMem implements ChatProvider {
      readonly modelName = 'mock';
      complete(): Promise<ChatCompletion> {
        return Promise.resolve({
          message: { role: 'assistant', content: null, tool_calls: [{ id: 's', type: 'function', function: { name: 'submit', arguments: '{}' } }] },
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
      }
    }
    const result = await solveInstance({ instance, repoDir, provider: new NoMem(), skipPriming: true });
    expect(result.memSearchCalls).toBe(0);
    expect(result.toolCallCounts.submit).toBe(1);
  });
});
