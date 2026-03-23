/**
 * Session Init Handler - UserPromptSubmit
 *
 * Extracted from new-hook.ts - initializes session and starts SDK agent.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { detectCorrection, detectTriggerPhrase, isDuplicateInSession, buildCorrectionFingerprint } from '../../services/principles/correctionDetector.js';

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip session init gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, prompt: rawPrompt } = input;

    // Guard: Codex CLI and other platforms may not provide a session_id (#744)
    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    // Handle image-only prompts (where text prompt is empty/undefined)
    // Use placeholder so sessions still get created and tracked for memory
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    // Principles: detect user corrections and trigger phrases (feature-flag gated)
    if (SettingsDefaultsManager.getBool('CLAUDE_MEM_PRINCIPLES_ENABLED') && rawPrompt) {
      // Trigger phrase detection (3 modes: direct, reflect, review)
      const trigger = detectTriggerPhrase(rawPrompt);
      if (trigger.isTriggered) {
        if (trigger.mode === 'direct' && trigger.rule) {
          // Direct: store the user-provided rule as a principle
          workerHttpRequest('/api/principles/manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'trigger',
              rule: trigger.rule,
              category: trigger.category,
            })
          }).catch(err => {
            logger.debug('HOOK', 'Failed to store trigger principle (non-blocking)', {}, err as Error);
          });
        } else if (trigger.mode === 'reflect') {
          // Reflect: mark session for forced extraction on next agent response.
          // The model will naturally extract principles from current conversation context.
          // We POST after session init below (need sessionDbId).
          // Store flag to POST after init completes.
          (input as any)._reflectTrigger = true;
        } else if (trigger.mode === 'review') {
          // Review: batch-process recent corrections into principles
          workerHttpRequest('/api/principles/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 50 })
          }).catch(err => {
            logger.debug('HOOK', 'Failed to review corrections (non-blocking)', {}, err as Error);
          });
        }
      }

      // Path 2: Correction detection with session-level dedup
      const detection = detectCorrection(rawPrompt);
      if (detection.isCorrection) {
        const fingerprint = buildCorrectionFingerprint(detection.patterns);
        if (!isDuplicateInSession(sessionId, fingerprint)) {
          // Fire-and-forget: don't block user prompt for correction storage
          workerHttpRequest('/api/corrections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionId,
              userMessage: rawPrompt,
              detectedPattern: detection.patterns[0] || null,
              category: detection.category,
            })
          }).catch(err => {
            logger.debug('HOOK', 'Failed to store correction (non-blocking)', {}, err as Error);
          });
        }
      }
    }

    const project = getProjectName(cwd);

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Initialize session via HTTP - handles DB operations and privacy checks
    const initResponse = await workerHttpRequest('/api/sessions/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt
      })
    });

    if (!initResponse.ok) {
      // Log but don't throw - a worker 500 should not block the user's prompt
      logger.failure('HOOK', `Session initialization failed: ${initResponse.status}`, { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const initResult = await initResponse.json() as {
      sessionDbId: number;
      promptNumber: number;
      skipped?: boolean;
      reason?: string;
      contextInjected?: boolean;
    };
    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    // Reflect mode: now that we have sessionDbId, mark session for forced extraction
    if ((input as any)._reflectTrigger && sessionDbId) {
      workerHttpRequest('/api/principles/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionDbId })
      }).catch(err => {
        logger.debug('HOOK', 'Failed to set reflect flag (non-blocking)', {}, err as Error);
      });
    }

    // Debug-level alignment log for detailed tracing
    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Skip SDK agent re-initialization if context was already injected for this session (#1079)
    // The prompt was already saved to the database by /api/sessions/init above —
    // no need to re-start the SDK agent on every turn
    if (initResult.contextInjected) {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped_agent_init=true | reason=context_already_injected`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Only initialize SDK agent for Claude Code (not Cursor)
    // Cursor doesn't use the SDK agent - it only needs session/observation storage
    if (input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      // /review 101 -> review 101 (more semantic for observations)
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber });

      // Initialize SDK agent session via HTTP (starts the agent!)
      const response = await workerHttpRequest(`/sessions/${sessionDbId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
      });

      if (!response.ok) {
        // Log but don't throw - SDK agent failure should not block the user's prompt
        logger.failure('HOOK', `SDK agent start failed: ${response.status}`, { sessionDbId, promptNumber });
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    return { continue: true, suppressOutput: true };
  }
};
