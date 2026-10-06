import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SCRIPT = join(import.meta.dir, '../../scripts/worker-logs.cjs');
const LOGGER = pathToFileURL(join(import.meta.dir, '../../src/utils/logger.ts')).href;
const COLLECTOR = pathToFileURL(join(import.meta.dir, '../../scripts/bug-report/collector.ts')).href;
const INSTANT = '2026-04-02T00:15:00.000Z';
const CLOCK = `const RealDate = Date; globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [${JSON.stringify(INSTANT)}])); }
  static now() { return new RealDate(${JSON.stringify(INSTANT)}).getTime(); }
};`;

describe('daily log consumers use the real worker logger', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'claude-mem-log-producer-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function env(tz: string) {
    return { ...process.env, CLAUDE_MEM_DATA_DIR: '', CLAUDE_MEM_WORKER_PORT: '1', HOME: home, USERPROFILE: home, TZ: tz };
  }

  function produce(tz: string) {
    const result = spawnSync(process.execPath, ['-e', CLOCK + `
      const { logger } = await import(${JSON.stringify(LOGGER)});
      logger.info('WORKER', 'native worker marker 🧭');
    `], { env: env(tz), encoding: 'utf-8' });
    expect(result.status).toBe(0);
    const logs = join(home, '.claude-mem', 'logs');
    // Obsolete and previous-local-day files must not win over the producer.
    writeFileSync(join(logs, 'worker-2026-04-02.log'), 'obsolete filename\n');
    writeFileSync(join(logs, 'worker-2026-04-01.log'), 'obsolete local filename\n');
    writeFileSync(join(logs, 'claude-mem-2026-04-01.log'), 'previous UTC day\n');
  }

  function tail(tz: string) {
    const clockPath = join(home, 'clock.cjs');
    writeFileSync(clockPath, CLOCK);
    return spawnSync('node', ['--require', clockPath, SCRIPT], { env: env(tz), encoding: 'utf-8' });
  }

  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    it(`reads the logger-produced UTC daily file in ${tz}`, () => {
      produce(tz);
      const result = tail(tz);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('native worker marker 🧭');
      expect(result.stdout).not.toContain('obsolete');
      expect(result.stdout).not.toContain('previous UTC day');
    });
  }

  it('includes the logger-produced daily file in bug report diagnostics', () => {
    produce('America/Los_Angeles');
    const result = spawnSync(process.execPath, ['-e', CLOCK + `
      const { collectDiagnostics } = await import(${JSON.stringify(COLLECTOR)});
      const result = await collectDiagnostics();
      process.stdout.write('DIAGNOSTIC_LOGS=' + JSON.stringify(result.logs.workerLog));
    `], { env: env('America/Los_Angeles'), encoding: 'utf-8', timeout: 20000 });
    expect(result.status).toBe(0);
    const logs = JSON.parse(result.stdout.split('DIAGNOSTIC_LOGS=')[1]);
    expect(logs.join('\n')).toContain('native worker marker 🧭');
    expect(logs.join('\n')).not.toContain('obsolete');
  }, 25000);
});
