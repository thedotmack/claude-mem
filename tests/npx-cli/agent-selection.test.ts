import { describe, expect, it } from 'bun:test';
import { initialIDESelection } from '../../src/npx-cli/commands/ide-detection.js';
import { claudeCodeInstallCommand } from '../../src/npx-cli/commands/install.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

describe('installer initial agent selection', () => {
  it('pre-selects detected agents when Claude Code is absent', () => {
    expect(initialIDESelection([
      { id: 'claude-code', label: 'Claude', detected: false },
      { id: 'opencode', label: 'OpenCode', detected: true },
      { id: 'pi', label: 'Pi', detected: true },
    ])).toEqual(['opencode', 'pi']);
  });
  it('falls back to Claude Code when no agents are detected', () => {
    expect(initialIDESelection([])).toEqual(['claude-code']);
  });
});

describe.skipIf(process.platform === 'win32')('Claude Code host installation failures', () => {
  function runDownload(script: string): number | null {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-host-download-'));
    try {
      writeFileSync(join(dir, 'curl'), '#!/bin/sh\n' + script, { mode: 0o755 });
      return spawnSync('/bin/bash', ['-c', claudeCodeInstallCommand(false)], {
        env: { ...process.env, PATH: dir + ':/usr/bin:/bin' },
        encoding: 'utf8', timeout: 5000,
      }).status;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('reports a download failure even when the empty installer shell exits successfully', () => {
    expect(runDownload('exit 7\n')).toBe(7);
  });

  it('preserves the native installer failure and success statuses', () => {
    expect(runDownload('printf "exit 9\\n"\n')).toBe(9);
    expect(runDownload('printf "exit 0\\n"\n')).toBe(0);
  });
});
