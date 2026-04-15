import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Source-inspection tests for Issue #1447: Worker startup race condition
 *
 * When the MCP server and SessionStart hook both spawn a daemon concurrently,
 * one daemon loses the port bind race (EADDRINUSE / Bun's "port in use" error).
 * The loser should detect this, verify the winner is healthy, and exit cleanly
 * instead of logging an ERROR that clutters the user's session start output.
 *
 * These are source-inspection tests because the race is non-deterministic and
 * requires a real concurrent multi-process scenario to reproduce reliably.
 */

const WORKER_SERVICE_PATH = join(import.meta.dir, '../../src/services/worker-service.ts');
const source = readFileSync(WORKER_SERVICE_PATH, 'utf-8');

describe('Worker daemon port-race guard (#1447)', () => {
  it('detects EADDRINUSE error code in the port-conflict check', () => {
    expect(source).toContain("code === 'EADDRINUSE'");
  });

  it('detects Bun port-in-use message via regex in the port-conflict check', () => {
    expect(source).toContain('/port.*in use|address.*in use/i.test(error.message)');
  });

  it('calls waitForHealth before exiting on a port conflict', () => {
    // The guard must verify the winner is actually healthy before exiting,
    // otherwise a non-worker process on the port would suppress a real error.
    expect(source).toContain('isPortConflict && await waitForHealth(port,');
  });

  it('uses async catch handler to allow awaiting waitForHealth', () => {
    // The .catch() must be async so it can await the health check.
    expect(source).toContain('worker.start().catch(async (error) =>');
  });

  it('logs info (not error) when cleanly exiting after port race', () => {
    // Must not call logger.failure() / logger.error() on the clean exit path.
    expect(source).toContain("logger.info('SYSTEM', 'Duplicate daemon exiting");
  });
});
