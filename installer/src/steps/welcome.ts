import * as p from '@clack/prompts';
import pc from 'picocolors';
import { existsSync } from 'fs';
import { expandHome } from '../utils/system.js';

export type InstallMode = 'fresh' | 'upgrade' | 'configure';

export async function runWelcome(): Promise<InstallMode> {
  p.intro(pc.bgCyan(pc.black(' claude-mem installer ')));

  p.log.info(`Version: 1.0.0`);
  p.log.info(`Platform: ${process.platform} (${process.arch})`);

  const settingsExist = existsSync(expandHome('~/.claude-mem/settings.json'));
  const pluginExist = existsSync(expandHome('~/.claude/plugins/marketplaces/thedotmack/'));

  const alreadyInstalled = settingsExist && pluginExist;

  if (alreadyInstalled) {
    p.log.warn('Existing claude-mem installation detected.');
  }

  const installMode = await p.select({
    message: 'What would you like to do?',
    options: alreadyInstalled
      ? [
          { value: 'upgrade' as const, label: 'Upgrade', hint: 'update to latest version' },
          { value: 'configure' as const, label: 'Configure', hint: 'change settings only' },
          { value: 'fresh' as const, label: 'Fresh Install', hint: 'reinstall from scratch' },
        ]
      : [
          { value: 'fresh' as const, label: 'Fresh Install', hint: 'recommended' },
          { value: 'configure' as const, label: 'Configure Only', hint: 'set up settings without installing' },
        ],
  });

  if (p.isCancel(installMode)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return installMode;
}
