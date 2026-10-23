// SPDX-License-Identifier: Apache-2.0
//
// Built-in agent descriptors (plan Phase 8 task 7, Appendix A). Each key was
// checked against magpie's adapter that writes it (internal/agent/*.go at
// e297a8ab2, MIT, Copyright (c) 2026 yetone) and, where the plan marked it
// "verify", against the agent's own source:
//
//   claude-code  env.ANTHROPIC_BASE_URL (magpie claude.go:1094-1100)
//   codex        openai_base_url (codex config_toml.rs:430, "Base URL override for the
//                built-in openai provider"; magpie codex.go:972-984) or the active
//                [model_providers.<id>].base_url (magpie import_codex.go:17-86)
//   gemini-cli   ~/.gemini/.env GOOGLE_GEMINI_BASE_URL (magpie gemini.go:96-101;
//                gemini-cli contentGenerator.ts:347-356)
//   opencode     provider.<id>.options.baseURL (opencode provider.ts:1810-1831)
//   crush        providers.<id>.base_url (magpie agents.go:383-402)
//   pi           providers.<id>.baseUrl (magpie agents.go:403-416)
//   omp          providers.<id>.baseUrl in models.yml (magpie omp.go:241, 662-671)
//   cline        providers.openai-compatible.settings.baseUrl (magpie cline.go:295)
//   qwen         security.auth.baseUrl (qwen-code settingsSchema.ts:3624-3631)
//   kimi         [providers.<id>] base_url (magpie kimi.go:209-212)
//   zed          language_models.openai_compatible.<id>.api_url (magpie zed.go)
//   hermes       providers.<id>.base_url (magpie hermes.go:267-277)
//   droid        customModels[<i>].baseUrl in ~/.factory/settings.json (magpie droid.go:3-21,
//                40-41, 134-143, 236-241)
//   vscode-chat  [<i>].models[<j>].url of customendpoint/customoai groups in
//                chatLanguageModels.json (magpie vscode.go:3-29, 57-63, 124-147, 274-277)
//   aider        openai-api-base (magpie plugin example aider.agent.js)
//   antigravity-cli, cursor-private-inference: env only, through `wire run`
//                (magpie agy.go:38-46, cursorlocal.go:214-230)
//
// Only keys that already exist are rewritten unless the agent has a known
// built-in endpoint (`defaultUpstream`): the gateway relays to the agent's own
// upstream and never invents one.

import { join } from 'path';
import { KIMI_MARKER_BEGIN } from '../../integrations/KimiHooksInstaller.js';
import { readConfigFileBytes } from '../edit/config-file.js';
import { resolveJsoncKeyPath } from '../edit/jsonc-editor.js';
import { isPlainObjectValue } from '../edit/text-shape.js';
import { joinConfigKeyPath, readConfigValue } from '../wiring/config-document.js';
import { directoryFromEnv, pathExists, xdgConfigHome, xdgDataHome } from './agent-paths.js';
import type {
  AgentConfigReadContext,
  AgentDescriptor,
  AgentEnvironment,
  ResolvedBaseUrlTarget,
  UnroutableAgentNote,
} from './types.js';

const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';

/** `npx claude-mem uninstall` removes every native integration; some agents have their own command. */
const UNINSTALL_ALL_INTEGRATIONS = 'npx claude-mem uninstall';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A target per key of an object whose members each have a base-URL key (provider blocks), present keys only. */
function providerBlockTargets(
  context: AgentConfigReadContext,
  options: { file: string; providersKeyPath: string; baseUrlKey: string[] },
): ResolvedBaseUrlTarget[] {
  const providers = context.readValue(options.file, options.providersKeyPath);
  if (!isPlainObjectValue(providers)) return [];
  const targets: ResolvedBaseUrlTarget[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    let value: unknown = provider;
    for (const key of options.baseUrlKey) value = isPlainObjectValue(value) ? value[key] : undefined;
    if (!stringValue(value)) continue;
    targets.push({
      file: options.file,
      keyPath: joinConfigKeyPath([...options.providersKeyPath.split('.'), providerId, ...options.baseUrlKey]),
      protocol: 'per-provider',
      providerLabel: providerId,
    });
  }
  return targets;
}

function readJsonFileIfPresent(filePath: string): unknown {
  const bytes = readConfigFileBytes(filePath);
  if (bytes === null) return undefined;
  return readConfigValueAtRoot(filePath, bytes);
}

function readConfigValueAtRoot(filePath: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it before connecting`);
  }
}

// ---------------------------------------------------------------------------
// Claude Code

function claudeConfigDirectory(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'CLAUDE_CONFIG_DIR') ?? join(environment.home, '.claude');
}

const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';

const claudeCode: AgentDescriptor = {
  id: 'claude-code',
  name: 'Claude Code',
  aliases: ['claude', 'cc'],
  userAgentPrefixes: ['claude-cli', 'claude-code'],
  editToolNames: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  detect: { bins: ['claude'], directories: (environment) => [claudeConfigDirectory(environment)] },
  files: [{ key: 'settings', format: 'json', candidatePaths: (environment) => [join(claudeConfigDirectory(environment), 'settings.json')] }],
  targets: [{ file: 'settings', keyPath: 'env.ANTHROPIC_BASE_URL', protocol: 'anthropic', defaultUpstream: ANTHROPIC_API_BASE_URL }],
  // Claude Code sends x-claude-code-request-class and friends only with this on (report 07 §2.3).
  // ENABLE_TOOL_SEARCH: Claude Code turns tool search off for a base URL that
  // is not Anthropic's and then sends every MCP tool schema inline; seen live
  // (Claude Code 2.1.301, 815 tools), that was 2.6 MB and ~1.09M tokens, and
  // every request failed "prompt is too long". The gateway relays to
  // Anthropic, so tool search works through it.
  identitySwitches: [
    { file: 'settings', keyPath: 'env.CLAUDE_CODE_GATEWAY_HINT_HEADERS', value: '1' },
    { file: 'settings', keyPath: 'env.ENABLE_TOOL_SEARCH', value: 'true' },
  ],
  detectSubscription(context) {
    // Claude Code is wired only for API-key users (plan D9). Without an API
    // key it uses its claude.ai sign-in, which the gateway never forwards (D4).
    const environmentVariables = context.environment.env;
    if (environmentVariables.CLAUDE_CODE_OAUTH_TOKEN) {
      return 'Claude Code has CLAUDE_CODE_OAUTH_TOKEN set (a Claude subscription sign-in)';
    }
    const credentials = [
      context.readValue('settings', 'env.ANTHROPIC_API_KEY'),
      context.readValue('settings', 'env.ANTHROPIC_AUTH_TOKEN'),
      environmentVariables.ANTHROPIC_API_KEY,
      environmentVariables.ANTHROPIC_AUTH_TOKEN,
    ].filter((value): value is string => typeof value === 'string' && value !== '');
    if (credentials.some((credential) => credential.startsWith(SUBSCRIPTION_TOKEN_PREFIX))) {
      return 'Claude Code is set up with a Claude subscription token (sk-ant-oat…)';
    }
    if (credentials.length === 0 && !stringValue(context.readValue('settings', 'apiKeyHelper'))) {
      return 'Claude Code has no API key (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or apiKeyHelper), so it signs in with claude.ai';
    }
    return null;
  },
  // Claude Code always stays on its hooks for memory capture (plan D9).
  nativeIntegration: { isInstalled: () => true, uninstallCommand: UNINSTALL_ALL_INTEGRATIONS, alwaysNative: true },
  lastUsed: {
    path: (environment) => join(claudeConfigDirectory(environment), 'history.jsonl'),
    kind: 'jsonl',
    field: 'timestamp',
    unit: 'ms',
    slashCommandTextField: 'display', // magpie claude.go:1623-1626
  },
  launch: {
    env: { ANTHROPIC_BASE_URL: '{baseUrl}', CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1', ENABLE_TOOL_SEARCH: 'true' },
    baseUrlVariable: 'ANTHROPIC_BASE_URL',
    defaultUpstream: ANTHROPIC_API_BASE_URL,
    protocol: 'anthropic',
  },
};

// ---------------------------------------------------------------------------
// Codex

function codexHome(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'CODEX_HOME') ?? join(environment.home, '.codex');
}

/** Codex's built-in providers (model_provider values that need no [model_providers] table). */
const CODEX_BUILT_IN_OPENAI_PROVIDER = 'openai';
const CODEX_PLUGIN_IDS = ['claude-mem@claude-mem-local', 'claude-mem@thedotmack'];
const CODEX_SUBSCRIPTION_AUTH_MODES = new Set(['chatgpt', 'chatgptAuthTokens']);
const CODEX_CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';

function codexHasChatGptSignIn(context: AgentConfigReadContext): boolean {
  const authMode = context.readValue('auth', 'auth_mode');
  return (typeof authMode === 'string' && CODEX_SUBSCRIPTION_AUTH_MODES.has(authMode)) || Boolean(stringValue(context.readValue('auth', 'tokens.access_token')));
}

const codex: AgentDescriptor = {
  id: 'codex',
  name: 'Codex',
  aliases: ['codex-cli'],
  userAgentPrefixes: ['codex', 'acp-extension-codex'],
  editToolNames: ['apply_patch'],
  detect: { bins: ['codex'], directories: (environment) => [codexHome(environment)] },
  files: [
    { key: 'config', format: 'toml', candidatePaths: (environment) => [join(codexHome(environment), 'config.toml')] },
    { key: 'auth', format: 'json', candidatePaths: (environment) => [join(codexHome(environment), 'auth.json')] },
  ],
  targets: [],
  resolveTargets(context) {
    const activeProvider = stringValue(context.readValue('config', 'model_provider')) ?? CODEX_BUILT_IN_OPENAI_PROVIDER;
    if (activeProvider === CODEX_BUILT_IN_OPENAI_PROVIDER) {
      // A ChatGPT sign-in talks to chatgpt.com's Codex backend, not api.openai.com (seen live, codex-cli 0.162.1).
      const defaultUpstream = codexHasChatGptSignIn(context) ? CODEX_CHATGPT_BACKEND_BASE_URL : OPENAI_API_BASE_URL;
      return [{ file: 'config', keyPath: 'openai_base_url', protocol: 'openai-responses', defaultUpstream }];
    }
    const keyPath = joinConfigKeyPath(['model_providers', activeProvider, 'base_url']);
    if (!stringValue(context.readValue('config', keyPath))) {
      throw new Error(`Codex uses model_provider "${activeProvider}", which has no [model_providers.${activeProvider}] base_url to route`);
    }
    const wireApi = context.readValue('config', joinConfigKeyPath(['model_providers', activeProvider, 'wire_api']));
    return [{ file: 'config', keyPath, protocol: wireApi === 'chat' ? 'openai-chat' : 'openai-responses', providerLabel: activeProvider }];
  },
  detectSubscription(context, targets) {
    // A ChatGPT sign-in drives only the built-in OpenAI provider.
    if (!targets.some((target) => target.keyPath === 'openai_base_url')) return null;
    if (codexHasChatGptSignIn(context)) {
      return `Codex is signed in with ChatGPT (${context.filePath('auth')} holds ChatGPT tokens)`;
    }
    return null;
  },
  nativeIntegration: {
    isInstalled(environment) {
      const configPath = join(codexHome(environment), 'config.toml');
      const bytes = readConfigFileBytes(configPath);
      return CODEX_PLUGIN_IDS.some((pluginId) => readConfigValue('toml', configPath, bytes, joinConfigKeyPath(['plugins', pluginId, 'enabled'])) === true);
    },
    uninstallCommand: UNINSTALL_ALL_INTEGRATIONS,
  },
  // magpie codex.go:1231 reads ts and skips `/` commands in text.
  lastUsed: { path: (environment) => join(codexHome(environment), 'history.jsonl'), kind: 'jsonl', field: 'ts', unit: 's', slashCommandTextField: 'text' },
};

// ---------------------------------------------------------------------------
// Gemini CLI

function geminiDirectory(environment: AgentEnvironment): string {
  return join(environment.home, '.gemini');
}

const geminiCli: AgentDescriptor = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  aliases: ['gemini'],
  userAgentPrefixes: ['geminicli', 'gemini-cli'],
  editToolNames: ['replace', 'write_file'],
  detect: { bins: ['gemini'], directories: (environment) => [geminiDirectory(environment)] },
  files: [
    { key: 'env', format: 'env', candidatePaths: (environment) => [join(geminiDirectory(environment), '.env')] },
    { key: 'settings', format: 'json', candidatePaths: (environment) => [join(geminiDirectory(environment), 'settings.json')] },
  ],
  targets: [{ file: 'env', keyPath: 'GOOGLE_GEMINI_BASE_URL', protocol: 'gemini', defaultUpstream: GEMINI_API_BASE_URL }],
  detectSubscription(context) {
    const selectedType = context.readValue('settings', 'security.auth.selectedType');
    if (selectedType !== 'gemini-api-key') {
      return `Gemini CLI's security.auth.selectedType is ${JSON.stringify(selectedType ?? null)}, not "gemini-api-key" (a Google sign-in is never forwarded)`;
    }
    return null;
  },
  statusNotes: () => [
    'Gemini CLI reads ~/.gemini/.env only in folders it trusts, and only when the project has no .env of its own; elsewhere it uses its built-in endpoint and bypasses the gateway.',
  ],
  launch: { env: { GOOGLE_GEMINI_BASE_URL: '{baseUrl}' }, baseUrlVariable: 'GOOGLE_GEMINI_BASE_URL', defaultUpstream: GEMINI_API_BASE_URL, protocol: 'gemini' },
};

// ---------------------------------------------------------------------------
// OpenCode

function openCodeConfigDirectory(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'OPENCODE_CONFIG_DIR') ?? join(xdgConfigHome(environment), 'opencode');
}

/** The AI SDK packages' own endpoints (magpie provider/plugins.go:158-167 npmBase). */
const OPENCODE_DEFAULT_UPSTREAM_BY_PACKAGE: Record<string, { upstream: string; protocol: ResolvedBaseUrlTarget['protocol'] }> = {
  '@ai-sdk/anthropic': { upstream: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
  '@ai-sdk/openai': { upstream: 'https://api.openai.com/v1', protocol: 'openai-responses' },
  '@ai-sdk/google': { upstream: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' },
};
const OPENCODE_PACKAGE_BY_PROVIDER_ID: Record<string, string> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  google: '@ai-sdk/google',
};

/** auth.json lives in OpenCode's data folder, not its config folder (opencode global/index.ts). */
function openCodeAuthPaths(environment: AgentEnvironment): string[] {
  return [join(xdgDataHome(environment), 'opencode', 'auth.json')];
}

const openCode: AgentDescriptor = {
  id: 'opencode',
  name: 'OpenCode',
  aliases: ['oc'],
  userAgentPrefixes: ['opencode'],
  detect: { bins: ['opencode'], directories: (environment) => [openCodeConfigDirectory(environment)] },
  files: [
    {
      key: 'config',
      format: 'json',
      // OpenCode merges config.json, opencode.json and opencode.jsonc (config.ts:272-274);
      // the wiring edits the one that wins.
      candidatePaths: (environment) => ['opencode.jsonc', 'opencode.json', 'config.json'].map((name) => join(openCodeConfigDirectory(environment), name)),
    },
  ],
  targets: [],
  resolveTargets(context) {
    const providers = context.readValue('config', 'provider');
    if (!isPlainObjectValue(providers)) return [];
    const targets: ResolvedBaseUrlTarget[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!isPlainObjectValue(provider)) continue;
      const keyPath = joinConfigKeyPath(['provider', providerId, 'options', 'baseURL']);
      const packageName = stringValue(provider.npm) ?? OPENCODE_PACKAGE_BY_PROVIDER_ID[providerId];
      const known = packageName ? OPENCODE_DEFAULT_UPSTREAM_BY_PACKAGE[packageName] : undefined;
      const options = isPlainObjectValue(provider.options) ? provider.options : {};
      if (!stringValue(options.baseURL) && !known) continue;
      targets.push({ file: 'config', keyPath, protocol: known?.protocol ?? 'per-provider', defaultUpstream: known?.upstream, providerLabel: providerId });
    }
    return targets;
  },
  detectSubscription(context, targets) {
    // auth.json: provider id → {type: "oauth" | "api" | "wellknown"} (opencode auth/index.ts:10-35);
    // OPENCODE_AUTH_CONTENT replaces the file when set (:59-62).
    const authContent = context.environment.env.OPENCODE_AUTH_CONTENT;
    const [authPath] = openCodeAuthPaths(context.environment);
    const auth = authContent ? readConfigValueAtRoot('OPENCODE_AUTH_CONTENT', new TextEncoder().encode(authContent)) : readJsonFileIfPresent(authPath);
    if (!isPlainObjectValue(auth)) return null;
    for (const target of targets) {
      const entry = target.providerLabel ? auth[target.providerLabel] : undefined;
      if (isPlainObjectValue(entry) && entry.type === 'oauth') {
        return `OpenCode's provider "${target.providerLabel}" is signed in with OAuth (a subscription)`;
      }
    }
    return null;
  },
  readOnlyInputPaths: openCodeAuthPaths,
  nativeIntegration: {
    isInstalled: (environment) => pathExists(join(openCodeConfigDirectory(environment), 'plugins', 'claude-mem.js')),
    uninstallCommand: UNINSTALL_ALL_INTEGRATIONS,
  },
  statusNotes({ environment, connectedFilePaths }) {
    // OpenCode merges every one of its config files; connect edits the first that exists.
    const notes: string[] = [];
    for (const candidatePath of openCode.files[0].candidatePaths(environment)) {
      if (candidatePath === connectedFilePaths.config) continue;
      try {
        const bytes = readConfigFileBytes(candidatePath);
        if (bytes === null) continue;
        const providers = readConfigValue('json', candidatePath, bytes, 'provider');
        const providerIds = isPlainObjectValue(providers) ? Object.keys(providers) : [];
        if (providerIds.length > 0) {
          notes.push(`OpenCode also merges ${candidatePath}; its providers (${providerIds.join(', ')}) were not wired and do not go through the gateway.`);
        }
      } catch (error) {
        notes.push(`OpenCode also merges ${candidatePath}, which cannot be read (${error instanceof Error ? error.message : String(error)}); providers there may not go through the gateway.`);
      }
    }
    return notes;
  },
};

// ---------------------------------------------------------------------------
// Crush

function crushConfigPath(environment: AgentEnvironment): string {
  if (environment.platform === 'win32') {
    const localAppData = directoryFromEnv(environment, 'LOCALAPPDATA') ?? join(environment.home, 'AppData', 'Local');
    return join(localAppData, 'crush', 'crush.json');
  }
  return join(xdgConfigHome(environment), 'crush', 'crush.json');
}

const crush: AgentDescriptor = {
  id: 'crush',
  name: 'Crush',
  userAgentPrefixes: ['crush'],
  detect: { bins: ['crush'] },
  files: [{ key: 'config', format: 'json', candidatePaths: (environment) => [crushConfigPath(environment)] }],
  targets: [{ file: 'config', keyPath: 'providers.*.base_url', protocol: 'per-provider' }],
};

// ---------------------------------------------------------------------------
// Pi

function piAgentDirectory(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'PI_CODING_AGENT_DIR') ?? join(environment.home, '.pi', 'agent');
}

const pi: AgentDescriptor = {
  id: 'pi',
  name: 'Pi',
  aliases: ['pi-mono'],
  userAgentPrefixes: ['pi-'],
  detect: { bins: ['pi'], directories: (environment) => [piAgentDirectory(environment)] },
  files: [{ key: 'models', format: 'json', candidatePaths: (environment) => [join(piAgentDirectory(environment), 'models.json')] }],
  targets: [{ file: 'models', keyPath: 'providers.*.baseUrl', protocol: 'per-provider' }],
  // Pi then sends x-session-affinity / session_id (magpie agents.go:403-416, 422-440).
  resolveIdentitySwitches(_context, targets) {
    return {
      switches: targets.map((target) => ({
        file: target.file,
        keyPath: joinConfigKeyPath(['providers', target.providerLabel!, 'compat', 'sendSessionAffinityHeaders']),
        value: true,
      })),
      notes: [],
    };
  },
  nativeIntegration: {
    isInstalled: (environment) => pathExists(join(piAgentDirectory(environment), 'extensions', 'claude-mem', 'index.js')),
    uninstallCommand: 'npx claude-mem pi uninstall',
  },
};

// ---------------------------------------------------------------------------
// Oh My Pi (omp)

function ompAgentDirectory(environment: AgentEnvironment): string {
  const configDirectoryName = environment.env.PI_CONFIG_DIR;
  const root = configDirectoryName ? join(environment.home, configDirectoryName) : join(environment.home, '.omp');
  const profile = environment.env.OMP_PROFILE || environment.env.PI_PROFILE;
  if (profile) return join(root, 'profiles', profile, 'agent');
  return directoryFromEnv(environment, 'PI_CODING_AGENT_DIR') ?? join(root, 'agent');
}

/** omp reads compat.promptCacheSessionHeader from 16.0.6 (magpie omp.go:580, 665). */
const OMP_SESSION_HEADER_MINIMUM_VERSION = '16.0.6';
// Anchored and applied per word (split at whitespace, `/` and `@`), so a long run of digits costs one pass.
const VERSION_WORD_PATTERN = /^v?(\d+\.\d+\.\d+)/;

function firstVersionNumber(output: string): string | undefined {
  for (const word of output.split(/[\s/@]/)) {
    const match = VERSION_WORD_PATTERN.exec(word);
    if (match) return match[1];
  }
  return undefined;
}

const omp: AgentDescriptor = {
  id: 'omp',
  name: 'Oh My Pi',
  aliases: ['oh-my-pi'],
  userAgentPrefixes: ['oh-my-pi'],
  detect: { bins: ['omp'], directories: (environment) => [ompAgentDirectory(environment)] },
  files: [{ key: 'models', format: 'yaml', candidatePaths: (environment) => [join(ompAgentDirectory(environment), 'models.yml')] }],
  targets: [],
  resolveTargets: (context) => providerBlockTargets(context, { file: 'models', providersKeyPath: 'providers', baseUrlKey: ['baseUrl'] }),
  resolveIdentitySwitches(_context, targets, helpers) {
    if (targets.length === 0) return { switches: [], notes: [] };
    const versionOutput = helpers.readAgentVersion('omp');
    const version = versionOutput ? firstVersionNumber(versionOutput) : undefined;
    if (!version || !Bun.semver.satisfies(version, `>=${OMP_SESSION_HEADER_MINIMUM_VERSION}`)) {
      return {
        switches: [],
        notes: [`omp ${version ?? '(version unknown)'} is older than ${OMP_SESSION_HEADER_MINIMUM_VERSION}: compat.promptCacheSessionHeader skipped, so omp sessions are told apart by their requests only`],
      };
    }
    return {
      switches: targets.map((target) => ({
        file: target.file,
        keyPath: joinConfigKeyPath(['providers', target.providerLabel!, 'compat', 'promptCacheSessionHeader']),
        value: 'x-session-affinity',
      })),
      notes: [],
    };
  },
  nativeIntegration: {
    isInstalled: (environment) => pathExists(join(ompAgentDirectory(environment), 'hooks', 'pre', 'claude-mem.ts')),
    uninstallCommand: UNINSTALL_ALL_INTEGRATIONS,
  },
};

// ---------------------------------------------------------------------------
// Cline

function clineDataDirectory(environment: AgentEnvironment): string {
  const clineDirectory = directoryFromEnv(environment, 'CLINE_DIR') ?? join(environment.home, '.cline');
  return directoryFromEnv(environment, 'CLINE_DATA_DIR') ?? join(clineDirectory, 'data');
}

const CLINE_PROVIDER_SETTINGS = ['providers', 'openai-compatible', 'settings'];

const cline: AgentDescriptor = {
  id: 'cline',
  name: 'Cline',
  userAgentPrefixes: ['cline'],
  detect: { bins: ['cline'], directories: (environment) => [clineDataDirectory(environment)] },
  files: [{ key: 'providers', format: 'json', candidatePaths: (environment) => [join(clineDataDirectory(environment), 'settings', 'providers.json')] }],
  targets: [{ file: 'providers', keyPath: joinConfigKeyPath([...CLINE_PROVIDER_SETTINGS, 'baseUrl']), protocol: 'openai-chat' }],
  // magpie cline.go:295 names Cline's requests with this header.
  resolveIdentitySwitches: (_context, targets) => ({
    switches: targets.length === 0 ? [] : [{ file: 'providers', keyPath: joinConfigKeyPath([...CLINE_PROVIDER_SETTINGS, 'headers', 'User-Agent']), value: 'cline' }],
    notes: [],
  }),
};

// ---------------------------------------------------------------------------
// Qwen Code

function qwenDirectory(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'QWEN_HOME') ?? join(environment.home, '.qwen');
}

/** AuthType values whose endpoint is security.auth.baseUrl (qwen-code utils/auth-type.ts:8-15). */
const QWEN_BASE_URL_AUTH_TYPES = new Set(['openai', 'openai-responses', 'anthropic']);

const qwen: AgentDescriptor = {
  id: 'qwen',
  name: 'Qwen Code',
  aliases: ['qwen-code'],
  userAgentPrefixes: ['qwencode'],
  detect: { bins: ['qwen'], directories: (environment) => [qwenDirectory(environment)] },
  files: [{ key: 'settings', format: 'json', candidatePaths: (environment) => [join(qwenDirectory(environment), 'settings.json')] }],
  targets: [],
  resolveTargets(context) {
    // A modelProviders entry's baseUrl wins over security.auth.baseUrl (modelConfigResolver.ts:233-254).
    const modelProviders = context.readValue('settings', 'modelProviders');
    const entries = isPlainObjectValue(modelProviders) ? Object.values(modelProviders).flat() : [];
    if (entries.some((entry) => isPlainObjectValue(entry) && stringValue(entry.baseUrl))) {
      throw new Error('Qwen Code\'s modelProviders entries set their own baseUrl, which wins over security.auth.baseUrl; route those by hand with `claude-mem wire routes add`');
    }
    return [{ file: 'settings', keyPath: 'security.auth.baseUrl', protocol: 'per-provider' }];
  },
  detectSubscription(context) {
    const selectedType = context.readValue('settings', 'security.auth.selectedType');
    if (selectedType === 'qwen-oauth') return 'Qwen Code is signed in with Qwen OAuth (a subscription)';
    if (typeof selectedType !== 'string' || !QWEN_BASE_URL_AUTH_TYPES.has(selectedType)) {
      return `Qwen Code's security.auth.selectedType is ${JSON.stringify(selectedType ?? null)}; only an API-key type (openai, openai-responses, anthropic) has a base URL to route`;
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Kimi Code

function kimiDirectory(environment: AgentEnvironment): string {
  const explicit = directoryFromEnv(environment, 'KIMI_CODE_HOME');
  if (explicit) return explicit;
  const current = join(environment.home, '.kimi-code');
  if (pathExists(current)) return current;
  const legacyShare = directoryFromEnv(environment, 'KIMI_SHARE_DIR');
  if (legacyShare) return legacyShare;
  const legacy = join(environment.home, '.kimi');
  return pathExists(legacy) ? legacy : current;
}

const kimi: AgentDescriptor = {
  id: 'kimi',
  name: 'Kimi Code',
  userAgentPrefixes: ['kimicli'],
  detect: { bins: ['kimi'], directories: (environment) => [kimiDirectory(environment)] },
  files: [{ key: 'config', format: 'toml', candidatePaths: (environment) => [join(kimiDirectory(environment), 'config.toml')] }],
  targets: [],
  resolveTargets: (context) => providerBlockTargets(context, { file: 'config', providersKeyPath: 'providers', baseUrlKey: ['base_url'] }),
  nativeIntegration: {
    isInstalled(environment) {
      const bytes = readConfigFileBytes(join(kimiDirectory(environment), 'config.toml'));
      return bytes !== null && new TextDecoder().decode(bytes).includes(KIMI_MARKER_BEGIN);
    },
    uninstallCommand: 'npx claude-mem kimi uninstall',
  },
};

// ---------------------------------------------------------------------------
// Zed

function zedConfigDirectory(environment: AgentEnvironment): string {
  if (environment.platform === 'win32') {
    return join(directoryFromEnv(environment, 'APPDATA') ?? join(environment.home, 'AppData', 'Roaming'), 'Zed');
  }
  if (environment.platform === 'darwin') return join(environment.home, '.config', 'zed');
  return join(xdgConfigHome(environment), 'zed');
}

const zed: AgentDescriptor = {
  id: 'zed',
  name: 'Zed',
  userAgentPrefixes: ['zed'],
  detect: { bins: ['zed'], directories: (environment) => [zedConfigDirectory(environment)] },
  files: [{ key: 'settings', format: 'json', candidatePaths: (environment) => [join(zedConfigDirectory(environment), 'settings.json')] }],
  targets: [{ file: 'settings', keyPath: 'language_models.openai_compatible.*.api_url', protocol: 'openai-chat' }],
};

// ---------------------------------------------------------------------------
// Hermes Agent

function hermesDirectory(environment: AgentEnvironment): string {
  const explicit = directoryFromEnv(environment, 'HERMES_HOME');
  if (explicit) return explicit;
  if (environment.platform === 'win32') {
    return join(directoryFromEnv(environment, 'LOCALAPPDATA') ?? join(environment.home, 'AppData', 'Local'), 'hermes');
  }
  return join(environment.home, '.hermes');
}

const hermes: AgentDescriptor = {
  id: 'hermes',
  name: 'Hermes Agent',
  userAgentPrefixes: ['hermes-agent'],
  detect: { bins: ['hermes'], directories: (environment) => [hermesDirectory(environment)] },
  files: [{ key: 'config', format: 'yaml', candidatePaths: (environment) => [join(hermesDirectory(environment), 'config.yaml')] }],
  targets: [],
  resolveTargets: (context) => providerBlockTargets(context, { file: 'config', providersKeyPath: 'providers', baseUrlKey: ['base_url'] }),
  // magpie hermes.go:267-277 names Hermes's requests with this header.
  resolveIdentitySwitches: (_context, targets) => ({
    switches: targets.map((target) => ({
      file: target.file,
      keyPath: joinConfigKeyPath(['providers', target.providerLabel!, 'extra_headers', 'User-Agent']),
      value: 'hermes-agent',
    })),
    notes: [],
  }),
};

// ---------------------------------------------------------------------------
// Droid (Factory)

function factoryDirectory(environment: AgentEnvironment): string {
  // FACTORY_HOME_OVERRIDE replaces the home .factory sits in (magpie droid.go:4, 135-140).
  return join(directoryFromEnv(environment, 'FACTORY_HOME_OVERRIDE') ?? environment.home, '.factory');
}

/** A custom model's `provider` → the API droid speaks to its baseUrl (magpie droid.go:5-7, 68-76). */
const DROID_PROTOCOL_BY_PROVIDER: Record<string, ResolvedBaseUrlTarget['protocol']> = {
  anthropic: 'anthropic',
  openai: 'openai-responses',
  'generic-chat-completion-api': 'openai-chat',
};

/** Credential prefixes of a subscription sign-in (plan D4): a Claude OAuth token, a ChatGPT JWT. */
const SUBSCRIPTION_CREDENTIAL_PREFIXES = [SUBSCRIPTION_TOKEN_PREFIX, 'eyJ'];

/**
 * Droid's own (BYOK) models are the customModels array of settings.json; each
 * entry with a baseUrl gets a route. Factory-hosted models are not in it and
 * are never touched. The legacy config.json custom_models is left alone, as
 * magpie does (droid.go:8-9). An entry is addressed by its index; one moved
 * before disconnect is found by the gateway URL connect wrote and restored
 * where it now is (wiring-engine movedArrayEntryKeyPaths).
 */
const droid: AgentDescriptor = {
  id: 'droid',
  name: 'Droid',
  aliases: ['factory', 'factory-droid'],
  userAgentPrefixes: ['factory-cli'],
  detect: { bins: ['droid'], directories: (environment) => [factoryDirectory(environment)] },
  files: [{ key: 'settings', format: 'json', candidatePaths: (environment) => [join(factoryDirectory(environment), 'settings.json')] }],
  targets: [],
  resolveTargets(context) {
    const customModels = context.readValue('settings', 'customModels');
    if (!Array.isArray(customModels)) return [];
    const targets: ResolvedBaseUrlTarget[] = [];
    customModels.forEach((entry: unknown, index) => {
      if (!isPlainObjectValue(entry) || !stringValue(entry.baseUrl)) return;
      const provider = stringValue(entry.provider);
      targets.push({
        file: 'settings',
        keyPath: joinConfigKeyPath(['customModels', String(index), 'baseUrl']),
        protocol: (provider && DROID_PROTOCOL_BY_PROVIDER[provider]) || 'per-provider',
        providerLabel: stringValue(entry.displayName) ?? stringValue(entry.model) ?? String(index),
      });
    });
    return targets;
  },
  detectSubscription(context, targets) {
    for (const target of targets) {
      const apiKey = context.readValue('settings', target.keyPath.replace(/baseUrl$/, 'apiKey'));
      if (typeof apiKey === 'string' && SUBSCRIPTION_CREDENTIAL_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
        return `Droid's custom model "${target.providerLabel}" uses a subscription sign-in token as its apiKey`;
      }
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// VS Code Chat (Copilot Chat's Custom Endpoint / OpenAI Compatible models)

function vscodeUserDirectory(environment: AgentEnvironment): string {
  // magpie vscode.go:116-138: Application Support on macOS, Roaming AppData on Windows, XDG on Linux.
  if (environment.platform === 'darwin') return join(environment.home, 'Library', 'Application Support', 'Code', 'User');
  if (environment.platform === 'win32') {
    return join(directoryFromEnv(environment, 'APPDATA') ?? join(environment.home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return join(xdgConfigHome(environment), 'Code', 'User');
}

/** Group vendors whose models carry their own `url` (magpie vscode.go:54-63). */
const VSCODE_URL_VENDORS = new Set(['customendpoint', 'customoai']);

/**
 * chatLanguageModels.json is a JSONC array of model groups (magpie
 * vscode.go:3-9, edit/jsonarray.go:12-16); every model of a Custom Endpoint
 * or OpenAI Compatible group with a `url` gets a route. Copilot's own models
 * are not in it and are never touched. Only the default profile's file of VS
 * Code Stable is wired; other profiles and VS Code Insiders keep their own
 * files (magpie vscode.go:361-401) and are not routed.
 */
const vscodeChat: AgentDescriptor = {
  id: 'vscode-chat',
  name: 'VS Code Chat',
  aliases: ['vscode', 'vs-code', 'copilot-chat'],
  userAgentPrefixes: ['githubcopilotchat'],
  detect: { bins: ['code'], directories: (environment) => [vscodeUserDirectory(environment)] },
  files: [{ key: 'models', format: 'json', candidatePaths: (environment) => [join(vscodeUserDirectory(environment), 'chatLanguageModels.json')] }],
  targets: [],
  resolveTargets(context) {
    const bytes = context.fileBytes('models');
    if (bytes === null) return [];
    const targets: ResolvedBaseUrlTarget[] = [];
    for (const { keys, value: group } of resolveJsoncKeyPath(bytes, '*')) {
      if (!isPlainObjectValue(group) || typeof group.vendor !== 'string' || !VSCODE_URL_VENDORS.has(group.vendor) || !Array.isArray(group.models)) continue;
      // magpie writes Custom Endpoint groups with apiType "chat-completions" (vscode.go:447).
      const protocol: ResolvedBaseUrlTarget['protocol'] = group.apiType === undefined || group.apiType === 'chat-completions' ? 'openai-chat' : 'per-provider';
      group.models.forEach((model: unknown, modelIndex) => {
        if (!isPlainObjectValue(model) || !stringValue(model.url)) return;
        targets.push({
          file: 'models',
          keyPath: joinConfigKeyPath([...keys, 'models', String(modelIndex), 'url']),
          protocol,
          providerLabel: `${stringValue(group.name) ?? group.vendor}-${stringValue(model.id) ?? String(modelIndex)}`,
        });
      });
    }
    return targets;
  },
};

// ---------------------------------------------------------------------------
// Aider

const aider: AgentDescriptor = {
  id: 'aider',
  name: 'Aider',
  userAgentPrefixes: ['aider', 'litellm'],
  detect: { bins: ['aider'] },
  files: [{ key: 'config', format: 'yaml', candidatePaths: (environment) => [join(environment.home, '.aider.conf.yml')] }],
  targets: [{ file: 'config', keyPath: 'openai-api-base', protocol: 'openai-chat', defaultUpstream: OPENAI_API_BASE_URL }],
  launch: { env: { OPENAI_API_BASE: '{baseUrl}' }, baseUrlVariable: 'OPENAI_API_BASE', defaultUpstream: OPENAI_API_BASE_URL, protocol: 'openai-chat' },
};

// ---------------------------------------------------------------------------
// Env-only agents: `claude-mem wire run`

function antigravityHooksInstalled(environment: AgentEnvironment): boolean {
  const hooks = readJsonFileIfPresent(join(environment.home, '.gemini', 'config', 'hooks.json'));
  const named = isPlainObjectValue(hooks) ? hooks['claude-mem'] : undefined;
  return isPlainObjectValue(named) && Object.values(named).some((handlers) => Array.isArray(handlers) && handlers.length > 0);
}

const antigravityCli: AgentDescriptor = {
  id: 'antigravity-cli',
  name: 'Antigravity CLI',
  aliases: ['agy', 'antigravity'],
  userAgentPrefixes: [],
  detect: { bins: ['agy'] },
  files: [],
  targets: [],
  nativeIntegration: { isInstalled: antigravityHooksInstalled, uninstallCommand: 'npx claude-mem antigravity-cli uninstall' },
  statusNotes: () => [
    'Gemini CLI reads ~/.gemini/.env only in folders it trusts, and only when the project has no .env of its own; elsewhere it uses its built-in endpoint and bypasses the gateway.',
  ],
  launch: { env: { GOOGLE_GEMINI_BASE_URL: '{baseUrl}' }, baseUrlVariable: 'GOOGLE_GEMINI_BASE_URL', defaultUpstream: GEMINI_API_BASE_URL, protocol: 'gemini' },
};

function cursorHooksInstalled(environment: AgentEnvironment): boolean {
  const bytes = readConfigFileBytes(join(environment.home, '.cursor', 'hooks.json'));
  if (bytes === null) return false;
  // CursorHooksInstaller isUnifiedClaudeMemCursorHook: `worker-service … hook cursor`.
  const text = new TextDecoder().decode(bytes);
  return text.includes('worker-service') && text.includes('hook cursor');
}

const cursorPrivateInference: AgentDescriptor = {
  id: 'cursor-private-inference',
  name: 'Cursor Private Inference',
  aliases: ['cursor-local'],
  userAgentPrefixes: ['cursor'],
  detect: {},
  files: [],
  targets: [],
  nativeIntegration: { isInstalled: cursorHooksInstalled, uninstallCommand: UNINSTALL_ALL_INTEGRATIONS },
  // No public default endpoint: the upstream is the CURSOR_LOCAL_AGENT_BASE_URL already set.
  launch: { env: { CURSOR_LOCAL_AGENT_BASE_URL: '{baseUrl}' }, baseUrlVariable: 'CURSOR_LOCAL_AGENT_BASE_URL', defaultUpstream: '', protocol: 'per-provider' },
};

export const BUILT_IN_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  claudeCode,
  codex,
  geminiCli,
  openCode,
  crush,
  pi,
  omp,
  cline,
  qwen,
  kimi,
  zed,
  hermes,
  droid,
  vscodeChat,
  aider,
  antigravityCli,
  cursorPrivateInference,
];

/**
 * Agents with no built-in descriptor. Connect names these and the manual way:
 * `claude-mem wire routes add`, then point the agent at the printed URL.
 */
export const AGENTS_WITHOUT_DESCRIPTORS: readonly UnroutableAgentNote[] = [
  { id: 'cursor', reason: 'Cursor CLI talks a Connect stream to Cursor\'s backend; it keeps its claude-mem hooks' },
  { id: 'copilot-cli', reason: 'Copilot CLI has a model setting but no endpoint setting' },
  { id: 'windsurf', reason: 'Windsurf/Devin talk Connect/protobuf to their backend' },
  { id: 'warp', reason: 'Warp has no endpoint setting' },
  { id: 'goose', reason: 'Goose\'s built-in provider host keys are unconfirmed; add a custom provider and route it by hand' },
  { id: 'kilo', reason: 'Kilo\'s base-URL key is unconfirmed' },
  { id: 'claude-desktop', reason: 'Claude Desktop\'s third-party gateway config lives in a generated config library entry; set it by hand' },
  { id: 'roo-code', reason: 'not described yet' },
  { id: 'openclaw', reason: 'not described yet' },
];
