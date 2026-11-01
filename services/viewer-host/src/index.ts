/**
 * Cloud viewer host: one owner's claude-mem worker, run as a sync device in
 * the cloud, behind the gate (gate.ts). The worker pulls everything the
 * owner's other devices synced, so My Work here reads the same records the
 * laptop's does, through the same code.
 *
 * Required env:
 *   VIEWER_OWNER_USER_ID          the cmem.ai user this viewer belongs to
 *   VIEWER_LINK_SECRET            shared with cmem.ai (CMEM_VIEWER_LINK_SECRET), 32+ characters
 *   CLAUDE_MEM_CLOUD_SYNC_TOKEN   the owner's sync token (cmem.ai Connect)
 * Optional:
 *   VIEWER_PUBLIC_ORIGIN          this host's https origin, default https://cmem-viewer.fly.dev
 *                                 (set it as a Fly secret to move to a custom domain)
 *   VIEWER_SIGN_IN_URL            default https://cmem.ai/work
 *   CLAUDE_MEM_CLOUD_SYNC_HUB_URL default https://sync.cmem.ai
 *   CLAUDE_MEM_DATA_DIR           default /data/claude-mem (a persistent volume)
 *   CLAUDE_MEM_WORKER_SCRIPT      default /app/plugin/scripts/worker-service.cjs
 *   PORT                          default 8080
 * Any other CLAUDE_MEM_* setting passes through to the worker unchanged.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createGate } from './gate.js';

const WORKER_PORT = '37777';
const RESTART_DELAY_MS = 3000;

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const ownerUserId = required('VIEWER_OWNER_USER_ID');
const secret = required('VIEWER_LINK_SECRET');
if (secret.length < 32) throw new Error('VIEWER_LINK_SECRET must be at least 32 characters');
const publicOrigin = (process.env.VIEWER_PUBLIC_ORIGIN ?? '').trim() || 'https://cmem-viewer.fly.dev';
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
  signInUrl: process.env.VIEWER_SIGN_IN_URL || 'https://cmem.ai/work',
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
