// SPDX-License-Identifier: Apache-2.0
//
// The My Work refresh may be pinned to the OpenCode backend (#5535) the same
// way it is pinned to Claude Code, Codex or Gemini: only that agent runs, and a
// failure is not handed to another agent's quota.

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'bun:test';
import { resolveRefreshAgents, WORK_VIEW_AGENT_CHOICES } from '../../src/services/work-view/refresh-task.js';

function withSettings(settings: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-opencode-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('My Work refresh on OpenCode', () => {
  it('is an accepted CLAUDE_MEM_WORK_VIEW_AGENT value', () => {
    expect(WORK_VIEW_AGENT_CHOICES).toContain('opencode');
  });

  it('CLAUDE_MEM_WORK_VIEW_AGENT=opencode runs only OpenCode and never falls through', () => {
    withSettings({ CLAUDE_MEM_WORK_VIEW_AGENT: 'opencode' }, dir => {
      expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: ['opencode'], preferredAgent: 'opencode', stayOnFirstUsableAgent: true });
    });
  });

  it('an empty setting still follows CLAUDE_MEM_PROVIDER, not OpenCode', () => {
    withSettings({ CLAUDE_MEM_PROVIDER: 'claude' }, dir => {
      expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: ['claude-code'], preferredAgent: 'claude-code', stayOnFirstUsableAgent: true });
    });
  });
});
