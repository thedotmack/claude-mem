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
const claudeCodeVersionSource = readFileSync(
  join(__dirname, '..', 'src', 'npx-cli', 'install', 'claude-code-version.ts'),
  'utf-8',
);
const codexInstallerSourcePath = join(
  __dirname,
  '..',
  'src',
  'services',
  'integrations',
  'CodexCliInstaller.ts',
);
const codexInstallerSource = readFileSync(codexInstallerSourcePath, 'utf-8');

describe('Install Non-TTY Support', () => {
  describe('non-interactive install path', () => {
    it('resolves a missing provider before the OAuth gate instead of aborting', () => {
      const validationIndex = installSource.indexOf('validateNonInteractiveProvider(options, summary)');
      const oauthIndex = installSource.indexOf('await requireInstallerOAuthLogin(version)');
      expect(validationIndex).toBeGreaterThan(-1);
      expect(validationIndex).toBeLessThan(oauthIndex);
      expect(installSource).not.toContain('A provider must be explicit when stdin is not interactive.');
      expect(installSource).toContain("providerSource = 'default'");
      expect(installSource).toContain("providerSource = 'persisted'");
    });

    it('offers a deferred login-only sign-in link at the end of a non-interactive install', () => {
      expect(installSource).toContain("'npx-installer-deferred'");
      expect(installSource).toContain('AGENT: show this link to the user so they can finish signing in.');
      const helperStart = installSource.indexOf('export async function offerDeferredLogin(');
      const helperEnd = installSource.indexOf('\n}\n', helperStart);
      const helper = installSource.slice(helperStart, helperEnd);
      expect(helper).not.toContain('checkoutUrl');
      expect(helper).not.toContain('userCode');
      expect(helper).not.toContain('process.exit');
      expect(helper).not.toContain('DO_NOT_TRACK');
      expect(helper).not.toContain('await requireInstallerOAuthLogin(version)');
      // The offer runs after the success line and before install_completed.
      const callIndex = installSource.indexOf('await offerDeferredLogin(options, version)');
      expect(callIndex).toBeGreaterThan(installSource.indexOf("'\\nclaude-mem installed successfully!'"));
      expect(callIndex).toBeLessThan(installSource.indexOf("captureCliEvent('install_completed'"));
    });

    it('never opens an API-key prompt on non-interactive stdin', () => {
      const passwordIndex = installSource.indexOf('const apiKeyResult = await p.password');
      const guardIndex = installSource.lastIndexOf('if (!isInteractive)', passwordIndex);
      expect(guardIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeLessThan(passwordIndex);
      expect(installSource.slice(guardIndex, passwordIndex)).toContain('missing a personal API key');
    });

    it('copies Codex marketplace metadata to the durable marketplace directory', () => {
      const copyRegion = installSource.slice(
        installSource.indexOf('const allowedTopLevelEntries = ['),
        installSource.indexOf('function copyPluginToCache'),
      );
      expect(copyRegion).toContain("'.agents'");
      expect(copyRegion).toContain("'.codex-plugin'");
      expect(copyRegion).toContain("'.claude-plugin'");
      // The shipped manifest also lists cowork/, which npm does not ship.
      expect(copyRegion).toContain('writeTrimmedMarketplaceManifest(marketplaceDir);');
      // Root .mcp.json was dropped in #2411; the MCP manifest now ships
      // exclusively as plugin/.mcp.json (bundled inside the 'plugin' entry).
      expect(copyRegion).toContain("'plugin'");
      expect(copyRegion).not.toContain("'.mcp.json'");
    });

    it('copies the OMP hook to the marketplace directory the OMP installer reads (#3556)', () => {
      const copyRegion = installSource.slice(
        installSource.indexOf('const allowedTopLevelEntries = ['),
        installSource.indexOf('function copyPluginToCache'),
      );
      // OmpHooksInstaller resolves <marketplace>/omp/hooks/claude-mem.ts; shipping
      // omp/ in the npm package alone never puts it there.
      expect(copyRegion).toContain("'omp'");
      const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
      expect(packageJson.files).toContain('omp');
    });

    it('copies the Hermes provider to the marketplace directory the Hermes installer reads', () => {
      const copyRegion = installSource.slice(
        installSource.indexOf('const allowedTopLevelEntries = ['),
        installSource.indexOf('function copyPluginToCache'),
      );
      // HermesInstaller reads the durable marketplace, not the npm package.
      expect(copyRegion).toContain("'hermes'");
      const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
      expect(packageJson.files).toContain('hermes');
    });

    it('publishes the Claude marketplace root manifest in the npm package (#3424)', () => {
      const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
      expect(packageJson.files).toContain('.claude-plugin');
      expect(packageJson.files).toContain('plugin/.claude-plugin');
    });

    it('registers Codex against the durable marketplace directory', () => {
      expect(installSource).toContain('installCodexCli(marketplaceDirectory())');
    });

    it('awaits cache dependencies before writing the initial install marker', () => {
      const runtimeSetupRegion = installSource.slice(
        installSource.indexOf("title: 'Setting up runtime"),
        installSource.indexOf("return `Runtime ready"),
      );
      const installCall = runtimeSetupRegion.indexOf('await installPluginDependencies(cacheDir, bunPath)');
      const markerWrite = runtimeSetupRegion.indexOf('writeInstallMarker(cacheDir, version, bunVersion, uvVersion)');
      expect(installCall).toBeGreaterThanOrEqual(0);
      expect(markerWrite).toBeGreaterThan(installCall);
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
      expect(installRegion.indexOf('assertCodexMarketplaceSupported()'))
        .toBeLessThan(installRegion.indexOf('registerCodexMarketplace(marketplaceRoot)'));
    });

    it('probes Claude Code version through the shared no-shell Windows invocation', () => {
      const versionProbeRegion = claudeCodeVersionSource.slice(
        claudeCodeVersionSource.indexOf('function readClaudeCodeVersionOutput'),
        claudeCodeVersionSource.indexOf('function detectClaudeCodeVersion'),
      );
      expect(versionProbeRegion).not.toContain("shell: process.platform === 'win32'");
      expect(versionProbeRegion).not.toContain('shell: IS_WINDOWS');
    });

    it('removes legacy Codex AGENTS context only after marketplace registration succeeds', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      expect(installRegion.indexOf('registerCodexMarketplace(marketplaceRoot)'))
        .toBeLessThan(installRegion.indexOf('cleanupLegacyCodexAgentsMdContext()'));
    });

    it('does not fail Codex install after marketplace registration when only AGENTS cleanup fails', () => {
      const installRegion = codexInstallerSource.slice(
        codexInstallerSource.indexOf('export async function installCodexCli'),
        codexInstallerSource.indexOf('export function uninstallCodexCli'),
      );
      // Bounded by the plugin-list verification rather than the success banner:
      // that verification legitimately returns 1, and this assertion is only
      // about the two legacy-cleanup branches staying warn-only.
      const cleanupFailureRegion = installRegion.slice(
        installRegion.indexOf('if (!cleanupLegacyCodexAgentsMdContext())'),
        installRegion.indexOf('if (!verifyCodexPluginLoaded())'),
      );
      expect(cleanupFailureRegion).toContain('console.warn');
      expect(cleanupFailureRegion).not.toContain('return 1');
    });
  });

  describe('runtime selection', () => {
    it('offers Server (beta) while keeping worker as the default runtime', () => {
      // Phase 1d: installer writes the new canonical `'server'` runtime value.
      // The legacy `'server-beta'` value is still accepted by
      // runtime-selector.ts for existing installs, but new writes use 'server'.
      expect(installSource).toContain("value: 'server'");
      expect(installSource).toContain('Server (beta)');
      expect(installSource).toContain("initialValue: 'worker'");
      expect(installSource).toContain('CLAUDE_MEM_RUNTIME');
    });
  });

  describe('post-install Next Steps copy', () => {
    it('keeps uninstall trivia and env-var opt-outs off the install screen', () => {
      // Uninstall instructions do not belong on the screen that just finished
      // installing, and opting out of the first-session hint is meaningless to
      // someone who has not seen it yet.
      const nextStepsRegion = installSource.slice(
        installSource.indexOf('const nextSteps = '),
        installSource.indexOf("p.note(nextSteps.join"),
      );
      expect(nextStepsRegion).not.toContain('before uninstalling');
      expect(nextStepsRegion).not.toContain('CLAUDE_MEM_WELCOME_HINT_ENABLED');
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
