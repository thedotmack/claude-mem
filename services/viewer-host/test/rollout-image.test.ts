import { describe, expect, it } from 'bun:test';
import { rolloutImage, type RolloutOptions } from '../scripts/rollout-image.js';
import { DEFAULT_REPLICA_FLY_APP_NAME_PREFIX } from '../src/defaults.js';

const NEW_IMAGE = 'registry.fly.io/cmem-viewer:deployment-NEW';
const OLD_IMAGE = 'registry.fly.io/cmem-viewer:deployment-OLD';

interface FakeMachine { id: string; state: string; version: string; config: Record<string, unknown> | null }
interface Call { method: string; path: string; body: any }

/** What the worker probe prints on the machine, or `412` for Fly's "machine not running". */
type WorkerAnswer = 'ready' | 'busy' | 'not-listening' | '412';

/**
 * A fake Machines API: GET lists apps and machines, POST updates a machine and returns its new
 * version, GET .../wait answers when started, POST .../exec answers the worker probe. Apps in
 * `failUpdatesFor` answer the update with 500, apps in `failWaitsFor` answer the wait with 408.
 * `workerAnswers` gives an app's probe answers in order (the last one repeats); default ready.
 */
function fakeFly(
  appsWithMachines: Record<string, FakeMachine[]>,
  { failUpdatesFor = [], expectedOrigin = 'https://api.machines.dev', failWaitsFor = [], workerAnswers = {} }:
    { failUpdatesFor?: string[]; expectedOrigin?: string; failWaitsFor?: string[]; workerAnswers?: Record<string, WorkerAnswer[]> } = {},
) {
  const calls: Call[] = [];
  const probesSeen: Record<string, number> = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text()) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    expect(`${url.protocol}//${url.hostname}`).toBe(expectedOrigin);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    if (method === 'GET' && url.pathname === '/v1/apps') {
      return Response.json({ total_apps: Object.keys(appsWithMachines).length, apps: Object.keys(appsWithMachines).map(name => ({ name })) });
    }
    const list = url.pathname.match(/^\/v1\/apps\/([^/]+)\/machines$/);
    if (method === 'GET' && list) return Response.json(appsWithMachines[list[1]] ?? []);
    const update = url.pathname.match(/^\/v1\/apps\/([^/]+)\/machines\/([^/]+)$/);
    if (method === 'POST' && update) {
      if (failUpdatesFor.includes(update[1])) return Response.json({ error: 'insufficient capacity' }, { status: 500 });
      return Response.json({ id: update[2], version: `new-${update[2]}` });
    }
    const wait = url.pathname.match(/^\/v1\/apps\/([^/]+)\/machines\/([^/]+)\/wait$/);
    if (method === 'GET' && wait) {
      if (failWaitsFor.includes(wait[1])) return Response.json({ error: 'deadline_exceeded: machine did not reach started' }, { status: 408 });
      return Response.json({ ok: true, state: 'started', version: url.searchParams.get('version') });
    }
    const exec = url.pathname.match(/^\/v1\/apps\/([^/]+)\/machines\/([^/]+)\/exec$/);
    if (method === 'POST' && exec) {
      const answers = workerAnswers[exec[1]] ?? ['ready'];
      const seen = probesSeen[exec[1]] ?? 0;
      probesSeen[exec[1]] = seen + 1;
      const answer = answers[Math.min(seen, answers.length - 1)];
      if (answer === '412') return Response.json({ error: 'machine is not running' }, { status: 412 });
      return Response.json({ exit_code: 0, exit_signal: 0, stdout: `${answer}\n`, stderr: '' });
    }
    return new Response('unexpected', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function machine(id: string, state: string, image: string): FakeMachine {
  return {
    id,
    state,
    version: `v-${id}`,
    config: { image, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 }, mounts: [{ volume: `vol_${id}`, path: '/data' }], services: [{ internal_port: 8080, autostop: 'stop' }], env: { VIEWER_SIGN_IN_URL: 'https://cmem.ai/work' } },
  };
}

/** A fake clock: each wait between worker checks moves it forward instead of sleeping. */
function fakeClock() {
  const clock = { milliseconds: 0, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.milliseconds,
    sleep: async (milliseconds: number) => { clock.sleeps.push(milliseconds); clock.milliseconds += milliseconds; },
  };
}

function options(fetchImpl: typeof fetch, extra: Partial<RolloutOptions> = {}): RolloutOptions {
  const { now, sleep } = fakeClock();
  return { flyApiToken: 'test-token', flyOrgSlug: 'personal', routerFlyAppName: 'cmem-viewer', replicaFlyAppNamePrefix: DEFAULT_REPLICA_FLY_APP_NAME_PREFIX, dryRun: false, workerReadyTimeoutSeconds: 30, fetchImpl, log: () => {}, now, sleep, ...extra };
}

/** Runs the script as an operator would, against the fake API served on loopback. */
async function run(failUpdatesFor: string[], args = ['--worker-ready-timeout-seconds', '30'], machineState = 'stopped', workerAnswers: Record<string, WorkerAnswer[]> = {}) {
  const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-a', machineState, OLD_IMAGE)], 'cmem-vw-bbb': [machine('m-b', machineState, OLD_IMAGE)] }, { failUpdatesFor, expectedOrigin: 'http://127.0.0.1', workerAnswers });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => fly.fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.method === 'POST' ? request.body : undefined, duplex: 'half' } as RequestInit) });
  try {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/../scripts/rollout-image.ts`, ...args], {
      env: { PATH: process.env.PATH ?? '', FLY_API_TOKEN: 'test-token', FLY_ORG_SLUG: 'personal', FLY_API_HOSTNAME: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr, posts: posts(fly.calls).length, calls: fly.calls.length };
  } finally {
    server.stop(true);
  }
}

/** Machine updates, not worker checks. */
const posts = (calls: Call[]) => calls.filter(call => call.method === 'POST' && !call.path.endsWith('/exec'));
const probes = (calls: Call[]) => calls.filter(call => call.method === 'POST' && call.path.endsWith('/exec'));

describe('rollout-image', () => {
  it('updates a stopped machine with its whole config, only the image changed, and skip_launch', async () => {
    const stopped = machine('m-stopped', 'stopped', OLD_IMAGE);
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [stopped] });
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(summary.updated).toEqual(['cmem-vw-aaa/m-stopped']);
    const [update] = posts(fly.calls);
    expect(update.path).toBe('/v1/apps/cmem-vw-aaa/machines/m-stopped');
    expect(update.body).toEqual({ config: { ...stopped.config, image: NEW_IMAGE }, current_version: 'v-m-stopped', skip_launch: true });
    expect(fly.calls.some(call => call.path.includes('/wait'))).toBe(false);
  });

  it('lets a running machine restart on the new image and waits for that new version to start', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-running', 'started', OLD_IMAGE)] });
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(posts(fly.calls)[0].body.skip_launch).toBe(false);
    const updateIndex = fly.calls.findIndex(call => call.method === 'POST');
    expect(fly.calls[updateIndex + 1]).toEqual({ method: 'GET', path: '/v1/apps/cmem-vw-aaa/machines/m-running/wait?state=started&version=new-m-running', body: undefined });
    expect(summary.updated).toEqual(['cmem-vw-aaa/m-running']);
  });

  it('asks the restarted machine\'s worker through exec, with bun and no shell, after it starts', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-running', 'started', OLD_IMAGE)] });
    await rolloutImage(options(fly.fetchImpl));
    const waitIndex = fly.calls.findIndex(call => call.path.includes('/wait'));
    const probe = fly.calls[waitIndex + 1];
    expect(probe.path).toBe('/v1/apps/cmem-vw-aaa/machines/m-running/exec');
    expect(probe.body.command.slice(0, 2)).toEqual(['bun', '-e']);
    expect(probe.body.command[2]).toContain('http://127.0.0.1:37777/api/health');
    expect(Object.keys(probe.body)).toEqual(['command']);
  });

  it('never checks the worker of a machine it kept asleep', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-stopped', 'stopped', OLD_IMAGE)] });
    await rolloutImage(options(fly.fetchImpl));
    expect(probes(fly.calls)).toEqual([]);
  });

  it('keeps waiting through a booting and busy worker, one check per second, and passes once it is ready', async () => {
    const fly = fakeFly(
      { 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-a', 'started', OLD_IMAGE)], 'cmem-vw-bbb': [machine('m-b', 'started', OLD_IMAGE)] },
      { workerAnswers: { 'cmem-vw-aaa': ['not-listening', 'not-listening', 'busy', 'busy', 'ready'] } },
    );
    const { clock, now, sleep } = fakeClock();
    const summary = await rolloutImage(options(fly.fetchImpl, { now, sleep }));
    expect(summary.updated).toEqual(['cmem-vw-aaa/m-a', 'cmem-vw-bbb/m-b']);
    expect(summary.failures).toEqual([]);
    expect(probes(fly.calls).filter(call => call.path.includes('cmem-vw-aaa'))).toHaveLength(5);
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  it('stops the run when a machine starts but its worker never becomes ready', async () => {
    const fly = fakeFly(
      { 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-a', 'started', OLD_IMAGE)], 'cmem-vw-bbb': [machine('m-b', 'started', OLD_IMAGE)] },
      { workerAnswers: { 'cmem-vw-aaa': ['busy'] } },
    );
    const summary = await rolloutImage(options(fly.fetchImpl, { workerReadyTimeoutSeconds: 5 }));
    expect(summary.updated).toEqual([]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toContain('cmem-vw-aaa/m-a');
    expect(summary.failures[0]).toContain('worker not ready after 5s (last check: busy)');
    expect(summary.notAttempted).toEqual(['cmem-vw-bbb']);
    expect(fly.calls.some(call => call.path.includes('cmem-vw-bbb/machines/'))).toBe(false);
  });

  it('stops the run at once when the worker answered and then stopped listening', async () => {
    const fly = fakeFly(
      { 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-a', 'started', OLD_IMAGE)], 'cmem-vw-bbb': [machine('m-b', 'started', OLD_IMAGE)] },
      { workerAnswers: { 'cmem-vw-aaa': ['not-listening', 'busy', 'not-listening'] } },
    );
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(summary.failures[0]).toContain('worker is down');
    expect(probes(fly.calls)).toHaveLength(3);
    expect(summary.notAttempted).toEqual(['cmem-vw-bbb']);
  });

  it('stops the run when the machine is no longer running for the worker check', async () => {
    const fly = fakeFly(
      { 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-a', 'started', OLD_IMAGE)], 'cmem-vw-bbb': [machine('m-b', 'started', OLD_IMAGE)] },
      { workerAnswers: { 'cmem-vw-aaa': ['412'] } },
    );
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(summary.failures[0]).toContain('412');
    expect(summary.notAttempted).toEqual(['cmem-vw-bbb']);
  });

  it('refuses to run without a positive worker-ready time limit', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)] });
    await expect(rolloutImage(options(fly.fetchImpl, { workerReadyTimeoutSeconds: 0 }))).rejects.toThrow('workerReadyTimeoutSeconds must be a positive number');
    expect(fly.calls).toEqual([]);
  });

  it('skips a machine already on the router image', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-current', 'stopped', NEW_IMAGE)] });
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(summary.alreadyCurrent).toEqual(['cmem-vw-aaa/m-current']);
    expect(posts(fly.calls)).toEqual([]);
  });

  it('never touches apps without the prefix', async () => {
    const fly = fakeFly({
      'cmem-viewer': [machine('router', 'started', NEW_IMAGE)],
      'cmem-sync-api': [machine('sync', 'started', OLD_IMAGE)],
      'other-cmem-vw-x': [machine('other', 'stopped', OLD_IMAGE)],
      'cmem-vw-aaa': [machine('m-a', 'stopped', OLD_IMAGE)],
    });
    await rolloutImage(options(fly.fetchImpl));
    const touched = fly.calls.filter(call => call.path.includes('cmem-sync-api') || call.path.includes('other-cmem-vw-x'));
    expect(touched).toEqual([]);
    expect(posts(fly.calls).map(call => call.path)).toEqual(['/v1/apps/cmem-vw-aaa/machines/m-a']);
  });

  it('stops the whole run at the first failed update and lists what was not attempted', async () => {
    const fly = fakeFly({
      'cmem-viewer': [machine('router', 'started', NEW_IMAGE)],
      'cmem-vw-aaa': [machine('m-a', 'stopped', OLD_IMAGE)],
      'cmem-vw-bbb': [machine('m-b1', 'stopped', OLD_IMAGE), machine('m-b2', 'stopped', OLD_IMAGE)],
      'cmem-vw-ccc': [machine('m-c', 'stopped', OLD_IMAGE)],
    }, { failUpdatesFor: ['cmem-vw-bbb'] });
    const lines: string[] = [];
    const summary = await rolloutImage(options(fly.fetchImpl, { log: line => lines.push(line) }));
    expect(summary.updated).toEqual(['cmem-vw-aaa/m-a']);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toContain('cmem-vw-bbb/m-b1');
    expect(summary.failures[0]).toContain('500');
    expect(summary.notAttempted).toEqual(['cmem-vw-bbb/m-b2', 'cmem-vw-ccc']);
    expect(fly.calls.some(call => call.path.includes('cmem-vw-ccc'))).toBe(false);
    expect(lines).toContain('updated 1, already current 0, failed 1, not attempted 2');
  });

  it('stops the whole run when an updated machine does not start', async () => {
    const fly = fakeFly({
      'cmem-viewer': [machine('router', 'started', NEW_IMAGE)],
      'cmem-vw-aaa': [machine('m-a', 'started', OLD_IMAGE)],
      'cmem-vw-bbb': [machine('m-b', 'started', OLD_IMAGE)],
    }, { failWaitsFor: ['cmem-vw-aaa'] });
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(summary.updated).toEqual([]);
    expect(summary.failures[0]).toContain('408');
    expect(summary.notAttempted).toEqual(['cmem-vw-bbb']);
    expect(posts(fly.calls)).toHaveLength(1);
  });

  it('the command exits non-zero when any machine failed, and zero when none did', async () => {
    const failing = await run(['cmem-vw-aaa']);
    expect(failing.exitCode).toBe(1);
    expect(failing.posts).toBe(1);
    expect(failing.stdout).toContain('updated 0, already current 0, failed 1, not attempted 1');
    expect(failing.stdout).toContain('not attempted: cmem-vw-bbb');
    const clean = await run([]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain('updated 2, already current 0, failed 0, not attempted 0');
  });

  it('the command refuses to run without --worker-ready-timeout-seconds and calls nothing', async () => {
    const missing = await run([], []);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('--worker-ready-timeout-seconds is required');
    expect(missing.stderr).toContain('Phase 8 staging run');
    expect(missing.calls).toBe(0);
    const zero = await run([], ['--worker-ready-timeout-seconds', '0']);
    expect(zero.exitCode).toBe(2);
    expect(zero.calls).toBe(0);
  });

  it('the command exits non-zero when a machine starts but its worker never becomes ready', async () => {
    // Real one-second spacing between checks, so a 1 s limit gives two checks and then stops.
    const stuck = await run([], ['--worker-ready-timeout-seconds', '1'], 'started', { 'cmem-vw-aaa': ['not-listening'] });
    expect(stuck.exitCode).toBe(1);
    expect(stuck.posts).toBe(1);
    expect(stuck.stdout).toContain('worker not ready after 1s (last check: not-listening)');
    expect(stuck.stdout).toContain('not attempted: cmem-vw-bbb');
  });

  it('refuses a machine whose config Fly could not read, instead of sending a partial one', async () => {
    const unreadable: FakeMachine = { id: 'm-x', state: 'stopped', version: 'v-x', config: null };
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [unreadable] });
    const summary = await rolloutImage(options(fly.fetchImpl));
    expect(summary.failures).toHaveLength(1);
    expect(posts(fly.calls)).toEqual([]);
  });

  it('changes nothing in a dry run', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('router', 'started', NEW_IMAGE)], 'cmem-vw-aaa': [machine('m-a', 'stopped', OLD_IMAGE)] });
    const lines: string[] = [];
    const summary = await rolloutImage(options(fly.fetchImpl, { dryRun: true, log: line => lines.push(line) }));
    expect(summary.wouldUpdate).toEqual(['cmem-vw-aaa/m-a']);
    expect(summary.updated).toEqual([]);
    expect(posts(fly.calls)).toEqual([]);
    expect(lines).toContain('would update 1, already current 0, failed 0');
    expect(lines.some(line => line.startsWith('would update cmem-vw-aaa/m-a (stopped, stays stopped)'))).toBe(true);
  });

  it('--only updates one prefixed app and refuses any other name', async () => {
    const apps = {
      'cmem-viewer': [machine('router', 'started', NEW_IMAGE)],
      'cmem-vw-aaa': [machine('m-a', 'stopped', OLD_IMAGE)],
      'cmem-vw-bbb': [machine('m-b', 'stopped', OLD_IMAGE)],
    };
    const fly = fakeFly(apps);
    await rolloutImage(options(fly.fetchImpl, { onlyFlyAppName: 'cmem-vw-bbb' }));
    expect(posts(fly.calls).map(call => call.path)).toEqual(['/v1/apps/cmem-vw-bbb/machines/m-b']);
    await expect(rolloutImage(options(fakeFly(apps).fetchImpl, { onlyFlyAppName: 'cmem-viewer' }))).rejects.toThrow('is not an app with prefix');
  });

  it('stops before touching anything when the router machines disagree on the image', async () => {
    const fly = fakeFly({ 'cmem-viewer': [machine('r1', 'started', NEW_IMAGE), machine('r2', 'started', OLD_IMAGE)], 'cmem-vw-aaa': [machine('m-a', 'stopped', OLD_IMAGE)] });
    await expect(rolloutImage(options(fly.fetchImpl))).rejects.toThrow('expected exactly one');
    expect(posts(fly.calls)).toEqual([]);
  });
});
