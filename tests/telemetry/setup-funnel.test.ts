import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSetupTelemetry } from '../../src/services/setup/telemetry.js';
import { readSetupTelemetryContext, setupSessionPath, startSetupSession } from '../../src/shared/setup-state.js';
import { parseSetupEvent, type SetupEvent } from '../../src/shared/setup-funnel.js';
import { createSetupTracker } from '../../src/ui/my-work/src/setup/setup-telemetry.ts';

const scratch = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, 'setup-telemetry-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture() {
  const statePath = join(dir, randomUUID(), 'setup-state.json');
  startSetupSession(statePath, true);
  const context = readSetupTelemetryContext(statePath)!;
  const sent: SetupEvent[] = [];
  let consent = true;
  const collector = createSetupTelemetry(statePath, { consent: () => consent, capture: event => { sent.push(event); } });
  const event: SetupEvent = { event: 'setup_step_viewed', event_id: randomUUID(), ...context, setup_funnel_version: 1,
    visit_id: randomUUID(), step: 'scan', branch: 'go', branch_confirmed: false, occurred_at: Date.now() };
  return { statePath, context, sent, collector, event, optOut: () => { consent = false; } };
}

describe('setup episode collection', () => {
  it('generates a fresh per-attempt identity and freezes the initial Pro configuration', () => {
    const { statePath, context } = fixture();
    expect(context.already_pro).toBe(true);
    startSetupSession(statePath, false);
    expect(readSetupTelemetryContext(statePath)?.setup_flow_id).not.toBe(context.setup_flow_id);
    expect(readSetupTelemetryContext(statePath)?.already_pro).toBe(false);
    writeFileSync(setupSessionPath(statePath), JSON.stringify({ pid: 2 ** 22 + 54321, ...context }));
    expect(readSetupTelemetryContext(statePath)).toBeNull();
  });
  it('checks consent on every read and write, including revocation', () => {
    const { collector, event, sent, optOut } = fixture();
    expect(collector.context()).not.toBeNull();
    expect(collector.receive(event)).toBe(true);
    optOut();
    expect(collector.context()).toBeNull();
    expect(collector.receive({ ...event, event_id: randomUUID() })).toBe(false);
    expect(sent).toHaveLength(1);
  });
  it('rejects forged episodes, wrong initial cohorts and stale timestamps', () => {
    const { collector, event, sent } = fixture();
    for (const changes of [{ setup_flow_id: randomUUID() }, { already_pro: false }, { occurred_at: Date.now() - 600_000 }]) {
      expect(collector.receive({ ...event, ...changes })).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });
  it('admits only the closed content-free event schema', () => {
    const { collector, event, sent } = fixture();
    for (const changes of [{ prompt: 'private' }, { url: 'https://example.test/?token=private' },
      { event: 'setup_step_error', error_code: 'my private exception' }, { step: '/home/private' }, { visit_id: 'a secret' },
      { event: 'setup_step_action', action: 'search', query: 'private question' }]) {
      expect(parseSetupEvent({ ...event, ...changes })).toBeNull();
      expect(collector.receive({ ...event, ...changes })).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });
  it('deduplicates delivery and permits only one exit for each originating visit', () => {
    const { collector, event, sent } = fixture();
    expect(collector.receive(event)).toBe(true);
    expect(collector.receive(event)).toBe(true);
    const next = { ...event, event: 'setup_step_transitioned', event_id: randomUUID(), to_step: 'reveal', direction: 'forward' };
    expect(collector.receive(next)).toBe(true);
    expect(collector.receive({ ...next, event_id: randomUUID(), to_step: 'choice' })).toBe(true);
    expect(sent).toHaveLength(2);
  });
  it('retains validated completion through immediate installer session removal', () => {
    const { collector, event, sent, statePath } = fixture();
    const common = { ...event, step: 'workspace', branch_confirmed: true };
    const finish = collector.prepareCompletion([
      { ...common, event: 'setup_step_transitioned', to_step: 'complete', direction: 'forward' },
      { ...common, event: 'setup_completed', event_id: randomUUID() },
    ]);
    expect(sent).toHaveLength(0);
    rmSync(setupSessionPath(statePath));
    finish();
    expect(sent.map(item => item.event)).toEqual(['setup_step_transitioned', 'setup_completed']);
  });
  it('replays the complete pending visit chain if completion overtakes a blocked POST', async () => {
    const { collector, context, statePath, sent } = fixture();
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const tracker = createSetupTracker(async event => { await blocked; collector.receive(event); });
    tracker.start(context);
    tracker.view('scan', { branch: 'go', branch_confirmed: false });
    tracker.view('workspace', { branch: 'home', branch_confirmed: true });
    await Promise.resolve();
    expect(sent).toHaveLength(0);
    const batch = tracker.completionEvents();
    expect(batch).toHaveLength(5);
    const completeAfterWrite = collector.prepareCompletion(batch);
    rmSync(setupSessionPath(statePath));
    completeAfterWrite();
    completeAfterWrite();
    tracker.complete();
    unblock();
    await tracker.flush();
    expect(sent).toHaveLength(5);
    const workspace = sent.filter(event => event.step === 'workspace');
    expect(workspace.map(event => event.event)).toEqual(['setup_step_viewed', 'setup_step_transitioned', 'setup_completed']);
    expect(new Set(workspace.map(event => event.visit_id)).size).toBe(1);
  });
});
