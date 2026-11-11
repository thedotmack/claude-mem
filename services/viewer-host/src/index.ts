/**
 * Cloud viewer host. One image, two roles, chosen by VIEWER_ROLE:
 *
 * VIEWER_ROLE must be exactly "router" or "account"; anything else, unset included,
 * stops the host at start.
 *
 *   router   (VIEWER_ROLE=router, the cmem-viewer app behind work.cmem.ai) sends
 *            each signed-in request to its account's own Fly app with fly-replay
 *            (router.ts). No worker, no volume, no sync token.
 *   account  (VIEWER_ROLE=account, one Fly app per account, created by cmem.ai) runs one
 *            owner's claude-mem worker as a sync device in the cloud, behind the
 *            gate (gate.ts). The worker pulls everything the owner's other devices
 *            synced, so My Work here reads the same records the laptop's does,
 *            through the same code.
 *
 * Router env:
 *   VIEWER_ROLE=router
 *   VIEWER_LINK_SECRET            the master secret (cmem.ai's CMEM_VIEWER_LINK_SECRET), 32+ characters
 *   VIEWER_PUBLIC_ORIGIN          optional, default https://cmem-viewer.fly.dev
 *   VIEWER_SIGN_IN_URL            optional, default https://cmem.ai/work
 *   VIEWER_REPLICA_FLY_APP_NAME_PREFIX  optional, default cmem-vw- (must match cmem.ai's)
 *   PORT                          default 8080
 *
 * Account env, required:
 *   VIEWER_ROLE=account
 *   VIEWER_OWNER_USER_ID          the cmem.ai user this viewer belongs to
 *   VIEWER_LINK_SECRET            this account's derived key (token.ts perUserViewerLinkSecret),
 *                                 never the master secret, 32+ characters
 *   CLAUDE_MEM_CLOUD_SYNC_TOKEN   the owner's sync token (cmem.ai Connect)
 * Account env, optional:
 *   VIEWER_PUBLIC_ORIGIN          this host's https origin, default https://cmem-viewer.fly.dev
 *                                 (set it as a Fly secret to move to a custom domain)
 *   VIEWER_SIGN_IN_URL            default https://cmem.ai/work
 *   CLAUDE_MEM_CLOUD_SYNC_HUB_URL default https://sync.cmem.ai
 *   CLAUDE_MEM_DATA_DIR           default /data/claude-mem (a persistent volume)
 *   CLAUDE_MEM_WORKER_SCRIPT      default /app/plugin/scripts/worker-service.cjs
 *   PORT                          default 8080
 *   POSTHOG_API_KEY               hosted viewer usage; falls back to the public project key
 *   POSTHOG_HOST                  default https://us.i.posthog.com
 * Any other CLAUDE_MEM_* setting passes through to the worker unchanged.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createGate } from './gate.js';
import { DEFAULT_REPLICA_FLY_APP_NAME_PREFIX, DEFAULT_VIEWER_PUBLIC_ORIGIN, DEFAULT_VIEWER_SIGN_IN_URL } from './defaults.js';
import { createRouter } from './router.js';

const WORKER_PORT = '37777';
const RESTART_DELAY_MS = 3000;

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runRouter(): void {
  const masterSecret = required('VIEWER_LINK_SECRET');
  if (masterSecret.length < 32) throw new Error('VIEWER_LINK_SECRET must be at least 32 characters');
  const router = createRouter({
    masterSecret,
    replicaFlyAppNamePrefix: (process.env.VIEWER_REPLICA_FLY_APP_NAME_PREFIX ?? '').trim() || DEFAULT_REPLICA_FLY_APP_NAME_PREFIX,
    publicOrigin: (process.env.VIEWER_PUBLIC_ORIGIN ?? '').trim() || DEFAULT_VIEWER_PUBLIC_ORIGIN,
    signInUrl: process.env.VIEWER_SIGN_IN_URL || DEFAULT_VIEWER_SIGN_IN_URL,
  });
  const server = Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.PORT || 8080), fetch: router });
  console.log(`[viewer-host] router on :${server.port}`);
  // Router answers are instant and hold no stream, so stopping the server is enough to exit.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.stop());
}

/** One account's viewer: today's single-owner host, unchanged. */
function runAccountViewer(): void {
  const ownerUserId = required('VIEWER_OWNER_USER_ID');
  const secret = required('VIEWER_LINK_SECRET');
  if (secret.length < 32) throw new Error('VIEWER_LINK_SECRET must be at least 32 characters');
  const publicOrigin = (process.env.VIEWER_PUBLIC_ORIGIN ?? '').trim() || DEFAULT_VIEWER_PUBLIC_ORIGIN;
  required('CLAUDE_MEM_CLOUD_SYNC_TOKEN');

  const workerEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_PORT: WORKER_PORT,
    CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR || '/data/claude-mem',
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: process.env.CLAUDE_MEM_CLOUD_SYNC_USER_ID || ownerUserId,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: process.env.CLAUDE_MEM_CLOUD_SYNC_HUB_URL || 'https://sync.cmem.ai',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: process.env.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME || 'cmem.ai viewer',
    // No hooks run here, so no session ever wakes the pull loop: keep it pulling.
    CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING: process.env.CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING || 'true',
    // Nothing here captures sessions or searches by meaning: no hooks run on this machine.
    CLAUDE_MEM_CHROMA_ENABLED: process.env.CLAUDE_MEM_CHROMA_ENABLED || 'false',
    // The owner's own computer runs goals and progress refreshes and writes request copy; this
    // replica starts no agent and spends nothing unless these are set on purpose.
    CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: process.env.CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH || 'false',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: process.env.CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER || 'off',
    // My Work sharing: without it, review checks and Join / Not-this answers made in the cloud
    // viewer never reach the owner's computer. Set here, not by hand on one deploy, so every
    // deploy from the repo keeps it on (it was lost twice that way after the Nov 4 launch).
    CLAUDE_MEM_WORK_VIEW_SHARED_STATE: process.env.CLAUDE_MEM_WORK_VIEW_SHARED_STATE || 'true',
    // A replica is not another install: keep it out of install and usage counts.
    DO_NOT_TRACK: process.env.DO_NOT_TRACK || '1',
  };
  for (const name of ['VIEWER_LINK_SECRET']) delete workerEnv[name];

  const workerScript = process.env.CLAUDE_MEM_WORKER_SCRIPT || '/app/plugin/scripts/worker-service.cjs';
  let worker: ChildProcess | null = null;
  let stopping = false;

  function startWorker(): void {
    worker = spawn(process.execPath, [workerScript, '--daemon'], { env: workerEnv, stdio: 'inherit' });
    worker.on('exit', (code, signal) => {
      worker = null;
      if (stopping) return;
      console.error(`[viewer-host] worker exited (${signal ?? code}); restarting in ${RESTART_DELAY_MS / 1000}s`);
      setTimeout(startWorker, RESTART_DELAY_MS);
    });
  }

  startWorker();

  const gate = createGate({
    ownerUserId,
    secret,
    upstreamOrigin: `http://127.0.0.1:${WORKER_PORT}`,
    publicOrigin,
    signInUrl: process.env.VIEWER_SIGN_IN_URL || DEFAULT_VIEWER_SIGN_IN_URL,
  });

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: Number(process.env.PORT || 8080),
    // The live feed is a long-lived SSE response.
    idleTimeout: 0,
    fetch: gate,
  });
  console.log(`[viewer-host] gate on :${server.port} for one owner; worker on 127.0.0.1:${WORKER_PORT}`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopping = true;
      worker?.kill('SIGTERM');
      server.stop();
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

const role = process.env.VIEWER_ROLE;
if (role === 'router') runRouter();
else if (role === 'account') runAccountViewer();
else throw new Error(`VIEWER_ROLE must be "router" or "account", got ${role === undefined ? 'nothing' : JSON.stringify(role)}`);
