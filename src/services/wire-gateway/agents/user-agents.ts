// SPDX-License-Identifier: Apache-2.0
//
// User agent descriptors (plan Phase 8 task 1): JSON files under
// <DATA_DIR>/wire-gateway/agents/*.json describe agents the built-ins do not.
// They take fixed key paths (one `*` over object keys, JSON only), are
// zod-validated, and are refused when they reuse a built-in id or alias
// (magpie internal/agent/plugged.go:89-102, MIT, Copyright (c) 2026 yetone).
// Paths expand `~`, `$VAR` and `${VAR}`; a candidate naming an unset variable
// is skipped.
//
// {
//   "id": "my-agent", "name": "My Agent", "ua": ["my-agent"],
//   "detect": {"bin": "my-agent", "dirs": ["~/.my-agent"]},
//   "files": [{"key": "config", "path": "$MY_AGENT_HOME/config.json", "alternates": ["~/.my-agent/config.json"], "format": "json"}],
//   "targets": [{"file": "config", "keyPath": "providers.*.baseUrl", "kind": "baseUrl"}],
//   "identitySwitches": [{"file": "config", "keyPath": "sendSessionHeaders", "value": true}],
//   "authProbe": {"file": "config", "keyPath": "auth.type", "subscriptionWhen": {"equals": ["oauth"]}},
//   "launch": {"env": {"MY_AGENT_BASE_URL": "{baseUrl}"}, "baseUrlVariable": "MY_AGENT_BASE_URL",
//              "defaultUpstream": "https://api.example.com/v1"}
// }

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { expandHome } from '../../../shared/expand-home.js';
import { WIRE_GATEWAY_DIR } from '../../../shared/paths.js';
import { splitConfigKeyPath } from '../edit/text-shape.js';
import { WIRE_GATEWAY_ROUTE_ID_PATTERN, validateUpstreamBaseUrl } from '../routes.js';
import type { AgentDescriptor, AgentEnvironment } from './types.js';

export function defaultUserAgentsDirectory(): string {
  return join(WIRE_GATEWAY_DIR, 'agents');
}

const formatSchema = z.enum(['json', 'toml', 'yaml', 'env']);
const upstreamSchema = z.string().refine((value) => validateUpstreamBaseUrl(value) === null, { message: 'must be an http(s) URL with no query or fragment' });

const userAgentDescriptorSchema = z.object({
  id: z.string().regex(WIRE_GATEWAY_ROUTE_ID_PATTERN, 'lower-case letters, digits, ".", "_" and "-" only (at most 64)'),
  name: z.string().min(1).optional(),
  ua: z.array(z.string().min(1)).default([]),
  detect: z.object({ bin: z.string().min(1).optional(), dirs: z.array(z.string().min(1)).optional() }).strict().default({}),
  files: z.array(z.object({
    key: z.string().min(1),
    path: z.string().min(1),
    alternates: z.array(z.string().min(1)).optional(),
    format: formatSchema,
  }).strict()).default([]),
  targets: z.array(z.object({
    file: z.string().min(1),
    keyPath: z.string().min(1),
    kind: z.literal('baseUrl'),
    defaultUpstream: upstreamSchema.optional(),
  }).strict()).default([]),
  identitySwitches: z.array(z.object({
    file: z.string().min(1),
    keyPath: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }).strict()).default([]),
  authProbe: z.object({
    file: z.string().min(1),
    keyPath: z.string().min(1),
    subscriptionWhen: z.object({
      /** The value is one of these: a subscription. */
      equals: z.array(z.string()).optional(),
      /** The value is none of these (absent included): a subscription. */
      notEquals: z.array(z.string()).optional(),
    }).strict(),
  }).strict().optional(),
  launch: z.object({
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    baseUrlVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    defaultUpstream: upstreamSchema,
  }).strict().optional(),
}).strict();

type UserAgentDescriptorJson = z.infer<typeof userAgentDescriptorSchema>;

const ENV_REFERENCE_PATTERN = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** `~`, `$VAR`, `${VAR}`; null when a variable is unset (the candidate does not apply). `$HOME` is the environment's home. */
export function expandUserDescriptorPath(path: string, environment: AgentEnvironment): string | null {
  let unset = false;
  const expanded = path.replace(ENV_REFERENCE_PATTERN, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare)!;
    const value = name === 'HOME' ? environment.home : environment.env[name];
    if (!value) unset = true;
    return value ?? '';
  });
  return unset ? null : expandHome(expanded, environment.platform, environment.home);
}

function checkKeyPath(keyPath: string, where: string, options: { wildcardAllowed: boolean }): void {
  const segments = splitConfigKeyPath(keyPath);
  const wildcards = segments.filter((segment) => segment.matchesAnyKey).length;
  if (wildcards > 0 && !options.wildcardAllowed) throw new Error(`${where}: "*" is allowed only in a JSON target's key path`);
  if (wildcards > 1) throw new Error(`${where}: at most one "*" per key path`);
}

function toDescriptor(json: UserAgentDescriptorJson): AgentDescriptor {
  const fileFormats = new Map(json.files.map((file) => [file.key, file.format]));
  if (fileFormats.size !== json.files.length) throw new Error('files: two files share a key');
  const requireFile = (fileKey: string, where: string) => {
    const format = fileFormats.get(fileKey);
    if (!format) throw new Error(`${where}: no file with key "${fileKey}"`);
    return format;
  };
  json.targets.forEach((target, index) => {
    const format = requireFile(target.file, `targets[${index}]`);
    checkKeyPath(target.keyPath, `targets[${index}].keyPath`, { wildcardAllowed: format === 'json' });
  });
  json.identitySwitches.forEach((identitySwitch, index) => {
    requireFile(identitySwitch.file, `identitySwitches[${index}]`);
    checkKeyPath(identitySwitch.keyPath, `identitySwitches[${index}].keyPath`, { wildcardAllowed: false });
  });
  if (json.authProbe) {
    requireFile(json.authProbe.file, 'authProbe');
    checkKeyPath(json.authProbe.keyPath, 'authProbe.keyPath', { wildcardAllowed: false });
  }
  if (json.targets.length === 0 && !json.launch) throw new Error('a descriptor needs "targets" or "launch"');

  const authProbe = json.authProbe;
  const descriptorPaths = [...(json.detect.dirs ?? []), ...json.files.flatMap((file) => [file.path, ...(file.alternates ?? [])])];
  const pathVariables = [...new Set(descriptorPaths.flatMap((path) => [...path.matchAll(ENV_REFERENCE_PATTERN)].map((match) => (match[1] ?? match[2])!)))];
  return {
    id: json.id,
    name: json.name ?? json.id,
    userAgentPrefixes: json.ua.map((prefix) => prefix.toLowerCase()),
    detect: {
      bins: json.detect.bin ? [json.detect.bin] : undefined,
      directories: (environment) => (json.detect.dirs ?? [])
        .map((directory) => expandUserDescriptorPath(directory, environment))
        .filter((directory): directory is string => directory !== null),
    },
    files: json.files.map((file) => ({
      key: file.key,
      format: file.format,
      candidatePaths: (environment: AgentEnvironment) => [file.path, ...(file.alternates ?? [])]
        .map((candidate) => expandUserDescriptorPath(candidate, environment))
        .filter((candidate): candidate is string => candidate !== null),
    })),
    targets: json.targets.map(({ file, keyPath, defaultUpstream }) => ({ file, keyPath, defaultUpstream })),
    identitySwitches: json.identitySwitches,
    detectSubscription: authProbe
      ? (context) => {
        const value = context.readValue(authProbe.file, authProbe.keyPath);
        const text = typeof value === 'string' ? value : undefined;
        const { equals, notEquals } = authProbe.subscriptionWhen;
        if (equals && text !== undefined && equals.includes(text)) return `${authProbe.keyPath} is "${text}" (a subscription sign-in)`;
        if (notEquals && (text === undefined || !notEquals.includes(text))) {
          return `${authProbe.keyPath} is ${JSON.stringify(value ?? null)}, not one of ${notEquals.map((item) => `"${item}"`).join(', ')}`;
        }
        return null;
      }
      : undefined,
    launch: json.launch,
    pathVariables,
  };
}

export interface LoadedUserAgentDescriptors {
  descriptors: AgentDescriptor[];
  /** One line per descriptor file that was refused: its path and why. */
  refusals: string[];
}

/**
 * Every `*.json` under the directory. A file that does not parse, fails the
 * schema, or takes a name already in use is refused and reported; the others
 * load. A missing directory is no descriptors.
 */
export function loadUserAgentDescriptors(
  directory: string,
  takenNames: ReadonlySet<string>,
): LoadedUserAgentDescriptors {
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { descriptors: [], refusals: [] };
    throw error;
  }
  const descriptors: AgentDescriptor[] = [];
  const refusals: string[] = [];
  const usedIds = new Map<string, string>();
  for (const fileName of fileNames) {
    const sourcePath = join(directory, fileName);
    try {
      const parsed = userAgentDescriptorSchema.safeParse(JSON.parse(readFileSync(sourcePath, 'utf-8')));
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(top)'}: ${issue.message}`).join('; '));
      }
      if (takenNames.has(parsed.data.id)) throw new Error(`agent id "${parsed.data.id}" is a built-in agent's`);
      const earlier = usedIds.get(parsed.data.id);
      if (earlier) throw new Error(`agent id "${parsed.data.id}" is ${earlier}'s too`);
      descriptors.push(toDescriptor(parsed.data));
      usedIds.set(parsed.data.id, fileName);
    } catch (error) {
      refusals.push(`${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { descriptors, refusals };
}
