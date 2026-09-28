/**
 * Setup snapshot v1 for the Claude-Mem install advisor (`npx claude-mem
 * advisor plan|fix`). The user's agent — or, on the human TTY path, our own
 * collector below — describes the machine; this module keeps only the allowed
 * fields, in strict formats, before anything leaves the machine. The server
 * (claude-mem-pro src/lib/installer-advisor/redact.ts) re-applies the same
 * rules; tests/fixtures/installer-snapshot-cases.json pins both sides.
 *
 * Rules: unknown keys are dropped; enums outside their list become `other`
 * (or null where there is no `other`); versions must match VERSION_RE or
 * become null; ids and versions cannot contain a path, host, user or email
 * because their formats forbid `/ \ ~ : @` and spaces. There is no free-text
 * field in a snapshot.
 */

import { release } from 'os';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { isDesktopSession, isWsl } from './desktop-detect.js';
import { redactText } from '../../services/telemetry/error-scrub.js';

export const SNAPSHOT_VERSION = 1;

/** The IDE ids in commands/ide-detection.ts (asserted by snapshot.test.ts). */
export const KNOWN_AI_TOOL_IDS = [
  'claude-code', 'opencode', 'openclaw', 'windsurf', 'codex-cli', 'cursor',
  'grok-bot', 'copilot-cli', 'antigravity', 'goose', 'roo-code', 'warp',
] as const;

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const ARCHES = ['arm64', 'x64'] as const;
const SHELLS = ['bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'other'] as const;
const AGENT_HOSTS = ['claude-code', 'cursor', 'codex', 'windsurf', 'other', 'none'] as const;
const PROVIDERS = ['claude', 'openrouter', 'gemini', 'host'] as const;
const SHARED_BY = ['agent', 'human'] as const;

export const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const RELEASE_MAJOR_RE = /^[0-9]{1,6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_AI_TOOLS = 16;

export interface SnapshotV1 {
  v: 1;
  os: { platform: string | null; release_major: string | null; arch: string | null; is_wsl: boolean };
  shell: string;
  node: string | null;
  npm: string | null;
  bun: string | null;
  uv: string | null;
  ai_tools: Array<{ id: string; version: string | null }>;
  agent_host: string;
  tty: boolean;
  desktop: boolean;
  ci: boolean;
  claude_mem: { installed_version: string | null; provider: string | null };
  install_id: string | null;
  shared_by: 'agent' | 'human';
  human_asked: boolean;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function oneOf<T extends string>(value: unknown, list: readonly T[], fallback: T | null): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T : fallback;
}

export function cleanVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v(?=\d)/, '');
  return VERSION_RE.test(trimmed) ? trimmed : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

/**
 * Keep only the allowed fields, in their strict formats. Pure; never throws;
 * the same input always gives the same output (the server relies on that).
 */
export function redactSnapshot(input: unknown): SnapshotV1 {
  const raw = obj(input);
  const os = obj(raw.os);
  const cm = obj(raw.claude_mem);
  const tools = Array.isArray(raw.ai_tools) ? raw.ai_tools.slice(0, MAX_AI_TOOLS) : [];
  const seen = new Set<string>();
  const aiTools: SnapshotV1['ai_tools'] = [];
  for (const tool of tools) {
    const t = obj(tool);
    const id = oneOf(t.id, KNOWN_AI_TOOL_IDS, null) ?? 'other';
    if (seen.has(id) && id !== 'other') continue;
    seen.add(id);
    aiTools.push({ id, version: cleanVersion(t.version) });
  }
  const releaseMajor = typeof os.release_major === 'string' || typeof os.release_major === 'number'
    ? String(os.release_major)
    : '';
  return {
    v: 1,
    os: {
      platform: oneOf(os.platform, PLATFORMS, null),
      release_major: RELEASE_MAJOR_RE.test(releaseMajor) ? releaseMajor : null,
      arch: oneOf(os.arch, ARCHES, null),
      is_wsl: bool(os.is_wsl),
    },
    shell: oneOf(raw.shell, SHELLS, 'other') as string,
    node: cleanVersion(raw.node),
    npm: cleanVersion(raw.npm),
    bun: cleanVersion(raw.bun),
    uv: cleanVersion(raw.uv),
    ai_tools: aiTools,
    agent_host: oneOf(raw.agent_host, AGENT_HOSTS, 'other') as string,
    tty: bool(raw.tty),
    desktop: bool(raw.desktop),
    ci: bool(raw.ci),
    claude_mem: {
      installed_version: cleanVersion(cm.installed_version),
      provider: oneOf(cm.provider, PROVIDERS, null),
    },
    install_id: typeof raw.install_id === 'string' && UUID_RE.test(raw.install_id) ? raw.install_id : null,
    shared_by: oneOf(raw.shared_by, SHARED_BY, 'agent') as 'agent' | 'human',
    human_asked: bool(raw.human_asked),
  };
}

export const ERROR_SNIPPET_MAX_LINES = 40;
export const ERROR_SNIPPET_MAX_BYTES = 4096;

/**
 * `advisor fix` only: the error text, scrubbed line by line (home dir, paths,
 * URLs' query strings, tokens, emails) and capped at 40 lines / 4 KB.
 */
export function scrubErrorSnippet(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const lines = text.split(/\r?\n/).slice(0, ERROR_SNIPPET_MAX_LINES).map((line) => redactText(line));
  let out = lines.join('\n');
  while (Buffer.byteLength(out, 'utf-8') > ERROR_SNIPPET_MAX_BYTES) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

// ---------------------------------------------------------------------------
// Path 2 (human in a TTY): OUR code collects the same fields — no LLM, no
// file contents, no paths. Everything still goes through redactSnapshot.

export interface CollectSnapshotInput {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  isTTY: boolean;
  bunVersion: string | null;
  uvVersion: string | null;
  aiToolIds: string[];
  agentContext: string;
  installedVersion: string | null;
  provider: string | null;
  installId: string | null;
}

export function detectShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL ? basename(env.SHELL).toLowerCase() : '';
  if (shell) return (SHELLS as readonly string[]).includes(shell) ? shell : 'other';
  if (platform === 'win32') return env.PSModulePath ? 'powershell' : 'cmd';
  return 'other';
}

function agentHostFromContext(context: string): string {
  if (context === 'claude-code' || context === 'cursor' || context === 'codex') return context;
  return context === 'tty' ? 'none' : 'other';
}

export function collectSnapshot(input: CollectSnapshotInput): SnapshotV1 {
  const npmAgent = input.env.npm_config_user_agent ?? '';
  const npmVersion = /^npm\/([^\s]+)/.exec(npmAgent)?.[1] ?? null;
  const uv = input.uvVersion ? /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(input.uvVersion)?.[1] ?? null : null;
  return redactSnapshot({
    os: {
      platform: input.platform,
      release_major: release().split('.')[0],
      arch: input.arch,
      is_wsl: isWsl(input.platform, input.env),
    },
    shell: detectShell(input.platform, input.env),
    node: input.nodeVersion,
    npm: npmVersion,
    bun: input.bunVersion,
    uv,
    ai_tools: input.aiToolIds.map((id) => ({ id, version: null })),
    agent_host: agentHostFromContext(input.agentContext),
    tty: input.isTTY,
    desktop: isDesktopSession(input.platform, input.env),
    ci: Boolean(input.env.CI),
    claude_mem: { installed_version: input.installedVersion, provider: input.provider },
    install_id: input.installId,
    shared_by: 'human',
    human_asked: true,
  });
}

/** The version in an existing marketplace install, if any. */
export function readInstalledPluginVersion(marketplaceDir: string): string | null {
  try {
    const path = join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json');
    if (!existsSync(path)) return null;
    return cleanVersion(JSON.parse(readFileSync(path, 'utf-8')).version);
  } catch {
    // [ANTI-PATTERN IGNORED]: a missing or corrupt plugin.json just means "not installed" in the snapshot.
    return null;
  }
}
