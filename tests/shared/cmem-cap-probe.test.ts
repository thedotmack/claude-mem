import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  __setCmemCapProbePathForTests,
  cmemCapProbeAllowed,
  clearCmemCapProbe,
  CMEM_CAP_PROBE_INTERVAL_MS,
  noteCmemCapExhausted,
} from '../../src/shared/cmem-cap-probe';

describe('cmem allowance probe', () => {
  let directory: string;

  afterEach(() => {
    __setCmemCapProbePathForTests(null);
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('allows the first request, then one per day, and a success clears the wait', () => {
    directory = mkdtempSync(join(tmpdir(), 'cmem-cap-probe-'));
    const path = join(directory, 'cmem-cap-probe.json');
    __setCmemCapProbePathForTests(path);
    const start = Date.parse('2026-11-02T00:00:00.000Z');
    expect(cmemCapProbeAllowed(start)).toBe(true);
    noteCmemCapExhausted(start);
    expect(cmemCapProbeAllowed(start + 1000)).toBe(false);
    expect(cmemCapProbeAllowed(start + CMEM_CAP_PROBE_INTERVAL_MS - 1)).toBe(false);
    // A new reader (restart) sees the same file.
    expect(cmemCapProbeAllowed(start + CMEM_CAP_PROBE_INTERVAL_MS)).toBe(true);
    noteCmemCapExhausted(start + CMEM_CAP_PROBE_INTERVAL_MS);
    expect(cmemCapProbeAllowed(start + CMEM_CAP_PROBE_INTERVAL_MS + 1)).toBe(false);
    clearCmemCapProbe();
    expect(cmemCapProbeAllowed(start + CMEM_CAP_PROBE_INTERVAL_MS + 1)).toBe(true);
  });
});
