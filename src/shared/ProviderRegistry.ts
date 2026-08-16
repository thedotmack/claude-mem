import type { LlmProvider } from './LlmProvider.js';
import {
  MemoryTaskType,
  MEMORY_TASK_DEFAULTS,
  ProviderName,
} from './MemoryTaskRegistry.js';
import type { SettingsDefaults } from './SettingsDefaultsManager.js';
import { OllamaProvider } from '../services/worker/OllamaProvider.js';
import { GeminiCliProvider } from '../services/worker/GeminiCliProvider.js';

export class ProviderRegistry {
  private providers: Map<ProviderName, LlmProvider> = new Map();
  private taskOverrides: Map<MemoryTaskType, ProviderName> = new Map();
  private costOptimization: boolean;

  constructor(settings: SettingsDefaults) {
    this.registerProviders(settings);
    this.loadTaskOverrides(settings);
    this.costOptimization =
      settings.CLAUDE_MEM_PREFER_COST_OPTIMIZATION === 'true' ||
      (settings.CLAUDE_MEM_PREFER_COST_OPTIMIZATION as any) === true;
  }

  private registerProviders(settings: SettingsDefaults) {
    const ollamaEndpoint = (settings.OLLAMA_ENDPOINT as string | undefined)?.trim();
    if (ollamaEndpoint) {
      const ollamaModel = (settings.OLLAMA_MODEL as string | undefined)?.trim() || 'gpt-oss:20b';
      this.registerProvider(new OllamaProvider({ endpoint: ollamaEndpoint, model: ollamaModel }));
    }
    const geminiCliBinary = settings.CLAUDE_MEM_GEMINI_CLI_BINARY?.trim() || 'gemini';
    const geminiCliModel = settings.CLAUDE_MEM_GEMINI_CLI_MODEL?.trim() || 'gemini-2.5-flash-lite';
    this.registerProvider(new GeminiCliProvider({ binary: geminiCliBinary, model: geminiCliModel }));
  }

  private loadTaskOverrides(settings: SettingsDefaults) {
    try {
      const tasksStr = settings.CLAUDE_MEM_TASKS;
      if (tasksStr && typeof tasksStr === 'string' && tasksStr !== '{}') {
        const parsed = JSON.parse(tasksStr);
        for (const [task, provider] of Object.entries(parsed)) {
          this.taskOverrides.set(
            task as MemoryTaskType,
            provider as ProviderName
          );
        }
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  // Get provider for a specific memory task
  async getForTask(task: MemoryTaskType): Promise<LlmProvider> {
    // 1. Check user override
    const override = this.taskOverrides.get(task);
    if (override) {
      const provider = this.providers.get(override);
      if (provider && (await provider.isAvailable())) {
        return provider;
      }
    }

    // 2. Check cost optimization flag
    if (this.costOptimization) {
      const provider = this.getLowestCostProvider(task);
      if (provider && (await provider.isAvailable())) {
        return provider;
      }
    }

    // 3. Use task default with fallback chain
    const taskConfig = MEMORY_TASK_DEFAULTS[task];
    for (const providerName of [
      taskConfig.preferredProvider,
      ...taskConfig.fallbackChain,
    ]) {
      const provider = this.providers.get(providerName);
      if (provider && (await provider.isAvailable())) {
        return provider;
      }
    }

    throw new Error(`No available provider for task: ${task}`);
  }

  // Get lowest-cost provider from task's chain
  private getLowestCostProvider(task: MemoryTaskType): LlmProvider | null {
    const taskConfig = MEMORY_TASK_DEFAULTS[task];
    const candidates = [
      taskConfig.preferredProvider,
      ...taskConfig.fallbackChain,
    ];
    const costOrder: ProviderName[] = [
      'ollama',
      'gemini-cli',
      'openrouter',
      'gemini-api',
      'claude',
    ];

    for (const providerName of costOrder) {
      if (candidates.includes(providerName)) {
        const provider = this.providers.get(providerName);
        if (provider) {
          return provider;
        }
      }
    }

    // Fallback to preferred if no candidates matched cost order
    return this.providers.get(taskConfig.preferredProvider) ?? null;
  }

  registerProvider(provider: LlmProvider): void {
    this.providers.set(provider.name as ProviderName, provider);
  }
}
