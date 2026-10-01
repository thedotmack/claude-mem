import { describe, expect, it } from 'bun:test';
import { clearRejectedOutput, recordRejectedOutput } from '../../../../src/services/worker/session/OutputRecovery.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

function session(claimedMessageIds: number[]): ActiveSession {
  return { claimedMessageIds, consecutiveInvalidOutputs: 0, invalidOutputBatchKey: null } as unknown as ActiveSession;
}

describe('recordRejectedOutput: one retry per batch', () => {
  it('retries a rejected batch once, then drops it', () => {
    const s = session([7, 8]);
    expect(recordRejectedOutput(s)).toBe('retry');
    expect(recordRejectedOutput(s)).toBe('drop');
  });

  // R4-12: Codex folds queued observations that arrived meanwhile into the
  // retry's turn, so the retried batch carries more ids than the rejected one.
  // Keyed on every id, each growth earned a fresh retry (up to the batch size,
  // each a full-history request). The head of the queue is what was retried.
  it('keeps the count when the retried batch grew behind the same head', () => {
    const s = session([7]);
    expect(recordRejectedOutput(s)).toBe('retry');
    s.claimedMessageIds = [7, 8, 9];
    expect(recordRejectedOutput(s)).toBe('drop');
  });

  it('starts a fresh count for a batch with a different head', () => {
    const s = session([7]);
    expect(recordRejectedOutput(s)).toBe('retry');
    s.claimedMessageIds = [10, 11];
    expect(recordRejectedOutput(s)).toBe('retry');
  });

  it('starts a fresh count once a valid answer cleared it', () => {
    const s = session([7]);
    expect(recordRejectedOutput(s)).toBe('retry');
    clearRejectedOutput(s);
    expect(recordRejectedOutput(s)).toBe('retry');
  });
});
