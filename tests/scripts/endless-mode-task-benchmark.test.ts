import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TEE_INJECT_PLACEHOLDER, startTee } from '../../scripts/endless-mode-validation/forward/tee-proxy';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const TASKS = join(REPO_ROOT, 'scripts/endless-mode-validation/tasks');
// Scratch space inside the repo (.scratch is gitignored), removed after the run.
const scratchRoot = join(REPO_ROOT, '.scratch');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'emv-tasks-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function python(code: string) {
  const run = Bun.spawnSync(['python3', '-c', code], { cwd: TASKS });
  return { code: run.exitCode, stdout: run.stdout.toString().trim(), stderr: run.stderr.toString() };
}

describe('task benchmark extract.py', () => {
  it('reads usage from a streamed response, final output count included', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":300,"cache_read_input_tokens":1000,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":300},"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":42}}',
      '',
    ].join('\n');
    const read = (text: string) => {
      const file = join(scratch, 'resp.raw');
      writeFileSync(file, text);
      const out = python(`import json, extract; m, u, o, done = extract.usage_of(open(${JSON.stringify(file)}, 'rb').read()); print(json.dumps([m, u['cache_read_input_tokens'], u['cache_creation']['ephemeral_1h_input_tokens'], o, done]))`);
      expect(out.code).toBe(0);
      return JSON.parse(out.stdout);
    };
    // Cut off before message_stop: the usage is read, and the response is flagged as not complete.
    expect(read(sse)).toEqual(['claude-haiku-5-5', 1000, 300, 42, false]);
    expect(read(`${sse}\nevent: message_stop\ndata: {"type":"message_stop"}\n`)).toEqual(['claude-haiku-5-5', 1000, 300, 42, true]);
  });

  it('prices cache writes and reads, and a prompt over the long-prompt threshold at the long rates', () => {
    const out = python([
      'import json, extract',
      "p = extract.price_of('claude-haiku-5-5')",
      // 1M fresh input + 1M 5-minute writes + 1M 1-hour writes + 1M reads + 1M output, short-prompt rates
      'short, short_long = extract.cost(p, 1_000_000, 0, 0, 0, 0)',
      'parts = [extract.cost(dict(p, long_over=10**12), *args)[0] for args in [(1e6,0,0,0,0),(0,1e6,0,0,0),(0,0,1e6,0,0),(0,0,0,1e6,0),(0,0,0,0,1e6)]]',
      'long_in, is_long = extract.cost(p, 200_000, 0, 0, 0, 0)',
      'flat, flat_long = extract.cost(p, 200_000, 0, 0, 0, 0, flat=True)',
      'print(json.dumps([[round(x, 6) for x in parts], round(long_in, 6), is_long, round(flat, 6), flat_long]))',
    ].join('\n'));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([[0.1, 0.125, 0.2, 0.01, 0.5], 0.1, true, 0.02, false]);
  });

  it('refuses a model it has no price for', () => {
    const out = python("import extract; extract.price_of('some-unknown-model')");
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('no price for model');
  });
});

describe('tee-proxy --inject-claude-token', () => {
  it('swaps only the placeholder bearer for the real token and adds the OAuth beta', async () => {
    const seen: Array<[string, string]> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push([request.headers.get('authorization') ?? '', request.headers.get('anthropic-beta') ?? '']);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const tee = startTee({ port: 0, upstream: `http://127.0.0.1:${upstream.port}`, outDir: join(scratch, 'tee-inject'), injectToken: () => 'real-token' });
    const send = (auth: string) => fetch(`http://127.0.0.1:${tee.port}/v1/messages`, {
      method: 'POST', headers: { authorization: auth, 'anthropic-beta': 'some-beta', 'content-type': 'application/json' }, body: '{}',
    }).then(r => r.text());
    await send(`Bearer ${TEE_INJECT_PLACEHOLDER}`);
    await send('Bearer someone-elses-token');
    tee.stop(true);
    upstream.stop(true);
    expect(seen).toEqual([['Bearer real-token', 'some-beta,oauth-2025-04-20'], ['Bearer someone-elses-token', 'some-beta']]);
    const saved = readdirSync(join(scratch, 'tee-inject')).map(f => readFileSync(join(scratch, 'tee-inject', f), 'utf8')).join('\n');
    expect(saved).not.toContain('real-token');
  });
});

describe('task benchmark run_session.py', () => {
  it('grades with the hidden tests, counts failures, and checks the standing rule', () => {
    const bench = join(scratch, 'bench');
    const proj = join(scratch, 'proj');
    const ex = join(bench, 'adder');
    mkdirSync(join(ex, '.meta'), { recursive: true });
    mkdirSync(join(ex, '.docs'), { recursive: true });
    writeFileSync(join(ex, '.meta', 'config.json'), JSON.stringify({ files: { solution: ['adder.py'], test: ['adder_test.py'] } }));
    writeFileSync(join(ex, '.docs', 'instructions.md'), 'Add two numbers.');
    writeFileSync(join(ex, 'adder.py'), 'def add(a, b):\n    pass\n');
    // Unittest classes, like the benchmark's own test files, so both runners can grade them.
    writeFileSync(join(ex, 'adder_test.py'), 'import unittest\nfrom adder import add\n\nclass AdderTest(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(add(1, 2), 3)\n\n    def test_two(self):\n        self.assertEqual(add(2, 2), 4)\n');
    const run = (code: string) => python(`import json, run_session as r\nfrom pathlib import Path\nbench, proj = Path(${JSON.stringify(bench)}), Path(${JSON.stringify(proj)})\n${code}`);

    const prepared = run("r.prepare_project(proj, bench, ['adder']); print(json.dumps(sorted(p.name for p in (proj / 'adder').iterdir())))");
    expect(prepared.code).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual(['INSTRUCTIONS.md', 'adder.py']); // the tests stay hidden

    // unittest is always there; pytest (what real runs use) is graded too wherever it is installed.
    const runners = python('import pytest').code === 0 ? ['unittest', 'pytest'] : ['unittest'];
    const gradeWith = (runner: string) => {
      const out = run(`p, f, _ = r.grade(proj, bench, 'adder', runner='${runner}'); print(json.dumps([p, f, r.rule_kept(proj, bench, 'adder')]))`);
      expect(out.code).toBe(0);
      return JSON.parse(out.stdout);
    };
    for (const runner of runners) expect(gradeWith(runner)).toEqual([0, 2, 0]);

    writeFileSync(join(proj, 'adder', 'adder.py'), '# Benchmark session solution\ndef add(a, b):\n    return a + b\n');
    for (const runner of runners) expect(gradeWith(runner)).toEqual([2, 0, 1]);
  });
});
