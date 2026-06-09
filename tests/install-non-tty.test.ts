import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const installSourcePath = join(
  __dirname,
  '..',
  'src',
  'npx-cli',
  'commands',
  'install.ts',
);
const installSource = readFileSync(installSourcePath, 'utf-8');
const codexInstallerSourcePath = join(
  __dirname,
  '..',
  'src',
  'services',
  'integrations',
  'CodexCliInstaller.ts',
);
const codexInstallerSource = readFileSync(codexInstallerSourcePath, 'utf-8');
const syncMarketplaceSourcePath = join(
  __dirname,
  '..',
  'scripts',
  'sync-marketplace.cjs',
);
const syncMarketplaceSource = readFileSync(syncMarketplaceSourcePath, 'utf-8');
const transcriptConfigSourcePath = join(
  __dirname,
  '..',
  'src',
  'services',
  'transcripts',
  'config.ts',
);
const transcriptConfigSource = readFileSync(transcriptConfigSourcePath, 'utf-8');

describe('Install Non-TTY Support', () => {
  describe('isInteractive flag', () => {
    it('defines isInteractive based on process.stdin.isTTY', () => {
      expect(installSource).toContain('const isInteractive = process.stdin.isTTY === true');
    });

    it('uses strict equality (===) not truthy check for isTTY', () => {
      const match = installSource.match(/const isInteractive = process\.stdin\.isTTY === true/);
      expect(match).not.toBeNull();
    });
  });

  describe('runTasks helper', () => {
    it('defines a runTasks function', () => {
      expect(installSource).toContain('async function runTasks');
    });

    it('has interactive branch using p.tasks', () => {
      expect(installSource).toContain('await p.tasks(tasks)');
    });

    it('has non-interactive fallback using console.log', () => {
      expect(installSource).toContain('console.log(`  ${msg}`)');
    });

    it('branches on isInteractive', () => {
      expect(installSource).toContain('if (isInteractive)');
    });
  });

  describe('log wrapper', () => {
    it('defines log.info that falls back to console.log', () => {
      expect(installSource).toContain('info: (msg: string) =>');
      expect(installSource).toMatch(/info:.*console\.log/);
    });

    it('defines log.success that falls back to console.log', () => {
      expect(installSource).toContain('success: (msg: string) =>');
      expect(installSource).toMatch(/success:.*console\.log/);
    });

    it('defines log.warn that falls back to console.warn', () => {
      expect(installSource).toContain('warn: (msg: string) =>');
      expect(installSource).toMatch(/warn:.*console\.warn/);
    });

    it('defines log.error that falls back to console.error', () => {
      expect(installSource).toContain('error: (msg: string) =>');
      expect(installSource).toMatch(/error:.*console\.error/);
    });
  });

  describe('non-interactive install path', () => {
    it('defaults to claude-code when not interactive and no IDE specified', () => {
      expect(installSource).toContain("selectedIDEs = ['claude-code']");
    });

    it('parses the explicit --disable-auto-memory flag for non-interactive installs', () => {
      expect(readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8'))
        .toContain("disableAutoMemory: argv.includes('--disable-auto-memory')");
    });

    it('documents the explicit --disable-auto-memory install flag in help output', () => {
      expect(readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8'))
        .toContain('npx claude-mem install --disable-auto-memory');
    });

    it('uses console.log for intro in non-interactive mode', () => {
      expect(installSource).toContain("console.log('claude-mem install')");
    });

    it('uses console.log for note/summary in non-interactive mode', () => {
      expect(installSource).toContain("console.log(`\\n  ${installStatus}`)");
    });

    it('copies Codex marketplace metadata to the durable marketplace directory', () => {
      const copyRegion = installSource.slice(
        installSource.indexOf('const allowedTopLevelEntries = ['),
        installSource.indexOf('function copyPluginToCache'),
      );
      expect(copyRegion).toContain("'.agents'");
      expect(copyRegion).toContain("'.codex-plugin'");
      // Root .mcp.json was dropped in #2411; the MCP manifest now ships
      // exclusively as plugin/.mcp.json (bundled inside the 'plugin' entry).
      expect(copyRegion).toContain("'plugin'");
      expect(copyRegion).not.toContain("'.mcp.json'");
    });

    it('validates the bundled plugin as the Codex marketplace source', () => {
      expect(codexInstallerSource).toContain("path.join('plugin', '.codex-plugin', 'plugin.json')");
      expect(codexInstallerSource).toContain("path.join('plugin', '.mcp.json')");
      expect(codexInstallerSource).toContain("path.join('plugin', 'hooks', 'codex-hooks.json')");
      expect(codexInstallerSource).toContain("path.join('plugin', 'skills', 'mem-search', 'SKILL.md')");
    });

    it('keeps the sync-managed gitignore override mechanism for local marketplace sync', () => {
      const gitignoreExcludeRegion = syncMarketplaceSource.slice(
        syncMarketplaceSource.indexOf('function getGitignoreExcludes'),
        syncMarketplaceSource.indexOf('const branch = getCurrentBranch'),
      );
      // Root .mcp.json was dropped in #2411, so it is no longer a
      // sync-managed override — the override mechanism itself remains.
      expect(gitignoreExcludeRegion).toContain('syncManagedFiles');
      expect(gitignoreExcludeRegion).toContain('syncManagedFiles.has(line)');
    });

    it('registers Codex against the durable marketplace directory', () => {
      expect(installSource).toContain('installCodexCli(marketplaceDirectory())');
    });

    it('refreshes Codex marketplace cache after registration', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      expect(installRegion).toContain("['plugin', 'marketplace', 'upgrade', MARKETPLACE_NAME]");
      expect(installRegion).toContain('installed plugin cache');
    });

    it('replaces stale Codex marketplace registrations from a different source', () => {
      const registerRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('function registerCodexMarketplace'),
        codexInstallerSource.indexOf('function parseSemver'),
      );
      expect(registerRegion).toContain('isMarketplaceDifferentSourceError(error)');
      expect(registerRegion).toContain("['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]");
      expect(registerRegion).toContain("['plugin', 'marketplace', 'add', marketplaceRoot]");
    });

    it('enables Codex hooks and claude-mem plugin config during install', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      expect(codexInstallerSource).toContain("setTomlFeatureEnabled(next, 'hooks', true)");
      expect(codexInstallerSource).toContain("const CODEX_PLUGIN_ID = `claude-mem@${MARKETPLACE_NAME}`");
      expect(installRegion).toContain('enableCodexPluginConfig()');
      expect(installRegion).not.toContain('plugin_hooks');
    });

    it('captures Codex CLI output for install failure reporting', () => {
      // codex is spawned through the centralized codexSpawn() helper (#2695:
      // shell-resolved on Windows so codex.cmd is found). The helper region
      // owns the spawnSync call; runCodex captures stdout/stderr (pipe, not
      // inherit) for failure reporting.
      const codexSpawnRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export function codexSpawn'),
        codexInstallerSource.indexOf('function removeCodexAgentsMdContext'),
      );
      expect(codexSpawnRegion).toContain('spawnSync');
      expect(codexSpawnRegion).not.toContain("stdio: 'inherit'");
    });

    it('checks Codex CLI marketplace version before registration', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      expect(codexInstallerSource).toContain("const MIN_CODEX_MARKETPLACE_VERSION = '0.128.0'");
      expect(codexInstallerSource).toContain("codexSpawn(['--version'])");
      expect(installRegion.indexOf('assertCodexMarketplaceSupported()'))
        .toBeLessThan(installRegion.indexOf('registerCodexMarketplace(marketplaceRoot)'));
    });

    it('resolves codex.cmd on Windows via a shell-aware spawn (#2695)', () => {
      const codexSpawnRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export function codexSpawn'),
        codexInstallerSource.indexOf('function runCodex'),
      );
      expect(codexSpawnRegion).toContain("process.platform === 'win32'");
      expect(codexSpawnRegion).toContain('shell: true');
    });

    it('removes legacy Codex AGENTS context only after marketplace registration succeeds', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      expect(installRegion.indexOf('registerCodexMarketplace(marketplaceRoot)'))
        .toBeLessThan(installRegion.indexOf('cleanupLegacyCodexAgentsMdContext()'));
    });

    it('reports legacy Codex AGENTS cleanup failures to callers', () => {
      expect(codexInstallerSource).toContain('function removeCodexAgentsMdContext(): boolean');
      expect(codexInstallerSource).toContain('function disableCodexTranscriptAgentsContext(): boolean');
      expect(codexInstallerSource).toContain('if (!cleanupLegacyCodexAgentsMdContext())');
      expect(codexInstallerSource).toContain('if (!cleanupLegacyCodexTranscriptAgentsContext())');
    });

    it('does not fail Codex install after marketplace registration when only AGENTS cleanup fails', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      const cleanupFailureRegion = installRegion.slice(
        installRegion.indexOf('if (!cleanupLegacyCodexAgentsMdContext())'),
        installRegion.indexOf('Installation complete!'),
      );
      expect(cleanupFailureRegion).toContain('console.warn');
      expect(cleanupFailureRegion).not.toContain('return 1');
    });

    it('does not seed new Codex transcript watcher configs with AGENTS context injection', () => {
      expect(transcriptConfigSource).toContain("name: 'codex'");
      const sampleConfigRegion = transcriptConfigSource.slice(
        transcriptConfigSource.indexOf('export const SAMPLE_CONFIG'),
        transcriptConfigSource.indexOf('stateFile: DEFAULT_STATE_PATH'),
      );
      expect(sampleConfigRegion).toContain('watches: []');
      expect(sampleConfigRegion).not.toContain("path: '~/.codex/sessions/**/*.jsonl'");
      expect(sampleConfigRegion).not.toContain("mode: 'agents'");
      expect(sampleConfigRegion).not.toContain('updateOn');
    });
  });

  describe('TaskDescriptor interface', () => {
    it('defines a task interface with title and task function', () => {
      expect(installSource).toContain('interface TaskDescriptor');
      expect(installSource).toContain('title: string');
      expect(installSource).toContain('task: (message: (msg: string) => void) => Promise<string>');
    });
  });

  describe('InstallOptions interface', () => {
    it('exports InstallOptions with optional ide field', () => {
      expect(installSource).toContain('export interface InstallOptions');
      expect(installSource).toContain('ide?: string');
    });
  });

  describe('runtime selection', () => {
    it('offers Server (beta) while keeping worker as the default runtime', () => {
      expect(installSource).toContain("'server-beta'");
      expect(installSource).toContain('Server (beta)');
      expect(installSource).toContain("initialValue: 'worker'");
      expect(installSource).toContain('CLAUDE_MEM_RUNTIME');
    });
  });

  describe('post-install Next Steps copy', () => {
    it('frames the choice as two paths', () => {
      expect(installSource).toContain('Two paths from here:');
    });

    it('sets timing honesty about second-session memory injection', () => {
      expect(installSource).toContain('Memory injection starts on your second session in a project.');
    });

    it('addresses privacy: everything stays local', () => {
      expect(installSource).toContain('Everything stays in ');
      expect(installSource).toContain("pc.cyan('~/.claude-mem')");
    });

    it('keeps /learn-codebase as the optional front-load path', () => {
      expect(installSource).toContain('/learn-codebase');
    });

    it('demotes the uninstall caveat into a dim footer', () => {
      expect(installSource).toContain('close all Claude Code sessions before uninstalling');
    });

    it('does not advertise /mem-search in the post-install Next Steps', () => {
      const nextStepsRegion = installSource.slice(
        installSource.indexOf('const nextSteps = '),
        installSource.indexOf("p.note(nextSteps.join"),
      );
      expect(nextStepsRegion).not.toContain('/mem-search');
    });

    it('does not advertise /knowledge-agent in the post-install Next Steps', () => {
      const nextStepsRegion = installSource.slice(
        installSource.indexOf('const nextSteps = '),
        installSource.indexOf("p.note(nextSteps.join"),
      );
      expect(nextStepsRegion).not.toContain('/knowledge-agent');
    });
  });
});
