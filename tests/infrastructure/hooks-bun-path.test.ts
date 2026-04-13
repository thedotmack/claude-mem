import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');

function getHookCommands(): string[] {
  const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command?: string }> }>>;
  };

  const commands: string[] = [];
  for (const matchers of Object.values(parsed.hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.type === 'command' && hook.command) {
          commands.push(hook.command);
        }
      }
    }
  }
  return commands;
}

describe('hooks.json - Bun PATH regression guard', () => {
  it('includes $HOME/.bun/bin in every export PATH hook command', () => {
    const commands = getHookCommands();
    const exportPathCommands = commands.filter((cmd) => cmd.includes('export PATH='));

    expect(exportPathCommands.length).toBeGreaterThan(0);
    for (const command of exportPathCommands) {
      expect(command).toContain('$HOME/.bun/bin');
      expect(command).toContain(':$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH');
    }
  });

  it('keeps PreToolUse file-context hook aligned with Bun PATH export', () => {
    const commands = getHookCommands();
    const fileContextCommand = commands.find((cmd) => cmd.includes('hook claude-code file-context'));

    expect(fileContextCommand).toBeDefined();
    expect(fileContextCommand).toContain('export PATH=');
    expect(fileContextCommand).toContain('$HOME/.bun/bin');
  });
});
