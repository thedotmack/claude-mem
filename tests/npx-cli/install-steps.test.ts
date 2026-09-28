import { describe, expect, it } from 'bun:test';
import {
  detectAgentContext,
  INSTALL_STEP_ID_RE,
  INSTALL_STEP_IDS,
  StepTracker,
} from '../../src/npx-cli/install/install-steps';
import { InstallAbortError } from '../../src/npx-cli/install/error-reporter';
import { classifyError } from '../../src/npx-cli/install/error-taxonomy';
import { CLOSED_VALUE_PATTERNS } from '../../src/services/telemetry/scrub';

function tracker() {
  const events: Array<{ event: string; props: Record<string, unknown> }> = [];
  const t = new StepTracker(
    { version: '13.29.0', agent_context: 'claude-code', interactive: false },
    async (event, props) => { events.push({ event, props }); },
  );
  return { t, events };
}

describe('StepTracker', () => {
  it('emits exactly one install_step per step, even if a step is recorded twice', async () => {
    const { t, events } = tracker();
    await t.run('bun.ensure', async () => 'x');
    await t.run('uv.ensure', async () => 'y');
    t.record('bun.ensure', 'ok', 5);
    await t.flush();
    expect(events.map((e) => e.props.step_id)).toEqual(['bun.ensure', 'uv.ensure']);
    expect(events.every((e) => e.event === 'install_step')).toBe(true);
    expect(events[0].props).toMatchObject({ outcome: 'ok', agent_context: 'claude-code', version: '13.29.0', interactive: false });
  });

  it('records error with the taxonomy category and rethrows the abort', async () => {
    const { t, events } = tracker();
    const abort = new InstallAbortError('x', {
      category: classifyError(new Error('Bun executable not found'), { component: 'bun-install', phase: 'setup-runtime' }),
      remediation: 'r',
      cause: null,
    });
    const err = await t.run('bun.ensure', async () => { throw abort; }, {
      extra: () => ({ bun_fail_reason: 'unzip-missing', fix_id: 'fix.bun.npm-package', fix_outcome: 'error' }),
    }).catch((e) => e);
    expect(err).toBe(abort);
    expect(t.current).toBe('bun.ensure');
    await t.flush();
    expect(events[0].props).toMatchObject({
      step_id: 'bun.ensure',
      outcome: 'error',
      error_category: 'bun-missing-after-install',
      bun_fail_reason: 'unzip-missing',
      fix_id: 'fix.bun.npm-package',
    });
  });

  it('marks a step failed when it reports failure without throwing (IDE on the summary)', async () => {
    const { t, events } = tracker();
    await t.run('ide.cursor', async () => undefined, { failed: () => true });
    await t.flush();
    expect(events[0].props.outcome).toBe('error');
    expect(t.current).toBeNull();
  });

  it('every fixed step id passes both the tracker pattern and the scrubber pattern', () => {
    for (const id of [...INSTALL_STEP_IDS, 'ide.claude-code', 'ide.roo-code']) {
      expect(INSTALL_STEP_ID_RE.test(id)).toBe(true);
      expect(CLOSED_VALUE_PATTERNS.step_id.test(id)).toBe(true);
    }
    expect(CLOSED_VALUE_PATTERNS.step_id.test('ide./etc/passwd')).toBe(false);
  });
});

describe('detectAgentContext', () => {
  it('reads env markers only', () => {
    expect(detectAgentContext({ CLAUDECODE: '1' }, false)).toBe('claude-code');
    expect(detectAgentContext({ CURSOR_AGENT: '1' }, false)).toBe('cursor');
    expect(detectAgentContext({ CODEX_SANDBOX: 'seatbelt' }, false)).toBe('codex');
    expect(detectAgentContext({ AI_AGENT: 'codex-cli' }, false)).toBe('codex');
    expect(detectAgentContext({ AI_AGENT: 'something-else' }, false)).toBe('unknown-non-tty');
    expect(detectAgentContext({}, false)).toBe('unknown-non-tty');
    expect(detectAgentContext({}, true)).toBe('tty');
  });
});
