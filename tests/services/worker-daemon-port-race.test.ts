import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

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
    expect(source).toContain('isPortConflict && await waitForHealth(port,');
  });

  it('uses async catch handler to allow awaiting waitForHealth', () => {
    expect(source).toContain('worker.start().catch(async (error) =>');
  });

  it('logs info (not error) when cleanly exiting after port race', () => {
    expect(source).toContain("logger.info('SYSTEM', 'Duplicate daemon exiting");
  });
});

describe('Worker daemon stale-socket guard (orphaned listener)', () => {
  it('probes real bindability (not just health) to catch stale sockets', () => {
    // isPortInUse is health-based on Windows and cannot see a bound-but-dead
    // socket; isPortBindable attempts an actual bind, which is what catches it.
    expect(source).toContain('isPortBindable(port, host)');
  });

  it('retries a bounded number of times before giving up', () => {
    expect(source).toContain('STALE_SOCKET_RETRIES');
    expect(source).toContain('STALE_SOCKET_RETRY_DELAY_MS');
  });

  it('defers to a healthy worker that claims the port mid-wait (exit 0)', () => {
    expect(source).toContain('Healthy worker claimed the port during stale-socket wait');
  });

  it('fails with actionable guidance naming CLAUDE_MEM_WORKER_PORT', () => {
    expect(source).toContain('held by a stale socket with no healthy worker behind it');
    expect(source).toContain('set CLAUDE_MEM_WORKER_PORT to a');
  });
});
