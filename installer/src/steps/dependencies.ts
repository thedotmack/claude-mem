import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findBinary, compareVersions, installBun, installUv } from '../utils/dependencies.js';
import { detectOS } from '../utils/system.js';

const BUN_EXTRA_PATHS = ['~/.bun/bin/bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];
const UV_EXTRA_PATHS = ['~/.local/bin/uv', '~/.cargo/bin/uv'];

interface DependencyStatus {
  nodeOk: boolean;
  gitOk: boolean;
  bunOk: boolean;
  uvOk: boolean;
  bunPath: string | null;
  uvPath: string | null;
}

export async function runDependencyChecks(): Promise<DependencyStatus> {
  const status: DependencyStatus = {
    nodeOk: false,
    gitOk: false,
    bunOk: false,
    uvOk: false,
    bunPath: null,
    uvPath: null,
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
          return `git ${info.version ?? ''} ${pc.green('✓')}`;
        }
        return `git not found ${pc.red('✗')}`;
      },
    },
    {
      title: 'Checking Bun',
      task: async () => {
        const info = findBinary('bun', BUN_EXTRA_PATHS);
        if (info.found && info.version && compareVersions(info.version, '1.1.14')) {
          status.bunOk = true;
          status.bunPath = info.path;
          return `Bun ${info.version} ${pc.green('✓')}`;
        }
        if (info.found && info.version) {
          return `Bun ${info.version} — requires >= 1.1.14 ${pc.yellow('⚠')}`;
        }
        return `Bun not found ${pc.yellow('⚠')}`;
      },
    },
    {
      title: 'Checking uv',
      task: async () => {
        const info = findBinary('uv', UV_EXTRA_PATHS);
        if (info.found) {
          status.uvOk = true;
          status.uvPath = info.path;
          return `uv ${info.version ?? ''} ${pc.green('✓')}`;
        }
        return `uv not found ${pc.yellow('⚠')}`;
      },
    },
  ]);

  // Handle missing dependencies
  if (!status.gitOk) {
    const os = detectOS();
    p.log.error('git is required but not found.');
    if (os === 'macos') {
      p.log.info('Install with: xcode-select --install');
    } else if (os === 'linux') {
      p.log.info('Install with: sudo apt install git (or your distro equivalent)');
    } else {
      p.log.info('Download from: https://git-scm.com/downloads');
    }
    p.cancel('Please install git and try again.');
    process.exit(1);
  }

  if (!status.nodeOk) {
    p.log.error(`Node.js >= 18.0.0 is required. Current: ${process.version}`);
    p.cancel('Please upgrade Node.js and try again.');
    process.exit(1);
  }

  if (!status.bunOk) {
    const shouldInstall = await p.confirm({
      message: 'Bun is required but not found. Install it now?',
      initialValue: true,
    });

    if (p.isCancel(shouldInstall)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    if (shouldInstall) {
      const s = p.spinner();
      s.start('Installing Bun...');
      try {
        installBun();
        const recheck = findBinary('bun', BUN_EXTRA_PATHS);
        if (recheck.found) {
          status.bunOk = true;
          status.bunPath = recheck.path;
          s.stop(`Bun installed ${pc.green('✓')}`);
        } else {
          s.stop(`Bun installed but not found in PATH. You may need to restart your shell.`);
        }
      } catch {
        s.stop(`Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash`);
      }
    } else {
      p.log.warn('Bun is required for claude-mem. Install manually: curl -fsSL https://bun.sh/install | bash');
      p.cancel('Cannot continue without Bun.');
      process.exit(1);
    }
  }

  if (!status.uvOk) {
    const shouldInstall = await p.confirm({
      message: 'uv (Python package manager) is recommended for Chroma. Install it now?',
      initialValue: true,
    });

    if (p.isCancel(shouldInstall)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    if (shouldInstall) {
      const s = p.spinner();
      s.start('Installing uv...');
      try {
        installUv();
        const recheck = findBinary('uv', UV_EXTRA_PATHS);
        if (recheck.found) {
          status.uvOk = true;
          status.uvPath = recheck.path;
          s.stop(`uv installed ${pc.green('✓')}`);
        } else {
          s.stop('uv installed but not found in PATH. You may need to restart your shell.');
        }
      } catch {
        s.stop('uv installation failed. Install manually: curl -fsSL https://astral.sh/uv/install.sh | sh');
      }
    } else {
      p.log.warn('Skipping uv — Chroma vector search will not be available.');
    }
  }

  return status;
}
