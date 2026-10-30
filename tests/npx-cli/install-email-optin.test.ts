import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

// The installer's TTY flag, settings path and signup endpoint are read at import, so the cases run in a fresh
// Bun process (the same pattern as browser-setup-install.test.ts). The child answers the opt-in questions through
// mocked prompts and points the signup at a loopback server that records each request.
if (process.env.CLAUDE_MEM_EMAIL_OPTIN_FIXTURE_CHILD !== import.meta.path) {
  describe('isolated email opt-in fixture', () => {
    it('passes every case in a fresh Bun process', () => {
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, CLAUDE_MEM_EMAIL_OPTIN_FIXTURE_CHILD: import.meta.path },
        stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      expect(child.exitCode).toBe(0);
    }, 150_000);
  });
} else {
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const fixture = mkdtempSync(join(scratchRoot, 'email-optin-'));
const data = join(fixture, 'data');
mkdirSync(data, { recursive: true });
const settingsPath = join(data, 'settings.json');

// The loopback signup service: answers with the status the case sets and records every body it receives.
const received: Array<Record<string, unknown>> = [];
let replyStatus = 200;
const server = await new Promise<Server>((resolve) => {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(replyStatus, { 'Content-Type': 'application/json' }).end('{}');
    });
  }).listen(0, '127.0.0.1', () => resolve(s));
});
const address = server.address();
const signupPort = typeof address === 'object' && address ? address.port : 0;

Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
process.env.CLAUDE_MEM_DATA_DIR = data;
process.env.CLAUDE_MEM_SIGNUP_URL = `http://127.0.0.1:${signupPort}/api/waitlist`;
process.env.DO_NOT_TRACK = '1';
delete process.env.CI;
delete process.env.CLAUDE_MEM_ONLINE_OPTIN;

const lines: string[] = [];
const questions: string[] = [];
let answers: string[] = [];
const prompts = { ...await import('@clack/prompts') };
mock.module('@clack/prompts', () => ({
  ...prompts,
  note: (value: string, title?: string) => lines.push(`${title}\n${value}`),
  spinner: () => ({ start: (value: string) => lines.push(value), stop: (value: string) => lines.push(value), message: () => {} }),
  text: async (options: { message: string }) => { questions.push(options.message); return answers.shift() ?? ''; },
  log: Object.fromEntries(['info', 'success', 'warn', 'error', 'message', 'step'].map(key => [key, (value: string) => lines.push(value)])),
}));

const { promptEmailOptIn } = await import('../../src/npx-cli/commands/install.js');
const stored = (): Record<string, string> => existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};

describe('installer email opt-in', () => {
  beforeEach(() => {
    rmSync(settingsPath, { force: true });
    received.length = 0;
    lines.length = 0;
    questions.length = 0;
    answers = [];
    replyStatus = 200;
    delete process.env.CI;
    delete process.env.CLAUDE_MEM_ONLINE_OPTIN;
  });

  afterAll(() => {
    server.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('sends the email and note, records the send, and does not ask again', async () => {
    answers = ['dev@example.com', 'onboarding a small team'];
    await promptEmailOptIn('1.2.3');

    expect(questions).toHaveLength(2);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ email: 'dev@example.com', note: 'onboarding a small team', version: '1.2.3', source: 'npx-installer' });
    expect(stored()).toMatchObject({
      CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: 'dev@example.com',
      CLAUDE_MEM_ONLINE_SIGNUP_NOTE: 'onboarding a small team',
      CLAUDE_MEM_ONLINE_SIGNUP_SENT: 'true',
    });

    await promptEmailOptIn('1.2.3');
    expect(questions).toHaveLength(2);
    expect(received).toHaveLength(1);
  });

  it('keeps a rejected send and retries it quietly on the next install', async () => {
    replyStatus = 500;
    answers = ['dev@example.com', ''];
    await promptEmailOptIn('1.2.3');

    expect(received).toHaveLength(1);
    expect(stored()).toMatchObject({ CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: 'dev@example.com', CLAUDE_MEM_ONLINE_SIGNUP_SENT: 'false' });
    expect(lines.some(line => line.includes("we'll finish sending it next time"))).toBe(true);

    replyStatus = 200;
    await promptEmailOptIn('1.2.4');
    expect(questions).toHaveLength(2);
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ email: 'dev@example.com', note: '', version: '1.2.4', source: 'npx-installer' });
    expect(stored().CLAUDE_MEM_ONLINE_SIGNUP_SENT).toBe('true');
  });

  it('skips the note and sends nothing when Enter is pressed at the email question', async () => {
    await promptEmailOptIn('1.2.3');

    expect(questions).toHaveLength(1);
    expect(received).toHaveLength(0);
    expect(stored().CLAUDE_MEM_ONLINE_SIGNUP_EMAIL).toBeUndefined();
  });

  it('asks nothing in CI or when the opt-in is turned off', async () => {
    process.env.CI = 'true';
    await promptEmailOptIn('1.2.3');
    delete process.env.CI;
    process.env.CLAUDE_MEM_ONLINE_OPTIN = 'false';
    await promptEmailOptIn('1.2.3');

    expect(questions).toHaveLength(0);
    expect(received).toHaveLength(0);
  });
});
}
