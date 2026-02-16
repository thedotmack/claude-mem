import * as p from '@clack/prompts';
import { runWelcome } from './steps/welcome.js';
import { runDependencyChecks } from './steps/dependencies.js';
import { runIdeSelection } from './steps/ide-selection.js';
import { runProviderConfiguration } from './steps/provider.js';
import { runSettingsConfiguration } from './steps/settings.js';
import { writeSettings } from './utils/settings-writer.js';
import { runInstallation } from './steps/install.js';
import { runWorkerStartup } from './steps/worker.js';
import { runCompletion } from './steps/complete.js';

async function runInstaller(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Error: This installer requires an interactive terminal.');
    console.error('Run directly: npx claude-mem-installer');
    process.exit(1);
  }

  const installMode = await runWelcome();

  // Dependency checks (all modes)
  await runDependencyChecks();

  // IDE and provider selection
  const selectedIDEs = await runIdeSelection();
  const providerConfig = await runProviderConfiguration();

  // Settings configuration
  const settingsConfig = await runSettingsConfiguration();

  // Write settings file
  writeSettings(providerConfig, settingsConfig);
  p.log.success('Settings saved.');

  // Installation (fresh or upgrade)
  if (installMode !== 'configure') {
    await runInstallation(selectedIDEs);
    await runWorkerStartup(settingsConfig.workerPort, settingsConfig.dataDir);
  }

  // Completion summary
  runCompletion(providerConfig, settingsConfig, selectedIDEs);
}

runInstaller().catch((error) => {
  p.cancel('Installation failed.');
  console.error(error);
  process.exit(1);
});
