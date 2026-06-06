import { SessionStore } from '../../sqlite/SessionStore.js';
import { logger } from '../../../utils/logger.js';

export type PromptPrivacyDecision =
  | { allow: true; prompt: string }
  | { allow: false; reason: 'private' };

export class PrivacyCheckValidator {
  /**
   * Decide whether an observation/summary may be generated for a given prompt.
   *
   * Distinguishes two cases the old boolean check conflated (#2794):
   *  - The `user_prompts` row is ABSENT (getUserPrompt → null): session-init
   *    never persisted the prompt for this session (e.g. the UserPromptSubmit
   *    hook raced worker boot, #2795). This is NOT a privacy signal — treating
   *    it as "private" silently freezes EVERY observation for the session.
   *    Allow ingestion and emit a visible warn.
   *  - The row is PRESENT but empty after privacy stripping (''/whitespace):
   *    the user genuinely redacted the turn → suppress.
   */
  static checkUserPromptPrivacy(
    store: SessionStore,
    contentSessionId: string,
    promptNumber: number,
    operationType: 'observation' | 'summarize',
    sessionDbId: number,
    additionalContext?: Record<string, any>
  ): PromptPrivacyDecision {
    const userPrompt = store.getUserPrompt(contentSessionId, promptNumber);

    if (userPrompt === null) {
      logger.warn(
        'HOOK',
        `${operationType}: no user_prompts row for prompt #${promptNumber} — ingesting anyway (session-init likely raced worker boot; see #2794/#2795)`,
        { sessionId: sessionDbId, contentSessionId, promptNumber, ...additionalContext }
      );
      return { allow: true, prompt: '' };
    }

    if (userPrompt.trim() === '') {
      logger.debug('HOOK', `Skipping ${operationType} - user prompt was entirely private`, {
        sessionId: sessionDbId,
        promptNumber,
        ...additionalContext,
      });
      return { allow: false, reason: 'private' };
    }

    return { allow: true, prompt: userPrompt };
  }
}
