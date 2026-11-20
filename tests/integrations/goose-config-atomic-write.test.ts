import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { mergeGooseYamlConfig, uninstallGooseMcpIntegration } from '../../src/services/integrations/McpIntegrations.js';

// The Goose config is a user-owned YAML file, so a write over an existing file
// must replace it rather than truncate it in place: an interrupted install or
// uninstall then cannot leave a half-written config.yaml that stops Goose from
// loading its extensions. An in-place truncate keeps the same file; a
// temp-file-plus-rename write yields a new one.
describe('Goose writes config.yaml atomically', () => {
  let tmp: string;
  let configPath: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'goose-config-atomic-'));
    configPath = path.join(tmp, 'config.yaml');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces the config file instead of truncating it in place on install', () => {
    writeFileSync(configPath, 'GOOSE_PROVIDER: anthropic\n');
    const first = statSync(configPath);

    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');
    const second = statSync(configPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
  });

  it('replaces the config file instead of truncating it in place on uninstall', () => {
    writeFileSync(configPath, 'extensions:\n  claude-mem:\n    enabled: true\n    cmd: node\n    args:\n      - /plugin/scripts/mcp-server.cjs\n');
    const first = statSync(configPath);

    expect(uninstallGooseMcpIntegration(configPath)).toBe(0);
    const second = statSync(configPath);

    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
  });
});
