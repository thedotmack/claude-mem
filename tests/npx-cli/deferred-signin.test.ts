import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { signinArmForInstallId, type SigninArm } from '../../src/npx-cli/install/signin-arm';

// Runs the real offerDeferredLogin in a non-TTY child with fetch stubbed and a
// fake `xdg-open` first on PATH that logs every URL it is asked to open. The
// child is a Linux "desktop" (DISPLAY set, no CI/SSH/WSL) unless a test says
// otherwise, so the only things deciding the tab are the rules under test.

// Each case spawns one or two Bun children that import the whole installer.
setDefaultTimeout(30_000);

const repoRoot = process.cwd();
const decoder = new TextDecoder();
const pairingId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const secret = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const loginClaim = `/api/pro/trial/claim?pairing=${pairingId}&login_only=1`;
const authorizationUrl = `https://cmem.ai/login?next=${encodeURIComponent(loginClaim)}`;
const startBody = {
  pairing_id: pairingId,
  secret,
  user_code: 'ABCD-2345',
  authorization_url: authorizationUrl,
  checkout_url: `https://cmem.ai/api/pro/trial/claim?pairing=${pairingId}&trial=7`,
  poll_interval: 3,
  expires_in: 1800,
};

function installIdForArm(arm: SigninArm): string {
  for (;;) {
    const id = randomUUID();
    if (signinArmForInstallId(id) === arm) return id;
  }
}

let dataDir: string;
let binDir: string;
let openLog: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cm-deferred-'));
  binDir = mkdtempSync(join(tmpdir(), 'cm-fakebin-'));
  openLog = join(binDir, 'opened.log');
  const opener = join(binDir, 'xdg-open');
  writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${openLog}"\n`);
  chmodSync(opener, 0o755);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

function setArm(arm: SigninArm): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'telemetry.json'), JSON.stringify({ installId: installIdForArm(arm), decidedAt: '' }));
}

function runOffer(opts: { noBrowser?: boolean; env?: Record<string, string> } = {}): { output: string; exitCode: number; sources: string[] } {
  const script = `
    const sources = [];
    globalThis.fetch = async (_url, init) => {
      sources.push(JSON.parse(init.body).source);
      return new Response(${JSON.stringify(JSON.stringify(startBody))}, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { offerDeferredLogin } = await import('./src/npx-cli/commands/install.ts');
    const result = await offerDeferredLogin({ provider: 'claude', providerSource: 'default', noBrowser: ${opts.noBrowser === true} }, 'test-version');
    console.log('__RESULT__=' + JSON.stringify({ result, sources }));
  `;
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    CLAUDE_MEM_DATA_DIR: dataDir,
    CLAUDE_MEM_TELEMETRY: '0',
    DISPLAY: ':0',
    ...opts.env,
  };
  for (const key of ['CI', 'SSH_CONNECTION', 'SSH_TTY', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'CLAUDE_MEM_NO_BROWSER', 'WAYLAND_DISPLAY']) {
    if (!(opts.env && key in opts.env)) delete env[key];
  }
  const child = Bun.spawnSync([process.execPath, '--eval', script], {
    cwd: repoRoot,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = decoder.decode(child.stdout) + decoder.decode(child.stderr);
  const marker = output.split('\n').find((l) => l.startsWith('__RESULT__='));
  const parsed = marker ? JSON.parse(marker.slice('__RESULT__='.length)) : { sources: [] };
  return { output, exitCode: child.exitCode ?? -1, sources: parsed.sources };
}

function openedUrls(): string[] {
  return existsSync(openLog) ? readFileSync(openLog, 'utf-8').trim().split('\n').filter(Boolean) : [];
}

describe('deferred sign-in (non-TTY install)', () => {
  it('arm B opens the login link once on a desktop and says so', () => {
    setArm('B');
    const { output, exitCode, sources } = runOffer();
    expect(exitCode, output).toBe(0);
    expect(sources).toEqual(['npx-installer-deferred-open']);
    expect(openedUrls()).toEqual([authorizationUrl]);
    expect(output).toContain('A sign-in page opened in your browser.');
    expect(existsSync(join(dataDir, 'signin-browser-opened'))).toBe(true);
  });

  it('the marker stops a second tab on the next run', () => {
    setArm('C');
    runOffer();
    const second = runOffer();
    expect(second.exitCode, second.output).toBe(0);
    expect(openedUrls()).toHaveLength(1);
    expect(second.output).not.toContain('A sign-in page opened in your browser.');
    expect(second.output).toContain('  Link:  https://cmem.ai/login?next=');
  });

  it('--no-browser never calls the opener', () => {
    setArm('B');
    const { output } = runOffer({ noBrowser: true });
    expect(openedUrls()).toEqual([]);
    expect(output).toContain('  Link:  ');
    expect(output).not.toContain('A sign-in page opened');
  });

  it('CLAUDE_MEM_NO_BROWSER=1 never calls the opener', () => {
    setArm('B');
    runOffer({ env: { CLAUDE_MEM_NO_BROWSER: '1' } });
    expect(openedUrls()).toEqual([]);
  });

  it('under CI nothing opens and cmem.ai is not contacted', () => {
    setArm('B');
    const { output, sources } = runOffer({ env: { CI: '1' } });
    expect(sources).toEqual([]);
    expect(openedUrls()).toEqual([]);
    expect(output).not.toContain('  Link:  ');
  });

  it('over SSH or on headless Linux nothing opens, but the link is printed', () => {
    setArm('B');
    runOffer({ env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } });
    runOffer({ env: { DISPLAY: '' } });
    expect(openedUrls()).toEqual([]);
  });

  it('arm A keeps today’s link-only behavior and source', () => {
    setArm('A');
    const { output, sources } = runOffer();
    expect(sources).toEqual(['npx-installer-deferred']);
    expect(openedUrls()).toEqual([]);
    expect(output).toContain('  Link:  ');
  });

  it('saves the pairing for login --check (0600, secret only on disk) and marks the install unclaimed', () => {
    setArm('A');
    const { output } = runOffer();
    expect(output).not.toContain(secret);
    const pendingPath = join(dataDir, 'pending-signin.json');
    const pending = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    expect(pending).toMatchObject({ pairingId, secret, url: authorizationUrl, source: 'npx-installer-deferred' });
    expect(statSync(pendingPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dataDir, 'signin-state.json'), 'utf-8'))).toMatchObject({ state: 'unclaimed', arm: 'A' });
  });
});
