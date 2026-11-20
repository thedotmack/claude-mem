// The SessionStart message opens with one line pointing at the Rules + Tools
// file instead of repeating how to read the timeline and use the tools.
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { renderHeader } from '../../src/services/context/sections/HeaderRenderer.js';
import {
  rulesAndToolsDisplayPath,
  rulesAndToolsFilePath,
  rulesAndToolsPointerLine,
} from '../../src/services/context/RulesAndToolsFile.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { WORK_STATE_RULE } from '../../src/shared/memory-instructions.js';

beforeAll(() => {
  ModeManager.getInstance().loadMode('code');
});

afterEach(() => {
  rmSync(rulesAndToolsFilePath(), { force: true });
});

describe('Rules + Tools file', () => {
  it('is the whole header: one line, then a blank line', () => {
    expect(renderHeader({}, false)).toEqual([rulesAndToolsPointerLine(), '']);
    expect(rulesAndToolsPointerLine()).toBe(`Access Claude-Mem Rules + Tools: ${rulesAndToolsDisplayPath()}`);
    expect(rulesAndToolsDisplayPath(`${homedir()}/.claude-mem/RULES-AND-TOOLS.md`)).toBe('~/.claude-mem/RULES-AND-TOOLS.md');
  });

  it('writes the file the line points to: how to read the timeline, then the rules and tools', () => {
    renderHeader({}, false);
    const text = readFileSync(rulesAndToolsFilePath(), 'utf-8');
    expect(text).toStartWith('# Claude-Mem Rules + Tools\n');
    expect(text).toContain('Format: ID TIME TYPE TITLE');
    expect(text).toContain('Legend: 🎯session ');
    expect(text).toContain('Mode: ');
    expect(text).toContain('Fetch details: get_observations([IDs]) | Search: mem-search skill');
    expect(text).toContain(WORK_STATE_RULE);
    expect(text).toContain('# claude-mem memory use');
  });

  it('names the server tools for server runtime, which has no by-id fetch', () => {
    renderHeader({ fetchByIdSupported: false }, false);
    const text = readFileSync(rulesAndToolsFilePath(), 'utf-8');
    expect(text).toContain('Fetch details: observation_search by title');
    expect(text).not.toContain('get_observations([IDs])');
  });

  it('rewrites the file only when its text changes', () => {
    renderHeader({}, false);
    const firstWrite = statSync(rulesAndToolsFilePath()).mtimeMs;
    const firstText = readFileSync(rulesAndToolsFilePath(), 'utf-8');
    Bun.sleepSync(20);
    renderHeader({}, false);
    expect(statSync(rulesAndToolsFilePath()).mtimeMs).toBe(firstWrite);
    renderHeader({ fetchByIdSupported: false }, false);
    expect(readFileSync(rulesAndToolsFilePath(), 'utf-8')).not.toBe(firstText);
  });
});
