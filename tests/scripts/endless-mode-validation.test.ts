import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import { PinVerifier, isInferencePath, providerMatchesPin, readClaudeAccessToken, startTee } from '../../scripts/endless-mode-validation/forward/tee-proxy';

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

describe('forward tee-proxy: endpoint pin', () => {
  const PIN = { providerSlug: 'deepinfra/fp8', model: 'deepseek/deepseek-v4.1-flash-1017' };
  const PIN_FIELD = { order: ['deepinfra/fp8'], allow_fallbacks: false };
  const servedBy = (provider: string, model = PIN.model) => `data: ${JSON.stringify({ model, provider, choices: [] })}\n\ndata: [DONE]\n\n`;

  function pinnedTee(name: string, answer: (request: Request, path: string) => Response, extra: Record<string, unknown> = {}) {
    const received: { path: string; body: Record<string, unknown>; encoding: string | null }[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const text = await request.text();
        received.push({ path, encoding: request.headers.get('content-encoding'), body: text ? JSON.parse(text) : {} });
        return answer(request, path);
      },
    });
    const outDir = join(scratch, name);
    const tee = startTee({ port: 0, upstream: `http://127.0.0.1:${upstream.port}`, outDir, pin: PIN, ...extra });
    const post = (path: string, body: object) => fetch(`http://127.0.0.1:${tee.port}${path}`, { method: 'POST', body: JSON.stringify(body) });
    return { tee, upstream, outDir, received, post, stop() { tee.stop(true); upstream.stop(true); } };
  }

  it('sets the pin on /v1/messages, /v1/chat/completions and /v1/responses, and leaves other paths alone', async () => {
    const t = pinnedTee('pin-inject', () => new Response(servedBy('DeepInfra')));
    for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
      await (await t.post(path, { model: PIN.model, provider: { order: ['other'] } })).text();
    }
    await (await t.post('/v1/messages/count_tokens', { model: 'anything' })).text();
    expect(t.received.map(r => r.body.provider)).toEqual([PIN_FIELD, PIN_FIELD, PIN_FIELD, undefined]);
    expect(JSON.parse(readFileSync(join(t.outDir, '0002-req.body'), 'utf8')).provider).toEqual(PIN_FIELD);
    expect(existsSync(join(t.outDir, 'OFF-PIN'))).toBe(false);
    t.stop();
  });

  it('decompresses a zstd body before editing it and drops the header', async () => {
    const t = pinnedTee('pin-zstd', () => new Response(servedBy('DeepInfra')));
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ model: PIN.model, input: [] })));
    await (await fetch(`http://127.0.0.1:${t.tee.port}/v1/responses`, { method: 'POST', headers: { 'content-encoding': 'zstd' }, body: compressed })).text();
    expect(t.received[0]!.encoding).toBeNull();
    expect(t.received[0]!.body.provider).toEqual(PIN_FIELD);
    t.stop();
  });

  it('stops on a response from another provider: the marker is written and later requests never go upstream', async () => {
    const t = pinnedTee('pin-offpin', () => new Response(servedBy('Wafer')));
    await t.post('/v1/chat/completions', { model: PIN.model }).then(r => r.text()).catch(() => 'stream failed');
    expect(readFileSync(join(t.outDir, 'OFF-PIN'), 'utf8')).toContain('served by provider Wafer');
    const next = await t.post('/v1/chat/completions', { model: PIN.model });
    expect(next.status).toBe(502);
    expect(await next.text()).toContain('Wafer');
    expect(t.received.length).toBe(1);
    t.stop();
  });

  it('stops on a served model other than the pinned one, in the Anthropic stream shape too', async () => {
    const t = pinnedTee('pin-offmodel', () => new Response(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'other/model', provider: 'DeepInfra' } })}\n\n`));
    await t.post('/v1/messages', { model: PIN.model }).then(r => r.text()).catch(() => 'stream failed');
    expect(readFileSync(join(t.outDir, 'OFF-PIN'), 'utf8')).toContain('served by model other/model');
    t.stop();
  });

  it('refuses a request for another model without sending it, so no full-price model can run', async () => {
    const t = pinnedTee('pin-refuse-model', () => new Response(servedBy('DeepInfra')));
    const refused = await t.post('/v1/messages', { model: 'claude-opus-5-5' });
    expect(refused.status).toBe(502);
    expect(t.received.length).toBe(0);
    expect(readFileSync(join(t.outDir, 'OFF-PIN'), 'utf8')).toContain('claude-opus-5-5');
    t.stop();
  });

  it('asks OpenRouter which provider served a /responses answer, which names none, and stops on a wrong one', async () => {
    const answer = (provider: string) => (request: Request, path: string) => path === '/v1/generation'
      ? Response.json({ data: { provider_name: provider } })
      : new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'gen-1', model: PIN.model, usage: {} } })}\n\n`);
    for (const [name, provider, offPin] of [['pin-gen-ok', 'DeepInfra', false], ['pin-gen-off', 'Wafer', true]] as const) {
      const t = pinnedTee(name, answer(provider), { generationLookupDelaysMs: [1] });
      await (await t.post('/v1/responses', { model: PIN.model, input: [] })).text();
      await Bun.sleep(50);
      expect(existsSync(join(t.outDir, 'OFF-PIN'))).toBe(offPin);
      expect(readFileSync(join(t.outDir, 'generation-lookups.tsv'), 'utf8')).toContain(provider);
      t.stop();
    }
  });

  it('retries a 429 with its waits, logs each attempt, and passes it on when they run out', async () => {
    let calls = 0;
    const t = pinnedTee('pin-429', () => (++calls <= 2 ? new Response('slow down', { status: 429 }) : new Response(servedBy('DeepInfra'))), { retry429DelaysMs: [1, 1] });
    expect((await t.post('/v1/chat/completions', { model: PIN.model })).status).toBe(200);
    expect(readFileSync(join(t.outDir, '429s.tsv'), 'utf8').trim().split('\n').length).toBe(2);
    t.stop();
    const always = pinnedTee('pin-429-out', () => new Response('slow down', { status: 429 }), { retry429DelaysMs: [1] });
    expect((await always.post('/v1/chat/completions', { model: PIN.model })).status).toBe(429);
    expect(always.received.length).toBe(2);
    expect(readFileSync(join(always.outDir, '429s.tsv'), 'utf8')).toContain('gave up');
    always.stop();
  });

  it('reads a provider split across chunks and a whole-JSON answer, and matches slugs to provider names', () => {
    const stream = new PinVerifier(PIN);
    const text = servedBy('Wafer');
    stream.feed(text.slice(0, 20)); stream.feed(text.slice(20));
    expect(stream.violation).toContain('Wafer');
    const whole = new PinVerifier(PIN);
    whole.feed(JSON.stringify({ model: PIN.model, provider: 'DeepInfra' })); whole.finish();
    expect(whole.violation).toBeNull();
    expect(whole.needsGenerationLookup).toBe(false);
    expect(providerMatchesPin('InferenceNet', { ...PIN, providerSlug: 'inference-net/fp8' })).toBe(true);
    expect(providerMatchesPin('DeepInfra', { ...PIN, providerSlug: 'deepinfra/fp8/flex' })).toBe(true);
    expect(isInferencePath('/v1/messages/count_tokens')).toBe(false);
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
      // `release` gets OpenRouter's stream shape: nulls in message_start, the real numbers and a cost in message_delta.
      writeFileSync(join(tee, `${r.n}-resp.raw`), (config === 'release' ? [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null } } })}`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: r.read, cache_creation_input_tokens: null, cost: 0.001 } })}`, '',
      ] : [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: r.read, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } } } })}`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 100 } })}`, '',
      ]).join('\n'));
    }
    writeFileSync(join(tee, 'index.tsv'), requests.map(r => `${r.n}\tPOST\t/v1/messages\t200\ttext/event-stream`).join('\n') + '\n');
    return tee;
  }

  it('reduces the bodies, prices the usage per turn and prints the comparison', () => {
    const results = join(scratch, 'results'); mkdirSync(results, { recursive: true });
    const stacks: Record<string, string> = {};
    for (const [config, blocks, read] of [['none', 0, 5000], ['timeline', 3, 20000], ['release', 0, 6000]] as const) {
      const stack = join(scratch, 'stacks', config);
      const tee = writeStack(stack, config, blocks, read);
      if (config === 'release') {
        mkdirSync(join(stack, 'data'), { recursive: true });
        const db = new Database(join(stack, 'data', 'claude-mem.db'));
        db.run('create table observations (id integer)'); db.run('create table session_summaries (id integer)');
        db.run('insert into observations values (1), (2), (3)'); db.run('insert into session_summaries values (1)');
        db.close();
      }
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
    // The release configuration: its own column, a crossing line against it, and what its claude-mem stored.
    const release = JSON.parse(readFileSync(join(results, 'release.json'), 'utf8'));
    expect(release.observations_stored).toBe(3);
    expect(release.summaries_stored).toBe(1);
    expect(release.measured_cost_usd).toBeCloseTo(0.002, 6);
    expect(release.per_turn['2'].measured).toBeCloseTo(0.001, 6);
    expect(release.cache_read).toBe(6000);
    expect(tables.stdout).toContain('Provider-reported cost per 1-turn bucket');
    expect(JSON.parse(readFileSync(join(results, 'none.json'), 'utf8')).observations_stored).toBeNull();
    expect(tables.stdout).toContain('claude-mem release (no gateway)');
    expect(tables.stdout).toContain('Endless `timeline` vs claude-mem release (no gateway): never drops below');
    expect(tables.stdout).toContain('observations stored 3, summaries 1');
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

// Runs zsh with a clean harness environment (no EMV_* or provider variables from the caller).
function harnessEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('EMV_') && !/^(ANTHROPIC_|OPENROUTER_|CLAUDE_)/.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}
function zsh(script: string, env: Record<string, string>) {
  const run = Bun.spawnSync(['zsh', '-c', script], { cwd: REPO_ROOT, env: harnessEnv(env) });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}
const ENV_SH = join(HARNESS, 'forward/lib/env.sh');
const PIN_ENV = { EMV_PIN_PROVIDER: 'deepinfra/fp8' };

describe('forward model profiles: discount models only', () => {
  it('refuses a run with no profile, the anthropic profile and Codex, with a clear message', () => {
    const none = zsh(`source '${ENV_SH}' && emv_check_profile`, {});
    expect(none.code).toBe(4);
    expect(none.stderr).toContain('refused: no EMV_MODEL_PROFILE set, and there is no fallback to Claude');
    const anthropic = zsh(`source '${ENV_SH}' && emv_check_profile`, { EMV_MODEL_PROFILE: 'anthropic' });
    expect(anthropic.code).toBe(4);
    expect(anthropic.stderr).toContain('refused: EMV_MODEL_PROFILE=anthropic runs Claude models');
    const codex = zsh(`source '${ENV_SH}' && emv_check_profile`, { EMV_MODEL_PROFILE: 'openrouter-deepseek-flash', EMV_AGENT: 'codex', OPENROUTER_API_KEY: 'sk-or-test', ...PIN_ENV });
    expect(codex.code).toBe(4);
    expect(zsh(`source '${ENV_SH}' && emv_check_profile`, { EMV_MODEL_PROFILE: 'anthropic', EMV_ALLOW_FULL_PRICE_MODELS: '1' }).code).toBe(0);
    expect(zsh(`source '${ENV_SH}' && emv_check_profile`, { EMV_MODEL_PROFILE: 'openrouter-deepseek-flash', OPENROUTER_API_KEY: 'sk-or-test', ...PIN_ENV }).code).toBe(0);
  });

  it('refuses a key found only in claude-mem settings.json', () => {
    const home = join(scratch, 'settings-only-home'), memDir = join(home, '.claude-mem');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-only-in-settings' }));
    const refused = zsh(`source '${ENV_SH}' && emv_read_openrouter_key`, {
      EMV_REAL_HOME: home, EMV_REAL_CLAUDE_MEM_DIR: memDir, EMV_REAL_USER: 'nobody', EMV_OPENROUTER_KEYCHAIN_SERVICE: 'emv-test-no-such-entry',
    });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('no OpenRouter key');
    expect(refused.stderr + refused.stdout).not.toContain('sk-or-only-in-settings');
  });

  it('refuses the OpenRouter profile when no endpoint is pinned', () => {
    const r = zsh(`source '${ENV_SH}' && emv_check_profile`, { EMV_MODEL_PROFILE: 'openrouter-deepseek-flash', OPENROUTER_API_KEY: 'sk-or-test', EMV_CARD: join(scratch, 'no-such-card.json') });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no pinned endpoint');
  });

  it('stops a session before its next turn once the tee has written OFF-PIN', () => {
    const runDir = join(scratch, 'off-pin-run');
    const tee = join(runDir, 'stacks', 'none', 'tee-anthropic');
    mkdirSync(tee, { recursive: true }); mkdirSync(join(runDir, 'stacks', 'none', 'logs'), { recursive: true });
    writeFileSync(join(tee, 'OFF-PIN'), '0001\tserved by provider Wafer\n');
    const r = zsh(`zsh '${join(HARNESS, 'forward/session.sh')}' none 1 1`, { EMV_RUN_DIR: runDir, EMV_MODEL_PROFILE: 'openrouter-deepseek-flash', OPENROUTER_API_KEY: 'sk-or-test', ...PIN_ENV });
    expect(r.code).toBe(5);
    expect(r.stdout).toContain('STOP: off-pin response before turn 1');
    expect(readFileSync(join(runDir, 'stacks', 'none', 'logs', 'session.log'), 'utf8')).not.toContain('turn 1 start');
  });

  it('refuses before an agent turn starts, so no turn can run on Claude', () => {
    const turn = zsh(`EMV_CONFIG=none zsh '${join(HARNESS, 'forward/agent-turn.sh')}' t1 hello first`, { EMV_RUN_DIR: join(scratch, 'refused-run') });
    expect(turn.code).toBe(4);
    expect(turn.stderr).toContain('refused');
  });
});

describe('forward release configuration', () => {
  it('has its own ports after the existing four, and is not in the default set', () => {
    const r = zsh(`source '${ENV_SH}' && emv_ports release && print $EMV_WORKER_PORT $EMV_TEE_ANTHROPIC_PORT && print -r -- "$EMV_DEFAULT_CONFIGS"`, {});
    expect(r.stdout.split('\n')[0]).toBe('38140 38142');
    expect(r.stdout.split('\n')[1]).toBe('none off timeline observation');
  });

  it('installs with npx into the sandbox only, keeps the installer settings, and points Claude Code at its tee', () => {
    // Stand-ins for npm and npx that do what the real installer does to the sandbox (checked by hand against
    // claude-mem 15.4.0's installer): plugin cache, registry, enabledPlugins, launcher, data-dir settings.
    const bin = join(scratch, 'stub-bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$1" = view ] && echo 9.8.7\n');
    writeFileSync(join(bin, 'npx'), `#!/bin/sh
echo "npx $*" >> "$CLAUDE_MEM_DATA_DIR/../logs/npx-args.log"
root="$CLAUDE_CONFIG_DIR/plugins/cache/thedotmack/claude-mem/9.8.7"
mkdir -p "$root/scripts" "$root/.claude-plugin" "$HOME/.local/bin"
echo '{"version":"9.8.7"}' > "$root/.claude-plugin/plugin.json"; : > "$root/scripts/worker-service.cjs"
printf '#!/bin/sh\\n' > "$HOME/.local/bin/claude-mem"; chmod +x "$HOME/.local/bin/claude-mem"
echo '{"enabledPlugins":{"claude-mem@thedotmack":true}}' > "$CLAUDE_CONFIG_DIR/settings.json"
echo '{"CLAUDE_MEM_PROVIDER":"claude","CLAUDE_MEM_CLAUDE_AUTH_METHOD":"subscription"}' > "$CLAUDE_MEM_DATA_DIR/settings.json"
`);
    chmodSync(join(bin, 'npm'), 0o755); chmodSync(join(bin, 'npx'), 0o755);
    const runDir = join(scratch, 'release-run');
    const setup = zsh(`zsh '${join(HARNESS, 'forward/setup-stack.sh')}' release`, {
      PATH: `${bin}:${process.env.PATH}`, EMV_RUN_DIR: runDir, EMV_MODEL_PROFILE: 'openrouter-deepseek-flash', OPENROUTER_API_KEY: 'sk-or-test-key', ...PIN_ENV,
    });
    expect(setup.stderr).toBe('');
    expect(setup.code).toBe(0);
    const stack = join(runDir, 'stacks', 'release');
    expect(readFileSync(join(stack, 'logs', 'npx-args.log'), 'utf8')).toContain('-y claude-mem@9.8.7 install --provider claude --no-auto-start');
    expect(readFileSync(join(stack, 'release-version.txt'), 'utf8').trim()).toBe('9.8.7');
    const claudeSettings = JSON.parse(readFileSync(join(stack, 'claude-config', 'settings.json'), 'utf8'));
    expect(claudeSettings.enabledPlugins['claude-mem@thedotmack']).toBe(true);
    expect(claudeSettings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:38142');  // its tee, no gateway
    expect(claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek/deepseek-v4.1-flash-1017');
    const memSettings = JSON.parse(readFileSync(join(stack, 'data', 'settings.json'), 'utf8'));
    expect(memSettings.CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe('subscription');  // the installer's own setting is kept
    expect(memSettings.CLAUDE_MEM_PROVIDER).toBe('openrouter');  // the observer matches the other claude-mem configs
    expect(memSettings.CLAUDE_MEM_OPENROUTER_MODEL).toBe('deepseek/deepseek-v4.1-flash-1017');
    expect(JSON.parse(memSettings.CLAUDE_MEM_OPENROUTER_EXTRA_BODY)).toEqual({ provider: { order: ['deepinfra/fp8'], allow_fallbacks: false } });
    expect(memSettings.CLAUDE_MEM_WORKER_PORT).toBe('38140');
    expect(Object.keys(memSettings).filter(k => k.startsWith('CLAUDE_MEM_WIRE_GATEWAY'))).toEqual([]);
    for (const file of [join(stack, 'data', 'settings.json'), join(stack, 'claude-config', 'settings.json')]) {
      expect(readFileSync(file, 'utf8')).not.toContain('sk-or-test-key');
    }
    // The sandbox's launcher comes before the contributor's own ~/.local/bin.
    const path = zsh(`source '${ENV_SH}' && emv_use_stack release && command -v claude-mem`, { PATH: `${bin}:${process.env.PATH}`, EMV_RUN_DIR: runDir });
    expect(path.stdout.trim()).toBe(join(stack, 'home', '.local', 'bin', 'claude-mem'));
  });

  it('marks the replies that name claude-mem in the key file, never in the judges folder', () => {
    const run = join(scratch, 'blind-run');
    for (const [config, reply] of [['none', 'plain reply'], ['release', 'I checked claude-mem memory first']]) {
      mkdirSync(join(run, 'artifacts', config), { recursive: true });
      writeFileSync(join(run, 'artifacts', config, 'turns.jsonl'), JSON.stringify({ config, turn: 1, prompt: 'p', reply }) + '\n');
    }
    const judges = join(scratch, 'judges'), keyFile = join(scratch, 'blind-key.json');
    const r = python([join(HARNESS, 'forward/blind-artifacts.py'), run, judges, keyFile, join(HARNESS, 'forward/probe-turns-500.txt')]);
    expect(r.code).toBe(0);
    const key = JSON.parse(readFileSync(keyFile, 'utf8'));
    const releaseLetter = Object.entries(key.key).find(([, c]) => c === 'release')![0];
    expect(key.identifying_mentions).toEqual({ [releaseLetter]: [1] });
    for (const letter of Object.keys(key.key)) expect(readFileSync(join(judges, letter, 'turns.jsonl'), 'utf8')).not.toContain('"config"');
  });
});

describe('scripted prompts', () => {
  const F = join(HARNESS, 'forward');
  it('never refer to a turn by its number, and the check catches one that does', () => {
    expect(python([join(F, 'check-prompts.py'), join(F, 'prompts200.txt'), join(F, 'prompts500.txt')]).code).toBe(0);
    const bad = join(scratch, 'bad-prompts.txt'); writeFileSync(bad, 'Add a test.\nList what we built since turn 150.\n');
    const r = python([join(F, 'check-prompts.py'), bad]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('bad-prompts.txt:2');
  });

  it('prompts500 continues prompts200, and every probe points at earlier turns', () => {
    const p200 = readFileSync(join(F, 'prompts200.txt'), 'utf8').trimEnd().split('\n');
    const p500 = readFileSync(join(F, 'prompts500.txt'), 'utf8').trimEnd().split('\n');
    expect(p500.length).toBe(500);
    expect(p500.slice(0, 200)).toEqual(p200);
    const probes = readFileSync(join(F, 'probe-turns-500.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
    expect(probes.length).toBeGreaterThanOrEqual(60);
    for (const [turn, , refs, question] of probes) {
      expect(p500[Number(turn) - 1]).toBe(question);
      if (refs === '-') continue;
      for (const part of refs.split(',')) for (const n of part.split('-')) expect(Number(n)).toBeLessThan(Number(turn));
    }
    // About every 10th turn after 200 is a probe.
    expect(probes.filter(([t]) => Number(t) > 200).length).toBeGreaterThanOrEqual(30);
  });
});

describe('forward harness: chat-completions agents', () => {
  const forward = join(HARNESS, 'forward');

  function chatTurn(agent: string, stdout: string, stderr: string, exitCode = '0') {
    const directory = mkdtempSync(join(scratch, 'chat-turn-'));
    writeFileSync(join(directory, 'raw'), stdout);
    writeFileSync(join(directory, 'err'), stderr);
    writeFileSync(join(directory, 'sid'), 'emv-session');
    const run = python([join(forward, 'chat-turn-result.py'), agent, join(directory, 'raw'), join(directory, 'err'), join(directory, 'out.json'), exitCode, '5', join(directory, 'sid')]);
    return { status: run.stdout.split('\n')[0], out: JSON.parse(readFileSync(join(directory, 'out.json'), 'utf8')), sid: readFileSync(join(directory, 'sid'), 'utf8') };
  }

  it('reads a Hermes turn: the reply from stdout and the session id from stderr', () => {
    const turn = chatTurn('hermes', 'All 4 tests pass.\n', 'noise\nsession_id: local-abc\n');
    expect(turn.status).toBe('rc=0 secs=5 error=False sid=local-abc');
    expect(turn.out).toEqual({ result: 'All 4 tests pass.', session_id: 'local-abc' });
    expect(turn.sid).toBe('local-abc');
  });

  it('reads an OpenClaw turn after any log lines before its JSON', () => {
    const turn = chatTurn('openclaw', `[plugins] loaded\n${JSON.stringify({ payloads: [{ text: 'Done.' }], meta: {} })}`, '');
    expect(turn.status).toBe('rc=0 secs=5 error=False sid=emv-session');
    expect(turn.out.result).toBe('Done.');
  });

  it('calls a turn with no reply an error even when the agent exited 0', () => {
    expect(chatTurn('hermes', '', 'session_id: local-abc\n').status).toContain('error=True');
    expect(chatTurn('openclaw', JSON.stringify({ payloads: [], meta: {} }), '').status).toContain('error=True');
    expect(chatTurn('openclaw', JSON.stringify({ payloads: [{ text: 'partial' }], meta: { aborted: true } }), '').status).toContain('error=True');
  });

  it('extracts tool calls, file reads and side calls from a chat completion, and stats counts its usage and cost', () => {
    const stack = mkdtempSync(join(scratch, 'chat-stack-'));
    const tee = join(stack, 'tee-anthropic');
    mkdirSync(tee); mkdirSync(join(stack, 'logs'));
    const assistant = (id: string, name: string, args: object) => ({ role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
    writeFileSync(join(tee, '0001-req.body'), JSON.stringify({
      model: 'm', tools: [{}], messages: [assistant('a', 'read_file', { path: '/p/calc.py' }), assistant('b', 'exec', { command: 'cat calc.py' }), { role: 'tool', content: 'x' }],
    }));
    writeFileSync(join(tee, '0001-req.json'), JSON.stringify({ time: '2026-11-02T00:00:02Z', path: '/v1/chat/completions' }));
    writeFileSync(join(tee, '0001-resp.raw'), `data: ${JSON.stringify({ choices: [] })}\n\ndata: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 }, cost: 0.01 } })}\n\ndata: [DONE]\n`);
    writeFileSync(join(tee, '0002-req.body'), JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'title this' }] }));
    writeFileSync(join(tee, '0002-req.json'), JSON.stringify({ time: '2026-11-02T00:00:03Z', path: '/v1/chat/completions' }));
    writeFileSync(join(tee, '0002-resp.raw'), JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.001 } }));
    writeFileSync(join(tee, 'index.tsv'), '0001\tx\tx\t200\n0002\tx\tx\t200\n');
    writeFileSync(join(stack, 'logs', 'session.log'), '2026-11-02T00:00:01Z turn 1 start\nrc=0 secs=1 error=False sid=x\n2026-11-02T00:00:09Z turn 1 done; observer wait 10s; status \n');
    const stop = join(stack, 'stop');
    writeFileSync(stop, '');
    expect(python([join(forward, 'extract.py'), stop, tee]).code).toBe(0);
    const prices = join(stack, 'prices.json');
    writeFileSync(prices, JSON.stringify({ input: 1, cache_read: 0.5, output: 2 }));
    const stats = python([join(forward, 'stats.py'), stack, prices]);
    expect(stats.code).toBe(0);
    const result = JSON.parse(stats.stdout);
    expect(result).toMatchObject({ requests: 2, side_calls: 1, max_prompt_tokens: 100, tool_calls: 2, file_reads: 2, file_rereads: 1, cache_read: 60, uncached_input: 45, output_tokens: 8, measured_cost_usd: 0.011 });
    expect(result.errors).toEqual([]);
  });
});
