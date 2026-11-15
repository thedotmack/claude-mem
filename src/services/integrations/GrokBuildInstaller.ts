import {
  grokBuildContextStatus,
  grokRulesFile,
  installGrokBuildContext,
  refreshGrokBuildContext,
  uninstallGrokBuildContext,
} from './GrokBuildRules.js';

/**
 * `claude-mem grok install|status|uninstall`: the terminal side of the Grok
 * Build integration. Kept apart from GrokBuildRules.ts, which the worker also
 * runs after each summary and which must log through the logger, not the console.
 */
export async function handleGrokCommand(subcommand: string | undefined, rest: string[] = []): Promise<number> {
  const cwd = process.cwd();
  // `grok uninstall --help` must print usage, never run the uninstall.
  const wantsHelp = [subcommand, ...rest].some(arg => arg === '--help' || arg === '-h');
  switch (wantsHelp ? undefined : subcommand) {
    case 'install': {
      const result = installGrokBuildContext(cwd);
      if (!result.ok) {
        console.error(result.message);
        return 1;
      }
      const filled = await refreshGrokBuildContext(cwd);
      console.log(filled
        ? `Wrote ${grokRulesFile(cwd)}`
        : `Set up ${grokRulesFile(cwd)} without fresh notes (no notes yet, or the worker did not answer). It fills in after your next session summary.`);
      console.log(result.excluded
        ? 'Added it to .git/info/exclude so it stays out of git status.'
        : 'Not a git repo (or git is missing): nothing was added to .git/info/exclude.');
      console.log('Grok reads project rules only for trusted folders (grok --trust, or grant it when asked).');
      console.log('Context loads when a session starts, so it shows up from your next Grok session.');
      return 0;
    }
    case 'uninstall':
      uninstallGrokBuildContext(cwd);
      console.log('Removed the claude-mem rules file, registry entry and exclude line for this folder (if it was installed).');
      return 0;
    case 'status': {
      const s = grokBuildContextStatus(cwd);
      console.log(`${s.installed ? 'Installed' : 'Not installed'}: ${s.file}${s.registered ? ' (registered for refresh)' : ''}`);
      if (s.staleProject) {
        console.log(`Refreshes are keyed to project "${s.staleProject.stored ?? '(none)'}", but this folder is now "${s.staleProject.current}", so the file is no longer refreshed. Run: claude-mem grok install`);
      }
      return 0;
    }
    default:
      console.log(`Claude-Mem Grok Build context

Usage: claude-mem grok <install|status|uninstall>   (acts on the current folder)

Writes .grok/rules/claude-mem-context.md so Grok Build starts sessions with recalled memory.
Capture already works through the Claude plugin; this only adds context at session start.`);
      return 0;
  }
}
