import { describe, expect, it } from 'bun:test';
import { initialIDESelection } from '../../src/npx-cli/commands/ide-detection.js';

describe('installer initial agent selection', () => {
  it('pre-selects detected agents when Claude Code is absent', () => {
    expect(initialIDESelection([
      { id: 'claude-code', label: 'Claude', detected: false },
      { id: 'opencode', label: 'OpenCode', detected: true },
      { id: 'pi', label: 'Pi', detected: true },
    ])).toEqual(['opencode', 'pi']);
  });
  it('falls back to Claude Code when no agents are detected', () => {
    expect(initialIDESelection([])).toEqual(['claude-code']);
  });
});
