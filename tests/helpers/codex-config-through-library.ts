import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { writeCodexPluginConfig } from '../../src/services/integrations/CodexCliInstaller.js';

let counter = 0;

/**
 * Codex's config.toml edits run through the Library (the Phase 7 TOML
 * editor): write `input` to a fresh config.toml under the test data dir,
 * enable (or disable) claude-mem's plugin there, and return the file's text.
 */
export function codexConfigAfterLibraryWrite(input: string, enabled = true): string {
  const directory = join(WIRE_GATEWAY_DIR, 'tmp', `codex-config-${process.pid}-${counter++}`);
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, 'config.toml');
  writeFileSync(configPath, input);
  writeCodexPluginConfig(enabled, configPath);
  return readFileSync(configPath, 'utf-8');
}
