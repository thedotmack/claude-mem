/**
 * EndlessRunner: Session-cycling orchestrator for Endless Mode V2
 *
 * Spawns Claude Code sessions via Agent SDK query(), cycles them when
 * observations arrive (indicating context is being consumed). Claude-mem's
 * existing SessionStart hook injects compressed observations from previous
 * cycles, providing continuity across session boundaries.
 *
 * Cycle lifecycle:
 * 1. Spawn a Claude Code process via SDK query()
 * 2. Monitor for observation storage (via queue-empty event on PendingMessageStore)
 * 3. When an observation arrives, abort the current SDK session
 * 4. Wait for the observer queue to drain
 * 5. Clean up the old transcript
 * 6. Start a new cycle with a continuation prompt
 */

import { unlinkSync, existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findClaudeExecutable, getModelId } from './agent-utils.js';
import { buildIsolatedEnv } from '../../shared/EnvManager.js';
import { OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { SessionManager } from './SessionManager.js';
import { DatabaseManager } from './DatabaseManager.js';

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
   * runs until an observation is stored (signaling context consumption),
   * then the session is aborted, the queue is drained, and a new cycle
   * begins with a continuation prompt. Claude-mem's SessionStart hook
   * automatically injects compressed prior context into each new session.
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

    logger.info('ENDLESS', 'Starting endless mode', {
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
   * Core orchestrator loop.
   *
   * For each cycle:
   * 1. Create a fresh AbortController
   * 2. Listen for the global `observation-confirmed` event on PendingMessageStore
   * 3. Call query() with the task prompt (cycle 1) or continuation prompt (cycle 2+)
   * 4. Iterate SDK messages; when observation-confirmed fires, abort the session
   * 5. After the SDK finishes, drain the observer queue using the real sessionDbId
   * 6. Clean up the transcript file
   * 7. If the agent finished naturally (no observation triggered abort), the task is complete
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

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      this.currentTask!.currentCycle = cycle;

      logger.info('ENDLESS', `Starting cycle ${cycle}/${MAX_CYCLES}`, {
        taskId: this.currentTask!.taskId,
        cycle,
      });

      // Build prompt for this cycle
      const prompt =
        cycle === 1
          ? task
          : `Continue working on: ${task}\n\nYou have context from previous work sessions injected above. Pick up where you left off.`;

      // Create a fresh AbortController for this cycle
      const abortController = new AbortController();

      // Closure-scoped state for this cycle
      let observationTriggeredAbort = false;
      let realSessionDbId: number | null = null;

      // Listen for the global observation-confirmed event.
      // The spawned Claude Code process has its own contentSessionId (assigned by
      // Claude Code, not by us). Plugin hooks POST observations to the worker using
      // that ID. The worker creates a DB session and queues the observation. When the
      // observer finishes processing and confirmProcessed() fires, PendingMessageStore
      // emits 'observation-confirmed' with the sessionDbId.
      //
      // Since the plan says "one at a time is MVP", any observation-confirmed event
      // during this cycle is from our spawned active agent.
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const observationListener = (sessionDbId: number) => {
        if (!abortController.signal.aborted) {
          realSessionDbId = sessionDbId;
          observationTriggeredAbort = true;
          logger.info('ENDLESS', 'Observation confirmed, aborting current cycle', {
            cycle,
            sessionDbId,
          });
          abortController.abort();
        }
      };
      pendingStore.getEvents().on('observation-confirmed', observationListener);

      // Track transcript path for cleanup
      let transcriptPath: string | null = null;

      try {
        // Spawn active agent via SDK query()
        const queryResult = query({
          prompt,
          options: {
            model: modelId,
            cwd: taskCwd,
            abortController,
            pathToClaudeCodeExecutable: claudePath,
            env: isolatedEnv,
          },
        });

        // Iterate SDK messages
        for await (const message of queryResult) {
          // Capture transcript path from result messages for cleanup
          if (message.type === 'result') {
            if (message.transcript_path) {
              transcriptPath = message.transcript_path;
            }

            // Agent finished — check WHY
            if (!observationTriggeredAbort) {
              // Agent finished naturally — task is complete
              logger.info('ENDLESS', 'Agent finished naturally, task complete', {
                cycle,
              });
              return 'completed';
            }
            // Observation triggered abort — continue to drain + next cycle
            break;
          }
        }
      } finally {
        // Always clean up the observation listener
        pendingStore.getEvents().removeListener('observation-confirmed', observationListener);
      }

      // Drain observer queue — wait for all pending tool uses to be processed
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
      });
    }

    return 'max_cycles_reached';
  }
}
