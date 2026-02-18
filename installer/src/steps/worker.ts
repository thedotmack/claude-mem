import * as p from '@clack/prompts';
import pc from 'picocolors';
import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { expandHome } from '../utils/system.js';
import { findBinary } from '../utils/dependencies.js';

const MARKETPLACE_DIR = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

const HEALTH_CHECK_INTERVAL_MS = 1000;
const HEALTH_CHECK_MAX_ATTEMPTS = 30;

async function pollHealthEndpoint(port: string, maxAttempts: number = HEALTH_CHECK_MAX_ATTEMPTS): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // Expected during startup — worker not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }
  return false;
}

export async function runWorkerStartup(workerPort: string, dataDir: string): Promise<void> {
  const bunInfo = findBinary('bun', ['~/.bun/bin/bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun']);

  if (!bunInfo.found || !bunInfo.path) {
    p.log.error('Bun is required to start the worker but was not found.');
    p.log.info('Install Bun: curl -fsSL https://bun.sh/install | bash');
    return;
  }

  const workerScript = join(MARKETPLACE_DIR, 'plugin', 'scripts', 'worker-service.cjs');
  const expandedDataDir = expandHome(dataDir);
  const logPath = join(expandedDataDir, 'logs');

  const s = p.spinner();
  s.start('Starting worker service...');

  // Start worker as a detached background process
  const child = spawn(bunInfo.path, [workerScript], {
    cwd: MARKETPLACE_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_MEM_WORKER_PORT: workerPort,
      CLAUDE_MEM_DATA_DIR: expandedDataDir,
    },
  });

  child.unref();

  // Poll the health endpoint until the worker is responsive
  const workerIsHealthy = await pollHealthEndpoint(workerPort);

  if (workerIsHealthy) {
    s.stop(`Worker running on port ${pc.cyan(workerPort)} ${pc.green('OK')}`);
  } else {
    s.stop(`Worker may still be starting. Check logs at: ${logPath}`);
    p.log.warn('Health check timed out. The worker might need more time to initialize.');
    p.log.info(`Check status: curl http://127.0.0.1:${workerPort}/api/health`);
  }
}
