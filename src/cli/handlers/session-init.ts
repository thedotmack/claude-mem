
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped?: boolean;
  reason?: string;
  contextInjected?: boolean;
}

interface SemanticContextResponse {
  context: string;
  count: number;
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  

    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    const initResult = await executeWithWorkerFallback<SessionInitResponse>(
      '/api/sessions/init',
      'POST',
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
      },
    );

    if (isWorkerFallback(initResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (typeof initResult?.sessionDbId !== 'number') {
      logger.failure('HOOK', 'Session initialization returned malformed response', { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    const settings = loadFromFileOnce();
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';
    let additionalContext = '';

    if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
      const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
      const semanticResult = await executeWithWorkerFallback<SemanticContextResponse>(
        '/api/context/semantic',
        'POST',
        { q: prompt, project, limit },
      );
      if (!isWorkerFallback(semanticResult) && semanticResult?.context) {
        logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
        additionalContext = semanticResult.context;
      }
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};
