import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = 'Usage: claude-mem hermes install --mcp-only --project-cwd <absolute-directory> | hermes uninstall';

/** Connect a selected Hermes home without changing its memory provider. */
export async function runHermesCommand(action: string | undefined, args: string[]): Promise<number> {
  if (action === undefined || action === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (action !== 'install' && action !== 'uninstall') {
    console.error(USAGE);
    return 1;
  }

  try {
    const { values } = parseArgs({
      args,
      options: action === 'install' ? {
        'mcp-only': { type: 'boolean' },
        'project-cwd': { type: 'string' },
      } : {},
      strict: true,
      allowPositionals: false,
    });

    if (action === 'uninstall') {
      const { uninstallHermesIntegration } = await import('../../services/integrations/HermesInstaller.js');
      return uninstallHermesIntegration();
    }

    const projectCwd = values['project-cwd'];
    if (values['mcp-only'] !== true || typeof projectCwd !== 'string' || !isAbsolute(projectCwd)) {
      console.error('Hermes MCP setup requires --mcp-only and --project-cwd with an absolute existing directory.');
      return 1;
    }
    if (!statSync(projectCwd).isDirectory()) {
      console.error('--project-cwd must name an existing directory.');
      return 1;
    }

    const { installHermesIntegration } = await import('../../services/integrations/HermesInstaller.js');
    return installHermesIntegration({ mcpOnly: true, projectCwd });
  } catch (error) {
    console.error(`Hermes setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
