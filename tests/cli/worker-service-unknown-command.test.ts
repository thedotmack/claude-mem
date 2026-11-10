import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The PATH launcher forwards every argument except `--version` to the real
 * worker-service entry point, so `claude-mem --help` or a typo must not boot a
 * foreground daemon (#5490). A process that is still running when the timeout
 * kills it is the daemon (which exits 0 on SIGTERM, so the timeout is checked).
 */

const root = join(import.meta.dir, '..', '..');
const workerServiceEntry = join(root, 'src/services/worker-service.ts');
const RUN_TIMEOUT_MS = 20_000;

let sandbox: string;
let dataDirectory: string;
let closedLocalPort: number;

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no bound port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function runWorkerService(args: string[]) {
  const child = Bun.spawnSync([process.execPath, workerServiceEntry, ...args], {
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      HOME: sandbox,
      CLAUDE_CONFIG_DIR: join(sandbox, '.claude'),
      CLAUDE_MEM_DATA_DIR: dataDirectory,
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_PORT: String(closedLocalPort),
      CLAUDE_MEM_TELEMETRY: '0',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: RUN_TIMEOUT_MS,
  });
  return {
    exitCode: child.exitCode,
    timedOut: child.exitedDueToTimeout === true,
    stderr: child.stderr.toString(),
  };
}

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'claude-mem-unknown-command-'));
  dataDirectory = join(sandbox, '.claude-mem');
  mkdirSync(dataDirectory, { recursive: true });
  closedLocalPort = await reserveClosedPort();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('worker-service command dispatch (#5490)', () => {
  for (const helpFlag of ['--help']) {
    it(`${helpFlag} prints usage and exits 0 without starting a worker`, () => {
      const result = runWorkerService([helpFlag]);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Usage: worker-service <command>');
      expect(existsSync(join(dataDirectory, 'worker.pid'))).toBe(false);
    }, RUN_TIMEOUT_MS + 10_000);
  }

  it('an unknown command prints usage and exits non-zero without starting a worker', () => {
    const result = runWorkerService(['stauts']);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command: stauts');
    expect(result.stderr).toContain('Usage: worker-service <command>');
    expect(existsSync(join(dataDirectory, 'worker.pid'))).toBe(false);
  }, RUN_TIMEOUT_MS + 10_000);
});
