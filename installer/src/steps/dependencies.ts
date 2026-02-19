import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findBinary, compareVersions, installBun } from '../utils/dependencies.js';
import { detectOS } from '../utils/system.js';

const BUN_EXTRA_PATHS = ['~/.bun/bin/bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];
interface DependencyStatus {
  nodeOk: boolean;
  gitOk: boolean;
  bunOk: boolean;
  bunPath: string | null;
}

export async function runDependencyChecks(): Promise<DependencyStatus> {
  const status: DependencyStatus = {
    nodeOk: false,
    gitOk: false,
    bunOk: true, // No longer required for users
    bunPath: null,
  };

  await p.tasks([
    {
      title: 'Checking Node.js',
      task: async () => {
        const version = process.version.slice(1); // remove 'v'
        if (compareVersions(version, '18.0.0')) {
          status.nodeOk = true;
          return `Node.js ${process.version} ${pc.green('✓')}`;
        }
        return `Node.js ${process.version} — requires >= 18.0.0 ${pc.red('✗')}`;
      },
    },
    {
      title: 'Checking git',
      task: async () => {
        const info = findBinary('git');
        if (info.found) {
          status.gitOk = true;
          return `git ${info.version || ''} ${pc.green('✓')}`;
        }
        return `git not found ${pc.red('✗')}`;
      },
    },
  ]);

  if (!status.nodeOk) {
    p.log.error(`Node.js >= 18.0.0 is required. Current: ${process.version}`);
    p.cancel('Please upgrade Node.js and try again.');
    process.exit(1);
  }

  return status;
}

  return status;
}
