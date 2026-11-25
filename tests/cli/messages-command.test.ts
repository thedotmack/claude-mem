import { expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMessagesCommand } from '../../src/cli/messages-command.js';
import { dispatchClaudeMemMessage } from '../../src/shared/claude-mem-messages.js';

it('records only a dispatched message, preserving the first receipt on retry', () => {
  const id = 'holiday-cloud-sync-2026';
  const dataDir = mkdtempSync(join(tmpdir(), 'cmem-message-cli-'));
  const previousDir = process.env.CLAUDE_MEM_DATA_DIR;
  const receiptPath = join(dataDir, 'messages-from-claude-mem', id + '.acknowledged.json');
  const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  try {
    expect(runMessagesCommand(['acknowledge', '../not-a-message'])).toBe(1);
    expect(stderr).toHaveBeenLastCalledWith('Unknown Claude-Mem message.\n');
    expect(runMessagesCommand(['acknowledge', id])).toBe(1);
    expect(stderr).toHaveBeenLastCalledWith('This Claude-Mem message has not been dispatched on this installation.\n');
    expect(stdout).not.toHaveBeenCalled();
    expect(existsSync(receiptPath)).toBe(false);

    expect(dispatchClaudeMemMessage(id, dataDir)).toBe(true);
    expect(runMessagesCommand(['acknowledge', id, 'extra'])).toBe(1);
    expect(stderr).toHaveBeenLastCalledWith('Usage: claude-mem messages acknowledge <message-id>\n');
    expect(existsSync(receiptPath)).toBe(false);
    expect(runMessagesCommand(['acknowledge', id])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(`Acknowledged Claude-Mem message ${id}.\n`);
    const saved = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(saved);
    expect(receipt.id).toBe(id);
    expect(Number.isFinite(Date.parse(receipt.acknowledgedAt))).toBe(true);
    expect(runMessagesCommand(['acknowledge', id])).toBe(0);
    expect(readFileSync(receiptPath, 'utf8')).toBe(saved);
    expect(runMessagesCommand(['--help'])).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith('Usage: claude-mem messages acknowledge <message-id>\n');

    const invalidDir = join(dataDir, 'file-instead-of-directory');
    writeFileSync(invalidDir, '');
    process.env.CLAUDE_MEM_DATA_DIR = invalidDir;
    stdout.mockClear();
    expect(runMessagesCommand(['acknowledge', id])).toBe(1);
    expect(stderr).toHaveBeenLastCalledWith('Could not record the acknowledgment on this installation.\n');
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDir;
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
