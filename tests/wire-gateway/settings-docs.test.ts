import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// Plan Phase 17 item 3: every wire gateway setting is documented in
// docs/public/configuration.mdx (one was missing: FORWARD_SUBSCRIPTION_SIGNINS).
const repoRoot = join(import.meta.dir, '..', '..');

describe('wire gateway settings documentation', () => {
  it('lists every CLAUDE_MEM_WIRE_* setting in configuration.mdx', () => {
    const configurationDoc = readFileSync(join(repoRoot, 'docs/public/configuration.mdx'), 'utf8');
    const wireSettingNames = Object.keys(SettingsDefaultsManager.getAllDefaults()).filter(name => name.startsWith('CLAUDE_MEM_WIRE_'));
    expect(wireSettingNames.length).toBeGreaterThan(0);
    const undocumented = wireSettingNames.filter(name => !configurationDoc.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });
});
