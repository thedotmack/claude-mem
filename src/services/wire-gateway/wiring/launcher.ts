// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire run <agent> -- <args>` (plan Phase 8 task 5): start an
// agent with its base-URL env var pointed at a launcher session,
// `/r/<route>/l/<launchId>/…` (D8), so its session and folder are known from
// the first request. It covers agents set by environment only (Antigravity
// CLI, Cursor Private Inference) and any agent whose descriptor has `launch`.
//
// Launches live in the daemon's memory (identity/launch-registry.ts, plan
// Phase 4 task 10): a restarted daemon forgets them and the agent's requests
// still relay, identified by their own session ids. That is enough for a
// launcher, so they are not persisted.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { constants } from 'os';
import { relaySignalsToInteractiveChild } from '../../../shared/interactive-child-signals.js';
import { sanitizeEnvForUserAgentLaunch } from '../../../supervisor/env-sanitizer.js';
import {
  addWireGatewayRouteWhileRoutesFileIsLocked,
  readWireGatewayRoutesFile,
  withWireGatewayRoutesFileLock,
  type WireGatewayCaptureSource,
  type WireGatewayRoute,
} from '../routes.js';
import { isExecutableOnPath } from '../agents/agent-paths.js';
import type { AgentDescriptor, AgentEnvironment } from '../agents/types.js';
import { isGatewayRouteUrl, readCurrentBaseUrlTargets, splitUpstreamForRoute } from './wiring-engine.js';

export interface LaunchDependencies {
  environment: AgentEnvironment;
  cwd: string;
  gatewayOrigin: string;
  routesFilePath: string;
  ensureGatewayRunning(): Promise<void>;
  /** `POST /wire/launch {agentId, cwd}` → launchId. */
  createLaunch(agentId: string, cwd: string): Promise<string>;
  /** Spawn the agent in `cwd` with stdio inherited; resolves to its exit code. */
  spawnAgent(executablePath: string, args: string[], env: Record<string, string>, cwd: string): Promise<number>;
}

export interface PreparedLaunch {
  executablePath: string;
  args: string[];
  env: Record<string, string>;
  routeId: string;
  launchId: string;
}

/** What `wire run` does once the agent has exited. */
export interface AfterAgentExit {
  /** `GET /wire/launch?launchId=` → how many requests the launch relayed; null when the gateway cannot say. */
  countLaunchRequests(launchId: string): Promise<number | null>;
  writeErrorLine(line: string): void;
}

/**
 * A gateway route URL (`<origin>/r/<routeId>/<path>`) turned back into the
 * provider URL it relays to: that route's upstream plus the path.
 */
function upstreamBehindGatewayUrl(gatewayUrl: string, routes: Record<string, WireGatewayRoute>, where: string): string {
  const [, routeId = '', ...pathSegments] = new URL(gatewayUrl).pathname.slice(1).split('/');
  const route = Object.hasOwn(routes, routeId) ? routes[routeId] : undefined;
  if (!route) {
    throw new Error(`${where} points at the wire gateway's route "${routeId}", which does not exist; set it back to your provider's URL (or run claude-mem wire disconnect), then run this again`);
  }
  // A launch URL (`/r/<routeId>/l/<launchId>/<path>`, e.g. `wire run` from inside a launched agent) keeps only its path.
  const providerPathSegments = pathSegments[0] === 'l' ? pathSegments.slice(2) : pathSegments;
  const path = providerPathSegments.length > 0 ? `/${providerPathSegments.join('/')}` : '';
  return `${route.upstreamBaseUrl}${path}`;
}

/**
 * The provider URL the agent would use without the gateway: its env var,
 * else the base URL saved in its own config (e.g. GOOGLE_GEMINI_BASE_URL in
 * ~/.gemini/.env, read the way `wire status` reads it), else its built-in
 * endpoint. A value that is already one of this gateway's route URLs stands
 * for that route's upstream; an env value does so before the saved config is
 * read, so `wire run` inside a launched agent keeps the outer launch's
 * provider even when the saved config names another.
 */
function currentUpstream(descriptor: AgentDescriptor, dependencies: LaunchDependencies, routes: Record<string, WireGatewayRoute>): string {
  const launch = descriptor.launch!;
  const fromEnvironment = dependencies.environment.env[launch.baseUrlVariable];
  if (fromEnvironment) {
    if (!isGatewayRouteUrl(fromEnvironment, dependencies.gatewayOrigin)) return fromEnvironment;
    return upstreamBehindGatewayUrl(fromEnvironment, routes, launch.baseUrlVariable);
  }
  let savedTargets: ReturnType<typeof readCurrentBaseUrlTargets>;
  try {
    savedTargets = readCurrentBaseUrlTargets(descriptor, dependencies.environment);
  } catch (error) {
    throw new Error(`${descriptor.name}: could not read its saved base URL (${error instanceof Error ? error.message : String(error)}); fix the file or set ${launch.baseUrlVariable}, then run this again`);
  }
  for (const target of savedTargets) {
    if (typeof target.value !== 'string' || target.value === '') continue;
    if (!isGatewayRouteUrl(target.value, dependencies.gatewayOrigin)) return target.value;
    return upstreamBehindGatewayUrl(target.value, routes, `${target.keyPath} in ${target.filePath}`);
  }
  if (launch.defaultUpstream) return launch.defaultUpstream;
  throw new Error(`${descriptor.name} has no default endpoint: set ${launch.baseUrlVariable} to your provider's URL, then run this again`);
}

const LAUNCH_ROUTE_UPSTREAM_HASH_LENGTH = 10;

/**
 * `<agentId>-launch-<hash of the upstream>`: each upstream gets its own
 * launch route, so a launch to another provider never repoints the route an
 * earlier, still-running launch relays through.
 */
function launchRouteIdFor(agentId: string, upstreamBaseUrl: string): string {
  const upstreamHash = createHash('sha256').update(upstreamBaseUrl).digest('hex').slice(0, LAUNCH_ROUTE_UPSTREAM_HASH_LENGTH);
  const suffix = `-launch-${upstreamHash}`;
  return `${agentId.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * Under the routes lock: pick the route for this upstream, add it when
 * missing, and bring a reused route's capture source up to date (native
 * hooks installed or removed since it was made). A route that relays
 * elsewhere is never repointed: it may carry a running launch.
 */
function claimLaunchRoute(agentId: string, upstreamBaseUrl: string, captureSource: WireGatewayCaptureSource, routesFilePath: string): string {
  return withWireGatewayRoutesFileLock(routesFilePath, () => {
    const routes = readWireGatewayRoutesFile(routesFilePath).routes;
    const ownRoute = Object.hasOwn(routes, agentId) ? routes[agentId] : undefined;
    const routeId = !ownRoute || (ownRoute.agentId === agentId && ownRoute.upstreamBaseUrl === upstreamBaseUrl)
      ? agentId
      : launchRouteIdFor(agentId, upstreamBaseUrl);
    const existing = Object.hasOwn(routes, routeId) ? routes[routeId] : undefined;
    if (existing && existing.agentId !== agentId) {
      throw new Error(`Route "${routeId}" belongs to agent ${existing.agentId}; remove it (claude-mem wire routes remove ${routeId}) first`);
    }
    if (existing && existing.upstreamBaseUrl !== upstreamBaseUrl) {
      throw new Error(`Route "${routeId}" already relays to ${existing.upstreamBaseUrl}, not ${upstreamBaseUrl}; remove it (claude-mem wire routes remove ${routeId}) first`);
    }
    if (!existing || existing.captureSource !== captureSource) {
      addWireGatewayRouteWhileRoutesFileIsLocked({ routeId, agentId, upstreamBaseUrl, captureSource, features: existing?.features }, routesFilePath);
    }
    return routeId;
  });
}

/**
 * Pick (or add) the route and make the launch. The agent's own route is used
 * when it relays to the same upstream; otherwise a launch route for that
 * upstream carries it, so a config-wired route keeps its upstream.
 */
export async function prepareAgentLaunch(
  descriptor: AgentDescriptor,
  agentArguments: string[],
  dependencies: LaunchDependencies,
  captureSource: WireGatewayCaptureSource,
): Promise<PreparedLaunch> {
  const launch = descriptor.launch;
  if (!launch) {
    throw new Error(`${descriptor.name} is wired through its config, not its environment: run \`claude-mem wire connect ${descriptor.id}\`, then start it as usual`);
  }
  let command = descriptor.detect.bins?.find((bin) => isExecutableOnPath(dependencies.environment, bin));
  let args = agentArguments;
  if (!command) {
    if (agentArguments.length === 0) {
      throw new Error(`${descriptor.name}'s command was not found on PATH${descriptor.detect.bins ? ` (${descriptor.detect.bins.join(', ')})` : ''}; give it after --: claude-mem wire run ${descriptor.id} -- <command> [args]`);
    }
    [command, ...args] = agentArguments;
  }
  const searchPath = dependencies.environment.env.PATH ?? dependencies.environment.env.Path ?? '';
  const executablePath = Bun.which(command, { PATH: searchPath, cwd: dependencies.cwd });
  if (!executablePath) throw new Error(`${command} was not found on PATH`);

  await dependencies.ensureGatewayRunning();
  const upstreamValue = currentUpstream(descriptor, dependencies, readWireGatewayRoutesFile(dependencies.routesFilePath).routes);
  const { upstreamBaseUrl } = splitUpstreamForRoute(upstreamValue, dependencies.gatewayOrigin, descriptor.id);
  const routeId = claimLaunchRoute(descriptor.id, upstreamBaseUrl, captureSource, dependencies.routesFilePath);

  const launchId = await dependencies.createLaunch(descriptor.id, dependencies.cwd);
  const { agentBaseUrl } = splitUpstreamForRoute(upstreamValue, dependencies.gatewayOrigin, `${routeId}/l/${launchId}`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizeEnvForUserAgentLaunch({ ...dependencies.environment.env }))) {
    if (value !== undefined) env[name] = value;
  }
  for (const [name, template] of Object.entries(launch.env)) env[name] = template.replaceAll('{baseUrl}', agentBaseUrl);
  // The agent is the user's, not a claude-mem helper: its own hooks must record it.
  delete env.CLAUDE_MEM_INTERNAL;
  return { executablePath, args, env, routeId, launchId };
}

/**
 * Spawn with inherited stdio and pass the exit code through (a signal death is
 * 128 + its number). Ctrl-C is the agent's; SIGTERM/SIGHUP are relayed to it.
 */
export function spawnAgentWithInheritedStdio(executablePath: string, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // `env` was built from sanitizeEnvForUserAgentLaunch in prepareAgentLaunch.
    const child = spawn(executablePath, args, { stdio: 'inherit', env, cwd });
    const stopRelaying = relaySignalsToInteractiveChild(child);
    child.on('error', (error) => {
      stopRelaying();
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      stopRelaying();
      resolve(exitCode ?? 128 + (signal ? constants.signals[signal] : 1));
    });
  });
}

export async function runAgentThroughGateway(
  descriptor: AgentDescriptor,
  agentArguments: string[],
  dependencies: LaunchDependencies,
  captureSource: WireGatewayCaptureSource,
  afterExit: AfterAgentExit,
): Promise<number> {
  const prepared = await prepareAgentLaunch(descriptor, agentArguments, dependencies, captureSource);
  const exitCode = await dependencies.spawnAgent(prepared.executablePath, prepared.args, prepared.env, dependencies.cwd);
  // An agent that ignores the base URL variable (Antigravity's agy with a
  // Google sign-in, seen live) runs fine and records nothing: say so.
  if (await afterExit.countLaunchRequests(prepared.launchId) === 0) {
    afterExit.writeErrorLine(
      `claude-mem: ${descriptor.name} sent no requests through the wire gateway, so nothing from this run was recorded. `
      + `It likely used its own endpoint instead of ${descriptor.launch!.baseUrlVariable}${captureSource === 'native' ? ' (its claude-mem hooks may still have recorded it)' : ''}.`,
    );
  }
  return exitCode;
}
