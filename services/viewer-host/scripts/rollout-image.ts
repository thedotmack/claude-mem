/**
 * Moves every account's viewer machine to the image the router runs. The last
 * steps of each release after the router cutover (services/viewer-host/fly.router.toml):
 *
 *   npm run build
 *   fly deploy --config services/viewer-host/fly.router.toml --dockerfile services/viewer-host/Dockerfile .
 *   bun services/viewer-host/scripts/rollout-image.ts --worker-ready-timeout-seconds <N> --only <one cmem-vw- app>   (canary; check it)
 *   bun services/viewer-host/scripts/rollout-image.ts --worker-ready-timeout-seconds <N>
 *
 * `--worker-ready-timeout-seconds` is required and has no default: use the worker boot time
 * measured in the Phase 8 staging run (.scratch/cloud-viewer-everyone/phase-8-staging.md), plus
 * the margin that measurement supports. `--dry-run` lists what would change and changes nothing.
 *
 * Env:
 *   FLY_API_TOKEN                       required. An org token (`fly tokens create org`). Never commit it.
 *   FLY_ORG_SLUG                        required. The organization that holds the account apps.
 *   VIEWER_ROUTER_FLY_APP_NAME          default cmem-viewer. Its machine's image is the target.
 *   VIEWER_REPLICA_FLY_APP_NAME_PREFIX  default cmem-vw-. Only apps with this prefix are touched.
 *   FLY_API_HOSTNAME                    default https://api.machines.dev, the name Fly's examples use
 *                                       (https://docs.fly.io/machines/api/working-with-machines-api).
 *
 * Fly Machines API (https://docs.fly.io/machines/api/machines-resource):
 *   - The target is the router machine's image pinned by digest, `registry/repository:tag@digest`
 *     from its image_ref (pinnedImageReference), the same string cmem.ai creates account machines
 *     with. A router machine without a digest stops the run before anything changes.
 *   - An update replaces the whole config ("we don't support partial updates"), so each
 *     update sends the machine's own config with only `image` changed. A machine whose
 *     config Fly could not read (host unreachable, `config` null) is reported as failed,
 *     never updated.
 *   - `skip_launch` keeps a machine that is not running from starting. It is set for every
 *     machine not `started`, so a sleeping viewer stays asleep and is not billed for running.
 *   - A running machine is waited for (`/wait?state=started` on the new version), then its
 *     worker is asked whether it is ready, before the next one. `started` alone proves nothing:
 *     the gate keeps running and answers its own /health with 200 while index.ts restarts a
 *     crashing worker. So the script runs a one-line `bun -e` fetch of the worker's /api/health
 *     on the machine through the exec endpoint (POST .../exec, `command` run directly, no shell;
 *     the image has bun but no curl). Ready = HTTP 200 with `initialized: true`; busy (answering
 *     but not ready, or slow) and not yet listening (the worker binds its port only after its own
 *     boot steps) keep waiting; a worker that answered and then stops listening is down and fails
 *     at once; still not ready at the time limit fails.
 *   - The first update, wait or worker check that fails stops the whole run, lists what was not
 *     attempted, and exits non-zero, so a bad image reaches one account, not all of them.
 *   - Fly allows 1 request per second per action per machine, bursts of 3
 *     (https://docs.fly.io/machines/api/working-with-machines-api). Machines are updated
 *     one at a time, in sequence, so no rate-limit logic is needed. The worker check is one
 *     exec per second (WORKER_PROBE_INTERVAL_MS), the smallest spacing that stays within that limit.
 */
import { parseArgs } from 'node:util';
import { ACCOUNT_WORKER_PORT, DEFAULT_REPLICA_FLY_APP_NAME_PREFIX } from '../src/defaults.js';

/**
 * Spacing between worker checks on one machine. No measurement sets it: Fly allows 1 request per
 * second per action per machine (https://docs.fly.io/machines/api/working-with-machines-api), and
 * every check is one exec, so one second is the smallest spacing that stays within that limit.
 */
const WORKER_PROBE_INTERVAL_MS = 1000;
/**
 * How long one check waits for the worker to answer before calling it busy. The same 1 s the
 * gate's own /health probe uses (src/gate.ts), so the rollout and the gate give one worker the
 * same state. The exec call itself sends no `timeout`, so Fly's documented default (10 s) bounds
 * bun's start plus this fetch.
 */
const WORKER_PROBE_FETCH_TIMEOUT_MS = 1000;
/** Run on the machine with `bun -e`. Prints exactly one of: ready, busy, not-listening. */
const WORKER_PROBE_SCRIPT = [
  'try {',
  `  const response = await fetch("http://127.0.0.1:${ACCOUNT_WORKER_PORT}/api/health", { signal: AbortSignal.timeout(${WORKER_PROBE_FETCH_TIMEOUT_MS}) });`,
  '  const health = await response.json().catch(() => null);',
  '  console.log(response.ok && health?.initialized === true ? "ready" : "busy");',
  '} catch (error) {',
  '  console.log(error?.name === "TimeoutError" || error?.name === "AbortError" ? "busy" : "not-listening");',
  '}',
].join('\n');

export interface RolloutOptions {
  flyApiToken: string;
  /** Default https://api.machines.dev. */
  flyApiHostname?: string;
  flyOrgSlug: string;
  routerFlyAppName: string;
  replicaFlyAppNamePrefix: string;
  dryRun: boolean;
  /** Update only this app (the canary step). It must still carry the prefix and belong to the organization. */
  onlyFlyAppName?: string;
  /**
   * How long a restarted machine's worker gets to become ready before the run stops. Required, no
   * default: it comes from the worker boot time measured in the Phase 8 staging run.
   */
  workerReadyTimeoutSeconds: number;
  fetchImpl?: typeof fetch;
  /** Tests replace the clock and the wait between worker checks. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface RolloutSummary {
  targetImage: string;
  /** Machines moved to the target image. Always empty in a dry run. */
  updated: string[];
  /** Dry run only: machines a real run would update. */
  wouldUpdate: string[];
  alreadyCurrent: string[];
  /** Apps or machines that failed. An update, wait or worker-check failure also stops the run. */
  failures: string[];
  /** Set when the run stopped early: the apps and machines it never tried. */
  notAttempted: string[];
}

/** Machine.image_ref (OpenAPI ImageRef): "The image the Machine runs, as resolved when it was last created or updated." */
interface FlyImageRef {
  registry?: string;
  repository?: string;
  tag?: string;
  digest?: string;
}

interface FlyMachine {
  id: string;
  state: string;
  version?: string;
  config: (Record<string, unknown> & { image?: string }) | null;
  image_ref?: FlyImageRef | null;
}

/** Router machines on their way out; Fly lists them until they are gone. Same set cmem.ai skips. */
const MACHINE_GONE_STATES = new Set(['destroying', 'destroyed']);

/**
 * The image a router machine runs, pinned: `registry/repository:tag@digest`, built from
 * Machine.image_ref, never the bare config.image tag. Reason: on staging (2026-11-11) a router
 * deploy whose builder failed ("error releasing builder: deadline_exceeded") left config.image
 * naming a tag the registry never received, and machine creates answered 400 MANIFEST_UNKNOWN.
 * The same tag with its digest appended worked and the digest alone did not, so all four parts
 * are required, and a missing one stops the run instead of guessing. cmem.ai builds the same
 * string the same way when it creates an account machine (claude-mem-pro
 * src/lib/viewer-host/provision.ts pinnedImageReference), so machines it created count as current.
 */
export function pinnedImageReference(routerFlyAppName: string, machine: Pick<FlyMachine, 'id' | 'image_ref'>): string {
  const ref = machine.image_ref;
  if (!ref?.digest) {
    throw new Error(`${routerFlyAppName}/${machine.id} reports no image_ref digest, so its image cannot be pinned. Finish or redo the router deploy first.`);
  }
  if (!ref.registry || !ref.repository || !ref.tag) {
    throw new Error(`${routerFlyAppName}/${machine.id} image_ref lacks its registry, repository or tag (${JSON.stringify(ref)}); a digest alone does not resolve on Fly's registry.`);
  }
  return `${ref.registry}/${ref.repository}:${ref.tag}@${ref.digest}`;
}

export async function rolloutImage(options: RolloutOptions): Promise<RolloutSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const flyApiHostname = options.flyApiHostname ?? 'https://api.machines.dev';
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  if (!Number.isFinite(options.workerReadyTimeoutSeconds) || options.workerReadyTimeoutSeconds <= 0) {
    throw new Error(`workerReadyTimeoutSeconds must be a positive number of seconds, got ${options.workerReadyTimeoutSeconds}`);
  }

  async function flyApi<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${flyApiHostname}${path}`, {
      method,
      headers: { Authorization: `Bearer ${options.flyApiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  const machinesPath = (appName: string) => `/v1/apps/${encodeURIComponent(appName)}/machines`;
  const listMachines = (appName: string) => flyApi<FlyMachine[]>('GET', machinesPath(appName));

  /** Throws unless the machine's worker reports ready within the time limit. */
  async function waitForWorkerReady(appName: string, machineId: string): Promise<void> {
    const deadline = now() + options.workerReadyTimeoutSeconds * 1000;
    let workerHasAnswered = false;
    for (;;) {
      // A 412 (machine not running) or any other error status throws in flyApi and stops the run.
      const result = await flyApi<{ exit_code?: number; stdout?: string; stderr?: string }>(
        'POST',
        `${machinesPath(appName)}/${encodeURIComponent(machineId)}/exec`,
        { command: ['bun', '-e', WORKER_PROBE_SCRIPT] },
      );
      const answer = (result.stdout ?? '').trim();
      if (result.exit_code !== 0 || !['ready', 'busy', 'not-listening'].includes(answer)) {
        throw new Error(`worker check could not run (exit ${result.exit_code}, stdout ${JSON.stringify(answer)}, stderr ${JSON.stringify((result.stderr ?? '').trim())})`);
      }
      if (answer === 'ready') return;
      if (answer === 'not-listening' && workerHasAnswered) {
        throw new Error('worker is down: it answered, then stopped listening (crashed and restarting?)');
      }
      if (answer === 'busy') workerHasAnswered = true;
      if (now() >= deadline) {
        throw new Error(`worker not ready after ${options.workerReadyTimeoutSeconds}s (last check: ${answer})`);
      }
      await sleep(WORKER_PROBE_INTERVAL_MS);
    }
  }

  // The target is whatever the router runs, so the order is always: deploy the router, then roll out.
  // It is the pinned reference (pinnedImageReference), compared with each account machine's
  // config.image and written there in that same form. A machine still on a bare tag is out of date.
  const routerMachines = (await listMachines(options.routerFlyAppName)).filter(machine => !MACHINE_GONE_STATES.has(machine.state));
  const routerImages = [...new Set(routerMachines.map(machine => pinnedImageReference(options.routerFlyAppName, machine)))];
  if (routerImages.length !== 1) {
    throw new Error(`${options.routerFlyAppName} machines report images ${JSON.stringify(routerImages)}; expected exactly one. Finish the router deploy first.`);
  }
  const targetImage = routerImages[0];
  log(`target image (from ${options.routerFlyAppName}): ${targetImage}${options.dryRun ? '  [dry run: nothing will change]' : ''}`);

  // Without `limit`, Fly returns every app in one response (GET /v1/apps, https://docs.fly.io/machines/api/apps-resource).
  const { apps } = await flyApi<{ apps: { name: string }[] }>('GET', `/v1/apps?org_slug=${encodeURIComponent(options.flyOrgSlug)}`);
  let replicaAppNames = apps.map(app => app.name).filter(name => name.startsWith(options.replicaFlyAppNamePrefix)).sort();
  if (options.onlyFlyAppName !== undefined) {
    if (!replicaAppNames.includes(options.onlyFlyAppName)) {
      throw new Error(`${options.onlyFlyAppName} is not an app with prefix ${options.replicaFlyAppNamePrefix} in ${options.flyOrgSlug}`);
    }
    replicaAppNames = [options.onlyFlyAppName];
  }

  const summary: RolloutSummary = { targetImage, updated: [], wouldUpdate: [], alreadyCurrent: [], failures: [], notAttempted: [] };
  const fail = (label: string, message: string) => {
    summary.failures.push(`${label}: ${message}`);
    log(`FAILED ${label}: ${message}`);
  };

  apps: for (const [appIndex, appName] of replicaAppNames.entries()) {
    let machines: FlyMachine[];
    try {
      machines = await listMachines(appName);
    } catch (error) {
      fail(appName, (error as Error).message);
      continue;
    }
    for (const [machineIndex, machine] of machines.entries()) {
      const label = `${appName}/${machine.id}`;
      if (!machine.config) {
        fail(label, 'Fly returned no config (host unreachable?); not updated, a partial config would replace the whole machine');
        continue;
      }
      if (machine.config.image === targetImage) {
        summary.alreadyCurrent.push(label);
        continue;
      }
      const keepAsleep = machine.state !== 'started';
      const change = `${label} (${machine.state}${keepAsleep ? ', stays stopped' : ', restarts'}): ${machine.config.image} -> ${targetImage}`;
      if (options.dryRun) {
        summary.wouldUpdate.push(label);
        log(`would update ${change}`);
        continue;
      }
      try {
        const updatedMachine = await flyApi<FlyMachine>('POST', `${machinesPath(appName)}/${encodeURIComponent(machine.id)}`, {
          config: { ...machine.config, image: targetImage },
          // Rejected with 409 if the machine changed since it was listed, so a newer config is never overwritten.
          ...(machine.version ? { current_version: machine.version } : {}),
          skip_launch: keepAsleep,
        });
        if (!keepAsleep) {
          // Wait for the new version to start before touching the next machine. `version` makes Fly wait
          // for this update, not the old version; no timeout is passed, so Fly's own default applies
          // (GET .../wait, https://docs.fly.io/machines/api/machines-resource).
          const version = updatedMachine.version ? `&version=${encodeURIComponent(updatedMachine.version)}` : '';
          await flyApi('GET', `${machinesPath(appName)}/${encodeURIComponent(machine.id)}/wait?state=started${version}`);
          await waitForWorkerReady(appName, machine.id);
        }
        summary.updated.push(label);
        log(`updated ${change}`);
      } catch (error) {
        // A failed update, start or worker check may mean the new image is bad: stop before it reaches anyone else.
        fail(label, (error as Error).message);
        summary.notAttempted.push(
          ...machines.slice(machineIndex + 1).map(rest => `${appName}/${rest.id}`),
          ...replicaAppNames.slice(appIndex + 1),
        );
        break apps;
      }
    }
  }

  const counts = options.dryRun
    ? `would update ${summary.wouldUpdate.length}, already current ${summary.alreadyCurrent.length}, failed ${summary.failures.length}`
    : `updated ${summary.updated.length}, already current ${summary.alreadyCurrent.length}, failed ${summary.failures.length}, not attempted ${summary.notAttempted.length}`;
  log(counts);
  for (const failure of summary.failures) log(`  failed: ${failure}`);
  if (summary.notAttempted.length > 0) log(`  stopped early; not attempted: ${summary.notAttempted.join(', ')}`);
  return summary;
}

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const usage = [
    'usage: bun services/viewer-host/scripts/rollout-image.ts --worker-ready-timeout-seconds <N> [--dry-run] [--only <app name>]',
    '  --worker-ready-timeout-seconds  required, no default: how long a restarted machine\'s worker gets to',
    '                                  become ready. Use the worker boot time measured in the Phase 8 staging run.',
  ].join('\n');
  let flags: { 'dry-run'?: boolean; only?: string; 'worker-ready-timeout-seconds'?: string };
  let workerReadyTimeoutSeconds: number;
  try {
    flags = parseArgs({ options: { 'dry-run': { type: 'boolean' }, only: { type: 'string' }, 'worker-ready-timeout-seconds': { type: 'string' } }, strict: true }).values;
    const rawTimeout = flags['worker-ready-timeout-seconds'];
    if (rawTimeout === undefined) throw new Error('--worker-ready-timeout-seconds is required');
    workerReadyTimeoutSeconds = Number(rawTimeout);
    if (!Number.isFinite(workerReadyTimeoutSeconds) || workerReadyTimeoutSeconds <= 0) {
      throw new Error(`--worker-ready-timeout-seconds must be a positive number, got ${JSON.stringify(rawTimeout)}`);
    }
  } catch (error) {
    console.error(`${(error as Error).message}\n${usage}`);
    process.exit(2);
  }
  try {
    const summary = await rolloutImage({
      flyApiToken: requiredEnv('FLY_API_TOKEN'),
      flyApiHostname: (process.env.FLY_API_HOSTNAME ?? '').trim() || undefined,
      flyOrgSlug: requiredEnv('FLY_ORG_SLUG'),
      routerFlyAppName: (process.env.VIEWER_ROUTER_FLY_APP_NAME ?? '').trim() || 'cmem-viewer',
      replicaFlyAppNamePrefix: (process.env.VIEWER_REPLICA_FLY_APP_NAME_PREFIX ?? '').trim() || DEFAULT_REPLICA_FLY_APP_NAME_PREFIX,
      dryRun: flags['dry-run'] === true,
      onlyFlyAppName: flags.only,
      workerReadyTimeoutSeconds,
    });
    process.exit(summary.failures.length > 0 || summary.notAttempted.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`rollout stopped: ${(error as Error).message}`);
    process.exit(1);
  }
}
