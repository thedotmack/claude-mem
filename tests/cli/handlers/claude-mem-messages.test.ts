import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedHookInput } from '../../../src/cli/types.js';
import {
  acknowledgeClaudeMemMessage, dispatchClaudeMemMessage, formatClaudeMemMessage, nextClaudeMemMessage,
} from '../../../src/shared/claude-mem-messages.js';

const id = 'holiday-cloud-sync-2026';
const startup: NormalizedHookInput = { platform: 'claude-code', sessionSource: 'startup', sessionId: 's1', cwd: '/project' };
const settings = {
  CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
  CLAUDE_MEM_PRO_PLAN: '',
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
  CLAUDE_MEM_TEAMBRAIN_URL: '',
};
const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
let dataDir: string;

function existingInstall() {
  const path = join(dataDir, 'claude-mem.db');
  writeFileSync(path, '');
  const beforeLaunch = new Date('2026-11-01T00:00:00Z');
  utimesSync(path, beforeLaunch, beforeLaunch);
}

function receipt(kind: string) {
  return JSON.parse(readFileSync(join(dataDir, 'messages-from-claude-mem', id + '.' + kind + '.json'), 'utf8'));
}

describe('Messages from Claude-Mem', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cmem-messages-test-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('gives an existing free install the dated offer and optional local acknowledgement', () => {
    expect(nextClaudeMemMessage(startup, settings, dataDir, env)).toBeUndefined();
    existingInstall();
    const next = nextClaudeMemMessage(startup, settings, dataDir, env)!;
    expect(next.id).toBe(id);
    expect(formatClaudeMemMessage(next)).toContain('Messages from Claude-Mem · 2026-11-25');
    expect(formatClaudeMemMessage(next)).toContain('30 days of Cloud Sync and the remote Work Viewer free. No credit card required. https://cmem.ai/sync');
    expect(formatClaudeMemMessage(next)).toContain('claude-mem messages acknowledge ' + id);
  });

  it('leaves pending messages for an ordinary, supported, top-level session', () => {
    existingInstall();
    const excluded: Partial<NormalizedHookInput>[] = [
      { sessionSource: 'clear' }, { sessionSource: 'compact' }, { sessionSource: 'fork' },
      { sessionSource: 'resume' }, { sessionSource: undefined }, { hookEventName: 'PreToolUse' },
      { agentId: 'child' }, { agentType: 'explore' }, { platform: 'cursor' }, { platform: 'windsurf' },
    ];
    for (const fields of excluded) expect(nextClaudeMemMessage({ ...startup, ...fields }, settings, dataDir, env)).toBeUndefined();
    for (const automation of [{ CI: 'true' }, { CI: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }])
      expect(nextClaudeMemMessage(startup, settings, dataDir, automation)).toBeUndefined();
    expect(nextClaudeMemMessage(startup, settings, dataDir, env)?.id).toBe(id);
  });

  it('honors opt-outs, cloud connection settings, paid plans and trials', () => {
    existingInstall();
    for (const override of [
      { CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false' }, { CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' },
      { CLAUDE_MEM_PRO_PLAN: 'trial' }, { CLAUDE_MEM_PRO_PLAN: 'pro' },
      { CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai' }, { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'configured' },
      { CLAUDE_MEM_TEAMBRAIN_URL: 'https://team.invalid' },
    ]) expect(nextClaudeMemMessage(startup, { ...settings, ...override }, dataDir, env)).toBeUndefined();
    expect(nextClaudeMemMessage(startup, { ...settings, CLAUDE_MEM_PRO_PLAN: 'none' }, dataDir, env)?.id).toBe(id);
  });

  it('skips explicit Codex exec and subagent rollout metadata', () => {
    existingInstall();
    const transcriptPath = join(dataDir, 'rollout.jsonl');
    const input = { ...startup, platform: 'codex', transcriptPath };
    for (const payload of [{ source: 'exec' }, { originator: 'codex_exec' }, { source: { subagent: {} } }]) {
      writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload }) + '\n');
      expect(nextClaudeMemMessage(input, settings, dataDir, env)).toBeUndefined();
    }
    writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } }) + '\n');
    expect(nextClaudeMemMessage(input, settings, dataDir, env)?.id).toBe(id);
  });

  it('selects the oldest eligible published item and advances after dispatch without requiring acknowledgement', () => {
    existingInstall();
    const first = nextClaudeMemMessage(startup, settings, dataDir, env)!;
    const second = { ...first, id: 'second', publishedAt: '2026-11-25T09:00:01Z' };
    const queue = [second, { ...first, id: 'future', publishedAt: '2100-01-01T00:00:00Z' },
      { ...first, id: 'ineligible', publishedAt: '2026-11-24T00:00:00Z', eligible: () => false }, first];
    expect(nextClaudeMemMessage(startup, settings, dataDir, env, queue)?.id).toBe(first.id);
    const before = Date.now();
    expect(dispatchClaudeMemMessage(first.id, dataDir)).toBe(true);
    const saved = receipt('dispatched');
    expect(saved.id).toBe(id);
    expect(saved.publishedAt).toBe(first.publishedAt);
    expect(Date.parse(saved.dispatchedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(saved.dispatchedAt)).toBeLessThanOrEqual(Date.now());
    expect(nextClaudeMemMessage(startup, settings, dataDir, env, queue)?.id).toBe(second.id);
    expect(nextClaudeMemMessage(startup, settings, dataDir, env)).toBeUndefined();
    expect(dispatchClaudeMemMessage(first.id, dataDir)).toBe(false);
  });

  it('rejects unknown or undispatched IDs and preserves the first acknowledgement timestamp', () => {
    expect(acknowledgeClaudeMemMessage('../untrusted', dataDir)).toBe('unknown');
    expect(dispatchClaudeMemMessage('../untrusted', dataDir)).toBe(false);
    expect(acknowledgeClaudeMemMessage(id, dataDir)).toBe('not-dispatched');
    expect(readdirSync(dataDir)).toEqual([]);
    expect(dispatchClaudeMemMessage(id, dataDir)).toBe(true);
    const dispatched = receipt('dispatched');
    expect(acknowledgeClaudeMemMessage(id, dataDir)).toBe('acknowledged');
    const acknowledged = receipt('acknowledged');
    expect(acknowledged.id).toBe(id);
    expect(Date.parse(acknowledged.acknowledgedAt)).toBeGreaterThanOrEqual(Date.parse(dispatched.dispatchedAt));
    expect(acknowledgeClaudeMemMessage(id, dataDir)).toBe('already-acknowledged');
    expect(receipt('acknowledged')).toEqual(acknowledged);
    expect(receipt('dispatched')).toEqual(dispatched);
  });

  it('does not report dispatch or acknowledgement when the receipt location is unavailable', () => {
    writeFileSync(join(dataDir, 'messages-from-claude-mem'), 'unavailable');
    expect(dispatchClaudeMemMessage(id, dataDir)).toBe(false);
    expect(acknowledgeClaudeMemMessage(id, dataDir)).toBe('unavailable');
  });

  it('grants only one concurrent dispatcher and one concurrent acknowledgement', async () => {
    const source = new URL('../../../src/shared/claude-mem-messages.ts', import.meta.url).href;
    const concurrent = async (method: string) => {
      const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e',
        `import { ${method} } from ${JSON.stringify(source)}; console.log(${method}(process.argv[1], process.argv[2]))`, id, dataDir], { stdout: 'pipe' }));
      return Promise.all(children.map(async child => {
        const result = (await new Response(child.stdout).text()).trim();
        expect(await child.exited).toBe(0);
        return result;
      }));
    };
    expect((await concurrent('dispatchClaudeMemMessage')).sort()).toEqual(['false', 'false', 'false', 'true']);
    expect((await concurrent('acknowledgeClaudeMemMessage')).sort()).toEqual(['acknowledged', 'already-acknowledged', 'already-acknowledged', 'already-acknowledged']);
    expect(readdirSync(join(dataDir, 'messages-from-claude-mem')).length).toBe(2);
  });
});
