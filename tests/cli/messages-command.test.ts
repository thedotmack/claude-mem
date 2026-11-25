import { expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMessagesCommand } from '../../src/cli/messages-command.js';
import { dispatchClaudeMemMessage } from '../../src/shared/claude-mem-messages.js';

it('records only a dispatched message, preserving the first receipt on retry', () => {
  const id = 'holiday-cloud-sync-2026';
  const dataDir = mkdtempSync(join(tmpdir(), 'cmem-message-cli-'));
  const previousDir = process.env.CLAUDE_MEM_DATA_DIR;
  const receiptPath = join(dataDir, 'messages-from-claude-mem', id + '.acknowledged.json');
  const stdout = spyOn(console, 'log').mockImplementation(() => {});
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  try {
    expect(runMessagesCommand(['acknowledge', '../not-a-message'])).toBe(1);
    expect(runMessagesCommand(['acknowledge', id])).toBe(1);
    expect(stderr).toHaveBeenLastCalledWith('This Claude-Mem message has not been dispatched on this installation.');
    expect(stdout).not.toHaveBeenCalled();
    expect(existsSync(receiptPath)).toBe(false);

    expect(dispatchClaudeMemMessage(id, dataDir)).toBe(true);
    expect(runMessagesCommand(['acknowledge', id, 'extra'])).toBe(1);
    expect(existsSync(receiptPath)).toBe(false);
    expect(runMessagesCommand(['acknowledge', id])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(`Acknowledged Claude-Mem message ${id}.`);
    const saved = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(saved);
    expect(receipt.id).toBe(id);
    expect(Number.isFinite(Date.parse(receipt.acknowledgedAt))).toBe(true);
    expect(runMessagesCommand(['acknowledge', id])).toBe(0);
    expect(readFileSync(receiptPath, 'utf8')).toBe(saved);
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDir;
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
