import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createSetupInstallerResumer } from '../../../src/services/setup/resume-installer.js';
import { INITIAL_SETUP_STATE, readSetupState, startSetupSession, writeSetupState, type SetupStateFile } from '../../../src/shared/setup-state.js';
import type { spawnHidden } from '../../../src/shared/spawn.js';

const scratch = join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratch, { recursive: true });
let fixture: string;
let statePath: string;

class Child extends EventEmitter {
  pid = 123456;
  unrefs = 0;
  unref() { this.unrefs++; }
}

const pending = (): SetupStateFile => ({
  ...INITIAL_SETUP_STATE,
  install: {
    status: 'waiting', selection: null, error: null,
    catalog: {
      agents: [{ id: 'claude-code', label: 'Claude Code', hint: '', detected: true }],
      skills: [], reinstall: false,
      defaults: { agents: ['claude-code'], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: false },
    },
  },
});

beforeEach(() => {
  fixture = mkdtempSync(join(scratch, 'setup-resume-'));
  statePath = join(fixture, 'setup-state.json');
  writeSetupState(pending(), statePath);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function harness() {
  const children: Child[] = [];
  const calls: unknown[][] = [];
  let changed = 0;
  const resume = createSetupInstallerResumer(statePath, {
    resolveProgram: () => ({ runtime: '/fixture/bun', cli: join(fixture, 'dist', 'npx-cli', 'index.js') }),
    spawn: ((...args: unknown[]) => {
      calls.push(args);
      const child = new Child(); children.push(child);
      return child as unknown as ChildProcess;
    }) as typeof spawnHidden,
    isAlive: () => true,
    onStateChange: () => { changed++; },
  });
  return { resume, children, calls, changed: () => changed };
}

describe('deferred setup installer', () => {
  it('starts only an explicit pending install, not legacy state or completed setup', async () => {
    const run = harness();
    writeSetupState({ ...INITIAL_SETUP_STATE }, statePath);
    await run.resume();
    writeSetupState({ ...pending(), status: 'complete' }, statePath);
    await run.resume();
    expect(run.children).toHaveLength(0);
  });

  it('leaves a live installer alone', async () => {
    const run = harness();
    startSetupSession(statePath);
    await run.resume();
    expect(run.children).toHaveLength(0);
  });

  it('coalesces concurrent requests and does not launch again while the child is alive', async () => {
    const run = harness();
    const first = run.resume();
    const second = run.resume();
    expect(run.children).toHaveLength(1);
    run.children[0].emit('spawn');
    await Promise.all([first, second]);
    await run.resume();
    expect(run.children).toHaveLength(1);
    expect(run.children[0].unrefs).toBe(1);
    expect(run.calls[0][1]).toEqual(['--no-install', join(fixture, 'dist', 'npx-cli', 'index.js'), 'install', '--setup', 'resume']);
    expect(run.calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore', env: { CLAUDE_MEM_DATA_DIR: fixture } });
  });

  it('saves a spawn failure, does not retry automatically, and allows an explicit retry', async () => {
    const run = harness();
    const first = run.resume();
    run.children[0].emit('error', new Error('Bun could not start'));
    await expect(first).rejects.toThrow('Bun could not start');
    expect(readSetupState(statePath).install).toMatchObject({ status: 'failed', error: 'Bun could not start' });
    expect(run.changed()).toBe(1);
    await run.resume();
    expect(run.children).toHaveLength(1);
    const retry = run.resume(true);
    expect(run.children).toHaveLength(2);
    run.children[1].emit('spawn');
    await retry;
  });

  it('reports a missing setup program without leaving the page waiting', async () => {
    const resume = createSetupInstallerResumer(statePath, {
      resolveProgram: () => { throw new Error('The setup program is missing'); },
    });
    await expect(resume()).rejects.toThrow('setup program is missing');
    expect(readSetupState(statePath).install).toMatchObject({ status: 'failed', error: 'The setup program is missing' });
  });

  it('surfaces an early child exit and keeps saved selections for review', async () => {
    const run = harness();
    const initial = pending();
    initial.install!.selection = initial.install!.catalog.defaults;
    initial.install!.status = 'installing';
    writeSetupState(initial, statePath);
    const started = run.resume();
    run.children[0].emit('spawn');
    await started;
    run.children[0].emit('exit', 1, null);
    const saved = readSetupState(statePath);
    expect(saved.install).toMatchObject({ status: 'failed', selection: initial.install!.selection });
    expect(saved.install?.error).toContain('exit 1');
    expect(run.changed()).toBe(1);
    await run.resume();
    expect(run.children).toHaveLength(1);
  });

  it('handles an exit before spawn instead of leaving the launch request unresolved', async () => {
    const run = harness();
    const started = run.resume();
    run.children[0].emit('exit', null, 'SIGTERM');
    await expect(started).rejects.toThrow('SIGTERM');
    expect(readSetupState(statePath).install?.status).toBe('failed');
    expect(run.changed()).toBe(1);
  });

  it('preserves installed agents if the child stops during the storage and account steps', async () => {
    const run = harness();
    const started = run.resume();
    run.children[0].emit('spawn');
    await started;
    const state = pending();
    state.install!.status = 'ready';
    state.install!.selection = state.install!.catalog.defaults;
    state.choice = { branch: 'home', memoryBilling: 'existing', chosenAt: 'now' };
    writeSetupState(state, statePath);
    run.children[0].emit('exit', 2, null);
    const saved = readSetupState(statePath);
    expect(saved.install?.status).toBe('ready');
    expect(saved.choice).toEqual(state.choice);
    expect(saved.installer).toMatchObject({ stage: 'failed' });
    await run.resume();
    expect(run.children).toHaveLength(1);
  });

  it('does not overwrite completion or another live installer when the old child exits', async () => {
    for (const changedTo of ['complete', 'active'] as const) {
      writeSetupState(pending(), statePath);
      const run = harness();
      const started = run.resume();
      run.children[0].emit('spawn');
      await started;
      if (changedTo === 'complete') writeSetupState({ ...pending(), status: 'complete' }, statePath);
      else startSetupSession(statePath);
      run.children[0].emit('exit', 1, null);
      expect(readSetupState(statePath).install?.status).toBe('waiting');
      expect(run.changed()).toBe(0);
    }
  });
});
