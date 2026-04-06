import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { BanditEngine } from './BanditEngine.js';

const MODEL_PER_OBS_TYPE = 'model-per-obs-type';
const REWARD_SIGNALS = new Set(['semantic_inject_hit', 'search_accessed']);

export class FeedbackRecorder {
  private insertFeedback;
  private updateRelevance;
  private getObservation;

  constructor(
    private db: Database,
    private banditEngine: BanditEngine | null = null
  ) {
    this.insertFeedback = db.prepare(
      'INSERT INTO observation_feedback (observation_id, signal, source, created_at_epoch) VALUES (?, ?, ?, ?)'
    );
    this.updateRelevance = db.prepare(
      'UPDATE observations SET relevance_count = relevance_count + 1 WHERE id = ?'
    );
    this.getObservation = db.prepare(
      'SELECT id, type, generated_by_model FROM observations WHERE id = ?'
    );
  }

  recordFeedback(observationIds: number[], signal: string, source: string): void {
    if (observationIds.length === 0) return;

    const now = Date.now();

    for (const obsId of observationIds) {
      try {
        this.insertFeedback.run(obsId, signal, source, now);
        this.updateRelevance.run(obsId);

        if (this.banditEngine && REWARD_SIGNALS.has(signal)) {
          const obs = this.getObservation.get(obsId) as { id: number; type: string; generated_by_model: string | null } | undefined;
          if (obs?.generated_by_model) {
            const armId = `${obs.type}:${obs.generated_by_model}`;
            this.banditEngine.recordReward(MODEL_PER_OBS_TYPE, armId, 1);
          }
        }
      } catch (e) {
        logger.debug('FEEDBACK', 'Failed to record feedback', {
          observationId: obsId, signal, error: e instanceof Error ? e.message : String(e)
        });
      }
    }

    logger.debug('FEEDBACK', `Recorded ${observationIds.length} feedback signals`, {
      signal, source, count: observationIds.length
    });
  }
}
