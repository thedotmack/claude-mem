import { existsSync } from 'fs';
import { join } from 'path';
import { getSupervisor } from '../../supervisor/index.js';
import { logger } from '../../utils/logger.js';
import {
  ensureTreeSitterCliBinary,
  isTreeSitterCliBinaryUsable,
} from '../smart-file-read/tree-sitter-cli-provision.js';
import { pinnedTreeSitterExecutableSha256 } from '../smart-file-read/tree-sitter-cli-checksums.js';

const TREE_SITTER_CLI_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export type TreeSitterCliProvisioningOutcome = 'no-package' | 'already-usable' | 'provisioned';

/**
 * Claude Code installs a marketplace plugin's node_modules with lifecycle
 * scripts off, and the Setup hook never fires on install or update, so no
 * install step downloads the tree-sitter CLI for marketplace users:
 * smart_search, smart_outline and smart_unfold cannot parse, and the File Read
 * Gate stays off (D9). The worker is the one long-lived process every install
 * starts, so it provisions its own plugin root. A root without the
 * tree-sitter-cli package (a source checkout, a host copy without
 * node_modules) has nothing to provision. `pinnedSha256ForVersion` exists for
 * tests; callers pass none.
 */
export async function provisionTreeSitterCliForPluginRoot(
  pluginRoot: string,
  pinnedSha256ForVersion: (version: string) => string | undefined = pinnedTreeSitterExecutableSha256,
): Promise<TreeSitterCliProvisioningOutcome> {
  if (!existsSync(join(pluginRoot, 'node_modules', 'tree-sitter-cli', 'install.js'))) return 'no-package';
  if (await isTreeSitterCliBinaryUsable(pluginRoot)) return 'already-usable';
  getSupervisor().assertCanSpawn('tree-sitter cli install');
  logger.info('SYSTEM', 'Downloading the tree-sitter CLI for smart_search, smart_outline and smart_unfold', { pluginRoot });
  await ensureTreeSitterCliBinary(pluginRoot, TREE_SITTER_CLI_INSTALL_TIMEOUT_MS, pinnedSha256ForVersion);
  logger.info('SYSTEM', 'tree-sitter CLI provisioned', { pluginRoot });
  return 'provisioned';
}
