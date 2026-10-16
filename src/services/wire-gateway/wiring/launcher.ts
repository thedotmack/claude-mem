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
import { constants } from 'os';
import { relaySignalsToInteractiveChild } from '../../../shared/interactive-child-signals.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { addWireGatewayRoute, readWireGatewayRoutesFile, type WireGatewayCaptureSource } from '../routes.js';
import { isExecutableOnPath } from '../agents/agent-paths.js';
import type { AgentDescriptor, AgentEnvironment } from '../agents/types.js';
import { isGatewayRouteUrl, splitUpstreamForRoute } from './wiring-engine.js';

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
  launchBaseUrl: string;
}

/** The env value the agent already has, unless it is this gateway's own URL. */
function currentUpstream(descriptor: AgentDescriptor, dependencies: LaunchDependencies): string {
  const launch = descriptor.launch!;
  const fromEnvironment = dependencies.environment.env[launch.baseUrlVariable];
  if (fromEnvironment && !isGatewayRouteUrl(fromEnvironment, dependencies.gatewayOrigin)) return fromEnvironment;
  if (launch.defaultUpstream) return launch.defaultUpstream;
  throw new Error(`${descriptor.name} has no default endpoint: set ${launch.baseUrlVariable} to your provider's URL, then run this again`);
}

/**
 * Pick (or add) the route and make the launch. The agent's own route is used
 * when it relays to the same upstream; otherwise a `<agentId>-launch` route
 * carries the launch, so a config-wired route keeps its upstream.
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
  const routes = readWireGatewayRoutesFile(dependencies.routesFilePath).routes;
  const upstreamValue = currentUpstream(descriptor, dependencies);
  const ownRoute = Object.hasOwn(routes, descriptor.id) ? routes[descriptor.id] : undefined;
  const { upstreamBaseUrl } = splitUpstreamForRoute(upstreamValue, dependencies.gatewayOrigin, descriptor.id);
  const routeId = !ownRoute || (ownRoute.agentId === descriptor.id && ownRoute.upstreamBaseUrl === upstreamBaseUrl)
    ? descriptor.id
    : `${descriptor.id}-launch`;
  const existing = Object.hasOwn(routes, routeId) ? routes[routeId] : undefined;
  if (existing && existing.agentId !== descriptor.id) {
    throw new Error(`Route "${routeId}" belongs to agent ${existing.agentId}; remove it (claude-mem wire routes remove ${routeId}) first`);
  }
  if (!existing || existing.upstreamBaseUrl !== upstreamBaseUrl) {
    addWireGatewayRoute({ routeId, agentId: descriptor.id, upstreamBaseUrl, captureSource }, dependencies.routesFilePath);
  }

  const launchId = await dependencies.createLaunch(descriptor.id, dependencies.cwd);
  const { agentBaseUrl } = splitUpstreamForRoute(upstreamValue, dependencies.gatewayOrigin, `${routeId}/l/${launchId}`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizeEnv({ ...dependencies.environment.env }))) {
    if (value !== undefined) env[name] = value;
  }
  for (const [name, template] of Object.entries(launch.env)) env[name] = template.replaceAll('{baseUrl}', agentBaseUrl);
  // The agent is the user's, not a claude-mem helper: its own hooks must record it.
  delete env.CLAUDE_MEM_INTERNAL;
  return { executablePath, args, env, routeId, launchBaseUrl: agentBaseUrl };
}

/**
 * Spawn with inherited stdio and pass the exit code through (a signal death is
 * 128 + its number). Ctrl-C is the agent's; SIGTERM/SIGHUP are relayed to it.
 */
export function spawnAgentWithInheritedStdio(executablePath: string, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // `env` was built from sanitizeEnv in prepareAgentLaunch.
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
): Promise<number> {
  const prepared = await prepareAgentLaunch(descriptor, agentArguments, dependencies, captureSource);
  return dependencies.spawnAgent(prepared.executablePath, prepared.args, prepared.env, dependencies.cwd);
}
