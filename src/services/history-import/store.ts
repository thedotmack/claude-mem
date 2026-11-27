import { createHash } from 'node:crypto';
import type { ParsedObservation } from '../../sdk/parser.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import { hasStorableTitle } from '../sqlite/observations/store.js';
import type { ReplayReceipt, ReplayUnit } from './replay.js';

type DatedSource = Pick<ReplayUnit, 'key' | 'source' | 'conversationId' | 'messageId' | 'project' | 'projectId' | 'projectOrigin' | 'at' | 'sourceDigest'>;
type ReceiptRow = { source_digest: string; observation_ids: string };

/** Completed turns, including genuine observer skips. Contains no transcript or model output. */
export class HistoryReplayStore {
  constructor(private readonly store: SessionStore) {
    store.db.run(`CREATE TABLE IF NOT EXISTS history_replay_receipts (
      source_key TEXT PRIMARY KEY, source_digest TEXT NOT NULL, observation_ids TEXT NOT NULL
    )`);
  }

  lookup(key: string, sourceDigest?: string): ReplayReceipt | undefined {
    const row = this.store.db.query<ReceiptRow, [string]>(
      'SELECT source_digest, observation_ids FROM history_replay_receipts WHERE source_key = ?'
    ).get(key);
    if (!row) return undefined;
    if (sourceDigest !== undefined && row.source_digest !== sourceDigest) {
      throw new Error('This transcript turn changed since its previous import. The saved observations were preserved.');
    }

    // Rehydrate from the real rows so a removed observation stays removed, including its title.
    const observations = this.store.db.query<{ id: number; title: string }, [string, string]>(
      `SELECT o.id, o.title FROM json_each(?) r JOIN observations o ON o.id = r.value
       WHERE CASE WHEN json_valid(o.metadata) THEN json_extract(o.metadata, '$.sourceFingerprint') END = ?
       ORDER BY r.key`
    ).all(row.observation_ids, 'history:' + key);
    return { ids: observations.map(o => o.id), titles: observations.map(o => o.title) };
  }

  commit(unit: DatedSource, observations: ParsedObservation[], model: string): ReplayReceipt & { existing?: boolean } {
    return this.store.db.transaction(() => {
      const previous = this.lookup(unit.key, unit.sourceDigest);
      if (previous) return { ...previous, existing: true };
      if (observations.some(observation => !hasStorableTitle(observation.title))) {
        throw new Error('A historical observation has no title. The source turn was not marked complete.');
      }

      const platform = normalizePlatformSource(unit.source);
      const contentId = 'history-' + createHash('sha256').update(JSON.stringify([
        unit.source, unit.conversationId, unit.projectId ?? null, unit.project,
      ])).digest('hex');
      const deletedAt = this.store.getSessionDeletedAtEpochMs(platform, contentId);
      let ids: number[] = [];
      if (observations.length && (deletedAt === null || unit.at > deletedAt)) {
        // A resumed chat after deletion gets a fresh memory identity. Its former rows remain tombstoned.
        const memoryId = deletedAt === null ? contentId : contentId + '-' + deletedAt;
        const session = this.store.createSDKSession(contentId, unit.project, '', undefined, platform, unit.at);
        this.store.updateMemorySessionId(session, memoryId);
        const iso = new Date(unit.at).toISOString();
        this.store.db.query(`UPDATE sdk_sessions SET status = 'completed',
          started_at = CASE WHEN started_at_epoch >= ? THEN ? ELSE started_at END,
          started_at_epoch = MIN(started_at_epoch, ?),
          completed_at = CASE WHEN completed_at_epoch IS NULL OR completed_at_epoch <= ? THEN ? ELSE completed_at END,
          completed_at_epoch = MAX(COALESCE(completed_at_epoch, ?), ?) WHERE id = ?`
        ).run(unit.at, iso, unit.at, unit.at, iso, unit.at, unit.at, session);

        const metadata = JSON.stringify({
          sourceFingerprint: 'history:' + unit.key,
          importSource: {
            kind: 'historical_chat', provider: unit.source, conversationId: unit.conversationId,
            messageId: unit.messageId, projectId: unit.projectId, projectOrigin: unit.projectOrigin,
            occurredAt: iso, importedAt: new Date().toISOString(),
          },
        });
        const stored = this.store.storeObservations(memoryId, unit.project,
          observations.map(obs => ({ ...obs, metadata })), null, undefined, 0, unit.at, model,
          { skipTitleDedup: true, sourceEventKey: unit.key });
        ids = [...new Set(stored.observationIds)];
      }

      this.store.db.query('INSERT INTO history_replay_receipts(source_key, source_digest, observation_ids) VALUES (?, ?, ?)')
        .run(unit.key, unit.sourceDigest, JSON.stringify(ids));
      return this.lookup(unit.key)!;
    }).immediate();
  }
}
