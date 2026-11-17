import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_MODE_REFUSED_EVENTS, refusedEventsHooked } from '../../scripts/code-mode-refused-events.js';

const bundle = readFileSync(join(import.meta.dir, '..', '..', 'plugin', 'hooks', 'auto-clear.js'), 'utf-8');

describe('auto-clear bundle', () => {
  it('registers no event that makes Claude Code refuse Code Mode', () => {
    expect(refusedEventsHooked(bundle)).toEqual([]);
    for (const event of CODE_MODE_REFUSED_EVENTS) {
      expect(bundle).not.toMatch(new RegExp(`\\bon\\(\\s*["'\`]${event.replace(/\./g, '\\.')}["'\`]`));
    }
  });

  it('watches tool results at session.append, the event that replaced tool.call', () => {
    expect(bundle).toMatch(/\bon\(\s*"session\.append"\s*,\s*\{\s*door:\s*"tool-result"\s*\}/);
    expect(bundle).toContain('$.session.append(');
  });

  it('reads the save\'s own arguments off the model\'s response row, also at session.append', () => {
    expect(bundle).toMatch(/\bon\(\s*"session\.append"\s*,\s*\{\s*door:\s*"response"\s*\}/);
  });

  it('finds a refused event whichever quote style registers it, and leaves other events alone', () => {
    expect(refusedEventsHooked('on("tool.call", hook)')).toEqual(['tool.call']);
    expect(refusedEventsHooked("on('classic.PreToolUse', hook)")).toEqual(['classic.PreToolUse']);
    expect(refusedEventsHooked('on(`session.send`, hook)')).toEqual(['session.send']);
    expect(refusedEventsHooked('on("session.append", { door: "tool-result" }, hook)')).toEqual([]);
    expect(refusedEventsHooked('on("turn.complete", hook)')).toEqual([]);
  });
});
