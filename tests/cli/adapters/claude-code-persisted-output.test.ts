import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { buildObservationPrompt } from '../../../src/sdk/prompts.js';

// Claude Code cuts a Bash result over `bashOutputMaxChars` (30,000 by default),
// writes the whole output under <config>/projects/<project>/<session>/tool-results/,
// and sends the cut stdout with persistedOutputPath and persistedOutputSize (#6282).
const HARNESS_CAP = 30_000;
const FINAL_LINE = 'Tests: 3 failed, 412 passed';
const fullOutput = `${'x'.repeat(50_000)}\n${FINAL_LINE}\n`;

let configDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), 'claude-mem-persisted-output-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

function writeOutput(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'b3utdentl.txt');
  writeFileSync(file, fullOutput);
  return file;
}

function postToolUse(persistedOutputPath: string) {
  return {
    session_id: 's1',
    cwd: '/tmp',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: {
      stdout: fullOutput.slice(0, HARNESS_CAP),
      stderr: '',
      interrupted: false,
      isImage: false,
      persistedOutputPath,
      persistedOutputSize: fullOutput.length,
    },
  };
}

describe('claudeCodeAdapter.normalizeInput — persistedOutputPath', () => {
  it('ends stdout with the end of the persisted file and marks the cut', () => {
    const file = writeOutput(join(configDir, 'projects', '-tmp', 's1', 'tool-results'));
    const stdout = (claudeCodeAdapter.normalizeInput(postToolUse(file)).toolResponse as { stdout: string }).stdout;

    expect(stdout.endsWith(`${FINAL_LINE}\n`)).toBe(true);
    const note = stdout.match(/^<harness-cut [^>]*\/>\n/)![0];
    expect(note).toContain(`original_size_bytes="${fullOutput.length}"`);
    expect(stdout.slice(note.length).startsWith('x'.repeat(1_000))).toBe(true);
    const marker = stdout.match(/\n\.\.\. <elided [^>]*reason="harness-cut" \/> \.\.\.\n/)![0];
    expect(stdout.length).toBe(HARNESS_CAP + note.length + marker.length);
    const elided = Number(marker.match(/bytes="(\d+)"/)![1]);
    expect(note).toContain(`elided_bytes="${elided}"`);
    expect(stdout.length - note.length - marker.length + elided).toBe(fullOutput.length);
  });

  it('puts the final line of the real output into the observer prompt', () => {
    const file = writeOutput(join(configDir, 'projects', '-tmp', 's1', 'tool-results'));
    const input = claudeCodeAdapter.normalizeInput(postToolUse(file));
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: JSON.stringify(input.toolInput),
      tool_output: JSON.stringify(input.toolResponse),
      created_at_epoch: Date.now(),
    });

    expect(prompt).toContain(FINAL_LINE);
    // The prompt drops the middle of the field, where the cut point is; the note on the cut survives at its head.
    expect(prompt).toContain(`original_size_bytes=\\"${fullOutput.length}\\"`);
    expect(prompt).toContain('<harness-cut ');
  });

  it('ignores a path outside Claude Code tool-results', () => {
    const file = writeOutput(join(configDir, 'elsewhere', 'tool-results'));
    const payload = postToolUse(file);
    expect(claudeCodeAdapter.normalizeInput(payload).toolResponse).toEqual(payload.tool_response);
  });

  it('keeps the cut stdout when the file is missing', () => {
    mkdirSync(join(configDir, 'projects'), { recursive: true });
    const payload = postToolUse(join(configDir, 'projects', '-tmp', 's1', 'tool-results', 'gone.txt'));
    expect(claudeCodeAdapter.normalizeInput(payload).toolResponse).toEqual(payload.tool_response);
  });
});
