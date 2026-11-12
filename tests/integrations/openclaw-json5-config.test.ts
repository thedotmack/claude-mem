import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { getOpenClawConfigDirectory, uninstallOpenClawPlugin } from '../../src/services/integrations/OpenClawInstaller.js';

// OpenClaw reads openclaw.json through parseConfigJson5, including JSON5 keys,
// strings, comments and trailing commas (src/config/io.read-helpers.ts upstream).
describe('OpenClaw removal accepts native JSON5 configuration', () => {
  let root: string;
  let config: string;
  let extension: string;
  let home: ReturnType<typeof spyOn>;
  let log: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;
  const selectors = ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_PROFILE'];
  let savedSelectors: Array<string | undefined>;

  beforeEach(() => {
    savedSelectors = selectors.map(key => process.env[key]);
    for (const key of selectors) delete process.env[key];
    root = mkdtempSync(join(os.tmpdir(), 'openclaw-json5-'));
    home = spyOn(os, 'homedir').mockReturnValue(root);
    log = spyOn(console, 'log').mockImplementation(() => {});
    error = spyOn(console, 'error').mockImplementation(() => {});
    const state = join(root, '.openclaw');
    if (getOpenClawConfigDirectory() !== state) throw new Error('Refusing to touch a non-fixture OpenClaw home');
    config = join(state, 'openclaw.json');
    extension = join(state, 'extensions', 'claude-mem');
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, 'index.js'), '// owned installed extension');
  });

  afterEach(() => {
    home.mockRestore();
    log.mockRestore();
    error.mockRestore();
    selectors.forEach((key, index) => {
      if (savedSelectors[index] === undefined) delete process.env[key];
      else process.env[key] = savedSelectors[index];
    });
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    '{ // native configuration\n plugins: { slots: { memory: "claude-mem", }, entries: { "claude-mem": { enabled: true, }, other: { enabled: true, }, }, }, gateway: { port: 18789 }, }',
    "{plugins:{slots:{memory:'claude-mem'},entries:{'claude-mem':{enabled:true},other:{enabled:true}}},gateway:{port:0x4965}}",
    '\uFEFF{"plugins":{"slots":{"memory":"claude-mem"},"entries":{"claude-mem":{"enabled":true},"other":{"enabled":true}}},"gateway":{"port":18789}}',
  ])('removes only the selected plugin from valid host configuration: %s', content => {
    writeFileSync(config, content);
    expect(uninstallOpenClawPlugin()).toBe(0);
    const updated = JSON.parse(readFileSync(config, 'utf8'));
    expect(updated.plugins.entries['claude-mem']).toBeUndefined();
    expect(updated.plugins.slots.memory).toBeUndefined();
    expect(updated.plugins.entries.other).toEqual({ enabled: true });
    expect(updated.gateway).toEqual({ port: 18789 });
    expect(existsSync(extension)).toBe(false);
  });

  it('reports malformed configuration without overwriting its bytes', () => {
    const invalid = '{plugins: {entries: invalid syntax}}';
    writeFileSync(config, invalid);
    expect(uninstallOpenClawPlugin()).toBe(1);
    expect(readFileSync(config, 'utf8')).toBe(invalid);
  });
});
