// SPDX-License-Identifier: Apache-2.0
//
// What `claude-mem wire status` says of the rewrite features per route
// (plan Phase 12): whether memory injection, the hidden memory_search tool
// and Endless Mode are on, and whether a route's own switch or the setting
// decided it; with the running gateway's stage counters when it answers.

import { endlessModeEnabledFor } from '../endless/endless-mode-stage.js';
import type { WireGatewayRoute } from '../routes.js';
import type { WireRewriteStageState } from '../rewrite/rewrite-stage.js';
import { memoryInjectionEnabledFor } from './memory-injection-stage.js';
import { memorySearchToolEnabledFor } from './memory-search-stage.js';

export interface WireFeatureState {
  on: boolean;
  /** `route`: the route's own switch; `setting`: the gateway-wide setting (or the default). */
  decidedBy: 'route' | 'setting';
}

export interface WireRouteFeaturesStatus {
  routeId: string;
  agentId: string;
  captureSource: WireGatewayRoute['captureSource'];
  memoryInjection: WireFeatureState;
  memorySearchTool: WireFeatureState;
  endlessMode: WireFeatureState;
}

export interface WireMemoryStatus {
  routes: WireRouteFeaturesStatus[];
  /** Each stage's calls and failures, from the running gateway; null when it did not answer. */
  stages: Record<string, WireRewriteStageState> | null;
  /** Where claude-mem's MCP tools answer over HTTP on the gateway. */
  mcpPath: '/mcp';
}

function featureState(
  route: WireGatewayRoute,
  feature: 'memoryInjection' | 'memorySearchTool' | 'endlessMode',
  enabledFor: (route: WireGatewayRoute, settings: Readonly<Record<string, string>>) => boolean,
  settings: Readonly<Record<string, string>>,
): WireFeatureState {
  return { on: enabledFor(route, settings), decidedBy: route.features?.[feature] === undefined ? 'setting' : 'route' };
}

export function buildWireMemoryStatus(
  routes: Record<string, WireGatewayRoute>,
  settings: Readonly<Record<string, string>>,
  stages: Record<string, WireRewriteStageState> | null,
): WireMemoryStatus {
  return {
    routes: Object.entries(routes).sort(([first], [second]) => first.localeCompare(second)).map(([routeId, route]) => ({
      routeId,
      agentId: route.agentId,
      captureSource: route.captureSource,
      memoryInjection: featureState(route, 'memoryInjection', memoryInjectionEnabledFor, settings),
      memorySearchTool: featureState(route, 'memorySearchTool', memorySearchToolEnabledFor, settings),
      endlessMode: featureState(route, 'endlessMode', endlessModeEnabledFor, settings),
    })),
    stages,
    mcpPath: '/mcp',
  };
}

function stateText(state: WireFeatureState): string {
  return `${state.on ? 'on' : 'off'}${state.decidedBy === 'route' ? ' (route)' : ''}`;
}

export function formatWireMemoryStatus(status: WireMemoryStatus, gatewayOrigin: string): string[] {
  const lines = ['', `Memory: MCP tools at ${gatewayOrigin}${status.mcpPath}`];
  if (status.routes.length === 0) return lines;
  const idWidth = Math.max(5, ...status.routes.map(route => route.routeId.length));
  lines.push(`${'ROUTE'.padEnd(idWidth)}  ${'INJECTION'.padEnd(13)}  ${'MEMORY_SEARCH'.padEnd(13)}  ENDLESS`);
  for (const route of status.routes) {
    lines.push(`${route.routeId.padEnd(idWidth)}  ${stateText(route.memoryInjection).padEnd(13)}  ${stateText(route.memorySearchTool).padEnd(13)}  ${stateText(route.endlessMode)}`);
  }
  for (const [stageName, stage] of Object.entries(status.stages ?? {})) {
    lines.push(`  stage ${stageName}: ${stage.calls} calls, ${stage.failures} failures${stage.lastError ? ` (last: ${stage.lastError})` : ''}`);
  }
  return lines;
}
