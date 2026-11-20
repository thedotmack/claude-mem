import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  it.skipIf(process.platform === 'win32')('does not write through a symlink planted at the old pid temp name', () => {
    // The probe used to be written through `<path>.<pid>.tmp`, a name anyone on
    // the machine can predict and pre-plant as a symlink; the write followed it
    // and clobbered the target (the rename only replaced the link itself).
    directory = mkdtempSync(join(tmpdir(), 'cmem-cap-probe-'));
    const path = join(directory, 'cmem-cap-probe.json');
    const outsideFile = join(directory, 'outside-target.txt');
    writeFileSync(outsideFile, 'precious contents');
    symlinkSync(outsideFile, `${path}.${process.pid}.tmp`);
    __setCmemCapProbePathForTests(path);

    noteCmemCapExhausted(Date.parse('2026-11-02T00:00:00.000Z'));

    expect(readFileSync(outsideFile, 'utf-8')).toBe('precious contents');
    expect(JSON.parse(readFileSync(path, 'utf-8')).exhaustedAtMs).toBe(Date.parse('2026-11-02T00:00:00.000Z'));
    // The planted link is the only .tmp left; nothing was created beside it.
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([`cmem-cap-probe.json.${process.pid}.tmp`]);
  });
});
