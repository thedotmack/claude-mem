import * as p from '@clack/prompts';
import pc from 'picocolors';

export type ProviderType = 'claude' | 'gemini' | 'openrouter';
export type ClaudeAuthMethod = 'cli' | 'api';

export interface ProviderConfig {
  provider: ProviderType;
  claudeAuthMethod?: ClaudeAuthMethod;
  apiKey?: string;
  model?: string;
  rateLimitingEnabled?: boolean;
}

export async function runProviderConfiguration(): Promise<ProviderConfig> {
  const provider = await p.select({
    message: 'Which AI provider should claude-mem use for memory compression?',
    options: [
      { value: 'claude' as const, label: 'Claude', hint: 'uses your Claude subscription' },
      { value: 'gemini' as const, label: 'Gemini', hint: 'free tier available' },
      { value: 'openrouter' as const, label: 'OpenRouter', hint: 'free models available' },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  const config: ProviderConfig = { provider };

  if (provider === 'claude') {
    const authMethod = await p.select({
      message: 'How should Claude authenticate?',
      options: [
        { value: 'cli' as const, label: 'CLI (Max Plan subscription)', hint: 'no API key needed' },
        { value: 'api' as const, label: 'API Key', hint: 'uses Anthropic API credits' },
      ],
    });

    if (p.isCancel(authMethod)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    config.claudeAuthMethod = authMethod;

    if (authMethod === 'api') {
      const apiKey = await p.password({
        message: 'Enter your Anthropic API key:',
        validate: (value) => {
          if (!value || value.trim().length === 0) return 'API key is required';
          if (!value.startsWith('sk-ant-')) return 'Anthropic API keys start with sk-ant-';
        },
      });

      if (p.isCancel(apiKey)) {
        p.cancel('Installation cancelled.');
        process.exit(0);
      }

      config.apiKey = apiKey;
    }
  }

  if (provider === 'gemini') {
    const apiKey = await p.password({
      message: 'Enter your Gemini API key:',
      validate: (value) => {
        if (!value || value.trim().length === 0) return 'API key is required';
      },
    });

    if (p.isCancel(apiKey)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    config.apiKey = apiKey;

    const model = await p.select({
      message: 'Which Gemini model?',
      options: [
        { value: 'gemini-2.5-flash-lite' as const, label: 'Gemini 2.5 Flash Lite', hint: 'fastest, highest free RPM' },
        { value: 'gemini-2.5-flash' as const, label: 'Gemini 2.5 Flash', hint: 'balanced' },
        { value: 'gemini-3-flash-preview' as const, label: 'Gemini 3 Flash Preview', hint: 'latest' },
      ],
    });

    if (p.isCancel(model)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    config.model = model;

    const rateLimiting = await p.confirm({
      message: 'Enable rate limiting? (recommended for free tier)',
      initialValue: true,
    });

    if (p.isCancel(rateLimiting)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    config.rateLimitingEnabled = rateLimiting;
  }

  if (provider === 'openrouter') {
    const apiKey = await p.password({
      message: 'Enter your OpenRouter API key:',
      validate: (value) => {
        if (!value || value.trim().length === 0) return 'API key is required';
      },
    });

    if (p.isCancel(apiKey)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    config.apiKey = apiKey;

    const model = await p.text({
      message: 'Which OpenRouter model?',
      defaultValue: 'xiaomi/mimo-v2-flash:free',
      placeholder: 'xiaomi/mimo-v2-flash:free',
    });

    if (p.isCancel(model)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    config.model = model;
  }

  return config;
}
