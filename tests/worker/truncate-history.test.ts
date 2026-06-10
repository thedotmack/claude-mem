import { describe, expect, it, spyOn } from 'bun:test';
import { truncateConversationHistory } from '../../src/services/worker/truncate-history.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

const msg = (content: string): ConversationMessage => ({ role: 'user', content });
const estimateByLength = (text: string | null) => text?.length ?? 0;

describe('truncateConversationHistory', () => {
  it('returns empty history as-is', () => {
    const result = truncateConversationHistory([], {
      maxContextMessages: 10,
      maxEstimatedTokens: 1000,
    });
    expect(result).toEqual([]);
  });

  it('returns single init prompt as-is', () => {
    const history = [msg('init')];
    const result = truncateConversationHistory(history, {
      maxContextMessages: 10,
      maxEstimatedTokens: 1000,
    });
    expect(result).toEqual(history);
  });

  it('returns full history when within total message and token limits', () => {
    const history = [msg('a'), msg('b'), msg('c')];
    const result = truncateConversationHistory(history, {
      maxContextMessages: 3,
      maxEstimatedTokens: 3,
      estimateTokens: estimateByLength,
    });
    expect(result).toEqual(history);
  });

  it('message limit includes init prompt', () => {
    const history = [msg('init'), msg('old'), msg('newer'), msg('newest')];
    const result = truncateConversationHistory(history, {
      maxContextMessages: 2,
      maxEstimatedTokens: 999,
      estimateTokens: estimateByLength,
    });
    expect(result).toEqual([msg('init'), msg('newest')]);
  });

  it('token limit includes init prompt', () => {
    // init len=4, old len=3, two len=3  => total=10 tokens
    // maxEstimatedTokens=7 means only 3 tokens remain after init's 4
    const history = [msg('init'), msg('old'), msg('two')];
    const result = truncateConversationHistory(history, {
      maxContextMessages: 999,
      maxEstimatedTokens: 7,
      estimateTokens: estimateByLength,
    });
    // init (4 tokens) + two (3 tokens) = 7 tokens
    // old would push to 10 which exceeds 7
    expect(result).toEqual([msg('init'), msg('two')]);
  });

  it('returns init only when init consumes full token budget', () => {
    const history = [msg('init-longer'), msg('other')];
    const result = truncateConversationHistory(history, {
      maxContextMessages: 999,
      maxEstimatedTokens: 11,
      estimateTokens: estimateByLength,
    });
    // 'init-longer' length = 11, exactly equals maxEstimatedTokens
    expect(result).toEqual([msg('init-longer')]);
  });

  it('keeps newest messages but returns chronological order', () => {
    const history = [msg('init'), msg('one'), msg('two'), msg('three')];
    const result = truncateConversationHistory(history, {
      maxContextMessages: 3,
      maxEstimatedTokens: 999,
      estimateTokens: estimateByLength,
    });
    // maxRecentMessages = 3 - 1 = 2
    // walks: three (added), two (added), one would be 3rd recent -> stop
    // result: [init, two, three]
    expect(result).toEqual([msg('init'), msg('two'), msg('three')]);
  });

  it('logs warn when token budget forces init-only', () => {
    const warnSpy = spyOn(logger, 'warn');
    try {
      const history = [msg('init-longer'), msg('other')];
      const result = truncateConversationHistory(history, {
        maxContextMessages: 999,
        maxEstimatedTokens: 11,
        estimateTokens: estimateByLength,
      });
      expect(result).toEqual([msg('init-longer')]);
      expect(warnSpy).toHaveBeenCalledWith(
        'SDK',
        'Context window truncated to init prompt only',
        expect.objectContaining({
          originalMessages: 2,
          keptMessages: 1,
          droppedMessages: 1,
          estimatedTokens: 11,
          tokenLimit: 11,
          messageLimit: 999,
          reason: 'token_limit',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs warn when message budget forces init-only', () => {
    const warnSpy = spyOn(logger, 'warn');
    try {
      const history = [msg('init'), msg('other')];
      const result = truncateConversationHistory(history, {
        maxContextMessages: 1,
        maxEstimatedTokens: 999,
        estimateTokens: estimateByLength,
      });
      expect(result).toEqual([msg('init')]);
      expect(warnSpy).toHaveBeenCalledWith(
        'SDK',
        'Context window truncated to init prompt only',
        expect.objectContaining({
          originalMessages: 2,
          keptMessages: 1,
          droppedMessages: 1,
          estimatedTokens: 4,
          tokenLimit: 999,
          messageLimit: 1,
          reason: 'message_limit',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
