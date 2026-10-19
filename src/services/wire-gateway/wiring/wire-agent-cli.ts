// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire connect|disconnect|preview|run <agent>` (plan Phase 8).
// The daemon lifecycle comes in through WireAgentCliRuntime, so this module
// does not import WireGatewayService (which imports it).

import { spawnSync } from 'child_process';
import { isAbsolute } from 'path';
import { DATA_DIR, WIRE_GATEWAY_DIR, paths } from '../../../shared/paths.js';
import { formatHostForUrl } from '../../../shared/worker-url.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import type { WireGatewayConfig } from '../config.js';
import {
  installWireGatewayOsService,
  isWireGatewayOsServiceInstalled,
  uninstallWireGatewayOsService,
} from '../os-service.js';
import { requestJsonDirectly } from '../direct-http.js';
import { probeIdentityDirectly } from '../drift/reachability.js';
import type { WireGatewayCaptureSource } from '../routes.js';
import { currentAgentEnvironment } from '../agents/agent-paths.js';
import { loadAgentRegistry, requireAgentDescriptor } from '../agents/agent-registry.js';
import type { AgentDescriptor } from '../agents/types.js';
import { formatConfigDiffLine } from './config-diff.js';
import { runAgentThroughGateway, spawnAgentWithInheritedStdio } from './launcher.js';
import { PREVIEW_SANDBOX_FLAG, runWirePreview } from './preview.js';
import {
  connectAgent,
  disconnectAgent,
  type ConnectResult,
  type DisconnectResult,
  type WiringOptions,
  type WiringSideEffects,
} from './wiring-engine.js';
import { defaultWiringDirectory } from './wiring-records.js';

export interface WireAgentCliRuntime {
  config: WireGatewayConfig;
  bunPath: string;
  /** The wire gateway script (`… start --foreground` for the OS service, and the preview subprocess). */
  scriptPath: string;
  /** Start the daemon unless it runs; resolves once it answers. */
  startDaemon(): Promise<void>;
  stopDaemon(): Promise<void>;
  writeLine(line: string): void;
  writeErrorLine(line: string): void;
}

const ROUTE_PROBE_ATTEMPTS = 20;
const ROUTE_PROBE_INTERVAL_MS = 150;

/** Never through a proxy: behind one, a fetch would fail and connect would undo itself (direct-http.ts). */
export async function probeRouteIdentity(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < ROUTE_PROBE_ATTEMPTS; attempt++) {
    if (await probeIdentityDirectly(url, 1_000)) return true;
    await new Promise((resolve) => setTimeout(resolve, ROUTE_PROBE_INTERVAL_MS));
  }
  return false;
}

function readAgentVersion(executable: string): string | null {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true, env: sanitizeEnv(process.env) });
  return result.status === 0 ? result.stdout : null;
}

function gatewayOrigin(config: WireGatewayConfig): string {
  return `http://${formatHostForUrl(config.host)}:${config.port}`;
}

function sideEffectsFor(runtime: WireAgentCliRuntime, inPreviewSandbox: boolean): WiringSideEffects {
  if (inPreviewSandbox) {
    // The sandboxed run changes files only: no daemon, no OS service, nothing to probe.
    return {
      ensureGatewayRunning: async () => undefined,
      stopGateway: async () => undefined,
      isOsServiceInstalled: () => true,
      installOsService: () => '',
      uninstallOsService: () => '',
      probeRouteIdentity: async () => true,
    };
  }
  return {
    ensureGatewayRunning: () => runtime.startDaemon(),
    stopGateway: () => runtime.stopDaemon(),
    isOsServiceInstalled: isWireGatewayOsServiceInstalled,
    installOsService: () => installWireGatewayOsService({ bunPath: runtime.bunPath, scriptPath: runtime.scriptPath, drainTimeoutMs: runtime.config.drainTimeoutMs, host: runtime.config.host, port: runtime.config.port }),
    uninstallOsService: uninstallWireGatewayOsService,
    probeRouteIdentity,
  };
}

function wiringOptions(runtime: WireAgentCliRuntime, inPreviewSandbox: boolean): WiringOptions {
  const environment = currentAgentEnvironment();
  return {
    environment,
    // The preview copy of the agent's files is under the sandbox home; a path that resolves elsewhere is refused.
    confineAgentFileWritesTo: inPreviewSandbox ? environment.home : undefined,
    gatewayOrigin: gatewayOrigin(runtime.config),
    wiringDirectory: defaultWiringDirectory(),
    routesFilePath: paths.wireGatewayRoutes(),
    sideEffects: sideEffectsFor(runtime, inPreviewSandbox),
    helpers: { readAgentVersion },
    forwardSubscriptionSignIns: runtime.config.forwardSubscriptionSignIns,
  };
}

function describeCaptureSource(captureSource: WireGatewayCaptureSource): string {
  return captureSource === 'wire'
    ? 'wire (the gateway records this agent into claude-mem)'
    : 'native (its claude-mem integration records it; the gateway relays and never records it)';
}

function formatValue(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

export function printConnectResult(result: ConnectResult, writeLine: (line: string) => void): void {
  const { plan } = result;
  const { descriptor } = plan;
  if (result.alreadyConnected) {
    writeLine(`${descriptor.name} is already connected (routes: ${plan.routes.map((route) => route.routeId).join(', ')})`);
    return;
  }
  writeLine(`Connected ${descriptor.name}`);
  for (const route of plan.routes) {
    writeLine(`  ${route.filePath}: ${route.keyPath} → ${route.agentBaseUrl}`);
    writeLine(`    route ${route.routeId} relays to ${route.upstreamBaseUrl}${route.upstreamSource === 'default' ? ` (${descriptor.name}'s built-in endpoint)` : ''}`);
  }
  for (const identitySwitch of plan.identitySwitches) {
    writeLine(`  ${identitySwitch.filePath}: ${identitySwitch.keyPath} = ${formatValue(identitySwitch.value)} (identity headers)`);
  }
  writeLine(`  Capture: ${describeCaptureSource(plan.captureSource)}`);
  writeLine('  Features: the route uses the CLAUDE_MEM_WIRE_GATEWAY_* defaults');
  for (const note of plan.notes) writeLine(`  Note: ${note}`);
  for (const message of result.messages) writeLine(`  ${message}`);
  writeLine(`  Undo: claude-mem wire disconnect ${descriptor.id}`);
}

export function printDisconnectResult(descriptor: AgentDescriptor, result: DisconnectResult, writeLine: (line: string) => void): void {
  if (!result.wasConnected) {
    writeLine(result.removedRouteIds.length > 0
      ? `${descriptor.name} had no config changes to undo; removed route(s) ${result.removedRouteIds.join(', ')}`
      : `${descriptor.name} is not connected`);
  } else {
    writeLine(`Disconnected ${descriptor.name}`);
    for (const field of result.fields) {
      if (field.outcome === 'restored') writeLine(`  restored ${field.filePath}: ${field.keyPath}`);
      else writeLine(`  replaced ${field.filePath}: ${field.keyPath} is now ${formatValue(field.currentValue)}, changed outside claude-mem; left as it is`);
    }
    if (result.removedRouteIds.length > 0) writeLine(`  removed route(s) ${result.removedRouteIds.join(', ')}`);
  }
  if (result.lastRouteRemoved) writeLine('  That was the last route: the wire gateway stopped.');
  for (const message of result.messages) writeLine(`  ${message}`);
}

/** `--cwd <dir>`: the folder the agent starts in (the npx CLI passes the user's; the plugin runs from its own). */
function parseWorkingDirectoryFlag(args: string[]): string {
  const index = args.indexOf('--cwd');
  if (index === -1) return process.cwd();
  const value = args[index + 1];
  if (!value || !isAbsolute(value)) throw new Error('--cwd needs an absolute folder');
  return value;
}

function parseCaptureFlag(args: string[]): WireGatewayCaptureSource | undefined {
  const index = args.indexOf('--capture');
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value !== 'wire' && value !== 'native') throw new Error('--capture must be "wire" or "native"');
  return value;
}

/** `connect|disconnect|preview|run <agent> …`. Returns the exit code. */
export async function runWireAgentCli(command: 'connect' | 'disconnect' | 'preview' | 'run', args: string[], runtime: WireAgentCliRuntime): Promise<number> {
  const separatorIndex = args.indexOf('--');
  const ownArguments = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const agentArguments = separatorIndex === -1 ? args.slice(1) : args.slice(separatorIndex + 1);
  const agentName = ownArguments[0];
  if (!agentName || agentName.startsWith('--')) {
    runtime.writeErrorLine(`Usage: claude-mem wire ${command} <agent>${command === 'run' ? ' -- <args>' : ''}`);
    return 1;
  }
  const registry = loadAgentRegistry();
  for (const refusal of registry.refusals) runtime.writeErrorLine(`Refused agent descriptor ${refusal}`);
  const descriptor = requireAgentDescriptor(registry, agentName);
  const inPreviewSandbox = ownArguments.includes(PREVIEW_SANDBOX_FLAG);

  switch (command) {
    case 'connect': {
      const result = await connectAgent(descriptor, wiringOptions(runtime, inPreviewSandbox), { captureSource: parseCaptureFlag(ownArguments) });
      printConnectResult(result, runtime.writeLine);
      return 0;
    }
    case 'disconnect': {
      const result = await disconnectAgent(descriptor.id, wiringOptions(runtime, inPreviewSandbox));
      printDisconnectResult(descriptor, result, runtime.writeLine);
      return 0;
    }
    case 'preview': {
      const disconnect = ownArguments.includes('--disconnect');
      const environment = currentAgentEnvironment();
      const native = descriptor.nativeIntegration;
      const result = runWirePreview({
        descriptor,
        disconnect,
        captureSource: native && (native.alwaysNative || native.isInstalled(environment)) ? 'native' : undefined,
        environment,
        dataDirectory: DATA_DIR,
        wireGatewayDirectory: WIRE_GATEWAY_DIR,
        bunPath: runtime.bunPath,
        scriptPath: runtime.scriptPath,
      });
      runtime.writeLine(`Preview of \`claude-mem wire ${disconnect ? 'disconnect' : 'connect'} ${descriptor.id}\` (nothing was changed):`);
      if (result.changes.length === 0) runtime.writeLine('  No file would change.');
      for (const change of result.changes) {
        runtime.writeLine(`${change.displayPath}${change.created ? ' (new file)' : change.removed ? ' (removed)' : ''}`);
        for (const line of change.lines) runtime.writeLine(`  ${formatConfigDiffLine(line)}`);
      }
      return 0;
    }
    case 'run': {
      const environment = currentAgentEnvironment();
      const native = descriptor.nativeIntegration;
      const captureSource: WireGatewayCaptureSource = parseCaptureFlag(ownArguments)
        ?? (native && (native.alwaysNative || native.isInstalled(environment)) ? 'native' : 'wire');
      return runAgentThroughGateway(descriptor, agentArguments, {
        environment,
        cwd: parseWorkingDirectoryFlag(ownArguments),
        gatewayOrigin: gatewayOrigin(runtime.config),
        routesFilePath: paths.wireGatewayRoutes(),
        ensureGatewayRunning: () => runtime.startDaemon(),
        createLaunch: (agentId, cwd) => createLaunch(gatewayOrigin(runtime.config), agentId, cwd),
        spawnAgent: spawnAgentWithInheritedStdio,
      }, captureSource);
    }
  }
}

/** `POST /wire/launch` on the running gateway, never through a proxy (direct-http.ts). */
export async function createLaunch(origin: string, agentId: string, cwd: string): Promise<string> {
  const answer = await requestJsonDirectly<{ launchId?: unknown; error?: { message?: string } }>({
    url: `${origin}/wire/launch`,
    method: 'POST',
    jsonBody: { agentId, cwd },
    timeoutMs: 5_000,
  });
  if (!answer) throw new Error(`the wire gateway did not answer at ${origin}`);
  const launchId = answer.body?.launchId;
  if (answer.statusCode !== 200 || typeof launchId !== 'string') {
    throw new Error(`the wire gateway refused the launch: ${answer.body?.error?.message ?? `HTTP ${answer.statusCode}`}`);
  }
  return launchId;
}
