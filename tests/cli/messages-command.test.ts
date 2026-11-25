import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchClaudeMemMessage } from '../../src/shared/claude-mem-messages.js';

const messageId = 'holiday-cloud-sync-2026';
const cliEntry = join(__dirname, '../../src/npx-cli/index.ts');

it('acknowledges only a dispatched message and preserves its original receipt on retry', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmem-message-cli-'));
  const receipt = join(dataDir, 'messages-from-claude-mem', messageId + '.acknowledged.json');
  function run(...args: string[]) {
    return spawnSync(process.execPath, [cliEntry, 'messages', ...args], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  try {
    expect(run('--help').status).toBe(0);
    expect(run('acknowledge', '../not-a-message').status).toBe(1);
    const missing = run('acknowledge', messageId);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('has not been dispatched');
    expect(existsSync(receipt)).toBe(false);

    expect(dispatchClaudeMemMessage(messageId, dataDir)).toBe(true);
    const malformed = run('acknowledge', messageId, 'extra');
    expect(malformed.status).toBe(1);
    expect(existsSync(receipt)).toBe(false);
    const first = run('acknowledge', messageId);
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe(`Acknowledged Claude-Mem message ${messageId}.`);
    const saved = readFileSync(receipt, 'utf8');
    expect(JSON.parse(saved).id).toBe(messageId);
    expect(Number.isFinite(Date.parse(JSON.parse(saved).acknowledgedAt))).toBe(true);

    expect(run('acknowledge', messageId).status).toBe(0);
    expect(readFileSync(receipt, 'utf8')).toBe(saved);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 20_000);
