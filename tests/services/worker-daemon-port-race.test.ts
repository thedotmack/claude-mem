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
