// SPDX-License-Identifier: Apache-2.0
//
// claude-mem's MCP server as each agent's config spells it (plan Phase 14
// task 1, `mcp`), and `${NAME}` environment references translated into the
// syntax each agent reads, or refused where the agent reads none (task 2).
// Ported from magpie internal/library/envref.go:22-260 (refsOf, refsProblem,
// errNoEnvRef) and mcp.go:216-248, 384-853 (root keys, encode), MIT,
// Copyright (c) 2026 yetone.

import type { LibraryValue } from './types.js';

/** claude-mem's server, neutral: a stdio command, or the gateway's MCP over HTTP (`http://127.0.0.1:<port>/mcp`). */
export interface McpServerSpec {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** Values may hold `${NAME}`: a reference to a variable in the agent's environment. */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * How an agent spells an environment reference in its MCP config (Appendix B).
 *  - dollar:   `${NAME}`        claude family, grok, gemini, crush, copilot, pi, omp, hermes
 *  - opencode: `{env:NAME}`     opencode family
 *  - cursor:   `${env:NAME}`    cursor
 *  - codex:    bearer_token_env_var / env_http_headers / env_vars (a value is a variable whole)
 *  - goose:    env_keys (a variable whole, under its own name)
 *  - none:     no reference at all: desktop, antigravity, kimi, cline, zed
 */
export type EnvReferenceSyntax = 'dollar' | 'opencode' | 'cursor' | 'codex' | 'goose' | 'none';

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WHOLE_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** magpie's errNoEnvRef, word for word in substance. */
export const NO_ENV_REFERENCE_REFUSAL = 'it reads no environment variable from its MCP config, so a server with ${NAME} in its headers or environment is not given to it: written there, the token would be in its file as plain text';

function hasReference(values: Record<string, string> | undefined): boolean {
  return Object.values(values ?? {}).some((value) => new RegExp(ENV_REFERENCE.source).test(value));
}

function wholeReference(value: string): string | null {
  return WHOLE_ENV_REFERENCE.exec(value)?.[1] ?? null;
}

function bearerReference(header: string, value: string): string | null {
  if (header.toLowerCase() !== 'authorization' || !value.startsWith('Bearer ')) return null;
  return wholeReference(value.slice('Bearer '.length));
}

/** Why the agent cannot be given this server's references, or null when it can (or there are none). */
export function envReferenceProblem(spec: McpServerSpec, syntax: EnvReferenceSyntax): string | null {
  const headers = spec.transport === 'http' ? spec.headers : undefined;
  const env = spec.transport === 'stdio' ? spec.env : undefined;
  if (!hasReference(headers) && !hasReference(env)) return null;
  if (syntax === 'none') return NO_ENV_REFERENCE_REFUSAL;
  if (syntax === 'codex') {
    for (const [header, value] of Object.entries(headers ?? {})) {
      if (hasReference({ header: value }) && !wholeReference(value) && !bearerReference(header, value)) {
        return `Codex reads a header from a variable only whole (${header}: \${NAME}), or as Authorization: Bearer \${NAME}; ${header} is not one`;
      }
    }
  }
  if (syntax === 'codex' || syntax === 'goose') {
    const agent = syntax === 'codex' ? 'Codex' : 'Goose';
    for (const [name, value] of Object.entries(env ?? {})) {
      if (!hasReference({ name: value })) continue;
      const variable = wholeReference(value);
      if (variable !== name) return `${agent} passes a variable to a server only whole and under its own name (${name}: \${${name}}); ${name} is not one`;
    }
  }
  return null;
}

function translateInline(value: string, syntax: 'dollar' | 'opencode' | 'cursor'): string {
  if (syntax === 'dollar') return value;
  return value.replace(ENV_REFERENCE, (_match, name: string) => (syntax === 'opencode' ? `{env:${name}}` : `\${env:${name}}`));
}

function translateMap(values: Record<string, string> | undefined, syntax: 'dollar' | 'opencode' | 'cursor'): Record<string, string> | undefined {
  if (!values || Object.keys(values).length === 0) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, translateInline(value, syntax)]));
}

/** The MCP config formats claude-mem writes. */
export type McpEntryFormat = 'claude' | 'kimi' | 'opencode' | 'codex' | 'goose' | 'antigravity';

/** Which reference syntax each format reads (Appendix B). */
export const ENV_REFERENCE_SYNTAX_OF_FORMAT: Record<McpEntryFormat, EnvReferenceSyntax> = {
  claude: 'dollar',
  kimi: 'none',
  opencode: 'opencode',
  codex: 'codex',
  goose: 'goose',
  antigravity: 'none',
};

/** The server's entry in an agent's MCP config. Throws (with the refusal) when its references cannot be given to the agent. */
export function encodeMcpServerEntry(spec: McpServerSpec, format: McpEntryFormat, options: { cursorSyntax?: boolean; gooseName?: string; gooseTimeoutSeconds?: number } = {}): Record<string, LibraryValue> {
  const syntax = options.cursorSyntax ? 'cursor' : ENV_REFERENCE_SYNTAX_OF_FORMAT[format];
  const problem = envReferenceProblem(spec, syntax);
  if (problem) throw new Error(problem);
  const inline = syntax === 'cursor' || syntax === 'opencode' ? syntax : 'dollar';
  if (spec.transport === 'http') {
    const headers = translateMap(spec.headers, inline);
    switch (format) {
      case 'opencode':
        return { type: 'remote', url: spec.url!, ...(headers ? { headers } : {}) };
      case 'antigravity':
        return { serverUrl: spec.url!, ...(headers ? { headers } : {}) };
      case 'goose':
        return { enabled: true, type: 'streamable_http', name: options.gooseName ?? 'claude-mem', uri: spec.url!, ...(spec.headers ? { headers: spec.headers } : {}) };
      case 'codex': {
        const entry: Record<string, LibraryValue> = { url: spec.url! };
        const plain: Record<string, string> = {};
        const fromEnv: Record<string, string> = {};
        for (const [header, value] of Object.entries(spec.headers ?? {})) {
          const bearer = bearerReference(header, value);
          const whole = wholeReference(value);
          if (bearer) entry.bearer_token_env_var = bearer;
          else if (whole) fromEnv[header] = whole;
          else plain[header] = value;
        }
        if (Object.keys(plain).length > 0) entry.http_headers = plain;
        if (Object.keys(fromEnv).length > 0) entry.env_http_headers = fromEnv;
        return entry;
      }
      default:
        return { type: 'http', url: spec.url!, ...(headers ? { headers } : {}) };
    }
  }
  const args = spec.args ?? [];
  switch (format) {
    case 'opencode': {
      const environment = translateMap(spec.env, 'opencode');
      return { type: 'local', command: [spec.command!, ...args], ...(environment ? { environment } : {}) };
    }
    case 'kimi':
      return { type: 'stdio', command: spec.command!, args, ...(spec.env ? { env: spec.env } : {}) };
    case 'goose': {
      const envKeys = Object.keys(spec.env ?? {}).filter((name) => wholeReference(spec.env![name]) === name);
      return {
        enabled: true,
        type: 'stdio',
        name: options.gooseName ?? 'claude-mem',
        cmd: spec.command!,
        args,
        timeout: options.gooseTimeoutSeconds ?? 300,
        ...(envKeys.length > 0 ? { env_keys: envKeys } : {}),
      };
    }
    case 'codex': {
      const inherited = Object.keys(spec.env ?? {}).filter((name) => wholeReference(spec.env![name]) === name);
      const literal = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([name]) => !inherited.includes(name)));
      return {
        command: spec.command!,
        args,
        ...(Object.keys(literal).length > 0 ? { env: literal } : {}),
        ...(inherited.length > 0 ? { env_vars: inherited } : {}),
      };
    }
    default: {
      const env = translateMap(spec.env, inline);
      return { command: spec.command!, args, ...(env ? { env } : {}) };
    }
  }
}
