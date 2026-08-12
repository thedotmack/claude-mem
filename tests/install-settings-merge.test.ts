import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { USER_SETTINGS_PATH } from '../src/shared/paths.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { mergeSettings } from '../src/npx-cli/commands/install.js';

/**
 * The installer writes settings (runtime choice, trial state) before anything
 * calls getSetting(), so a legacy `{ "env": { ... } }` settings.json has not
 * been migrated yet at that point. loadFromFile's migration replaces the whole
 * document with the env subtree, so any key mergeSettings wrote beside `env`
 * used to vanish on the next read — the installer would report "server" while
 * the app kept running the old runtime.
 */

let saved: string | null = null;

beforeEach(() => {
  saved = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
  rmSync(USER_SETTINGS_PATH, { force: true });
});

afterEach(() => {
  if (saved === null) rmSync(USER_SETTINGS_PATH, { force: true });
  else writeFileSync(USER_SETTINGS_PATH, saved);
});

const writeSettings = (doc: unknown) =>
  writeFileSync(USER_SETTINGS_PATH, JSON.stringify(doc, null, 2));

describe('mergeSettings + legacy env-nested settings.json', () => {
  it('survives the loader migration when the document is env-nested', () => {
    writeSettings({ env: { CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_MODEL: 'legacy-model' } });

    mergeSettings({ CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:9999' });

    const loaded = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false);
    expect(loaded.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(loaded.CLAUDE_MEM_SERVER_URL).toBe('http://127.0.0.1:9999');
    // Untouched legacy values migrate rather than being dropped.
    expect(loaded.CLAUDE_MEM_MODEL).toBe('legacy-model');
  });

  it('flattens the document so no env subtree remains to re-trigger migration', () => {
    writeSettings({ env: { CLAUDE_MEM_RUNTIME: 'worker' } });

    mergeSettings({ CLAUDE_MEM_RUNTIME: 'server' });

    const written = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    expect(written.env).toBeUndefined();
    expect(written.CLAUDE_MEM_RUNTIME).toBe('server');
  });

  it('lets the env subtree win over stale sibling keys, matching the loader', () => {
    // loadFromFile does `flatSettings = settings.env` — a replacement, not a
    // merge — so mergeSettings must resolve the conflict the same way.
    writeSettings({ CLAUDE_MEM_MODEL: 'stale-toplevel', env: { CLAUDE_MEM_MODEL: 'env-wins' } });

    mergeSettings({ CLAUDE_MEM_RUNTIME: 'server' });

    const written = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    expect(written.CLAUDE_MEM_MODEL).toBe('env-wins');
  });

  it('still merges flat documents and preserves unknown keys', () => {
    writeSettings({ CLAUDE_MEM_RUNTIME: 'worker', someUnknownKey: 'keep-me' });

    mergeSettings({ CLAUDE_MEM_RUNTIME: 'server' });

    const written = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    expect(written.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(written.someUnknownKey).toBe('keep-me');
  });

  it('does not treat an array named env as a legacy subtree', () => {
    writeSettings({ env: ['not', 'an', 'object'], CLAUDE_MEM_RUNTIME: 'worker' });

    mergeSettings({ CLAUDE_MEM_RUNTIME: 'server' });

    const written = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    expect(written.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(Array.isArray(written.env)).toBe(true);
  });
});
