import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ProviderConfig } from './provider.js';
import type { SettingsConfig } from './settings.js';
import type { IDE } from './ide-selection.js';

function getProviderLabel(config: ProviderConfig): string {
  switch (config.provider) {
    case 'claude':
      return config.claudeAuthMethod === 'api' ? 'Claude (API Key)' : 'Claude (CLI subscription)';
    case 'gemini':
      return `Gemini (${config.model ?? 'gemini-2.5-flash-lite'})`;
    case 'openrouter':
      return `OpenRouter (${config.model ?? 'xiaomi/mimo-v2-flash:free'})`;
  }
}

function getIDELabels(ides: IDE[]): string {
  return ides.map((ide) => {
    switch (ide) {
      case 'claude-code': return 'Claude Code';
      case 'cursor': return 'Cursor';
    }
  }).join(', ');
}

export function runCompletion(
  providerConfig: ProviderConfig,
  settingsConfig: SettingsConfig,
  selectedIDEs: IDE[],
): void {
  const summaryLines = [
    `Provider:   ${pc.cyan(getProviderLabel(providerConfig))}`,
    `IDEs:       ${pc.cyan(getIDELabels(selectedIDEs))}`,
    `Data dir:   ${pc.cyan(settingsConfig.dataDir)}`,
    `Port:       ${pc.cyan(settingsConfig.workerPort)}`,
    `Chroma:     ${settingsConfig.chromaEnabled ? pc.green('enabled') : pc.dim('disabled')}`,
  ];

  p.note(summaryLines.join('\n'), 'Configuration Summary');

  const nextStepsLines: string[] = [];

  if (selectedIDEs.includes('claude-code')) {
    nextStepsLines.push('Open Claude Code and start a conversation — memory is automatic!');
  }
  if (selectedIDEs.includes('cursor')) {
    nextStepsLines.push('Open Cursor — hooks are active in your projects.');
  }
  nextStepsLines.push(`View your memories: ${pc.underline(`http://localhost:${settingsConfig.workerPort}`)}`);
  nextStepsLines.push(`Search past work: use ${pc.bold('/mem-search')} in Claude Code`);

  p.note(nextStepsLines.join('\n'), 'Next Steps');

  p.outro(pc.green('claude-mem installed successfully!'));
}
