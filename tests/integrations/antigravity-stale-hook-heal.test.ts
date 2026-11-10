import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildAntigravityHooksConfig,
  findStaleAntigravityHooks,
  healStaleAntigravityHooksConfig,
} from '../../src/services/integrations/AntigravityCliHooksInstaller.js';

// #5665: an in-place upgrade from a pre-#5085 install leaves a PreToolUse
// entry (and possibly a pre-#4911 PreInvocation → context entry) in
// ~/.gemini/config/hooks.json. agy keeps firing PreToolUse, the current
// adapter answers {} with no `decision`, and agy denies 100% of tool calls
// until the file is migrated. The heal migrates it in place on hook/worker
// runs. The hooks path is injected so the tests never touch the real ~/.gemini.

const workerCmd = (event: string) =>
  `bun /home/u/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs hook antigravity-cli ${event}`;

// The shape a <=14.x install wrote: PreToolUse present, PreInvocation still
// routing to context, everything pointing at worker-service.cjs.
function staleConfig(): Record<string, any> {
  return {
    'claude-mem': {
      SessionStart: [{ type: 'command', command: workerCmd('context'), timeout: 10 }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: workerCmd('observation'), timeout: 10 }] }],
      PreInvocation: [{ type: 'command', command: workerCmd('context'), timeout: 10 }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: workerCmd('observation'), timeout: 10 }] }],
      PostInvocation: [{ type: 'command', command: workerCmd('observation'), timeout: 10 }],
      Stop: [{ type: 'command', command: workerCmd('summarize'), timeout: 10 }],
    },
    'other-tool': {
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool run', timeout: 5 }] }],
    },
  };
}

describe('findStaleAntigravityHooks (#5665)', () => {
  it('flags both stale entries on a pre-#5085 / pre-#4911 install', () => {
    expect(findStaleAntigravityHooks(staleConfig())).toEqual({
      hasStalePreToolUse: true,
      hasStalePreInvocation: true,
    });
  });

  it('flags a stale PreToolUse on its own', () => {
    const config = staleConfig();
    config['claude-mem'].PreInvocation = [{ type: 'command', command: workerCmd('session-init'), timeout: 10 }];
    expect(findStaleAntigravityHooks(config)).toEqual({
      hasStalePreToolUse: true,
      hasStalePreInvocation: false,
    });
  });

  it('finds nothing stale in the config the current installer writes', () => {
    const current = buildAntigravityHooksConfig('/usr/bin/bun', '/plugins/thedotmack/plugin/scripts/worker-service.cjs');
    expect(findStaleAntigravityHooks(current)).toEqual({
      hasStalePreToolUse: false,
      hasStalePreInvocation: false,
    });
  });

  it('finds nothing stale without a claude-mem hook', () => {
    expect(findStaleAntigravityHooks({})).toEqual({ hasStalePreToolUse: false, hasStalePreInvocation: false });
    const other = staleConfig();
    delete other['claude-mem'];
    expect(findStaleAntigravityHooks(other)).toEqual({ hasStalePreToolUse: false, hasStalePreInvocation: false });
  });
});

describe('healStaleAntigravityHooksConfig (#5665)', () => {
  let tmp: string;
  let hooksPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'antigravity-heal-'));
    hooksPath = path.join(tmp, 'hooks.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('migrates a stale file in place: PreToolUse gone, no context-routing PreInvocation, other hooks preserved', () => {
    writeFileSync(hooksPath, JSON.stringify(staleConfig(), null, 2) + '\n');

    expect(healStaleAntigravityHooksConfig(hooksPath)).toBe(true);

    const healed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const named = healed['claude-mem'];
    expect(named.PreToolUse).toBeUndefined();
    // Whether the heal rebuilt the canonical config or stripped in place,
    // no surviving PreInvocation handler may route to `context`; a rebuilt
    // one routes to session-init.
    for (const handler of named.PreInvocation ?? []) {
      expect(handler.command).toMatch(/\bsession-init\s*$/);
    }
    expect(named.SessionStart).toBeDefined();
    expect(named.PostToolUse).toBeDefined();
    expect(named.PostInvocation).toBeDefined();
    expect(named.Stop).toBeDefined();
    expect(healed['other-tool']).toEqual(staleConfig()['other-tool']);

    // Idempotent: a current file is not rewritten again.
    expect(healStaleAntigravityHooksConfig(hooksPath)).toBe(false);
  });

  it('leaves a current file byte-identical', () => {
    const current = buildAntigravityHooksConfig('/usr/bin/bun', '/plugins/thedotmack/plugin/scripts/worker-service.cjs');
    const text = JSON.stringify(current, null, 2) + '\n';
    writeFileSync(hooksPath, text);

    expect(healStaleAntigravityHooksConfig(hooksPath)).toBe(false);
    expect(readFileSync(hooksPath, 'utf-8')).toBe(text);
  });

  it('does nothing when the file is missing', () => {
    expect(healStaleAntigravityHooksConfig(hooksPath)).toBe(false);
  });

  it('leaves a corrupt file exactly as found instead of overwriting user data', () => {
    writeFileSync(hooksPath, '{ not json');
    expect(healStaleAntigravityHooksConfig(hooksPath)).toBe(false);
    expect(readFileSync(hooksPath, 'utf-8')).toBe('{ not json');
  });
});
