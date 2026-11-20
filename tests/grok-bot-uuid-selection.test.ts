import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrokBotIndexConfig, resolveIndexSeats } from '../src/services/integrations/GrokBotIndexWriter.js';

it('selects a live agent when the configured UUID has different casing', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-agent-case-'));
  const id = 'abcdefab-1234-4321-abcd-123456789abc';
  try {
    mkdirSync(join(root, 'agents', id), { recursive: true });
    writeFileSync(join(root, 'agents', id, 'profile.json'), JSON.stringify({ name: 'Case fixture' }));
    const settings = join(root, 'settings.json');
    writeFileSync(settings, '{}');
    const config = loadGrokBotIndexConfig(settings, {
      GROK_BOT_AGENT_DATA: root,
      CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: id.toUpperCase(),
      CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join(root, 'watch.json'),
    });
    expect(config.agentIdsAuto).toBe(false);
    expect(resolveIndexSeats(config).map(seat => seat.id)).toEqual([id]);
    config.agentIds = ['11111111-1111-1111-1111-111111111111'];
    expect(resolveIndexSeats(config)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
