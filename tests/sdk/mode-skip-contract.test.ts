import { afterAll, describe, expect, it } from 'bun:test';
import { readdirSync } from 'fs';
import { join } from 'path';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

// plan-18 step 2 (#3624): a skip is the <skip_summary /> sentinel, never
// silence. The worker asks again for a queued batch whose reply is neither XML
// nor the sentinel, so a mode that still told the observer to skip with an
// empty reply would pay for every skip twice. Locales and the --chill variants
// resolve through ModeManager's inheritance, so every mode file is checked as
// the observer actually receives it.
const MODES_DIR = join(import.meta.dir, '..', '..', 'plugin', 'modes');
const modeIds = readdirSync(MODES_DIR)
  .filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -'.json'.length))
  .sort();

describe('every mode states the skip contract (#3624)', () => {
  afterAll(() => {
    ModeManager.getInstance().loadMode('code');
  });

  it('covers every mode file', () => {
    expect(modeIds.length).toBeGreaterThan(30);
  });

  for (const modeId of modeIds) {
    it(`${modeId} asks for <skip_summary />, never an empty reply`, () => {
      const guidance = ModeManager.getInstance().loadMode(modeId).prompts.skip_guidance;
      expect(guidance).toContain('<skip_summary reason="noise" />');
      expect(guidance).not.toContain('empty response only');
      expect(guidance).not.toContain('No output necessary');
    });
  }
});
