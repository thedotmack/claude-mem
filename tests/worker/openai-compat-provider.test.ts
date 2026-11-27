import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'node:http';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyOpenAICompatError,
  isLocalEndpointUrl,
  OpenAICompatProvider,
  isOpenAICompatAvailable,
  isOpenAICompatSelected,
  rememberServedModel,
  resetRefusedHostModelsForTesting,
  resetServedModelsForTesting,
  resolveOpenAICompatConfig,
} from '../../src/services/worker/OpenAICompatProvider.js';
import { shouldRotateKey } from '../../src/shared/api-key-pool.js';
import { DEFAULT_MODEL_DISABLED_CODE, HOST_MODEL_NOT_SERVED_CODE, OWN_MODEL_NOT_SERVED_CODE } from '../../src/services/worker/provider-errors.js';
import {
  OPENAI_COMPAT_PRESETS,
  resolveOpenAICompatPreset,
} from '../../src/shared/openai-compat-presets.js';
import { getSelectedProvider } from '../../src/services/worker/provider-dispatch.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { resetReasoningFieldRejectionsForTesting } from '../../src/services/worker/reasoning-budget.js';
import { markEndpointRefusesStreamingForTests, resetStreamingEndpointMemoryForTests } from '../../src/services/worker/streamed-chat-completion.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import { getQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

/**
 * As in provider-dispatch.test.ts: SettingsDefaultsManager applies process.env
 * LAST, so pinning env vars (empty string included) fully determines the
 * outcome regardless of the temp settings file preload created.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
  'CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
] as const;

const NIM_BASE = 'https://integrate.api.nvidia.com/v1';

describe('openai-compatible presets', () => {
  it('resolves case-insensitively and tolerates surrounding whitespace', () => {
    expect(resolveOpenAICompatPreset('  NVIDIA-NIM ').id).toBe('nvidia-nim');
  });

  it('degrades an unknown or blank preset to custom instead of throwing', () => {
    // A typo in settings.json is read during status polling; it must not crash.
    expect(resolveOpenAICompatPreset('nvidia-nimm').id).toBe('custom');
    expect(resolveOpenAICompatPreset('').id).toBe('custom');
    expect(resolveOpenAICompatPreset(undefined).id).toBe('custom');
    expect(resolveOpenAICompatPreset(42).id).toBe('custom');
  });

  it('has unique ids and a custom escape hatch', () => {
    const ids = OPENAI_COMPAT_PRESETS.map(preset => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('custom');
  });

  it('marks local presets as not needing a key', () => {
    for (const id of ['ollama', 'lmstudio', 'rapidmlx', 'vllm']) {
      expect(resolveOpenAICompatPreset(id).requiresApiKey).toBe(false);
      expect(resolveOpenAICompatPreset(id).defaultModel).toBe('');
    }
  });

  it('gives every hosted preset a base URL', () => {
    for (const preset of OPENAI_COMPAT_PRESETS) {
      if (preset.id === 'custom') continue;
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
    }
  });
});

describe('resolveOpenAICompatConfig', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it.each([
    ['nvidia-nim', NIM_BASE, 'nvidia/nemotron-3.5-lightning-30b-a3b'],
    ['api-route', 'https://global.api-route.com/v1', ''],
    ['atlascloud', 'https://api.atlascloud.ai/v1', 'deepseek-ai/deepseek-v4-flash'],
    ['atmorouter', 'https://atmorouter.dev/v1', 'zai/glm-5.3-flash'],
    ['cheapaimodel', 'https://api.cheapaimodel.ai/v1', 'deepseek-v4-1-flash'],
    ['hopbase', 'https://api.hop-base.com/v1', 'deepseek-v4.1-flash'],
    ['iflytek', 'https://maas-api.cn-huabei-1.xf-yun.com/v2', 'spark-x2.5'],
    ['minimax', 'https://api.minimax.io/v1', 'MiniMax-M3'],
    ['minimax-cn', 'https://api.minimaxi.com/v1', 'MiniMax-M3'],
    ['modelgo', 'https://api.modelgo.ai/v1', ''],
    ['obscurify-ai', 'https://obscurify.ai/v1', 'deepseek/deepseek-v4-flash'],
    ['opencode-go', 'https://opencode.ai/inference/go/openai/v1', 'kimi-k3'],
    ['opencode-zen', 'https://opencode.ai/inference/openai/v1', ''],
    ['opper', 'https://api.opper.ai/v3/compat', 'gpt-5.4-mini'],
    ['orcarouter', 'https://api.orcarouter.ai/v1', 'openai/gpt-4o-mini'],
    ['popnow', 'https://api.popnow.ai/v1', 'deepseek/v4-flash/chat'],
    ['runcrate', 'https://api.runcrate.ai/v1', 'deepseek-ai/DeepSeek-V4.1-Flash'],
    ['standardcompute', 'https://api.stdcmpt.com/v1', 'deepseek/deepseek-v4-flash'],
    ['trustedrouter', 'https://api.trustedrouter.com/v1', 'deepseek/deepseek-v4-flash'],
    ['uberllm', 'https://api.uberllm.dev/v1', 'deepseek/deepseek-v4.1-flash'],
    ['worldrouter', 'https://inference-api.worldrouter.ai/v1', 'deepseek-v4-flash'],
    ['aigrow', 'https://aigrow.gg/v1', 'claude-haiku-5.5'],
    ['straitly', 'https://api.straitly.ai/v1', 'deepseek/deepseek-v4-1-flash-1017'],
    ['teamorouter', 'https://api.teamorouter.com/v1', 'glm-5.3-flash'],
  ])('resolves %s with its hosted endpoint and default model', (id, baseUrl, defaultModel) => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = id;
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-preset-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const preset = resolveOpenAICompatPreset(id);
    expect(preset.id).toBe(id);
    expect(preset.baseUrl).toBe(baseUrl);
    expect(preset.defaultModel).toBe(defaultModel);
    expect(preset.requiresApiKey).toBe(true);
    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe(`${baseUrl}/chat/completions`);
    expect(config.model).toBe(defaultModel);
    expect(config.apiKey).toBe('fixture-preset-key');
    expect(isOpenAICompatAvailable()).toBe(defaultModel !== '');
  });

  it('keeps the preset model when only the base URL is overridden', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'iflytek';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-preset-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://maas-token-api.cn-huabei-1.xf-yun.com/v2';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe('https://maas-token-api.cn-huabei-1.xf-yun.com/v2/chat/completions');
    expect(config.model).toBe('spark-x2.5');
  });

  it('sends a resolved preset with bearer auth and no attribution headers', async () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'atlascloud';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-preset-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    try {
      await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<unknown>;
      }).query([{ role: 'user', content: 'observe' }], resolveOpenAICompatConfig());

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.atlascloud.ai/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer fixture-preset-key');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('deepseek-ai/deepseek-v4-flash');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('takes base URL and model from the preset and appends /chat/completions', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe(`${NIM_BASE}/chat/completions`);
    expect(config.model).toBe(resolveOpenAICompatPreset('nvidia-nim').defaultModel);
    expect(config.apiKey).toBe('nvapi-test');
  });

  it('lets an explicit base URL and model win over the preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://my-gateway.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'my/model';

    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe('https://my-gateway.example.com/v1/chat/completions');
    expect(config.model).toBe('my/model');
  });

  it('does not double up when the base URL already names the path', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'k';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'm';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://x.example.com/v1/chat/completions';

    expect(resolveOpenAICompatConfig().apiUrl).toBe('https://x.example.com/v1/chat/completions');
  });

  it('builds a rotation pool with the primary key first', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = 'nvapi-2, nvapi-3';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiKeys).toEqual(['nvapi-1', 'nvapi-2', 'nvapi-3']);
    expect(config.apiKey).toBe('nvapi-1');
  });

  it('promotes the first listed key when only the list is set', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = 'nvapi-a\nnvapi-b';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';

    const config = resolveOpenAICompatConfig();
    expect(config.apiKey).toBe('nvapi-a');
    expect(config.apiKeys).toEqual(['nvapi-a', 'nvapi-b']);
  });

  it('yields no endpoint for a bare custom preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';

    expect(resolveOpenAICompatConfig().apiUrl).toBe('');
  });

  function defaultOverrideEnv(override: string): void {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opencode-go';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-preset-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = override;
  }

  it('replaces the implicit default with the override', () => {
    defaultOverrideEnv('beam-free');
    expect(resolveOpenAICompatConfig().model).toBe('beam-free');
  });

  it('disables the implicit default with none while keeping the provider selected', () => {
    defaultOverrideEnv('none');
    const config = resolveOpenAICompatConfig();
    expect(config.model).toBe('');
    expect(config.defaultDisabled).toBe(true);
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('keeps the implicit candidates when the override is empty', () => {
    defaultOverrideEnv('');
    expect(resolveOpenAICompatConfig().model).toBe('kimi-k3');
  });

  it('keeps an explicit model ahead of the override', () => {
    defaultOverrideEnv('beam-free');
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'kimi-k3';
    expect(resolveOpenAICompatConfig().model).toBe('kimi-k3');
  });

  it('treats a padded, mixed-case none as disabled', () => {
    defaultOverrideEnv(' NoNe ');
    expect(resolveOpenAICompatConfig().model).toBe('');
  });

  it('keeps an explicit model when the override disables the default', () => {
    defaultOverrideEnv('none');
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'pinned-id';
    expect(resolveOpenAICompatConfig().model).toBe('pinned-id');
  });
});

/**
 * Task 5: the observer model is resolved from the live session, not just from
 * the global setting. Task 4 parked the endpoint-ready id on the session;
 * provider resolution must apply it last (session > setting > preset).
 */
describe('observer model resolution from the current session', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const resolvedModel = (session: ActiveSession) =>
    (new OpenAICompatProvider({} as never, {} as never) as unknown as {
      configForSession(s: ActiveSession): { model: string };
    }).configForSession(session);

  it('observer-model-wins: with the opt-in on, the session id beats CLAUDE_MEM_OPENAI_COMPAT_MODEL', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'true';

    expect(resolvedModel({ observerModel: 'session-model' } as ActiveSession).model).toBe('session-model');
  });

  it('observer-model-fallback: with the opt-in on, the setting applies when the session has no id, then the preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'true';
    expect(resolvedModel({} as ActiveSession).model).toBe('configured-model');

    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    expect(resolvedModel({} as ActiveSession).model).toBe(resolveOpenAICompatPreset('nvidia-nim').defaultModel);
  });

  it('session-model-opt-in-off: with the opt-in off, the global model wins even when the session has an id', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'false';

    expect(resolvedModel({ observerModel: 'session-model' } as ActiveSession).model).toBe('configured-model');
  });

  it('session-model-opt-in-on: the session id wins only when the exact gate value is true', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'true';

    expect(resolvedModel({ observerModel: 'session-model' } as ActiveSession).model).toBe('session-model');
  });

  it('blank-session-model-fallback: a whitespace-only session id keeps the configured model', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'true';

    expect(resolvedModel({ observerModel: '   ' } as ActiveSession).model).toBe('configured-model');
    expect(resolvedModel({ observerModel: '\t\n' } as ActiveSession).model).toBe('configured-model');
  });
});

/**
 * Task 4 (#6485): the observer and summary models may come from the host's
 * OpenCode config. Explicit settings still win, and host display keys are
 * translated before they reach an endpoint. The host and session gates remain
 * independent.
 */
describe('observer model resolution from the host config', () => {
  const HOST_ENV_KEYS = [...ENV_KEYS, 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER'] as const;
  let savedEnv: Record<string, string | undefined>;
  let hostDir: string;

  beforeEach(() => {
    savedEnv = {};
    for (const key of HOST_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    hostDir = mkdtempSync(join(tmpdir(), 'openai-compat-host-'));
    // Keep this machine's real OpenCode config out of the fixture.
    process.env.OPENCODE_CONFIG_DIR = join(hostDir, 'opencode');
    process.env.OPENCODE_CONFIG = join(hostDir, 'host.json');
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const key of HOST_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(hostDir, { recursive: true, force: true });
  });

  const writeHost = (config: unknown): void => {
    writeFileSync(process.env.OPENCODE_CONFIG!, JSON.stringify(config));
  };

  const hostConfig = (host?: { cwd?: string }) =>
    resolveOpenAICompatConfig(undefined, host ?? {});

  const PRESET_MODEL = resolveOpenAICompatPreset('nvidia-nim').defaultModel;
  // A fresh Response per call: the streaming reader locks and drains its body.
  const okFetch = () => spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
  }), { status: 200 }));
  const ranQuery = async (
    config: ReturnType<typeof resolveOpenAICompatConfig>,
    paidSendBudget?: PaidSendBudget,
  ) => {
    const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
      query(
        h: Array<{ role: string; content: string }>,
        c: unknown,
        signal?: AbortSignal,
        timeout?: number,
        budget?: PaidSendBudget,
      ): Promise<unknown>;
    };
    return provider.query([{ role: 'user', content: 'observe' }], config, undefined, undefined, paidSendBudget);
  };
  const presetAsHostConfig = {
    model: 'host/preset-model',
    provider: { host: { models: { 'preset-model': { modelID: PRESET_MODEL } } } },
  };

  const baseEnv = (): void => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
  };

  const hostModelConfig = {
    model: 'host/main-hote',
    agents: { title: { model: 'host/small-hote' } },
    provider: {
      host: {
        models: {
          'main-hote': { modelID: 'endpoint-main' },
          'small-hote': { modelID: 'endpoint-small' },
        },
      },
    },
  };

  it('host-off-uses-preset: with the gate off the preset model stands and no host model is used', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'false';
    writeHost(hostModelConfig);

    const config = hostConfig();
    expect(config.model).toBe(resolveOpenAICompatPreset('nvidia-nim').defaultModel);
    expect(config.summaryModel).toBeUndefined();
  });

  it('host-on-explicit-wins: an explicit CLAUDE_MEM_OPENAI_COMPAT_MODEL beats the host model', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    writeHost(hostModelConfig);

    expect(hostConfig().model).toBe('configured-model');
  });

  it('host-on-mapped-model: the host display keys resolve to the endpoint ids they declare', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(hostModelConfig);

    const config = hostConfig();
    expect(config.model).toBe('endpoint-main');
    expect(config.summaryModel).toBe('endpoint-small');
  });

  it('host-unmapped-warn-once: an untranslatable host model falls back to the preset and warns once', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost({ model: 'cmem-t4-unmapped-provider/ghost-model' });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const first = hostConfig();
      const second = hostConfig();

      const fallback = resolveOpenAICompatPreset('nvidia-nim').defaultModel;
      expect(first.model).toBe(fallback);
      expect(second.model).toBe(fallback);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain('cmem-t4-unmapped-provider/ghost-model');
    } finally {
      warn.mockRestore();
    }
  });

  it('host-unmapped-warn-once-per-id: alternating unmapped ids each warn once (Greptile P2)', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const fallback = resolveOpenAICompatPreset('nvidia-nim').defaultModel;
    try {
      // Alternate both ids: the old single-slot dedup replaced one with the
      // other and logged both again on every turn.
      for (const id of ['ghost-a', 'ghost-b', 'ghost-a', 'ghost-b']) {
        writeHost({ model: `cmem-greptile-p2/${id}` });
        expect(hostConfig().model).toBe(fallback);
      }
      const warnings = warn.mock.calls
        .map(call => String(call[1]))
        .filter(line => line.includes('not declared in the OpenCode provider config'));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('ghost-a');
      expect(warnings[1]).toContain('ghost-b');
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Greptile P2: an unmapped small model used to warn through translateHostModel.
   * The shared diagnosis now drops it silently on a `resolved` main model, so
   * the worker must print a separate one-shot notice without a new status.
   */
  it('unmapped-small-model-warns-once-without-a-new-status', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    const smallId = 'cmem-p2-small-greptile/host-ghost-small';
    writeHost({
      model: 'host/main-hote',
      agents: { title: { model: smallId } },
      provider: { host: { models: { 'main-hote': { modelID: 'endpoint-main' } } } },
    });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const first = hostConfig();
      hostConfig();

      expect(first.model).toBe('endpoint-main');
      expect(first.summaryModel).toBeUndefined();
      const lines = warn.mock.calls.map(call => String(call[1]));
      const notices = lines.filter(line => line.includes(smallId));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('small model');
      expect(notices[0]).toContain('not declared in the OpenCode provider config');
      // The main id resolved: its warning slot must stay untouched.
      expect(lines.filter(line => line.includes('host/main-hote'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('unmapped-small-model-dedups-per-id-with-a-bounded-set', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const ids = Array.from({ length: 65 }, (_, i) => `cmem-p2-cap/ghost-${i}`);
      for (const id of ids) {
        writeHost({
          model: 'host/main-hote',
          agents: { title: { model: id } },
          provider: { host: { models: { 'main-hote': { modelID: 'endpoint-main' } } } },
        });
        expect(hostConfig().summaryModel).toBeUndefined();
      }
      const notices = () => warn.mock.calls
        .map(call => String(call[1]))
        .filter(line => line.includes('unmapped small model'));
      expect(notices()).toHaveLength(65);
      // The 65th id evicted the first: a capped set warns once more for it.
      writeHost({
        model: 'host/main-hote',
        agents: { title: { model: ids[0] } },
        provider: { host: { models: { 'main-hote': { modelID: 'endpoint-main' } } } },
      });
      expect(hostConfig().summaryModel).toBeUndefined();
      expect(notices()).toHaveLength(66);
    } finally {
      warn.mockRestore();
    }
  });

  // The unmapped warning is one-shot per id (process-wide), so these cases run
  // after the tests that assert it, keeping their shared fixture id verbatim.
  it('host-unmapped-override: an untranslatable host model uses the override', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = 'beam-free';
    writeHost({ model: 'cmem-t4-unmapped-provider/ghost-model' });
    expect(hostConfig().model).toBe('beam-free');
  });

  it('keeps a translated host model ahead of the override', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = 'beam-free';
    writeHost(hostModelConfig);
    expect(hostConfig().model).toBe('endpoint-main');
  });

  it('keeps a translated id equal to the override host-chosen', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = 'endpoint-main';
    writeHost(hostModelConfig);
    expect(hostConfig().hostChosenModels).toHaveProperty('endpoint-main', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');
  });

  it('none-cuts-last-served: the override removes even a previously served model', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = 'none';
    // Pose the state explicitly: no undocumented successful request is needed.
    rememberServedModel(resolveOpenAICompatConfig().apiUrl, 'endpoint-main');
    writeHost({ model: 'cmem-none-cut/ghost' });
    expect(hostConfig().model).toBe('');
  });

  it('masked-model-warns-once: the masked host id is named once over two turns', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'pinned-model';
    // A fresh id: the warn-once set is process-wide and other tests in this
    // file already exercised the masked notice with `host/main-hote`.
    writeHost({
      model: 'host/masked-hote',
      provider: { host: { models: { 'masked-hote': { modelID: 'endpoint-masked' } } } },
    });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const first = hostConfig();
      const second = hostConfig();
      expect(first.model).toBe('pinned-model');
      expect(second.model).toBe('pinned-model');

      const masked = warn.mock.calls
        .map(call => String(call[1]))
        .filter(line => line.includes('host model: masked'));
      expect(masked).toHaveLength(1);
      expect(masked[0]).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL');
      expect(masked[0]).toContain('host/masked-hote');
    } finally {
      warn.mockRestore();
    }
  });

  it('host-and-session-precedence: the session id wins last and the host gate stays independent', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(hostModelConfig);
    const resolvedModel = (session: ActiveSession, host?: { cwd?: string }) =>
      (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        configForSession(s: ActiveSession, h?: { cwd?: string }): { model: string };
      }).configForSession(session, host);

    // Both gates on: the session id is applied after host and explicit values.
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    expect(resolvedModel({ observerModel: 'session-model' } as ActiveSession, {}).model).toBe('session-model');

    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    expect(resolvedModel({ observerModel: 'session-model' } as ActiveSession, {}).model).toBe('session-model');

    // Turning the session opt-in off must not disable host mode.
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'false';
    expect(resolvedModel({ observerModel: 'session-model' } as ActiveSession, {}).model).toBe('endpoint-main');
  });

  it('host-id-equal-to-preset-default-is-host-chosen', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(presetAsHostConfig);

    // The id is the host's choice even though the preset happens to name the
    // same id: a 404 for it is a refusal of that choice, not of our setting.
    const config = hostConfig();
    expect(config.model).toBe(PRESET_MODEL);
    expect(config.hostChosenModels).toEqual({ [PRESET_MODEL]: 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' });
  });

  it('unmapped-falls-back-to-last-served-before-preset', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    const fetchSpy = okFetch();
    try {
      writeHost({ model: 'cmem-last-served/ghost' });
      const presetConfig = hostConfig();
      expect(presetConfig.model).toBe(PRESET_MODEL);
      await ranQuery(presetConfig);

      writeHost(hostModelConfig);
      const translatedConfig = hostConfig();
      expect(translatedConfig.model).toBe('endpoint-main');
      await ranQuery(translatedConfig);

      writeHost({ model: 'cmem-last-served/ghost-final' });
      const warn = spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        expect(hostConfig().model).toBe('endpoint-main');
        const line = warn.mock.calls.map(call => String(call[1])).join('\n');
        expect(line).toContain('endpoint-main');
      } finally {
        warn.mockRestore();
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('opt-out-drops-remembered-model', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'false';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(hostModelConfig);
    const fetchSpy = okFetch();
    try {
      // A successful observer turn on the opted-in path remembers the id.
      await ranQuery(hostConfig());
      writeHost({ model: 'cmem-opt-out/ghost' });
      expect(hostConfig().model).toBe('endpoint-main');

      // With every host opt-in off, the remembered id must not drive the
      // observer: a summary turn would otherwise change its model.
      delete process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST;
      expect(hostConfig().model).toBe(PRESET_MODEL);

      // B4 stays intact: the id is still available once the opt-in returns.
      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
      expect(hostConfig().model).toBe('endpoint-main');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('unmapped-falls-back-to-explicit-first', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(hostModelConfig);
    const fetchSpy = okFetch();
    try {
      await ranQuery(hostConfig());
    } finally {
      fetchSpy.mockRestore();
    }

    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'configured-model';
    writeHost({ model: 'cmem-explicit-first/ghost' });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(hostConfig().model).toBe('configured-model');
      const line = warn.mock.calls.map(call => String(call[1])).join('\n');
      expect(line).toContain('configured-model');
    } finally {
      warn.mockRestore();
    }
  });

  it('unmapped-message-names-the-fallback', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost({ model: 'cmem-fallback-name/ghost' });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(hostConfig().model).toBe(PRESET_MODEL);
      const line = warn.mock.calls
        .map(call => String(call[1]))
        .find(text => text.includes('not declared in the OpenCode provider config')) ?? '';
      expect(line).toContain(PRESET_MODEL);
      expect(line).not.toContain('keeping the configured fallback model');
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Boundaries the fix must NOT cross: a refused id on an endpoint that never
   * had a configured default is still a half-configured endpoint, and so is one
   * whose default an explicit setting removed (PR3's `none` shape). Both keep
   * falling through to Claude; only an actual configured default that was
   * refused sets the internal flag.
   */
  it('refused-id-without-a-configured-default-still-falls-through', async () => {
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://custom.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    resetQuotaCooldownsForTesting();
    writeHost({ model: 'host/bare', provider: { host: { models: { bare: { modelID: 'bare-model' } } } } });

    const config = hostConfig();
    expect(config.model).toBe('bare-model');
    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' },
    }), { status: 403 }));
    try {
      await expect(ranQuery(config)).rejects.toMatchObject({ code: HOST_MODEL_NOT_SERVED_CODE });
    } finally {
      refusal.mockRestore();
    }

    // `custom` has no preset default; `api-route` is an explicit default-less
    // preset (the shape PR3's override setting produces). Neither can be
    // "exhausted by refusals" of a configured model.
    for (const preset of ['custom', 'api-route']) {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = preset;
      const after = hostConfig();
      expect(after.model).toBe('');
      expect(after.allModelsRefused).toBeUndefined();
      expect(isOpenAICompatAvailable()).toBe(false);
      expect(getSelectedProvider()).toBe('claude');
    }
    resetQuotaCooldownsForTesting();
  });

  it('refused-preset-default-is-not-resent', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(presetAsHostConfig);
    const config = hostConfig();
    expect(config.model).toBe(PRESET_MODEL);
    expect(config.hostChosenModels?.[PRESET_MODEL]).toBe('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');

    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' },
    }), { status: 403 }));
    try {
      const failure = await ranQuery(config).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: HOST_MODEL_NOT_SERVED_CODE });
    } finally {
      refusal.mockRestore();
    }

    const after = hostConfig();
    // Every candidate is refused: the empty sentinel keeps query() from
    // sending a request that is doomed to fail again.
    expect(after.model).toBe('');
    const noFetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no request may be sent for the refused preset default');
    });
    try {
      await expect(ranQuery(after)).rejects.toThrow();
      expect(noFetch).not.toHaveBeenCalled();
    } finally {
      noFetch.mockRestore();
    }
  });

  /**
   * Greptile P1 (2026-11-27): when the only candidate left is a preset default
   * the endpoint refused for a host-chosen id, an empty `model` made dispatch
   * pick Claude. That is a silent switch to another paid account (or to a
   * missing Claude credential), not the intended stop. The provider must stay
   * selected and stop before the network with the already-classified refusal.
   */
  it('refused-preset-default-keeps-the-provider-selected-and-stops-before-the-network', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    resetQuotaCooldownsForTesting();
    writeHost(presetAsHostConfig);

    const config = hostConfig();
    expect(config.model).toBe(PRESET_MODEL);
    expect(getSelectedProvider()).toBe('openai-compatible');

    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' },
    }), { status: 403 }));
    const budget = new PaidSendBudget(1);
    try {
      const failure = await ranQuery(config, budget).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: HOST_MODEL_NOT_SERVED_CODE });
      expect(budget.spentPaidSends).toBe(0);
    } finally {
      refusal.mockRestore();
    }

    const after = hostConfig();
    expect(after.model).toBe('');
    expect(getSelectedProvider()).toBe('openai-compatible');
    expect(isOpenAICompatAvailable()).toBe(true);

    const noFetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no request may be sent for the refused preset default');
    });
    try {
      const stopped = await ranQuery(after, budget).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
      expect(noFetch).not.toHaveBeenCalled();
      expect(budget.spentPaidSends).toBe(0);
    } finally {
      noFetch.mockRestore();
      resetQuotaCooldownsForTesting();
    }
  });

  /**
   * Greptile P1: a model-specific 404 on our own id joins the refusal family;
   * the id is remembered, and resolution falls back instead of sending it
   * again on the next generation.
   */
  it('own-404-model-not-found-is-not-resent', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'ghost-404';
    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'model_not_found', type: 'invalid_request_error' },
    }), { status: 404 }));
    try {
      const failure = await ranQuery(resolveOpenAICompatConfig()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: OWN_MODEL_NOT_SERVED_CODE });
    } finally {
      refusal.mockRestore();
    }

    const after = resolveOpenAICompatConfig();
    expect(after.model).toBe(PRESET_MODEL);
    const served = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    try {
      await ranQuery(after);
      const sent = served.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)).model);
      expect(sent).toEqual([PRESET_MODEL]);
      expect(sent).not.toContain('ghost-404');
    } finally {
      served.mockRestore();
    }
  });

  /**
   * Greptile P2: disabling the default is the user's choice, not an endpoint
   * refusal. The worker's diagnosis must not blame the endpoint for it.
   */
  it('none-is-not-a-refusal-in-the-worker', () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = 'none';
    writeHost({});
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const config = hostConfig();
      expect(config.model).toBe('');
      expect(config.allModelsRefused).toBeUndefined();
      const lines = warn.mock.calls.map(call => String(call[1]));
      expect(lines.some(line => line.includes('no model'))).toBe(true);
      expect(lines.some(line => line.includes('refused'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Greptile P1 (wave 2): a preset without a default has no implicit candidate,
   * so dropping a refused explicit id used to leave `allModelsRefused` false.
   * Dispatch then fell through to Claude with an otherwise configured endpoint.
   */
  const refusedExplicitKeepsProvider = async (defaultOverride: string): Promise<void> => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    // `custom` has no preset URL, so the endpoint must be configured by hand.
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://custom.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'ghost-explicit';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = defaultOverride;
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'false';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'false';
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    resetQuotaCooldownsForTesting();

    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' },
    }), { status: 403 }));
    let firstCallCount = 0;
    try {
      const failure = await ranQuery(resolveOpenAICompatConfig()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: OWN_MODEL_NOT_SERVED_CODE });
      firstCallCount = refusal.mock.calls.length;
    } finally {
      refusal.mockRestore();
    }

    const config = resolveOpenAICompatConfig();
    expect(config.model).toBe('');
    expect(config.allModelsRefused).toBe(true);
    expect(isOpenAICompatAvailable()).toBe(true);
    expect(getSelectedProvider()).toBe('openai-compatible');

    const noFetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no request may be sent for a refused explicit model');
    });
    try {
      const stopped = await ranQuery(config).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ kind: 'unrecoverable', code: OWN_MODEL_NOT_SERVED_CODE });
      expect(noFetch).not.toHaveBeenCalled();
      expect(firstCallCount + noFetch.mock.calls.length).toBe(1);
    } finally {
      noFetch.mockRestore();
      resetQuotaCooldownsForTesting();
    }
  };

  /**
   * Greptile P1 (wave 3): `none` is an intentional cost/privacy choice, not a
   * half-configured endpoint. Dispatch must stay on this provider and query()
   * must stop before the socket instead of letting globalPrimary() pick Claude.
   */
  /**
   * Greptile P1 (wave 6, R65): a model-specific 400/422 on a host-chosen id is
   * a permanent refusal of that choice, like 401/403 — not a plain bad request
   * that lets the next generation send the same dead id again.
   */
  const hostStructuredRefusal = async (status: 400 | 422): Promise<void> => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    writeHost(hostModelConfig);
    resetQuotaCooldownsForTesting();
    const body = JSON.stringify({ error: {
      code: 'model_not_found',
      type: 'invalid_request_error',
      message: "The model 'endpoint-main' does not exist",
    } });
    const classified = classifyOpenAICompatError({
      status,
      bodyText: body,
      cause: new Error('x'),
      hostChosenModel: { id: 'endpoint-main', setting: 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' },
    });
    expect(classified.kind).toBe('unrecoverable');
    expect(classified.code).toBe(HOST_MODEL_NOT_SERVED_CODE);
    expect(shouldRotateKey(classified)).toBe(false);

    const config = hostConfig();
    expect(config.hostChosenModels).toHaveProperty('endpoint-main', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');
    const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
      query(h: unknown[], c: unknown): Promise<unknown>;
    };
    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status }));
    try {
      const failure = await provider.query([{ role: 'user', content: 'observe' }], config).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
    } finally {
      refusal.mockRestore();
    }
    // The refused host id is dropped; the preset serves the next turn.
    expect(hostConfig().model).toBe(PRESET_MODEL);
    expect(getQuotaCooldown('openai-compatible')).toBeNull();
    resetQuotaCooldownsForTesting();
  };

  it('host-chosen-structured-400-is-remembered', async () => {
    await hostStructuredRefusal(400);
  });

  it('host-chosen-structured-422-is-remembered', async () => {
    await hostStructuredRefusal(422);
  });

  /**
   * Greptile P1 (wave 5): a structured `model_not_found` must outrank a named
   * error message whose wording breaks the textual regex. A real refusal must
   * not rotate keys or arm an auth cooldown, and the id is remembered.
   */
  it('structured-model-not-found-in-a-named-message-is-a-refusal', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'old-id';
    resetQuotaCooldownsForTesting();
    const body = JSON.stringify({ error: {
      code: 'model_not_found',
      type: 'invalid_request_error',
      message: "The model 'old-id' does not exist",
    } });
    const err = classifyOpenAICompatError({ status: 403, bodyText: body, cause: new Error('x') });
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBe(OWN_MODEL_NOT_SERVED_CODE);
    expect(shouldRotateKey(err)).toBe(false);
    expect(err.action).not.toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');

    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 403 }));
    try {
      const failure = await ranQuery(resolveOpenAICompatConfig()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: OWN_MODEL_NOT_SERVED_CODE });
    } finally {
      refusal.mockRestore();
    }
    // The refused id is dropped and never reintroduced; the preset serves.
    expect(resolveOpenAICompatConfig().model).toBe(PRESET_MODEL);
    expect(getQuotaCooldown('openai-compatible')).toBeNull();
    resetQuotaCooldownsForTesting();
  });

  it('none-default-keeps-the-provider-selected-and-stops', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://custom.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL = 'none';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'false';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = 'false';
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';

    const config = resolveOpenAICompatConfig();
    expect(config.model).toBe('');
    expect(config.defaultDisabled).toBe(true);
    expect(isOpenAICompatAvailable()).toBe(true);
    expect(getSelectedProvider()).toBe('openai-compatible');

    const noFetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no request may be sent for a disabled default');
    });
    try {
      const stopped = await ranQuery(config).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ kind: 'unrecoverable', code: DEFAULT_MODEL_DISABLED_CODE });
      expect((stopped as { action: string }).action).toContain('CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL');
      expect(noFetch).not.toHaveBeenCalled();
    } finally {
      noFetch.mockRestore();
    }
  });

  it('refused-explicit-model-without-preset-default-keeps-provider-selected', async () => {
    await refusedExplicitKeepsProvider('');
  });

  it('none-default-with-explicit-model-refused-keeps-provider-selected', async () => {
    await refusedExplicitKeepsProvider('none');
  });

  /**
   * Greptile P1 (wave 3): a refused explicit id must stop masking the host
   * model. The next resolution follows usable explicit → host → default.
   */
  it('refused-explicit-model-falls-back-to-usable-host', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'refused-explicit';
    writeHost(hostModelConfig);

    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' },
    }), { status: 403 }));
    try {
      const failure = await ranQuery(resolveOpenAICompatConfig()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: OWN_MODEL_NOT_SERVED_CODE });
    } finally {
      refusal.mockRestore();
    }

    const resolved = hostConfig();
    expect(resolved.model).toBe('endpoint-main');
    expect(resolved.hostChosenModels).toHaveProperty('endpoint-main', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');

    const served = okFetch();
    try {
      await ranQuery(resolved);
      const sent = served.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)).model);
      expect(sent).toEqual(['endpoint-main']);
    } finally {
      served.mockRestore();
    }
  });

  it('builtin-identity-goes-on-the-wire', async () => {
    baseEnv();
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST = 'true';
    // The host provider is not declaring this model, but it points at the very
    // endpoint the observer calls: its model key is endpoint-ready.
    writeHost({
      model: 'hy4/hy4-flash-free',
      provider: { hy4: { baseURL: 'https://integrate.api.nvidia.com/v1' } },
    });
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchSpy = okFetch();
    const config = hostConfig();
    try {
      expect(config.model).toBe('hy4-flash-free');
      expect(config.hostChosenModels).toEqual({ 'hy4-flash-free': 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' });
      const identityWarnings = () => warn.mock.calls
        .map(call => String(call[1]))
        .filter(line => line.includes('assuming the model key is endpoint-ready'));
      expect(identityWarnings()).toHaveLength(1);
      // The identity warning is one-shot per id, like the unmapped warning.
      hostConfig();
      expect(identityWarnings()).toHaveLength(1);

      await ranQuery(config);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      expect(JSON.parse(String(init.body)).model).toBe('hy4-flash-free');
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }

    // Composition with T1: a 403 on the identity id is a refusal of the host's
    // choice, so the next turn drops the id instead of arming auth cooldown.
    const refusal = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' },
    }), { status: 403 }));
    try {
      const failure = await ranQuery(config).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: HOST_MODEL_NOT_SERVED_CODE });
      const after = hostConfig();
      expect(after.model).toBe(PRESET_MODEL);
      expect(after.hostChosenModels).toBeUndefined();
    } finally {
      refusal.mockRestore();
    }
  });
});

describe('isOpenAICompatAvailable', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('is available with a NIM preset and a key', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('is unavailable with a NIM preset and no key at all', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it.each(['ollama', 'lmstudio', 'rapidmlx', 'vllm'])('is available for local preset %s with no key, once a model is set', (id) => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = id;
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'qwen3:8b';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it.each(['ollama', 'lmstudio', 'rapidmlx', 'vllm'])('is unavailable for local preset %s with no model — a model is not guessable', (id) => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = id;
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('is unavailable for a bare custom preset', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('selects the provider only when settings name it', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    expect(isOpenAICompatSelected()).toBe(true);
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    expect(isOpenAICompatSelected()).toBe(false);
  });

  it('dispatch picks it when selected and configured', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-test';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    expect(getSelectedProvider()).toBe('openai-compatible');
  });

  it('dispatch falls through to claude when selected but half-configured', () => {
    // The existing silent fall-through: a misconfigured provider must not fail
    // every observation, it must let Claude take over.
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    expect(getSelectedProvider()).toBe('claude');
  });

  /**
   * A `custom` endpoint has no default model, so a host-selected observer id is
   * the only model available. Dispatch must not fall through to Claude when the
   * operator opted into that id — but must stay strictly global-only otherwise.
   */
  const pinBareCustomEndpoint = (gate: string) => {
    process.env.CLAUDE_MEM_PROVIDER = 'openai-compatible';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://custom.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-key';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION = gate;
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
  };

  it('a session model satisfies a bare custom endpoint when the opt-in is on', () => {
    pinBareCustomEndpoint('true');
    expect(isOpenAICompatAvailable(undefined, 'session-model')).toBe(true);
    expect(getSelectedProvider(undefined, 'session-model')).toBe('openai-compatible');
  });

  it('stays unavailable and dispatches to claude without an id, even with the opt-in on', () => {
    pinBareCustomEndpoint('true');
    expect(isOpenAICompatAvailable()).toBe(false);
    expect(isOpenAICompatAvailable(undefined, '   ')).toBe(false);
    expect(getSelectedProvider()).toBe('claude');
  });

  it('ignores a session model and dispatches to claude when the opt-in is off', () => {
    pinBareCustomEndpoint('false');
    expect(isOpenAICompatAvailable(undefined, 'session-model')).toBe(false);
    expect(getSelectedProvider(undefined, 'session-model')).toBe('claude');
  });

  it('still needs the endpoint and a key when a session model is present', () => {
    pinBareCustomEndpoint('true');
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    expect(isOpenAICompatAvailable(undefined, 'session-model')).toBe(false);
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://custom.example.com/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    expect(isOpenAICompatAvailable(undefined, 'session-model')).toBe(false);
  });

  it('a session model keeps a bare custom backup usable during quota fallback (Greptile P1)', () => {
    pinBareCustomEndpoint('true');
    // The held primary is Claude; the backup's only model is the session id.
    process.env.CLAUDE_MEM_PROVIDER = 'claude';
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'openai-compatible';
    recordQuotaExhausted('claude', 'Allowance spent');
    try {
      expect(getSelectedProvider(undefined, 'session-model')).toBe('openai-compatible');
      expect(getSelectedProvider()).toBe('claude');
    } finally {
      resetQuotaCooldownsForTesting();
    }
  });
});

/**
 * The settings API validates CLAUDE_MEM_PROVIDER against a hardcoded list, and
 * the viewer POSTs the WHOLE settings object on every save (see
 * src/ui/viewer/hooks/useSettings.ts). A provider id missing from that list
 * therefore does not merely hide the option — it 400s every subsequent save
 * from the settings modal, including saves of unrelated fields. Adding a
 * provider id without adding it here is the regression these tests catch.
 */
describe('settings API provider validation', () => {
  const validate = (provider: string): { valid: boolean; error?: string } =>
    (new SettingsRoutes({} as never) as unknown as {
      validateSettings(settings: unknown): { valid: boolean; error?: string };
    }).validateSettings({ CLAUDE_MEM_PROVIDER: provider });

  it('accepts every provider id dispatch can select', () => {
    for (const provider of ['claude', 'gemini', 'openrouter', 'openai-compatible']) {
      expect(validate(provider).valid).toBe(true);
    }
  });

  it('still rejects an unknown provider id, and names openai-compatible when it does', () => {
    const result = validate('not-a-provider');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('openai-compatible');
  });
});

describe('classifyOpenAICompatError', () => {
  it('separates a spent allowance from a per-minute throttle on the same 429', () => {
    const throttle = classifyOpenAICompatError({ status: 429, bodyText: 'Too many requests', cause: new Error('x') });
    expect(throttle.kind).toBe('rate_limit');

    const spent = classifyOpenAICompatError({ status: 429, bodyText: 'insufficient_quota', cause: new Error('x') });
    expect(spent.kind).toBe('quota_exhausted');
  });

  it('honors Retry-After on a rate limit', () => {
    const err = classifyOpenAICompatError({
      status: 429,
      bodyText: 'slow down',
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '12' : null) },
      cause: new Error('x'),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('treats 402 as quota regardless of body', () => {
    expect(classifyOpenAICompatError({ status: 402, bodyText: '', cause: new Error('x') }).kind)
      .toBe('quota_exhausted');
  });

  it('classifies auth failures and names the setting to fix', () => {
    for (const status of [401, 403]) {
      const err = classifyOpenAICompatError({ status, bodyText: 'unauthorized', cause: new Error('x') });
      expect(err.kind).toBe('auth_invalid');
      expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
    }
  });

  /**
   * A 401/403 on an id the host chose is the endpoint refusing that choice,
   * not a bad key. It must not take the auth_invalid path: that would arm a
   * long credential cooldown and tell the user to rotate a working key.
   */
  const hostChosen = { id: 'endpoint-main', setting: 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' } as const;
  const hostNotServedAssertions = (err: ReturnType<typeof classifyOpenAICompatError>): void => {
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBe(HOST_MODEL_NOT_SERVED_CODE);
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');
    expect(err.action).toContain('endpoint-main');
    expect(err.action).not.toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
  };

  it('host-chosen-403-is-not-auth-invalid', () => {
    hostNotServedAssertions(classifyOpenAICompatError({
      status: 403,
      bodyText: 'Model access is disabled',
      cause: new Error('x'),
      hostChosenModel: hostChosen,
    }));
  });

  it('host-chosen-401-is-not-auth-invalid', () => {
    hostNotServedAssertions(classifyOpenAICompatError({
      status: 401,
      bodyText: 'Model access is disabled',
      cause: new Error('x'),
      hostChosenModel: hostChosen,
    }));
  });

  it('host-401-invalid-key-stays-auth-invalid', () => {
    // A credential failure is not proof that the endpoint refuses the id: the
    // pool must rotate to the next healthy key, not retire a valid model.
    const err = classifyOpenAICompatError({
      status: 401,
      bodyText: '{"error":{"message":"invalid API key"}}',
      cause: new Error('x'),
      hostChosenModel: hostChosen,
    });
    expect(err.kind).toBe('auth_invalid');
    expect(err.code).toBeUndefined();
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
    expect(shouldRotateKey(err)).toBe(true);

    // C1 stays intact: a 403 that names the model as disabled is a refusal of
    // the host's choice, with no credential cooldown and no rotation.
    hostNotServedAssertions(classifyOpenAICompatError({
      status: 403,
      bodyText: '{"error":{"message":"Model access is disabled"}}',
      cause: new Error('x'),
      hostChosenModel: hostChosen,
    }));
  });

  it('plain-401-403-stay-auth-invalid', () => {
    // Credential wording stays auth_invalid on both statuses. A model-refusal
    // wording on 403 is now the own-model case below, not a bad key; 401 with
    // that wording is still auth_invalid (the own-model branch needs 400/403/422).
    for (const status of [401, 403] as const) {
      const err = classifyOpenAICompatError({ status, bodyText: 'invalid API key', cause: new Error('x') });
      expect(err.kind).toBe('auth_invalid');
      expect(err.code).toBeUndefined();
      expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
    }
  });

  it('host-chosen-404-keeps-code', () => {
    const err = classifyOpenAICompatError({
      status: 404,
      bodyText: 'model not found',
      cause: new Error('x'),
      hostChosenModel: hostChosen,
    });
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBe(HOST_MODEL_NOT_SERVED_CODE);
    expect(err.action).toBe('The endpoint answered 404 for "endpoint-main", the model the host\'s OpenCode config names, which CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST reads. The observer stops using that id and goes back to the configured model. To use it, serve it on CLAUDE_MEM_OPENAI_COMPAT_BASE_URL and restart the worker; otherwise set CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST to false.');
  });

  it('plain-404-route-stays-plain', () => {
    // A missing route names no model, so it stays on the old base-URL answer.
    const err = classifyOpenAICompatError({ status: 404, bodyText: 'route not found', cause: new Error('x') });
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBeUndefined();
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_BASE_URL');
  });

  it('classifies 400/422 as unrecoverable and 5xx as transient', () => {
    expect(classifyOpenAICompatError({ status: 400, cause: new Error('x') }).kind).toBe('unrecoverable');
    expect(classifyOpenAICompatError({ status: 422, cause: new Error('x') }).kind).toBe('unrecoverable');
    expect(classifyOpenAICompatError({ status: 500, cause: new Error('x') }).kind).toBe('transient');
    expect(classifyOpenAICompatError({ status: 503, cause: new Error('x') }).kind).toBe('transient');
  });

  it('treats a request that never completed as transient', () => {
    const err = classifyOpenAICompatError({ cause: new Error('ECONNREFUSED') });
    expect(err.kind).toBe('transient');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('carries the endpoint label into the message, so logs name the endpoint', () => {
    const err = classifyOpenAICompatError({
      status: 500,
      bodyText: 'boom',
      cause: new Error('x'),
      endpointLabel: 'NVIDIA NIM (build.nvidia.com)',
    });
    expect(err.message).toContain('NVIDIA NIM');
  });
});

describe('a refused own model id is not an auth failure', () => {
  const classify = (status: number, body: string) =>
    classifyOpenAICompatError({ status, bodyText: body, cause: new Error('x') });

  it('classifies the live Go 403 as an unserved own model', () => {
    const err = classify(403, '{"error":{"message":"Model access is disabled"}}');
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBe(OWN_MODEL_NOT_SERVED_CODE);
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL');
    expect(err.action).not.toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
  });

  it('own-404-model-not-found-is-remembered', () => {
    const err = classify(404, '{"error":{"message":"model_not_found"}}');
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBe(OWN_MODEL_NOT_SERVED_CODE);
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL');
    expect(err.action).not.toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
    expect(shouldRotateKey(err)).toBe(false);
    expect(classify(404, 'The model `ghost` does not exist').code).toBe(OWN_MODEL_NOT_SERVED_CODE);
  });

  it('credential-words-still-win-over-a-structured-model-code', () => {
    // The structured code must not hide a real credential failure: the pool
    // keeps rotating and the auth path stays intact.
    for (const credential of ['invalid API key', 'unauthorized', 'billing', 'credit', 'quota']) {
      const body = JSON.stringify({ error: {
        code: 'model_not_found',
        message: `The model 'old-id' does not exist; ${credential}`,
      } });
      const err = classifyOpenAICompatError({ status: 403, bodyText: body, cause: new Error('x') });
      expect(err.kind).toBe('auth_invalid');
      expect(err.code).toBeUndefined();
      expect(shouldRotateKey(err)).toBe(true);
    }
  });

  it('host-chosen-400-422-credential-wording-keeps-the-old-path', () => {
    // R69: on the 400/422 branch opened by wave 6, C1 means "not a permanent
    // host refusal". A 400/422 with credential wording already classified as
    // unrecoverable before that wave; making it auth_invalid would be new
    // behaviour outside the two findings. Only the guard is pinned here.
    for (const status of [400, 422] as const) {
      const body = JSON.stringify({ error: {
        code: 'model_not_found',
        message: "The model 'old-id' does not exist; invalid API key",
      } });
      const err = classifyOpenAICompatError({
        status,
        bodyText: body,
        cause: new Error('x'),
        hostChosenModel: { id: 'old-id', setting: 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' },
      });
      expect(err.kind).toBe('unrecoverable');
      expect(err.code).not.toBe(HOST_MODEL_NOT_SERVED_CODE);
      expect(shouldRotateKey(err)).toBe(false);
    }
  });

  it('plain-404-route-stays-a-plain-404', () => {
    // No model designation, structured or textual: the old base-URL answer.
    const err = classify(404, JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }));
    expect(err.kind).toBe('unrecoverable');
    expect(err.code).toBeUndefined();
    expect(err.action).toContain('CLAUDE_MEM_OPENAI_COMPAT_BASE_URL');
    expect(shouldRotateKey(err)).toBe(false);
  });

  it('leaves a host-chosen refusal to PR2', () => {
    const err = classifyOpenAICompatError({
      status: 403, bodyText: 'model access is disabled', cause: new Error('x'),
      hostChosenModel: { id: 'endpoint-main', setting: 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' },
    });
    expect(err.code).toBe(HOST_MODEL_NOT_SERVED_CODE);
  });

  it('keeps the existing classifications for mixed credential, billing and 401 bodies', () => {
    expect(classify(403, '{"error":{"message":"Key revoked; see billing portal"}}').kind).toBe('auth_invalid');
    expect(classify(403, 'Model access is disabled: API key revoked').kind).toBe('auth_invalid');
    expect(classify(403, 'Model access is disabled; update your billing details').kind).toBe('auth_invalid');
    expect(classify(401, 'model access is disabled').kind).toBe('auth_invalid');
    expect(classify(400, 'credit limit reached').kind).toBe('quota_exhausted');
    expect(classify(400, 'some bad request').kind).toBe('unrecoverable');
  });
});

/**
 * Wave 3 gate R4-2: Groq and OpenAI end a per-minute throttle with a link to
 * their billing page. The loose "billing" marker read those as a spent
 * allowance, which parks the key for 30 minutes and arms the provider breaker
 * over a limit that clears in seconds.
 */
describe('a throttle that links to a billing page stays a rate limit', () => {
  const headers = (retryAfter: string) => ({ get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) });
  const groqTpm = JSON.stringify({ error: {
    message: 'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 11679, Requested 1462. Please try again in 5.705s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
    type: 'tokens', code: 'rate_limit_exceeded',
  } });
  const openaiRpm = JSON.stringify({ error: {
    message: 'Rate limit reached for gpt-4o-mini in organization org-abc on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.',
    type: 'requests', param: null, code: 'rate_limit_exceeded',
  } });

  it('reads Groq and OpenAI per-minute throttles as rate limits, with their Retry-After', () => {
    const groq = classifyOpenAICompatError({ status: 429, bodyText: groqTpm, headers: headers('6'), cause: new Error('x') });
    expect(groq.kind).toBe('rate_limit');
    expect(groq.retryAfterMs).toBe(6_000);

    const openai = classifyOpenAICompatError({ status: 429, bodyText: openaiRpm, headers: headers('20'), cause: new Error('x') });
    expect(openai.kind).toBe('rate_limit');
    expect(openai.retryAfterMs).toBe(20_000);
  });

  it('still reads a spent allowance as quota, on a 429 too', () => {
    const openaiQuota = JSON.stringify({ error: {
      message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota', param: null, code: 'insufficient_quota',
    } });
    expect(classifyOpenAICompatError({ status: 429, bodyText: openaiQuota, cause: new Error('x') }).kind).toBe('quota_exhausted');
  });

  it('keeps reading a billing refusal that is not a throttle as quota', () => {
    const hardLimit = JSON.stringify({ error: { message: 'Billing hard limit has been reached', type: 'invalid_request_error', code: 'billing_hard_limit_reached' } });
    expect(classifyOpenAICompatError({ status: 400, bodyText: hardLimit, cause: new Error('x') }).kind).toBe('quota_exhausted');
  });
});

/**
 * Several OpenAI-compatible gateways report a throttle in a 200 body rather
 * than a 429 — the shape #3263 hit through OpenRouter. A status-only
 * classifier calls that `unrecoverable`, which neither retries nor rotates the
 * key, so the pool never moves off a key that is merely throttled.
 */
describe('structured error envelopes outrank the transport status', () => {
  const classify = (body: unknown, status = 200) =>
    classifyOpenAICompatError({ status, bodyText: JSON.stringify(body), cause: new Error('x') });

  it('maps a rate-limit code in a 200 body to rate_limit', () => {
    expect(classify({ error: { message: 'slow down', code: 'rate_limited' } }).kind).toBe('rate_limit');
    expect(classify({ error: { message: 'slow down', type: 'rate_limit_error' } }).kind).toBe('rate_limit');
    expect(classify({ error: { code: 'rate_limit_exceeded' } }).kind).toBe('rate_limit');
  });

  it('lets quota markers keep winning over a rate-limit reading', () => {
    expect(classify({ error: { code: 'insufficient_quota' } }).kind).toBe('quota_exhausted');
  });

  it('does not turn an unknown structured failure into a rate limit', () => {
    expect(classify({ error: { code: 'weird_thing', message: 'boom' } }).kind).toBe('unrecoverable');
  });

  it('survives a body that is not JSON at all', () => {
    expect(classifyOpenAICompatError({ status: 500, bodyText: '<html>502</html>', cause: new Error('x') }).kind)
      .toBe('transient');
  });


});

/**
 * A preset bundles two separate facts — where to send the request, and whether
 * that place wants a bearer token. CLAUDE_MEM_OPENAI_COMPAT_BASE_URL replaces
 * the first, so keeping the second breaks in both directions: a keyless local
 * override gets refused for want of a key it does not need, and a hosted
 * override reports itself ready and then 401s on every observation.
 */
describe('auth policy follows the endpoint actually configured', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('reads loopback, LAN and .local hosts as keyless-capable', () => {
    for (const url of [
      'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8000/v1',
      'http://192.168.1.50:8000/v1', 'http://10.0.0.4:8000/v1', 'http://172.16.5.5:8000/v1',
      'http://box.local:8000/v1',
    ]) expect(isLocalEndpointUrl(url)).toBe(true);
  });

  it('treats a remote host as needing a key, and a malformed URL as remote', () => {
    for (const url of [
      'https://api.groq.com/openai/v1', 'https://integrate.api.nvidia.com/v1',
      'https://localhost.evil.com/v1', 'not a url',
    ]) expect(isLocalEndpointUrl(url)).toBe(false);
  });

  it('runs a keyless local override even when the preset is a hosted one', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'http://localhost:11434/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'llama3';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('refuses a hosted override with no key instead of 401ing every observation', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'ollama';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'x';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = '';
    expect(isOpenAICompatAvailable()).toBe(false);
  });
});

/**
 * The superclass hands `query()` the field-compression deadline. Dropping it
 * means the request outlives the budget that cancelled it and keeps retrying
 * in the background — the same wiring `field-deadline-wire.test.ts` pins for
 * OpenRouter.
 */
describe('field-deadline cancellation reaches the socket', () => {
  it('accepts the signal, aborts in flight, and starts no retries', async () => {
    let requests = 0;
    const server = createServer((req) => { requests++; /* never answer */ void req; });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const provider = new OpenAICompatProvider({} as never, {} as never);
      const controller = new AbortController();
      const config = {
        apiKey: 'fixture-not-a-secret',
        apiKeys: ['fixture-not-a-secret'],
        model: 'fixture',
        apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
        preset: resolveOpenAICompatPreset('custom'),
        requiresApiKey: false,
      };
      const requested = new Promise<void>(resolve => server.once('request', () => resolve()));
      const pending = (provider as unknown as {
        query(h: unknown[], c: unknown, s?: AbortSignal): Promise<unknown>;
      }).query([{ role: 'user', content: 'hi' }], config, controller.signal).catch((e: Error) => e);

      await requested;
      controller.abort();
      await pending;

      expect(controller.signal.aborted).toBe(true);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 5000);
});

/**
 * The quota scan matches loose body words, "billing" among them, and a 401/403
 * very often explains itself in billing terms. Reading that as a spent
 * allowance retires the key for 30 minutes and can arm the provider breaker,
 * when the actual fix is a new key — so status has to win for auth failures.
 */
describe('auth failures are not mistaken for spent quota', () => {
  const kind = (status: number, body: string) =>
    classifyOpenAICompatError({ status, bodyText: body, cause: new Error('x') }).kind;

  it('classifies a 401/403 as auth even when the body talks about billing', () => {
    expect(kind(401, '{"error":{"message":"Invalid API key. Update your billing details."}}')).toBe('auth_invalid');
    expect(kind(403, '{"error":{"message":"Key revoked; see billing portal"}}')).toBe('auth_invalid');
    expect(kind(401, '{"error":{"message":"out of credits"}}')).toBe('auth_invalid');
  });

  it('reads a credit-limit marker as spent quota', () => {
    expect(kind(429, 'credit limit reached')).toBe('quota_exhausted');
  });


});

/**
 * Main's observer contract, which this provider shares with OpenRouter: the
 * system anchor and turn normalization (#3868, #3491), text-only answers
 * (#4017), and the configurable output cap (#3868) with the
 * max_completion_tokens retry (#4003).
 */
describe('openai-compatible requests follow the shared observer contract', () => {
  const CONFIG = {
    apiKey: 'fixture-not-a-secret',
    apiKeys: ['fixture-not-a-secret'],
    model: 'fixture/model',
    apiUrl: 'https://compat.example.test/v1/chat/completions',
    preset: resolveOpenAICompatPreset('custom'),
    requiresApiKey: true,
  };
  let settingsOverrides: Record<string, string> = {};
  let spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    settingsOverrides = {};
    spies = [spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...settingsOverrides,
    }))];
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const spy of spies) spy.mockRestore();
  });

  const query = (history: ConversationMessage[]) =>
    (new OpenAICompatProvider({} as never, {} as never) as unknown as {
      query(h: ConversationMessage[], c: unknown): Promise<{ content: string; finishReason?: string }>;
    }).query(history, CONFIG);

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const sentBodies = (fetchSpy: { mock: { calls: unknown[][] } }) =>
    fetchSpy.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));

  it('sends no empty turn, no doubled role and no leading assistant turn', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    await query([
      { role: 'assistant', content: 'stray' },
      { role: 'user', content: 'init request' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'observation 1' },
    ]);

    expect(sentBodies(fetchSpy)[0].messages).toEqual([
      { role: 'user', content: 'init request\n\nobservation 1' },
    ]);
  });

  it('anchors a generation framing prompt as the system message', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    await query([{
      role: 'user',
      content: 'Instructions here.\n\n<observed_from_primary_session>\n<user_request>fix it</user_request>\n</observed_from_primary_session>',
      framing: true,
    }]);

    const [system, user] = sentBodies(fetchSpy)[0].messages;
    expect(system.role).toBe('system');
    expect(user.role).toBe('user');
    expect(user.content).toContain('<user_request>fix it</user_request>');
  });

  it('reads text blocks from a content array, never reasoning', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: '<observation>one</observation>' },
        { type: 'text', text: '<observation>two</observation>' },
      ] }, finish_reason: 'stop' }],
    })));

    const result = await query([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('<observation>one</observation>\n<observation>two</observation>');
    expect(result.finishReason).toBe('stop');
  });

  it('returns no text, not an object, when content is neither a string nor text blocks', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: { unexpected: true } } }],
    })));
    spies.push(spyOn(logger, 'error').mockImplementation(() => {}));

    const result = await query([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('');
  });

  it('sends CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS as the output cap in a plain, streamed body', async () => {
    settingsOverrides.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '9000';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    await query([{ role: 'user', content: 'hi' }]);

    const [body] = sentBodies(fetchSpy);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'reasoning', 'stream', 'stream_options', 'temperature']);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(9000);
  });

  it('resends max_completion_tokens when the model only takes that (#4003)', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ error: {
        message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter',
      } }, 400))
      .mockResolvedValueOnce(reply({ choices: [{ message: { content: 'ok' } }] }));
    spies.push(fetchSpy);

    const result = await query([{ role: 'user', content: 'hi' }]);

    const [first, second] = sentBodies(fetchSpy);
    expect(first.max_tokens).toBe(4096);
    expect(second.max_tokens).toBeUndefined();
    expect(second.max_completion_tokens).toBe(4096);
    expect(result.content).toBe('ok');
  });

  const compressField = (signal = new AbortController().signal) =>
    (new OpenAICompatProvider({} as never, {} as never) as unknown as {
      compressField(t: string, b: number, c: unknown, s: AbortSignal): Promise<{ text: string; truncated: boolean } | null>;
    }).compressField('a large payload', 1000, CONFIG, signal);

  it('reports a condense reply cut at max_tokens as truncated', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: 'the first half of a summ' }, finish_reason: 'length' }],
    })));
    spies.push(spyOn(logger, 'warn').mockImplementation(() => {}));

    expect(await compressField()).toEqual({ text: 'the first half of a summ', truncated: true });
  });

  it('reports a condense reply that stopped on its own as complete', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: 'a whole summary' }, finish_reason: 'stop' }],
    })));

    expect(await compressField()).toEqual({ text: 'a whole summary', truncated: false });
  });

  it('does not start field compression after observer capture is disabled', async () => {
    settingsOverrides.CLAUDE_MEM_OBSERVER_ENABLED = 'false';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply({
      choices: [{ message: { content: 'must not be requested' } }],
    }));
    spies.push(fetchSpy);

    expect(await compressField()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds the condense budget by CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS', () => {
    settingsOverrides.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '3200';
    const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
      fieldCompressionMaxOutputTokens(): number | undefined;
    };
    expect(provider.fieldCompressionMaxOutputTokens()).toBe(3200);
  });

  /**
   * Greptile P1 (wave 7, #4719718387): the reasoning-off retry runs outside
   * withRetry, and its catch used to swallow a classified model refusal. The
   * refused id then reached the next turn and earned another refusal. A model
   * refusal must travel to query()'s one remembering catch; every other class
   * stays logged and swallowed, as it was before.
   */
  describe('wave 7: reasoning-off retry refusals reach the one stop path', () => {
    const TRUNCATED = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    const SUCCESS = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
    const refusedEnvelope = (id: string) => ({
      code: 'model_not_found',
      type: 'invalid_request_error',
      message: `The model '${id}' does not exist`,
    });
    const hostConfig = {
      ...CONFIG,
      model: 'host/host-chosen',
      hostChosenModels: { 'host/host-chosen': 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST' as const },
    };
    const ownConfig = { ...CONFIG, model: 'own/stale-id' };

    beforeEach(() => {
      // Reasoning on makes the first request retryable with reasoning forced
      // off; a stale rejection of that wire field would skip the retry entirely.
      settingsOverrides.CLAUDE_MEM_OPENAI_COMPAT_REASONING = 'on';
      resetReasoningFieldRejectionsForTesting();
      resetStreamingEndpointMemoryForTests();
      resetQuotaCooldownsForTesting();
    });

    afterEach(() => {
      resetReasoningFieldRejectionsForTesting();
      resetStreamingEndpointMemoryForTests();
      resetQuotaCooldownsForTesting();
    });

    const runQuery = (config: typeof CONFIG, signal?: AbortSignal, budget?: PaidSendBudget) =>
      (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(
          h: ConversationMessage[],
          c: unknown,
          s?: AbortSignal,
          timeout?: number,
          paidSendBudget?: PaidSendBudget,
        ): Promise<{ content: string; finishReason?: string }>;
      }).query([{ role: 'user', content: 'observe' }], config, signal, undefined, budget);

    /** First reply is truncated, the retry is the refusal, later sends are a hard failure. */
    const refusalFetch = (id: string, status: number) => {
      let calls = 0;
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return reply(TRUNCATED);
        if (calls === 2) return reply({ error: refusedEnvelope(id) }, status);
        throw new Error('a refused id was sent again');
      });
      spies.push(fetchSpy, spyOn(logger, 'error').mockImplementation(() => {}), spyOn(logger, 'warn').mockImplementation(() => {}));
      return fetchSpy;
    };

    it('reasoning-off-retry-host-refusal-is-remembered', async () => {
      const fetchSpy = refusalFetch('host/host-chosen', 400);

      const failure = await runQuery(hostConfig).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
      expect(shouldRotateKey(failure)).toBe(false);
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [first, second] = sentBodies(fetchSpy);
      expect(first.reasoning).toBeUndefined();
      expect(second.reasoning).toEqual({ enabled: false });

      // The single refusal record now holds the id: the next turn stops before
      // the socket instead of paying to earn the same refusal again.
      const stopped = await runQuery(hostConfig).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: HOST_MODEL_NOT_SERVED_CODE });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('reasoning-off-retry-own-refusal-is-remembered', async () => {
      const fetchSpy = refusalFetch('own/stale-id', 422);

      const failure = await runQuery(ownConfig).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'unrecoverable', code: OWN_MODEL_NOT_SERVED_CODE });
      expect(shouldRotateKey(failure)).toBe(false);
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const stopped = await runQuery(ownConfig).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: OWN_MODEL_NOT_SERVED_CODE });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    /** Quota, throttle and context classes still end at the catch's log line. */
    it.each([
      ['quota', 402, { code: 'insufficient_quota', message: 'You exceeded your current quota' }, 'quota_exhausted'],
      ['rate-limit', 429, { code: 'rate_limit_error', message: 'Too many requests' }, 'rate_limit'],
      ['413', 413, { code: 'context_length_exceeded', message: 'Request entity too large' }, 'context_overflow'],
    ])('retry %s stays swallowed and unremembered', async (_name, status, error, expectedKind) => {
      const body = JSON.stringify({ error });
      expect(classifyOpenAICompatError({ status, bodyText: body, cause: new Error('x') }).kind).toBe(expectedKind);
      let calls = 0;
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return reply(TRUNCATED);
        if (calls === 2) return reply({ error }, status);
        return reply(SUCCESS);
      });
      spies.push(fetchSpy, spyOn(logger, 'error').mockImplementation(() => {}));

      await expect(runQuery(ownConfig)).resolves.toMatchObject({ content: '', finishReason: 'length' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // No pre-send stop on the next turn: this class was not recorded.
      await expect(runQuery(ownConfig)).resolves.toMatchObject({ content: 'ok' });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('abort still wins as the first gesture of the retry catch', async () => {
      const controller = new AbortController();
      const removeSpy = spyOn(controller.signal, 'removeEventListener');
      spies.push(removeSpy);
      let calls = 0;
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return reply(TRUNCATED);
        controller.abort();
        return reply({ error: refusedEnvelope('host/host-chosen') }, 400);
      });
      spies.push(fetchSpy, spyOn(logger, 'error').mockImplementation(() => {}));

      const failure = await runQuery(hostConfig, controller.signal).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: 'AbortError' });
      expect(failure).not.toMatchObject({ code: HOST_MODEL_NOT_SERVED_CODE });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('a refusal still spends one retry against the batch budget and finishes the deadline', async () => {
      // Only a non-streamed request owns a reasoning-retry deadline; a streamed
      // one uses the stream's own liveness and has no timer to finish.
      markEndpointRefusesStreamingForTests(CONFIG.apiUrl);
      const controller = new AbortController();
      const removeSpy = spyOn(controller.signal, 'removeEventListener');
      spies.push(removeSpy);
      const budget = new PaidSendBudget(1);
      const fetchSpy = refusalFetch('own/stale-id', 400);

      const failure = await runQuery(ownConfig, controller.signal, budget).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: OWN_MODEL_NOT_SERVED_CODE });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // One initial send plus the one claimed reasoning retry; no replay.
      expect(budget.spentPaidSends).toBe(2);
      // withRetry removes its own listener, and the retry's finally finishes
      // the deadline: two removals, so a thrown refusal still reaches finally.
      expect(removeSpy.mock.calls.filter(call => call[0] === 'abort').length).toBe(2);
    });
  });
});

/** #3263's lesson, applied here: a 200 envelope carries the status that matters. */
describe('200 error envelopes are classified by what they report', () => {
  const classify = (error: Record<string, unknown>) =>
    classifyOpenAICompatError({ status: 200, bodyText: JSON.stringify({ error }), cause: new Error('x') });

  it('reads a numeric error.code as the effective status', () => {
    expect(classify({ code: 429, message: 'Too many requests' }).kind).toBe('rate_limit');
    expect(classify({ code: 503, message: 'upstream unavailable' }).kind).toBe('transient');
    expect(classify({ code: '502', message: 'bad gateway' }).kind).toBe('transient');
    expect(classify({ code: 401, message: 'bad key' }).kind).toBe('auth_invalid');
  });

  // #5185: OmniRoute answers a failed stream with a textual code and names the
  // status only in the message. That 503 must pause and fall back, not end the session.
  it('reads an (HTTP NNN) status from the message when error.code is not numeric', () => {
    expect(classify({
      code: 'bad_gateway',
      type: 'server_error',
      message: 'cfp/some-model: provider — [503]: Service temporarily unavailable (HTTP 503)',
    }).kind).toBe('transient');
    expect(classify({ code: 'rate_limited_upstream', message: 'slow down (HTTP 429)' }).kind).toBe('rate_limit');
    expect(classify({ code: 'weird', message: 'odd (HTTP 200)' }).kind).toBe('unrecoverable');
    expect(classify({ code: 'weird', message: 'no status here' }).kind).toBe('unrecoverable');
    // An upstream's auth failure named in a combo message is not this request's status.
    expect(classify({ code: 'bad_gateway', message: 'unc/model: auth (HTTP 401)' }).kind).toBe('unrecoverable');
  });

  // A combo gateway lists every upstream's failure; the order is not fixed.
  it('reads every (HTTP NNN) marker in a combo message, not only the first', () => {
    expect(classify({
      code: 'bad_gateway',
      message: 'unc/model: auth (HTTP 401); cfp/model: Service temporarily unavailable (HTTP 503)',
    }).kind).toBe('transient');
    expect(classify({
      code: 'bad_gateway',
      message: 'unc/model: auth (HTTP 401); cfp/model: slow down (HTTP 429)',
    }).kind).toBe('rate_limit');
  });

  it('reads a textual server-failure code or type as its status when the message names none', () => {
    expect(classify({ code: 'bad_gateway', message: 'no status here' }).kind).toBe('transient');
    expect(classify({ code: 'service_unavailable', message: 'try later' }).kind).toBe('transient');
    expect(classify({ code: 'gateway_timeout', message: 'upstream timed out' }).kind).toBe('transient');
    expect(classify({ code: 'upstream_failed', type: 'server_error', message: 'all upstreams failed' }).kind).toBe('transient');
  });

  // Never pay twice: a litellm output failure stays an output failure even
  // under a server-failure code, because the model already ran and was billed.
  it('keeps a litellm output failure under a textual server-failure code unretried', () => {
    const err = classify({ code: 'bad_gateway', type: 'server_error', message: 'Unable to get json response - Expecting value (HTTP 502)' });
    expect(err.kind).toBe('unrecoverable');
    expect(err.paidSendOutcome).toBe('output_failure');
  });

  // Never pay twice (Phase 1): the model ran and was billed; only its output
  // was lost, so a resend would pay for the same work again. It used to be
  // classified transient and retried.
  it('treats a litellm parse failure as an output failure, never retried', () => {
    const err = classify({ code: 200, message: 'Unable to get json response - Expecting value: line 45 column 1' });
    expect(err.kind).toBe('unrecoverable');
    expect(err.paidSendOutcome).toBe('output_failure');
    expect(err.message).toContain('Unable to get json response');
  });

  it('keeps an unrelated 200 envelope unrecoverable', () => {
    expect(classify({ code: 200, message: 'something else' }).kind).toBe('unrecoverable');
  });
});

/**
 * #4276's key lock covers every provider: an account-owned cm_pro_ key never
 * leaves for a third-party endpoint, and the gateway never gets another key.
 */
describe('openai-compatible keys go through the cmem key lock', () => {
  const LOCK_ENV_KEYS = [...ENV_KEYS, 'CMEM_PRO_ORIGIN'];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of LOCK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'm';
  });

  afterEach(() => {
    resetRefusedHostModelsForTesting();
    resetServedModelsForTesting();
    for (const key of LOCK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('withholds a cm_pro_ key from a third-party endpoint', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'cm_pro_0123456789abcdef01234567';

    const config = resolveOpenAICompatConfig();
    expect(config.apiKey).toBe('');
    expect(config.apiKeys).toEqual([]);
    expect(isOpenAICompatAvailable()).toBe(false);
  });

  it('drops a cm_pro_ key pasted into the rotation list and keeps the endpoint keys', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'nvidia-nim';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = 'cm_pro_0123456789abcdef01234567, nvapi-2';

    expect(resolveOpenAICompatConfig().apiKeys).toEqual(['nvapi-1', 'nvapi-2']);
  });

  it('never sends a personal key to the cmem gateway', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'custom';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://cmem.ai/api/inference/v1';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'nvapi-personal';

    expect(resolveOpenAICompatConfig().apiKeys).toEqual([]);
    expect(isOpenAICompatAvailable()).toBe(false);
  });
});

/** The wrap-up runs on the provider the session observed with (SessionRoutes). */
describe('Telegram wrap-ups on the openai-compatible provider', () => {
  const input = {
    sessionDbId: 7,
    contentSessionId: 'content-7',
    project: 'p',
    platformSource: 'claude',
    summaryText: 'request\ncompleted',
  };

  it('SessionRoutes formats an openai-compatible session with the openai-compatible agent', async () => {
    let formatter: ((value: typeof input) => Promise<string>) | undefined;
    const sessionManager = {
      setTelegramWrapupFormatter: (fn: typeof formatter) => { formatter = fn; },
      getSession: () => ({ currentProvider: 'openai-compatible', lastModelId: 'local-model' }),
    };
    const otherAgent = { formatTelegramWrapup: async () => { throw new Error('wrong agent'); } };
    const compatAgent = { formatTelegramWrapup: mock(async () => '• Finished') };

    new SessionRoutes(
      sessionManager as never, {} as never, otherAgent as never, otherAgent as never, otherAgent as never,
      {} as never, {} as never, {} as never, otherAgent as never, compatAgent as never,
    );

    await expect(formatter!(input)).resolves.toBe('• Finished');
    expect(compatAgent.formatTelegramWrapup).toHaveBeenCalledWith(input, 'local-model');
  });

  it('formats a wrap-up on a keyless local endpoint', async () => {
    const provider = new OpenAICompatProvider({} as never, {} as never);
    const config = {
      apiKey: '', apiKeys: [], model: 'llama3', requiresApiKey: false,
      apiUrl: 'http://localhost:11434/v1/chat/completions', preset: resolveOpenAICompatPreset('ollama'),
    };
    const spies = [
      spyOn(provider as never, 'getConfig').mockReturnValue(config as never),
      spyOn(provider as never, 'query').mockResolvedValue({ content: '• Finished' } as never),
    ];
    try {
      await expect(provider.formatTelegramWrapup(input as never)).resolves.toBe('• Finished');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
