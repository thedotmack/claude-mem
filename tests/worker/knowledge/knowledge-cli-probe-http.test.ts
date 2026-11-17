import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real executable resolver launches this local CLI. It waits for a health
// request to release it, with a deadline so the blocking baseline still exits.
const cliProgram = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.KNOWLEDGE_PROBE_TEST_DIR;
const args = process.argv.slice(2);
const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8');
const log = value => fs.appendFileSync(path.join(dir, 'probes.jsonl'), JSON.stringify(value) + '\n');
if (mode === 'incompatible') {
  log({ args });
  if (args.includes('--permission-mode')) {
    process.stderr.write('dontAsk is not supported\n');
    process.exit(1);
  }
  console.log('2.0.42 (Claude Code)');
} else {
  fs.writeFileSync(path.join(dir, 'started'), 'ready');
  const deadline = Date.now() + 1200;
  const timer = setInterval(() => {
    const released = fs.existsSync(path.join(dir, 'released'));
    if (!released && Date.now() < deadline) return;
    clearInterval(timer);
    log({ args, healthServedDuringProbe: released });
    console.log('2.1.999 (Claude Code)');
  }, 10);
}
`;

const fixture = String.raw`
  import { mock } from 'bun:test';
  import express from 'express';
  import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
  import { join } from 'node:path';
  import { once } from 'node:events';
  const directory = process.env.KNOWLEDGE_PROBE_TEST_DIR;
  const cliPath = join(directory, 'claude with spaces');
  writeFileSync(cliPath, ${JSON.stringify(cliProgram)}, { mode: 0o755 });
  let sdkCalls = [];
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: ({ options }) => {
    sdkCalls.push({ path: options.pathToClaudeCodeExecutable, permissionMode: options.permissionMode,
      tools: options.tools, allowedTools: options.allowedTools });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'fixture-session' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture answer' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-session' };
    })();
  } }));
  const envModule = await import('./src/shared/EnvManager.ts');
  mock.module('./src/shared/EnvManager.ts', () => ({ ...envModule, buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH }) }));
  const { _internals, resetClaudeExecutableCache } = await import('./src/shared/find-claude-executable.ts');
  _internals.loadSettings = () => ({ CLAUDE_CODE_PATH: cliPath });
  const { KnowledgeAgent } = await import('./src/services/worker/knowledge/KnowledgeAgent.ts');
  const { CorpusStore } = await import('./src/services/worker/knowledge/CorpusStore.ts');
  const { CorpusRoutes } = await import('./src/services/worker/http/routes/CorpusRoutes.ts');
  const store = new CorpusStore();
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    writeFileSync(join(directory, 'released'), 'health served');
    res.json({ ok: true });
  });
  new CorpusRoutes(store, {}, new KnowledgeAgent(store)).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const outcomes = [];
  try {
    for (const scenario of ['prime', 'query', 'incompatible', 'launch-failure']) {
      resetClaudeExecutableCache();
      sdkCalls = [];
      for (const name of ['started', 'released', 'probes.jsonl']) rmSync(join(directory, name), { force: true });
      writeFileSync(join(directory, 'mode'), scenario === 'incompatible' ? 'incompatible' : 'capable');
      writeFileSync(cliPath, scenario === 'launch-failure' ? '#!/nonexistent-knowledge-fixture-interpreter\n' : ${JSON.stringify(cliProgram)}, { mode: 0o755 });
      const corpus = { version: 1, name: 'fixture', description: '', created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), filter: {},
        stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
        system_prompt: 'Use only this corpus', session_id: scenario === 'query' ? 'previous-session' : null, observations: [] };
      store.write(corpus);
      const operation = scenario === 'query' ? 'query' : 'prime';
      const request = () => fetch(origin + '/api/corpus/fixture/' + operation, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Question' }),
      });
      const pending = request();
      if (scenario === 'prime' || scenario === 'query') {
        const deadline = Date.now() + 5000;
        while (!existsSync(join(directory, 'started')) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (!existsSync(join(directory, 'started'))) throw new Error('CLI probe did not start');
        const health = await fetch(origin + '/health');
        if (!health.ok) throw new Error('Health request failed');
      }
      const response = await pending;
      const body = await response.json();
      if (scenario === 'prime' || scenario === 'query') {
        const repeated = await request();
        if (!repeated.ok) throw new Error('Cached request failed: ' + await repeated.text());
      }
      const logPath = join(directory, 'probes.jsonl');
      const probes = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      outcomes.push({ scenario, status: response.status, body, probes, sdkCalls,
        diskSession: store.read('fixture').session_id });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(outcomes));
`;

interface Outcome {
  scenario: string;
  status: number;
  body: { code?: string; session_id?: string; answer?: string; error?: string };
  probes: Array<{ args: string[]; healthServedDuringProbe?: boolean }>;
  sdkCalls: Array<{ path: string; permissionMode: string; tools: string[]; allowedTools: string[] }>;
  diskSession: string | null;
}

// POSIX executable fixtures exercise real child processes; Windows discovery
// and capability decisions remain covered by find-claude-executable.test.ts.
describe.skipIf(process.platform === 'win32')('knowledge CLI probes and concurrent HTTP requests', () => {
  let outcomes: Outcome[];
  const outcome = (scenario: string) => outcomes.find(value => value.scenario === scenario)!;

  beforeAll(() => {
    const directory = mkdtempSync(join(tmpdir(), 'knowledge-cli-http-'));
    try {
      const child = Bun.spawnSync([process.execPath, '--preload', './tests/preload.ts', '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, KNOWLEDGE_PROBE_TEST_DIR: directory,
          CLAUDE_MEM_DATA_DIR: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'config') },
        stdout: 'pipe', stderr: 'pipe', timeout: 30000,
      });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
      outcomes = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);

  for (const scenario of ['prime', 'query']) {
    it(`serves health while the ${scenario} request awaits a native CLI capability probe`, () => {
      expect(outcome(scenario).probes[0].healthServedDuringProbe).toBe(true);
    });

    it(`keeps ${scenario} results, capability flags, cached resolution and tool denial intact`, () => {
      const result = outcome(scenario);
      expect(result.status).toBe(200);
      expect(result.diskSession).toBe('fixture-session');
      expect(result.probes).toHaveLength(1);
      expect(result.probes[0].args).toEqual(['--permission-mode', 'dontAsk', '--version']);
      expect(result.sdkCalls).toHaveLength(2);
      for (const call of result.sdkCalls) {
        expect(call.path.endsWith('claude with spaces')).toBe(true);
        expect(call.permissionMode).toBe('dontAsk');
        expect(call.tools).toEqual([]);
        expect(call.allowedTools).toEqual([]);
      }
      if (scenario === 'query') expect(result.body.answer).toBe('Fixture answer');
    });
  }

  it('still reports a CLI that rejects dontAsk as setup-required without starting an SDK request', () => {
    const result = outcome('incompatible');
    expect(result.status).toBe(424);
    expect(result.body.code).toBe('CLAUDE_CLI_SETUP_REQUIRED');
    expect(result.sdkCalls).toEqual([]);
    expect(result.probes.map(probe => probe.args)).toEqual([['--permission-mode', 'dontAsk', '--version'], ['--version']]);
  });

  it('keeps a present but unspawnable CLI as a server fault', () => {
    const result = outcome('launch-failure');
    expect(result.status).toBe(500);
    expect(result.sdkCalls).toEqual([]);
    expect(result.body.error).toContain('ENOENT');
  });
});
