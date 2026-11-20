import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  disableCodexPluginForHome,
  readAndStripContextTags,
  stripLegacyTranscriptWatchContexts,
} from '../../src/services/integrations/CodexCliInstaller.js';

// Codex's config.toml and its AGENTS.md are user-owned files. Every write over
// them used a plain writeFileSync, which truncates in place: an interrupted
// install or uninstall could leave a half-written config that stops Codex from
// loading the user's own settings. A temp-file-plus-rename write yields a new
// file; an in-place truncate keeps the same one.
describe('Codex writes its config and AGENTS.md atomically', () => {
  let tmp: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codex-atomic-'));
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** True when the write replaced the file rather than rewriting it in place. */
  function wasReplaced(before: ReturnType<typeof statSync>, after: ReturnType<typeof statSync>): boolean {
    return after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs;
  }

  it('replaces config.toml instead of truncating it in place', () => {
    const configPath = path.join(tmp, 'config.toml');
    writeFileSync(configPath, '[plugins."claude-mem@thedotmack"]\nenabled = true\n');
    const first = statSync(configPath);

    disableCodexPluginForHome(tmp);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain('enabled = false');
  });

  it('replaces AGENTS.md instead of truncating it in place when stripping the context block', () => {
    const agentsMdPath = path.join(tmp, 'AGENTS.md');
    writeFileSync(agentsMdPath, '# House rules\n\n<claude-mem-context>\ninjected\n</claude-mem-context>\n\ntail\n');
    const first = statSync(agentsMdPath);

    readAndStripContextTags(agentsMdPath);
    const second = statSync(agentsMdPath);

    expect(wasReplaced(first, second)).toBe(true);
    const text = readFileSync(agentsMdPath, 'utf-8');
    expect(text).toContain('# House rules');
    expect(text).not.toContain('injected');
  });

  it('replaces a JSON config instead of truncating it in place when stripping legacy watch contexts', () => {
    const configPath = path.join(tmp, 'transcript-watch.json');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      watches: [{ name: 'codex', context: { mode: 'agents', updateOn: ['session_start', 'session_end'] }, keep: 'me' }],
    }, null, 2) + '\n');
    const first = statSync(configPath);

    stripLegacyTranscriptWatchContexts(configPath);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.watches[0].keep).toBe('me');
    expect(parsed.watches[0].context).toBeUndefined();
  });
});