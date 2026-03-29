/**
 * EndlessRunner: Session-cycling orchestrator for Endless Mode V2
 *
 * Spawns Claude Code sessions via Agent SDK query(), cycles them when
 * the agent cooperatively signals readiness via the `complete_cycle` MCP tool.
 * Claude-mem's existing SessionStart hook injects compressed observations from
 * previous cycles, providing continuity across session boundaries.
 *
 * Cooperative cycling (V2):
 * Instead of force-aborting the agent when an observation arrives, the agent
 * uses two custom MCP tools to participate in cycling decisions:
 * - `cycle_status`: Checks context pressure (observation count, time elapsed)
 * - `complete_cycle`: Signals graceful cycle completion with a summary
 *
 * The EndlessRunner still listens for `observation-confirmed` events, but only
 * to track observation counts (fed into cycle_status pressure calculation).
 * The agent decides when to cycle, not the orchestrator.
 *
 * Cycle lifecycle:
 * 1. Spawn a Claude Code process via SDK query() with MCP tools attached
 * 2. Track observation confirmations to update context pressure
 * 3. Agent periodically calls cycle_status, then complete_cycle when ready
 * 4. On complete_cycle, the SDK session ends naturally
 * 5. Wait for the observer queue to drain
 * 6. Clean up the old transcript
 * 7. Start a new cycle with a continuation prompt including the agent's summary
 */

import { unlinkSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findClaudeExecutable, getModelId } from './agent-utils.js';
import { buildIsolatedEnv } from '../../shared/EnvManager.js';
import { OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { SessionManager } from './SessionManager.js';
import { DatabaseManager } from './DatabaseManager.js';
import { createEndlessModeToolServer } from './EndlessModeToolServer.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

const MAX_CYCLES = 100;

export type EndlessTaskStatus = 'running' | 'completed' | 'max_cycles_reached' | 'error';

export interface EndlessTaskState {
  taskId: string;
  task: string;
  project: string;
  cwd: string;
  status: EndlessTaskStatus;
  currentCycle: number;
  maxCycles: number;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
}

export class EndlessRunner {
  private sessionManager: SessionManager;
  private dbManager: DatabaseManager;
  private currentTask: EndlessTaskState | null = null;

  constructor(sessionManager: SessionManager, dbManager: DatabaseManager) {
    this.sessionManager = sessionManager;
    this.dbManager = dbManager;
  }

  /**
   * Get current task state (for status endpoint)
   */
  getTaskState(): EndlessTaskState | null {
    return this.currentTask;
  }

  /**
   * Run the endless mode orchestrator loop.
   *
   * Spawns consecutive Claude Code sessions via SDK query(). Each session
   * has access to `cycle_status` and `complete_cycle` MCP tools. The agent
   * cooperatively cycles by calling `complete_cycle` when context pressure
   * is high. Claude-mem's SessionStart hook automatically injects compressed
   * prior context into each new session.
   */
  async run(task: string, project: string, cwd: string): Promise<EndlessTaskState> {
    if (this.currentTask && this.currentTask.status === 'running') {
      throw new Error('An endless mode task is already running');
    }

    const taskId = `endless-${Date.now()}`;
    this.currentTask = {
      taskId,
      task,
      project,
      cwd,
      status: 'running',
      currentCycle: 0,
      maxCycles: MAX_CYCLES,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };

    logger.info('ENDLESS', 'Starting endless mode (cooperative cycling)', {
      taskId,
      task: task.substring(0, 100),
      project,
      cwd,
    });

    try {
      const result = await this.orchestratorLoop(task, project, cwd);
      this.currentTask.status = result;
      this.currentTask.completedAt = Date.now();

      logger.info('ENDLESS', 'Endless mode completed', {
        taskId,
        status: result,
        cycles: this.currentTask.currentCycle,
        durationMs: Date.now() - this.currentTask.startedAt,
      });

      return this.currentTask;
    } catch (error) {
      this.currentTask.status = 'error';
      this.currentTask.error = (error as Error).message;
      this.currentTask.completedAt = Date.now();

      logger.error('ENDLESS', 'Endless mode failed', { taskId }, error as Error);
      return this.currentTask;
    }
  }

  /**
   * Core orchestrator loop with cooperative cycling.
   *
   * For each cycle:
   * 1. Reset the tool server's cycle state
   * 2. Listen for `observation-confirmed` to track observation count (for pressure)
   * 3. Call query() with MCP tools attached
   * 4. Race: agent calls complete_cycle OR agent finishes naturally
   * 5. After SDK finishes, drain the observer queue
   * 6. Clean up transcript
   * 7. If agent finished naturally WITHOUT calling complete_cycle, task is done
   *
   * Session ID mapping: The spawned Claude Code process generates its own
   * contentSessionId. Plugin hooks use that ID when POSTing to the worker.
   * The worker creates a DB session for it. We learn the real sessionDbId
   * from the `observation-confirmed` event (which includes sessionDbId).
   */
  private async orchestratorLoop(
    task: string,
    project: string,
    taskCwd: string
  ): Promise<'completed' | 'max_cycles_reached'> {
    const claudePath = findClaudeExecutable();
    const modelId = getModelId();
    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());
    ensureDir(OBSERVER_SESSIONS_DIR);

    // Create the cooperative cycling MCP tool server (persists across cycles)
    const toolServer = createEndlessModeToolServer();

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      this.currentTask!.currentCycle = cycle;

      logger.info('ENDLESS', `Starting cycle ${cycle}/${MAX_CYCLES}`, {
        taskId: this.currentTask!.taskId,
        cycle,
      });

      // Capture summary from previous cycle BEFORE resetting state
      const previousCycleSummary = toolServer.cycleState.cycleSummary;

      // Reset tool server state for this cycle
      toolServer.resetCycleState();

      // Build prompt for this cycle
      const prompt = this.buildCyclePrompt(task, cycle, previousCycleSummary);

      // Create an AbortController for this cycle (used for cleanup, not for
      // observation-triggered abort like the old approach)
      const abortController = new AbortController();

      // Track the real sessionDbId captured from observation-confirmed events
      let realSessionDbId: number | null = null;

      // Listen for observation-confirmed to track observation count.
      // Unlike the old abort-based approach, we do NOT abort on observation.
      // We just increment the counter so cycle_status can report pressure.
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const observationListener = (sessionDbId: number) => {
        realSessionDbId = sessionDbId;
        toolServer.incrementObservationCount();
        logger.debug('ENDLESS', 'Observation confirmed, incrementing pressure counter', {
          cycle,
          sessionDbId,
          observationCount: toolServer.cycleState.observationCount,
        });
      };
      pendingStore.getEvents().on('observation-confirmed', observationListener);

      // Track transcript path for cleanup
      let transcriptPath: string | null = null;

      try {
        // Spawn active agent via SDK query() with MCP tools
        const queryResult = query({
          prompt,
          options: {
            model: modelId,
            cwd: taskCwd,
            abortController,
            pathToClaudeCodeExecutable: claudePath,
            env: isolatedEnv,
            // Attach cooperative cycling tools as an in-process MCP server
            mcpServers: {
              'endless-mode-tools': toolServer.serverConfig,
            },
          },
        });

        // Iterate SDK messages
        for await (const message of queryResult) {
          // Capture transcript path from result messages for cleanup
          if (message.type === 'result') {
            if (message.transcript_path) {
              transcriptPath = message.transcript_path;
            }

            // Agent finished -- check WHY
            if (!toolServer.cycleState.completeCycleRequested) {
              // Agent finished naturally without calling complete_cycle -- task is done
              logger.info('ENDLESS', 'Agent finished naturally, task complete', {
                cycle,
                observationCount: toolServer.cycleState.observationCount,
              });
              return 'completed';
            }
            // Agent called complete_cycle -- continue to drain + next cycle
            break;
          }
        }
      } finally {
        // Always clean up the observation listener
        pendingStore.getEvents().removeListener('observation-confirmed', observationListener);
      }

      // Drain observer queue -- wait for all pending tool uses to be processed
      // Uses the real sessionDbId captured from the observation-confirmed event
      if (realSessionDbId !== null) {
        logger.info('ENDLESS', 'Waiting for observer queue to drain', {
          cycle,
          sessionDbId: realSessionDbId,
        });
        await this.sessionManager.waitForQueueEmpty(realSessionDbId);
        logger.info('ENDLESS', 'Observer queue drained', { cycle, sessionDbId: realSessionDbId });
      }

      // Clean up transcript file to free disk space
      if (transcriptPath && existsSync(transcriptPath)) {
        try {
          unlinkSync(transcriptPath);
          logger.debug('ENDLESS', 'Transcript cleaned up', { transcriptPath });
        } catch (error) {
          logger.warn('ENDLESS', 'Failed to clean transcript', { transcriptPath }, error as Error);
        }
      }

      logger.info('ENDLESS', `Cycle ${cycle} complete, starting next cycle`, {
        taskId: this.currentTask!.taskId,
        cycle,
        cycleSummary: toolServer.cycleState.cycleSummary?.substring(0, 200),
        observationCount: toolServer.cycleState.observationCount,
      });
    }

    return 'max_cycles_reached';
  }

  /**
   * Build the prompt for a given cycle.
   *
   * Cycle 1: Just the task.
   * Cycle 2+: Continuation prompt with the previous cycle's summary (from complete_cycle).
   */
  private buildCyclePrompt(task: string, cycle: number, previousCycleSummary: string | null): string {
    if (cycle === 1) {
      return (
        task +
        '\n\n' +
        'You have access to two session management tools:\n' +
        '- `cycle_status`: Call periodically to check if context pressure is high and you should cycle.\n' +
        '- `complete_cycle`: Call when you are ready to hand off to a fresh session. Provide a summary of your progress.\n' +
        '\n' +
        'Work on the task. When cycle_status indicates high pressure, wrap up and call complete_cycle.'
      );
    }

    const summaryBlock = previousCycleSummary
      ? `\n\nPrevious cycle summary:\n${previousCycleSummary}`
      : '';

    return (
      `Continue working on: ${task}` +
      summaryBlock +
      '\n\nYou have context from previous work sessions injected above. Pick up where you left off.' +
      '\n\n' +
      'Remember to call `cycle_status` periodically and `complete_cycle` when you are ready to hand off.'
    );
  }
}
