/**
 * Moves every account's viewer machine to the image the router runs. The last
 * steps of each release after the router cutover (services/viewer-host/fly.router.toml):
 *
 *   npm run build
 *   fly deploy --config services/viewer-host/fly.router.toml --dockerfile services/viewer-host/Dockerfile .
 *   bun services/viewer-host/scripts/rollout-image.ts --only <one cmem-vw- app>   (canary; check it)
 *   bun services/viewer-host/scripts/rollout-image.ts
 *
 * `--dry-run` lists what would change and changes nothing.
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
 *   - An update replaces the whole config ("we don't support partial updates"), so each
 *     update sends the machine's own config with only `image` changed. A machine whose
 *     config Fly could not read (host unreachable, `config` null) is reported as failed,
 *     never updated.
 *   - `skip_launch` keeps a machine that is not running from starting. It is set for every
 *     machine not `started`, so a sleeping viewer stays asleep and is not billed for running.
 *   - A running machine is waited for (`/wait?state=started` on the new version) before the
 *     next one. The first update or wait that fails stops the whole run, lists what was not
 *     attempted, and exits non-zero, so a bad image reaches one account, not all of them.
 *   - Fly allows 1 request per second per action per machine, bursts of 3
 *     (https://docs.fly.io/machines/api/working-with-machines-api). Machines are updated
 *     one at a time, in sequence, so no rate-limit logic is needed.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_REPLICA_FLY_APP_NAME_PREFIX } from '../src/defaults.js';

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
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface RolloutSummary {
  targetImage: string;
  /** Machines moved to the target image. Always empty in a dry run. */
  updated: string[];
  /** Dry run only: machines a real run would update. */
  wouldUpdate: string[];
  alreadyCurrent: string[];
  /** Apps or machines that failed. An update or wait failure also stops the run. */
  failures: string[];
  /** Set when the run stopped early: the apps and machines it never tried. */
  notAttempted: string[];
}

interface FlyMachine {
  id: string;
  state: string;
  version?: string;
  config: (Record<string, unknown> & { image?: string }) | null;
}

export async function rolloutImage(options: RolloutOptions): Promise<RolloutSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const flyApiHostname = options.flyApiHostname ?? 'https://api.machines.dev';

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

  // The target is whatever the router runs, so the order is always: deploy the router, then roll out.
  // Compared and sent as the config.image tag, not the image_ref digest: the API documents
  // config.image only as "The docker image to run" with no digest form, the tag fly deploy writes
  // (deployment-<id>) is new for every deploy, and cmem.ai creates account machines with this same tag.
  const routerImages = [...new Set((await listMachines(options.routerFlyAppName)).map(machine => machine.config?.image))];
  if (routerImages.length !== 1 || !routerImages[0]) {
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
        }
        summary.updated.push(label);
        log(`updated ${change}`);
      } catch (error) {
        // A failed update or start may mean the new image is bad: stop before it reaches anyone else.
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
  let flags: { 'dry-run'?: boolean; only?: string };
  try {
    flags = parseArgs({ options: { 'dry-run': { type: 'boolean' }, only: { type: 'string' } }, strict: true }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: bun services/viewer-host/scripts/rollout-image.ts [--dry-run] [--only <app name>]`);
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
    });
    process.exit(summary.failures.length > 0 || summary.notAttempted.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`rollout stopped: ${(error as Error).message}`);
    process.exit(1);
  }
}
