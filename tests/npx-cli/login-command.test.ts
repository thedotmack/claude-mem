import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseLastResultLine } from '../../src/npx-cli/install/result-line';

// Runs the real `login` command in a non-TTY child with fetch stubbed per URL:
// /api/installer/oauth/start mints a new pairing per call, and the poll
// endpoint answers with the status/body the test picks.

setDefaultTimeout(30_000);

const repoRoot = process.cwd();
const decoder = new TextDecoder();
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cm-login-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface PollReply { status: number; body: unknown }

/** 48 hex chars, unique per pairing; never a substring of the printed URL. */
function secretFor(n: number): string {
  return 'ef'.repeat(23) + 'a' + String(n % 10);
}

function runLogin(argv: string[], poll: PollReply | 'throw' = { status: 202, body: { status: 'pending', stage: 'awaiting_login' } }) {
  const script = `
    let n = 0;
    const calls = [];
    const secretFor = ${secretFor.toString()};
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/api/installer/oauth/start')) {
        n += 1;
        calls.push({ kind: 'start', source: body.source });
        const id = crypto.randomUUID().replace(/-/g, '');
        const claim = '/api/pro/trial/claim?pairing=' + id + '&login_only=1';
        return new Response(JSON.stringify({
          pairing_id: id,
          secret: secretFor(n),
          user_code: 'ABCD-2345',
          authorization_url: 'https://cmem.ai/login?next=' + encodeURIComponent(claim),
          checkout_url: 'https://cmem.ai/api/pro/trial/claim?pairing=' + id + '&trial=7',
          poll_interval: 3,
          expires_in: 1800,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      calls.push({ kind: 'poll', pairing_id: body.pairing_id, has_secret: typeof body.secret === 'string' && body.secret.length > 0 });
      ${poll === 'throw' ? "throw new TypeError('fetch failed');" : `return new Response(${JSON.stringify(JSON.stringify(poll.body))}, { status: ${poll.status}, headers: { 'content-type': 'application/json' } });`}
    };
    const { runLoginCommand } = await import('./src/npx-cli/commands/login.ts');
    const code = await runLoginCommand(${JSON.stringify(argv)});
    process.stderr.write('__CALLS__=' + JSON.stringify(calls) + '\\n');
    process.exitCode = code;
  `;
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_MEM_DATA_DIR: dataDir,
    CLAUDE_MEM_TELEMETRY: '0',
    CLAUDE_MEM_NO_BROWSER: '1',
  };
  const child = Bun.spawnSync([process.execPath, '--eval', script], { cwd: repoRoot, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const stdout = decoder.decode(child.stdout);
  const stderr = decoder.decode(child.stderr);
  const callsLine = stderr.split('\n').find((l) => l.startsWith('__CALLS__='));
  return {
    stdout,
    stderr,
    exitCode: child.exitCode,
    calls: callsLine ? JSON.parse(callsLine.slice('__CALLS__='.length)) as Array<Record<string, unknown>> : [],
  };
}

function pending() {
  return JSON.parse(readFileSync(join(dataDir, 'pending-signin.json'), 'utf-8'));
}
function state() {
  const path = join(dataDir, 'signin-state.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')).state : null;
}

describe('login --request', () => {
  it('makes a fresh npx-login-request pairing on every call and never prints the secret', () => {
    const first = runLogin(['--request']);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const firstPairing = pending().pairingId;
    const second = runLogin(['--request']);
    expect(second.exitCode).toBe(0);
    expect(pending().pairingId).not.toBe(firstPairing);
    expect(first.calls).toEqual([{ kind: 'start', source: 'npx-login-request' }]);
    for (const run of [first, second]) {
      expect(run.stdout).not.toContain('efefefef');
      expect(run.stdout).toContain('  Link:  https://cmem.ai/login?next=');
    }
    const result = parseLastResultLine(first.stdout)!;
    expect(result).toMatchObject({ command: 'login', status: 'ok', human_action_required: 'sign-in' });
    expect(result.signin).toMatchObject({ status: 'pending', check_command: 'npx claude-mem login --check' });
    expect(result.signin!.expires_in).toBeGreaterThan(1700);
    expect(first.stdout.trim().split('\n').pop()!.startsWith('CLAUDE_MEM_RESULT ')).toBe(true);
    expect(state()).toBe('unclaimed');
  });

  it('--json prints one object with the link and next steps, no secret', () => {
    const run = runLogin(['--request', '--json']);
    expect(run.exitCode).toBe(0);
    const out = JSON.parse(run.stdout.trim());
    expect(Object.keys(out).sort()).toEqual(['agent_next_steps', 'browser_opened', 'check_command', 'expires_in', 'for_the_user', 'status', 'url'].sort());
    expect(out.url).toStartWith('https://cmem.ai/login?next=');
    expect(out.check_command).toBe('npx claude-mem login --check');
    expect(run.stdout).not.toContain('efefefef');
  });
});

describe('login --check', () => {
  it('none when nothing was requested (no network call)', () => {
    const run = runLogin(['--check']);
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([]);
    expect(parseLastResultLine(run.stdout)).toMatchObject({ signin: { status: 'none' }, next_command: 'npx claude-mem login --request' });
  });

  it('signed_in on an authenticated poll, and marks the install claimed', () => {
    runLogin(['--request']);
    const run = runLogin(['--check'], { status: 200, body: { status: 'authenticated', user_id: 'u1' } });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([{ kind: 'poll', pairing_id: pending().pairingId, has_secret: true }]);
    expect(parseLastResultLine(run.stdout)).toMatchObject({ signin: { status: 'signed_in' }, human_action_required: null });
    expect(state()).toBe('claimed');
    expect(run.stdout).not.toContain('efefefef');
  });

  it('pending on a 202', () => {
    runLogin(['--request']);
    const run = runLogin(['--check'], { status: 202, body: { status: 'pending', stage: 'awaiting_login' } });
    expect(parseLastResultLine(run.stdout)).toMatchObject({ signin: { status: 'pending' }, human_action_required: 'sign-in' });
    expect(state()).toBe('unclaimed');
  });

  it('expired on a 410, pointing at --request', () => {
    runLogin(['--request']);
    const run = runLogin(['--check', '--json'], { status: 410, body: { status: 'expired' } });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ status: 'expired', next_command: 'npx claude-mem login --request' });
  });

  it('expired when the saved pairing is past its expiry and the server still says pending', () => {
    runLogin(['--request']);
    const saved = pending();
    writeFileSync(join(dataDir, 'pending-signin.json'), JSON.stringify({ ...saved, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const run = runLogin(['--check'], { status: 202, body: { status: 'pending' } });
    expect(parseLastResultLine(run.stdout)?.signin?.status).toBe('expired');
  });

  it('fails (exit 1) without guessing when cmem.ai is unreachable', () => {
    runLogin(['--request']);
    const run = runLogin(['--check'], 'throw');
    expect(run.exitCode).toBe(1);
    expect(parseLastResultLine(run.stdout)).toMatchObject({ status: 'failed' });
    expect(state()).toBe('unclaimed');
  });
});

describe('login --dismiss', () => {
  it('records dismissed, and a later deferred offer does not undo it', () => {
    runLogin(['--request']);
    const run = runLogin(['--dismiss']);
    expect(run.exitCode).toBe(0);
    expect(state()).toBe('dismissed');
    runLogin(['--request']);
    expect(state()).toBe('dismissed');
  });

  it('rejects zero or several modes', () => {
    expect(runLogin([]).exitCode).toBe(1);
    expect(runLogin(['--check', '--dismiss']).exitCode).toBe(1);
  });
});
