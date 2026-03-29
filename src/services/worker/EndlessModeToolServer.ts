/**
 * EndlessModeToolServer: MCP tool server for cooperative session cycling
 *
 * Provides two custom MCP tools that allow the active agent to cooperatively
 * participate in cycle decisions rather than being force-aborted:
 *
 * 1. `cycle_status` - Agent checks whether cycling is recommended based on
 *    context pressure (observation count, time elapsed, etc.)
 * 2. `complete_cycle` - Agent signals graceful cycle completion with a summary
 *
 * The server is created in-process using the Agent SDK's `createSdkMcpServer()`
 * helper, which wraps an MCP McpServer instance. The resulting config object is
 * passed directly to `query()` via `options.mcpServers`.
 *
 * Lifecycle: EndlessRunner creates one tool server per orchestrator run.
 * The cycle state resets between cycles, but the server instance persists
 * so the agent always has access to the tools.
 */

import { z } from 'zod';
import { logger } from '../../utils/logger.js';

// @ts-ignore - Agent SDK types may not be available
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

/**
 * Thresholds that govern when cycle_status recommends cycling.
 * These are intentionally conservative for MVP -- the agent always has
 * the final say via complete_cycle.
 */
const CYCLE_THRESHOLDS = {
  /** Observations stored before we suggest cycling */
  observationCountSoftLimit: 3,
  /** Elapsed seconds before we suggest cycling regardless of observation count */
  elapsedTimeSoftLimitSeconds: 300, // 5 minutes
} as const;

/**
 * Mutable state shared between the tool handlers and the EndlessRunner.
 * EndlessRunner resets this at the start of each cycle and reads
 * `completeCycleRequested` + `cycleSummary` to know when to transition.
 */
export interface CycleState {
  /** Number of observations stored in the current cycle */
  observationCount: number;
  /** Epoch ms when the current cycle started */
  cycleStartedAt: number;
  /** Set to true when the agent calls complete_cycle */
  completeCycleRequested: boolean;
  /** Summary provided by the agent via complete_cycle */
  cycleSummary: string | null;
  /** Promise resolver -- EndlessRunner awaits this to know when complete_cycle fires */
  onCompleteCycle: (() => void) | null;
}

/**
 * Create a fresh CycleState for a new cycle.
 */
export function createCycleState(): CycleState {
  return {
    observationCount: 0,
    cycleStartedAt: Date.now(),
    completeCycleRequested: false,
    cycleSummary: null,
    onCompleteCycle: null,
  };
}

/**
 * Build the in-process MCP tool server for endless mode cooperative cycling.
 *
 * Returns the server config (suitable for `options.mcpServers`) and a reference
 * to the mutable CycleState that the tool handlers read/write.
 *
 * The caller (EndlessRunner) is responsible for:
 * - Resetting cycleState between cycles via `resetCycleState()`
 * - Incrementing `cycleState.observationCount` when observations are confirmed
 * - Awaiting the `completeCyclePromise` to detect when the agent requests cycling
 */
export function createEndlessModeToolServer() {
  const cycleState = createCycleState();

  // Mutable holder for the promise that resolves when complete_cycle is called.
  // Recreated each cycle via resetCycleState().
  let completeCyclePromise: Promise<void>;
  let completeCycleResolve: () => void;

  function refreshCompleteCyclePromise() {
    completeCyclePromise = new Promise<void>((resolve) => {
      completeCycleResolve = resolve;
      cycleState.onCompleteCycle = resolve;
    });
  }
  refreshCompleteCyclePromise();

  // --- Tool definitions ---

  const cycleStatusTool = tool(
    'cycle_status',
    'Check whether a session cycle transition is recommended. Call this periodically ' +
    'to learn if context pressure is high enough that you should wrap up your current ' +
    'work and call complete_cycle. Returns should_cycle (boolean), reason, and a ' +
    'normalized context_pressure score (0.0 - 1.0).',
    {}, // no input parameters
    async () => {
      const elapsedMs = Date.now() - cycleState.cycleStartedAt;
      const elapsedSeconds = elapsedMs / 1000;

      const observationPressure = Math.min(
        cycleState.observationCount / CYCLE_THRESHOLDS.observationCountSoftLimit,
        1.0
      );
      const timePressure = Math.min(
        elapsedSeconds / CYCLE_THRESHOLDS.elapsedTimeSoftLimitSeconds,
        1.0
      );
      // Combined pressure: weighted max (observations matter more than wall-clock)
      const contextPressure = Math.min(
        observationPressure * 0.7 + timePressure * 0.3,
        1.0
      );

      const shouldCycle = contextPressure >= 0.8;

      let reason: string;
      if (shouldCycle) {
        const parts: string[] = [];
        if (observationPressure >= 0.8) {
          parts.push(`${cycleState.observationCount} observations stored`);
        }
        if (timePressure >= 0.8) {
          parts.push(`${Math.round(elapsedSeconds)}s elapsed`);
        }
        reason = `Cycling recommended: ${parts.join(', ') || 'high context pressure'}`;
      } else {
        reason = 'Continue working. Context pressure is manageable.';
      }

      logger.debug('ENDLESS_TOOLS', 'cycle_status queried', {
        shouldCycle,
        contextPressure: contextPressure.toFixed(2),
        observationCount: cycleState.observationCount,
        elapsedSeconds: Math.round(elapsedSeconds),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              should_cycle: shouldCycle,
              reason,
              context_pressure: parseFloat(contextPressure.toFixed(2)),
            }),
          },
        ],
      };
    }
  );

  const completeCycleTool = tool(
    'complete_cycle',
    'Signal that you are ready to end the current session cycle and hand off to a ' +
    'fresh cycle. Provide a brief summary of what was accomplished. A new cycle will ' +
    'begin automatically with your summary as context.',
    {
      summary: z.string().describe(
        'Brief summary of work completed in this cycle. Will be passed to the next cycle as context.'
      ),
    },
    async (args: { summary: string }) => {
      logger.info('ENDLESS_TOOLS', 'complete_cycle called', {
        summaryLength: args.summary.length,
        observationCount: cycleState.observationCount,
      });

      cycleState.completeCycleRequested = true;
      cycleState.cycleSummary = args.summary;

      // Notify the EndlessRunner that the agent wants to cycle
      if (cycleState.onCompleteCycle) {
        cycleState.onCompleteCycle();
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'cycle_ending',
              message: 'Cycle transition initiated. A new session will start with your summary as context.',
            }),
          },
        ],
      };
    }
  );

  // --- Create the in-process MCP server ---

  const serverConfig = createSdkMcpServer({
    name: 'endless-mode-tools',
    version: '1.0.0',
    tools: [cycleStatusTool, completeCycleTool],
  });

  /**
   * Reset cycle state for a new cycle. Call this at the start of each cycle
   * in EndlessRunner before spawning the agent.
   */
  function resetCycleState() {
    cycleState.observationCount = 0;
    cycleState.cycleStartedAt = Date.now();
    cycleState.completeCycleRequested = false;
    cycleState.cycleSummary = null;
    refreshCompleteCyclePromise();
  }

  return {
    /** MCP server config to pass to query() via options.mcpServers */
    serverConfig,
    /** Mutable cycle state -- read by EndlessRunner, written by tool handlers */
    cycleState,
    /** Promise that resolves when the agent calls complete_cycle */
    getCompleteCyclePromise: () => completeCyclePromise,
    /** Reset state for the next cycle */
    resetCycleState,
    /** Increment observation count (called by EndlessRunner when observation is confirmed) */
    incrementObservationCount: () => {
      cycleState.observationCount++;
    },
  };
}
