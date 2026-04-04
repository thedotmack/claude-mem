/**
 * Install command for `npx claude-mem install`.
 *
 * Delegates to Claude Code's native plugin system — two commands handle
 * marketplace registration, plugin installation, dependency setup, and
 * settings enablement.
 *
 * Pure Node.js — no Bun APIs used.
 */
import { execSync } from 'child_process';
import pc from 'picocolors';

export interface InstallOptions {
  /** Unused — kept for CLI compat. IDE integrations are separate. */
  ide?: string;
}

export async function runInstallCommand(_options: InstallOptions = {}): Promise<void> {
  console.log(pc.bold('claude-mem install'));
  console.log();

  try {
    execSync(
      'claude plugin marketplace add thedotmack/claude-mem && claude plugin install claude-mem',
      { stdio: 'inherit' },
    );
  } catch (error: any) {
    console.error(pc.red('Installation failed.'));
    console.error('Make sure Claude Code CLI is installed and on your PATH.');
    process.exit(1);
  }

  console.log();
  console.log(pc.green('claude-mem installed successfully!'));
  console.log();
  console.log('Open Claude Code and start a conversation — memory is automatic.');
}
