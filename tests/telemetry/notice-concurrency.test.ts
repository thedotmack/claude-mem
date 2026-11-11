import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeTelemetryNotice, loadTelemetryConfig, saveTelemetryConfig } from '../../src/services/telemetry/consent.js';

let directory: string;
let previous: Record<string, string | undefined>;
const keys = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_TELEMETRY', 'DO_NOT_TRACK'] as const;
const running: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = mkdtempSync(join(tmpdir(), 'telemetry-notice-race-'));
  process.env.CLAUDE_MEM_DATA_DIR = directory;
  delete process.env.CLAUDE_MEM_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  saveTelemetryConfig({ installId: 'existing-install', anonymousId: 'existing-anonymous', decidedAt: '' });
});
afterEach(async () => {
  writeFileSync(join(directory, 'read-release'), 'release');
  for (const child of running.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

function start(mode: 'notice' | 'disable', pause = false) {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/telemetry/notice-concurrency.ts', mode, pause ? 'pause' : 'run'], {
    cwd: join(import.meta.dir, '../..'), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  });
  running.push(child);
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { child, output };
}

async function waitForRead() {
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(directory, 'read-ready'))) {
    if (Date.now() > deadline) throw new Error('Child did not reach the read barrier');
    await Bun.sleep(5);
  }
}

it('a notice with a stale read cannot undo an actual CLI opt-out', async () => {
  const notice = start('notice', true);
  await waitForRead();
  const disable = start('disable');
  expect(await disable.child.exited, (await disable.output).join('\n')).toBe(0);
  expect(loadTelemetryConfig()?.enabled).toBe(false);
  writeFileSync(join(directory, 'read-release'), 'release');
  expect(await notice.child.exited, (await notice.output).join('\n')).toBe(0);
  expect(loadTelemetryConfig()).toMatchObject({ enabled: false, installId: 'existing-install', anonymousId: 'existing-anonymous' });
  expect(JSON.parse((await notice.output)[0]).notice).toBeNull();
  expect(existsSync(join(directory, 'telemetry.json.lock'))).toBe(false);
}, 10_000);

it('an active CLI writer excludes notice writes and another choice without a false acknowledgement', async () => {
  const original = readFileSync(join(directory, 'telemetry.json'), 'utf8');
  const disable = start('disable', true);
  await waitForRead();
  expect(consumeTelemetryNotice()).toContain('https://docs.claude-mem.ai/telemetry');
  expect(readFileSync(join(directory, 'telemetry.json'), 'utf8')).toBe(original);
  const competing = start('disable');
  expect(await competing.child.exited).toBe(1);
  const [stdout, stderr] = await competing.output;
  expect(stdout).not.toContain('Telemetry disabled.');
  expect(stderr).toContain('Telemetry configuration is locked');
  writeFileSync(join(directory, 'read-release'), 'release');
  expect(await disable.child.exited, (await disable.output).join('\n')).toBe(0);
  expect(loadTelemetryConfig()?.enabled).toBe(false);
  expect(loadTelemetryConfig()?.installId).toBe('existing-install');
  expect(existsSync(join(directory, 'telemetry.json.lock'))).toBe(false);
}, 10_000);
