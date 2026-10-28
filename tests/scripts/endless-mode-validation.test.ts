import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readClaudeAccessToken, startTee } from '../../scripts/endless-mode-validation/forward/tee-proxy';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const HARNESS = join(REPO_ROOT, 'scripts/endless-mode-validation');
// Scratch space inside the repo (.scratch is gitignored), removed after the run.
const scratchRoot = join(REPO_ROOT, '.scratch');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'emv-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function python(args: string[]) {
  const run = Bun.spawnSync(['python3', ...args], { cwd: REPO_ROOT });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe('forward tee-proxy', () => {
  it('retries a 401 once with the re-read claude.ai token, logs the retry, and never writes a token', async () => {
    const seen: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const auth = request.headers.get('authorization') ?? '';
        seen.push(auth);
        return auth === 'Bearer fresh-token' ? new Response('data: {"type":"message_start"}\n\n', { status: 200 }) : new Response('expired', { status: 401 });
      },
    });
    const outDir = join(scratch, 'tee-retry');
    const tee = startTee({ port: 0, upstream: `http://127.0.0.1:${upstream.port}`, outDir, refreshToken: () => 'fresh-token' });
    const response = await fetch(`http://127.0.0.1:${tee.port}/v1/messages`, {
      method: 'POST', headers: { authorization: 'Bearer stale-token', 'content-type': 'application/json' }, body: '{"messages":[]}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('message_start');
    expect(seen).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
    const retries = readFileSync(join(outDir, 'retries.tsv'), 'utf8').trim().split('\t');
    expect(retries.slice(1)).toEqual(['0001', '401', '200']);
    expect(readFileSync(join(outDir, 'index.tsv'), 'utf8')).toContain('0001\tPOST\t/v1/messages\t200');
    expect(readFileSync(join(outDir, '0001-req.body'), 'utf8')).toBe('{"messages":[]}');
    for (const file of readdirSync(outDir)) {
      const text = readFileSync(join(outDir, file), 'utf8');
      expect(text).not.toContain('stale-token');
      expect(text).not.toContain('fresh-token');
    }
    tee.stop(true); upstream.stop(true);
  });

  it('passes a 401 through unchanged without --refresh-claude-token', async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 401 }) });
    const tee = startTee({ port: 0, upstream: `http://127.0.0.1:${upstream.port}`, outDir: join(scratch, 'tee-plain') });
    const response = await fetch(`http://127.0.0.1:${tee.port}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(existsSync(join(scratch, 'tee-plain', 'retries.tsv'))).toBe(false);
    tee.stop(true); upstream.stop(true);
  });

  it('refuses a WebSocket upgrade with 426 without forwarding it, as the gateway does', async () => {
    let forwarded = 0;
    const upstream = Bun.serve({ port: 0, fetch: () => { forwarded++; return new Response('ok'); } });
    const tee = startTee({ port: 0, upstream: `http://127.0.0.1:${upstream.port}`, outDir: join(scratch, 'tee-ws') });
    const response = await fetch(`http://127.0.0.1:${tee.port}/responses`, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
    expect(response.status).toBe(426);
    expect(forwarded).toBe(0);
    tee.stop(true); upstream.stop(true);
  });

  it('saves a zstd-compressed request body decompressed and forwards the original bytes', async () => {
    let upstreamBody: Uint8Array | null = null;
    const upstream = Bun.serve({ port: 0, async fetch(request) { upstreamBody = new Uint8Array(await request.arrayBuffer()); return new Response('ok'); } });
    const outDir = join(scratch, 'tee-zstd');
    const tee = startTee({ port: 0, upstream: `http://127.0.0.1:${upstream.port}`, outDir });
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode('{"input":[]}'));
    await fetch(`http://127.0.0.1:${tee.port}/responses`, { method: 'POST', headers: { 'content-encoding': 'zstd' }, body: compressed });
    expect(readFileSync(join(outDir, '0001-req.body'), 'utf8')).toBe('{"input":[]}');
    expect(upstreamBody).toEqual(new Uint8Array(compressed));
    tee.stop(true); upstream.stop(true);
  });

  it('reads the token from EMV_CLAUDE_OAUTH_TOKEN first, then the credentials file', () => {
    expect(readClaudeAccessToken({ EMV_CLAUDE_OAUTH_TOKEN: 'from-env' })).toBe('from-env');
    const claudeDir = join(scratch, 'claude-dir');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }));
    // EMV_REAL_HOME points at a home with no keychain, so the macOS lookup finds nothing and the file is used.
    expect(readClaudeAccessToken({ EMV_REAL_HOME: join(scratch, 'no-home'), EMV_REAL_USER: 'nobody', EMV_REAL_CLAUDE_DIR: claudeDir })).toBe('from-file');
    expect(readClaudeAccessToken({ EMV_REAL_CLAUDE_DIR: join(scratch, 'missing') })).toBeNull();
  });
});

describe('forward extract, stats and tables', () => {
  function writeStack(stack: string, config: string, timelineBlocks: number, cacheRead: number) {
    const tee = join(stack, 'tee-anthropic');
    mkdirSync(tee, { recursive: true }); mkdirSync(join(stack, 'logs'), { recursive: true });
    writeFileSync(join(stack, 'logs', 'session.sid'), 'sid-123');
    writeFileSync(join(stack, 'logs', 'session.log'), [
      '2026-10-01T10:00:00Z turn 1 start', 'rc=0 secs=20 error=False turns=2 sid=sid-123 cost=0.1', 'reply',
      '2026-10-01T10:00:30Z turn 1 done; observer wait 10s; status {}',
      '2026-10-01T10:01:00Z turn 2 start', 'rc=0 secs=20 error=False turns=2 sid=sid-123 cost=0.1', 'reply',
      '2026-10-01T10:01:30Z turn 2 done; observer wait 10s; status {}',
    ].join('\n') + '\n');
    const timeline = timelineBlocks ? [{ type: 'text', text: '<claude-mem-timeline>\nrows' }, ...Array.from({ length: timelineBlocks - 1 }, () => ({ type: 'text', text: 'U: x' })), { type: 'text', text: '</claude-mem-timeline>' }] : [];
    const requests = [
      { n: '0001', time: '2026-10-01T10:00:05Z', read: 0 },
      { n: '0002', time: '2026-10-01T10:01:05Z', read: cacheRead },
    ];
    for (const r of requests) {
      const body = {
        model: 'm', metadata: { user_id: 'user_x_session_sid-123' },
        messages: [
          ...(timeline.length ? [{ role: 'user', content: timeline }] : []),
          { role: 'assistant', content: [{ type: 'tool_use', id: `call-${r.n}`, name: 'Read', input: { file_path: '/p/calc.py' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${r.n}`, content: 'x' }] },
        ],
      };
      writeFileSync(join(tee, `${r.n}-req.body`), JSON.stringify(body));
      writeFileSync(join(tee, `${r.n}-req.json`), JSON.stringify({ time: r.time, method: 'POST', path: '/v1/messages', headerNames: [], bodyBytes: 1 }));
      writeFileSync(join(tee, `${r.n}-resp.raw`), [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: r.read, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } } } })}`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 100 } })}`, '',
      ].join('\n'));
    }
    writeFileSync(join(tee, 'index.tsv'), requests.map(r => `${r.n}\tPOST\t/v1/messages\t200\ttext/event-stream`).join('\n') + '\n');
    return tee;
  }

  it('reduces the bodies, prices the usage per turn and prints the comparison', () => {
    const results = join(scratch, 'results'); mkdirSync(results, { recursive: true });
    const stacks: Record<string, string> = {};
    for (const [config, blocks, read] of [['none', 0, 5000], ['timeline', 3, 20000]] as const) {
      const stack = join(scratch, 'stacks', config);
      const tee = writeStack(stack, config, blocks, read);
      stacks[config] = stack;
      const stop = join(scratch, `stop-${config}`); writeFileSync(stop, '');
      expect(python([join(HARNESS, 'forward/extract.py'), stop, tee]).code).toBe(0);
      expect(readdirSync(tee).filter(f => f.endsWith('-req.body'))).toEqual([]);
      const stats = python([join(HARNESS, 'forward/stats.py'), stack, join(HARNESS, 'prices/anthropic-claude-opus-5-5.json')]);
      expect(stats.code).toBe(0);
      writeFileSync(join(results, `${config}.json`), stats.stdout);
    }
    const timeline = JSON.parse(readFileSync(join(results, 'timeline.json'), 'utf8'));
    expect(timeline.turns).toBe(2);
    expect(timeline.requests).toBe(2);
    expect(timeline.tool_calls).toBe(2);
    expect(timeline.file_reads).toBe(2);
    expect(timeline.file_rereads).toBe(1);
    expect(timeline.timeline_end.blocks).toBe(3);
    // (10 * $4 + 1000 * $8 + read * $0.20 + 100 * $20) / 1e6 per request
    expect(timeline.total_cost_usd).toBeCloseTo((2 * (10 * 4 + 1000 * 8 + 100 * 20) + 20000 * 0.2) / 1e6, 4);
    expect(timeline.per_turn['1'].requests).toBe(1);
    expect(timeline.errors).toEqual([]);
    const tables = python([join(HARNESS, 'forward/tables.py'), results]);
    expect(tables.code).toBe(0);
    expect(tables.stdout).toContain('| total_cost_usd |');
    expect(tables.stdout).toContain('Endless `timeline`');
  });
});

describe('backtest validation gate', () => {
  function writeSim(root: string, sessionId: string, simRead: number, simWrite: number) {
    const dir = join(root, sessionId); mkdirSync(dir, { recursive: true });
    const row = (read: number, write: number) => ({ prompt: 100_000, read, write_1h: write, write_5m: 0, uncached: 10, output: 100, cost: (read * 0.2 + write * 8 + 10 * 4 + 100 * 20) / 1e6 });
    const recorded = Array.from({ length: 20 }, () => row(90_000, 1_000));
    const simulated = Array.from({ length: 20 }, () => row(simRead, simWrite));
    writeFileSync(join(dir, 'sim-a.json'), JSON.stringify({ a: simulated, recorded }));
  }

  it('passes when the simulator reproduces the recorded usage', () => {
    const root = join(scratch, 'gate-pass'); writeSim(root, 'aaaaaaaa', 90_100, 1_000);
    writeFileSync(join(root, 'labels.json'), JSON.stringify({ aaaaaaaa: 's01' }));
    const run = python([join(HARNESS, 'backtest/validate.py'), root, join(root, 'labels.json'), join(root, 'out')]);
    expect(run.code).toBe(0);
    expect(readFileSync(join(root, 'out', 'validation.md'), 'utf8')).toContain('**PASS**');
    expect(readFileSync(join(root, 'out', 'validation.md'), 'utf8')).not.toContain('aaaaaaaa');
  });

  it('fails (exit 1) when the simulated cost is off by more than 2%', () => {
    const root = join(scratch, 'gate-fail'); writeSim(root, 'bbbbbbbb', 90_000, 3_000);
    writeFileSync(join(root, 'labels.json'), JSON.stringify({ bbbbbbbb: 's01' }));
    const run = python([join(HARNESS, 'backtest/validate.py'), root, join(root, 'labels.json'), join(root, 'out')]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('**FAIL**');
  });
});
