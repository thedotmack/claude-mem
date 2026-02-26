import * as p from '@clack/prompts';
import pc from 'picocolors';

export type ProviderType = 'claude' | 'gemini' | 'openrouter' | 'openai-codex';
export type ClaudeAuthMethod = 'cli' | 'api';

export interface ProviderConfig {
  provider: ProviderType;
  openclawProvider?: ProviderType;   // OpenClaw-specific override (empty = use global)
  claudeAuthMethod?: ClaudeAuthMethod;
  apiKey?: string;
  openclawApiKey?: string;
  model?: string;
  rateLimitingEnabled?: boolean;
}

async function askApiKey(prompt: string, hint: string): Promise<string> {
  const key = await p.password({
    message: `${prompt} (${hint}):`,
    validate: (v) => (!v || !v.trim().length ? 'API key is required' : undefined),
  });
  if (p.isCancel(key)) { p.cancel('Installation cancelled.'); process.exit(0); }
  return key;
}

async function selectProvider(
  message: string,
  warnClaudeOAuth = false,
): Promise<{ provider: ProviderType; apiKey?: string }> {
  const claudeHint = warnClaudeOAuth
    ? pc.red('⚠️  Not recommended — Anthropic ToS prohibits Claude OAuth in third-party apps')
    : 'uses your Anthropic subscription';

  const provider = await p.select({
    message,
    options: [
      {
        value: 'openai-codex',
        label: 'OpenAI Codex',
        hint: 'ChatGPT Plus/Pro OAuth — no extra API key needed',
      },
      {
        value: 'gemini',
        label: 'Gemini',
        hint: 'free tier available — requires API key from ai.google.dev',
      },
      {
        value: 'openrouter',
        label: 'OpenRouter',
        hint: 'access to 100+ models, free options available',
      },
      {
        value: 'claude',
        label: 'Claude',
        hint: claudeHint,
      },
    ],
  });

  if (p.isCancel(provider)) { p.cancel('Installation cancelled.'); process.exit(0); }

  const selectedProvider = provider as ProviderType;
  let apiKey: string | undefined;
  if (selectedProvider === 'gemini') {
    apiKey = await askApiKey('Enter your Gemini API key', 'https://ai.google.dev');
  } else if (selectedProvider === 'openrouter') {
    apiKey = await askApiKey('Enter your OpenRouter API key', 'https://openrouter.ai/keys');
  }
  // openai-codex: OAuth via `openclaw auth` — no key to collect here
  // claude: handled separately (auth method selection below)

  return { provider: selectedProvider, apiKey };
}

export async function runProviderConfiguration(): Promise<ProviderConfig> {
  const config: ProviderConfig = { provider: 'claude' };

  // ── Detect OpenClaw context ───────────────────────────────────────────────
  // Ask whether the user also runs OpenClaw so we can configure per-origin routing.
  const usesOpenClaw = await p.confirm({
    message: 'Do you also use OpenClaw (in addition to Claude Code)?',
    initialValue: false,
  });
  if (p.isCancel(usesOpenClaw)) { p.cancel('Installation cancelled.'); process.exit(0); }

  // ── Claude Code provider ──────────────────────────────────────────────────
  const ccResult = await selectProvider(
    usesOpenClaw
      ? 'Provider for Claude Code sessions:'
      : 'Which AI provider should claude-mem use for memory compression?',
    false,
  );
  config.provider = ccResult.provider;
  config.apiKey = ccResult.apiKey;

  if (config.provider === 'claude') {
    const authMethod = await p.select({
      message: 'How should Claude authenticate?',
      options: [
        { value: 'cli' as const, label: 'CLI (Max Plan subscription)', hint: 'no API key needed' },
        { value: 'api' as const, label: 'API Key', hint: 'uses Anthropic API credits' },
      ],
    });
    if (p.isCancel(authMethod)) { p.cancel('Installation cancelled.'); process.exit(0); }
    config.claudeAuthMethod = authMethod;

    if (authMethod === 'api') {
      const apiKey = await p.password({
        message: 'Enter your Anthropic API key:',
        validate: (v) => {
          if (!v || !v.trim().length) return 'API key is required';
          if (!v.startsWith('sk-ant-')) return 'Anthropic API keys start with sk-ant-';
        },
      });
      if (p.isCancel(apiKey)) { p.cancel('Installation cancelled.'); process.exit(0); }
      config.apiKey = apiKey;
    }
  }

  if (config.provider === 'gemini') {
    const model = await p.select({
      message: 'Which Gemini model?',
      options: [
        { value: 'gemini-2.5-flash-lite' as const, label: 'Gemini 2.5 Flash Lite', hint: 'fastest, highest free RPM' },
        { value: 'gemini-2.5-flash' as const, label: 'Gemini 2.5 Flash', hint: 'balanced' },
        { value: 'gemini-3-flash-preview' as const, label: 'Gemini 3 Flash Preview', hint: 'latest' },
      ],
    });
    if (p.isCancel(model)) { p.cancel('Installation cancelled.'); process.exit(0); }
    config.model = model;

    const rateLimiting = await p.confirm({
      message: 'Enable rate limiting? (recommended for free tier)',
      initialValue: true,
    });
    if (p.isCancel(rateLimiting)) { p.cancel('Installation cancelled.'); process.exit(0); }
    config.rateLimitingEnabled = rateLimiting;
  }

  if (config.provider === 'openrouter') {
    const model = await p.text({
      message: 'Which OpenRouter model?',
      defaultValue: 'xiaomi/mimo-v2-flash:free',
      placeholder: 'xiaomi/mimo-v2-flash:free',
    });
    if (p.isCancel(model)) { p.cancel('Installation cancelled.'); process.exit(0); }
    config.model = model;
  }

  // ── OpenClaw provider (only if user confirmed OpenClaw usage) ─────────────
  if (usesOpenClaw) {
    p.note(
      'Anthropic\'s ToS (Feb 2026) prohibits using Claude OAuth tokens in\n' +
      'third-party apps like OpenClaw. OpenClaw sessions need a separate provider.',
      '⚠️  OpenClaw Provider',
    );

    const ocResult = await selectProvider(
      'Provider for OpenClaw sessions:',
      true, // warn about Claude OAuth
    );

    if (ocResult.provider !== config.provider) {
      config.openclawProvider = ocResult.provider;
      config.openclawApiKey = ocResult.apiKey;
    }
    // If same as global, leave openclawProvider undefined (means "use global")

    if (ocResult.provider === 'claude') {
      p.log.warn('⚠️  Using Claude OAuth for OpenClaw sessions may violate Anthropic\'s ToS. Consider switching later.');
    }
  }

  return config;
}
