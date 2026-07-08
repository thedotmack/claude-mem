import { describe, expect, it, spyOn } from 'bun:test';
import { truncateConversationHistory } from '../../src/services/worker/truncate-history.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

const msg = (content: string): ConversationMessage => ({ role: 'user', content });
const estimateByLength = (text: string | null) => text?.length ?? 0;

describe('truncateConversationHistory', () => {
  it('returns empty history as-is', () => {
    expect(truncateConversationHistory([], {
      maxContextMessages: 10,
      maxEstimatedTokens: 1000,
    })).toEqual([]);
  });

  it('returns full history when within total message and token limits', () => {
    const history = [msg('a'), msg('b'), msg('c')];
    expect(truncateConversationHistory(history, {
      maxContextMessages: 3,
      maxEstimatedTokens: 3,
      estimateTokens: estimateByLength,
    })).toEqual(history);
  });

  it('message limit includes and preserves init prompt', () => {
    const history = [msg('init'), msg('old'), msg('newer'), msg('newest')];
    expect(truncateConversationHistory(history, {
      maxContextMessages: 2,
      maxEstimatedTokens: 999,
      estimateTokens: estimateByLength,
    })).toEqual([msg('init'), msg('newest')]);
  });

  it('token limit includes and preserves init prompt', () => {
    const history = [msg('init'), msg('old'), msg('two')];
    expect(truncateConversationHistory(history, {
      maxContextMessages: 999,
      maxEstimatedTokens: 7,
      estimateTokens: estimateByLength,
    })).toEqual([msg('init'), msg('two')]);
  });

  it('returns init only when init consumes the full token budget', () => {
    expect(truncateConversationHistory([msg('init-longer'), msg('other')], {
      maxContextMessages: 999,
      maxEstimatedTokens: 11,
      estimateTokens: estimateByLength,
    })).toEqual([msg('init-longer')]);
  });

  it('keeps newest messages in chronological order', () => {
    const history = [msg('init'), msg('one'), msg('two'), msg('three')];
    expect(truncateConversationHistory(history, {
      maxContextMessages: 3,
      maxEstimatedTokens: 999,
      estimateTokens: estimateByLength,
    })).toEqual([msg('init'), msg('two'), msg('three')]);
  });

  it('logs when token budget forces init-only', () => {
    const warnSpy = spyOn(logger, 'warn');
    try {
      truncateConversationHistory([msg('init-longer'), msg('other')], {
        maxContextMessages: 999,
        maxEstimatedTokens: 11,
        estimateTokens: estimateByLength,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'SDK',
        'Context window truncated to init prompt only',
        expect.objectContaining({ reason: 'token_limit', keptMessages: 1 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
