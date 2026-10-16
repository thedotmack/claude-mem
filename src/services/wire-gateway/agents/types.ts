// SPDX-License-Identifier: Apache-2.0
//
// Agent descriptors (plan Phase 8 task 1): what an agent's config files are,
// which keys hold the base URL the gateway takes over, which keys turn on
// identity headers, how a subscription sign-in and a claude-mem native
// integration are recognized, and how the agent is launched through
// `claude-mem wire run`. Built-ins are TS objects (agents/builtin-agents.ts);
// user descriptors are JSON under <DATA_DIR>/wire-gateway/agents/ and become
// the same shape (agents/user-agents.ts). Modeled on magpie's Agent struct
// (internal/agent/agent.go:84-273) and plugin descriptor
// (internal/agentplug/agentplug.go:61-89), MIT, Copyright (c) 2026 yetone.

/** `json` covers JSONC (comments and trailing commas are kept). */
export type AgentConfigFormat = 'json' | 'toml' | 'yaml' | 'env';

/**
 * What the agent speaks to the base URL. Informational: the relay classifies
 * every request by its path (relay/protocols.ts), so a provider block whose
 * protocol depends on a field (`npm`, `api`, `type`) is `per-provider`.
 */
export type AgentWireProtocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini' | 'per-provider';

/**
 * Where the agent runs. Every path a descriptor resolves comes from here, so
 * tests and `wire preview` point an agent at a sandbox home without touching
 * the real one.
 */
export interface AgentEnvironment {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
}

export interface AgentConfigFileDescriptor {
  /** Name the targets refer to (`config`, `env`, `settings`). */
  key: string;
  format: AgentConfigFormat;
  /** Candidate paths, best first: the first that exists is used, else the first. Empty: the agent has no such file here. */
  candidatePaths(environment: AgentEnvironment): string[];
}

/** A base-URL key the gateway takes over (one route per matched key). */
export interface AgentBaseUrlTargetDescriptor {
  file: string;
  /** Dotted key path. One `*` segment (JSON only) gives a route per existing key there (per-provider blocks). */
  keyPath: string;
  protocol: AgentWireProtocol;
  /** The agent's built-in endpoint when the key is absent. Without one, an absent key is not wired. */
  defaultUpstream?: string;
}

/** One concrete base-URL key: what connect reads, rewrites and routes. */
export interface ResolvedBaseUrlTarget {
  file: string;
  /** Literal key path (dots inside a key are escaped). */
  keyPath: string;
  protocol: AgentWireProtocol;
  defaultUpstream?: string;
  /** The provider the key belongs to, when there are several: the route id becomes `<agentId>-<provider>`. */
  providerLabel?: string;
}

/** A value connect sets so the agent sends identity headers (plan Phase 8 task 6). */
export interface ResolvedIdentitySwitch {
  file: string;
  keyPath: string;
  value: unknown;
}

/** What a descriptor's computed parts may look at: the files, read once, and the environment. */
export interface AgentConfigReadContext {
  agentId: string;
  environment: AgentEnvironment;
  /** The parsed value at a key path of a file, or undefined (absent file or key). Throws on an unreadable file. */
  readValue(fileKey: string, keyPath: string): unknown;
  /** The resolved absolute path of a file. */
  filePath(fileKey: string): string;
  /** A file's bytes, or null when absent. */
  fileBytes(fileKey: string): Uint8Array | null;
}

export interface AgentNativeIntegrationDescriptor {
  /** Whether a claude-mem native integration (hooks, plugin, extension) is installed for this agent. */
  isInstalled(environment: AgentEnvironment): boolean;
  /** The command that removes it, named when `--capture wire` is refused (plan D6). */
  uninstallCommand: string;
  /** True when the gateway may never record this agent, whatever is installed (Claude Code, plan D9). */
  alwaysNative?: boolean;
}

/** `claude-mem wire run <agent>`: the env that points a launched agent at its route. */
export interface AgentLaunchDescriptor {
  /** Env vars to set; `{baseUrl}` is replaced by the route's launch URL. */
  env: Record<string, string>;
  /** The env var whose current value (when set and not ours) is the route's upstream. */
  baseUrlVariable: string;
  defaultUpstream: string;
  protocol: AgentWireProtocol;
}

/** The agent's own record of use, for bypass detection (Phase 9). */
export interface AgentLastUsedDescriptor {
  path(environment: AgentEnvironment): string;
  kind: 'jsonl';
  field: string;
  unit: 's' | 'ms';
  /**
   * The field holding the prompt text, when the log also keeps `/` commands
   * (which never reach the model): a record whose text there starts with `/`
   * is skipped. Claude Code's history.jsonl: `display`.
   */
  slashCommandTextField?: string;
}

/** What `wire status` reads to word an agent's status notes (Phase 9). */
export interface AgentStatusNotesContext {
  environment: AgentEnvironment;
  /** fileKey → the path `wire connect` edited; empty when the agent was routed without connect. */
  connectedFilePaths: Record<string, string>;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  /** Other names `connect` accepts; user descriptors may not take them. */
  aliases?: string[];
  /** Lower-cased user-agent prefixes (identity, Phase 4). */
  userAgentPrefixes: string[];
  detect: {
    /** Executables looked up on PATH. */
    bins?: string[];
    /** Directories whose existence means the agent is installed. */
    directories?(environment: AgentEnvironment): string[];
  };
  files: AgentConfigFileDescriptor[];
  targets: AgentBaseUrlTargetDescriptor[];
  /** Computed targets, for keys a fixed path cannot name (the active Codex provider, providers in a TOML table). */
  resolveTargets?(context: AgentConfigReadContext): ResolvedBaseUrlTarget[];
  identitySwitches?: ResolvedIdentitySwitch[];
  /** Computed identity switches (one per wired provider, or behind a version check). Returns notes for skipped ones. */
  resolveIdentitySwitches?(
    context: AgentConfigReadContext,
    targets: ResolvedBaseUrlTarget[],
    helpers: AgentWiringHelpers,
  ): { switches: ResolvedIdentitySwitch[]; notes: string[] };
  /**
   * Returns why the agent is signed in with a subscription (plan D4), or null.
   * A refusal names the native path the agent stays on.
   */
  detectSubscription?(context: AgentConfigReadContext, targets: ResolvedBaseUrlTarget[]): string | null;
  /**
   * Files connect reads but never writes and that are not among `files`
   * (OpenCode's auth.json, in its data folder): `wire preview` copies them
   * into its sandbox so its connect decides as the real one would.
   */
  readOnlyInputPaths?(environment: AgentEnvironment): string[];
  nativeIntegration?: AgentNativeIntegrationDescriptor;
  lastUsed?: AgentLastUsedDescriptor;
  /**
   * Notes `wire status` shows whatever the state: ways the agent's requests
   * can miss the gateway that its config does not show. Must not throw; a
   * file it cannot read is a note.
   */
  statusNotes?(context: AgentStatusNotesContext): string[];
  launch?: AgentLaunchDescriptor;
  /** Set on descriptors loaded from <DATA_DIR>/wire-gateway/agents/*.json. */
  userDescriptorPath?: string;
  /** Env vars a user descriptor's paths name (`$VAR`), which `wire preview` re-roots into its sandbox. */
  pathVariables?: string[];
}

/** Side-effecting lookups a descriptor may need, injectable for tests. */
export interface AgentWiringHelpers {
  /** The agent's `--version` output, or null when it cannot be run. */
  readAgentVersion(executable: string): string | null;
}

/** An agent the gateway cannot route by config, listed so `connect` can say what to do instead. */
export interface UnroutableAgentNote {
  id: string;
  reason: string;
}
