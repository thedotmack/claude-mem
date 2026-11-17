import { describe, expect, it } from 'bun:test';
import { readTomlBooleanInTable } from '../../src/shared/codex-toml.js';
import { setTomlPluginEnabled } from '../../src/services/integrations/CodexCliInstaller.js';

const pluginId = 'claude-mem@claude-mem-local';
const header = `[plugins."${pluginId}"]`;

describe('Codex plugin state in dotted TOML keys', () => {
  const spellings = [
    `plugins."${pluginId}".enabled = false\n`,
    `[plugins]\n"${pluginId}".enabled = false\n`,
    `"plugins" . '${pluginId}' . "en\\u0061bled" = false # explicitly disabled\n`,
    `[ 'plugins' ] # operator settings\n'${pluginId}' . 'enabled' = false\n`,
  ];
  for (const content of spellings) {
    it(`honors an explicit false spelled ${JSON.stringify(content)}`, () => {
      const parsed = Bun.TOML.parse(content) as any;
      expect(parsed.plugins[pluginId].enabled).toBe(false);
      expect(readTomlBooleanInTable(content, header, 'enabled')).toBe(false);
      const enabled = setTomlPluginEnabled(content, pluginId, true);
      expect((Bun.TOML.parse(enabled) as any).plugins[pluginId].enabled).toBe(true);
      expect(setTomlPluginEnabled(enabled, pluginId, true)).toBe(enabled);
      expect(readTomlBooleanInTable(setTomlPluginEnabled(enabled, pluginId, false), header, 'enabled')).toBe(false);
    });
  }

  it('reads true and false without treating a quoted literal dot as a path separator', () => {
    const content = `"plugins.${pluginId}.enabled" = false\nplugins."${pluginId}".enabled = true\nfeatures.hooks = false\n`;
    expect(readTomlBooleanInTable(content, header, 'enabled')).toBe(true);
    expect(readTomlBooleanInTable(content, '[features]', 'hooks')).toBe(false);
  });

  it('keeps relative keys in unrelated tables out of the root plugin setting', () => {
    const content = `[profiles.other]\nplugins."${pluginId}".enabled = false\n`;
    expect((Bun.TOML.parse(content) as any).profiles.other.plugins[pluginId].enabled).toBe(false);
    expect(readTomlBooleanInTable(content, header, 'enabled')).toBeUndefined();
  });

  it('ignores dotted settings inside multiline examples and array tables', () => {
    const content = `example = '''\nplugins."${pluginId}".enabled = false\n'''\n[[examples]]\nplugins."${pluginId}".enabled = false\n`;
    expect(readTomlBooleanInTable(content, header, 'enabled')).toBeUndefined();
  });

  it('preserves ordinary table settings and rejects nonboolean values', () => {
    expect(readTomlBooleanInTable(`${header}\nenabled = false\n`, header, 'enabled')).toBe(false);
    expect(readTomlBooleanInTable(`plugins."${pluginId}".enabled = "false"\n`, header, 'enabled')).toBeUndefined();
  });
});
