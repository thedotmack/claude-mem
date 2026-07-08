import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import {
  MAX_STORED_PROMPT_CHARS,
  normalizeStoredPromptText,
  STORED_PROMPT_NORMALIZATION_MARKERS,
} from './prompt-storage.js';

export const LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION = 38;
export const LEGACY_PROMPT_BLOAT_RECLAIM_MIN_BYTES = 512 * 1024;

interface PromptRow {
  id: number;
  prompt_text: string;
}

interface PragmaValueRow {
  auto_vacuum?: number;
  freelist_count?: number;
  page_size?: number;
}

export interface PromptBloatCompactionResult {
  autoVacuumMode: number;
  error?: string;
  freeBytesAfter: number;
  freeBytesBefore: number;
  freelistCountAfter: number;
  freelistCountBefore: number;
  mode: 'failed' | 'incremental_vacuum' | 'vacuum' | 'skipped';
  pageSize: number;
  thresholdBytes: number;
}

export interface PromptBloatMaintenanceResult {
  clearedSessionPrompts: number;
  compaction: PromptBloatCompactionResult;
  normalizedPromptRows: number;
  versionApplied: boolean;
}

function getPragmaNumber(db: Database, pragma: 'auto_vacuum' | 'freelist_count' | 'page_size'): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as PragmaValueRow | undefined;
  return Number(row?.[pragma] ?? 0);
}

function buildPromptCandidateQuery(): string {
  const markerChecks = STORED_PROMPT_NORMALIZATION_MARKERS
    .map(() => 'instr(prompt_text, ?) > 0')
    .join(' OR ');
  return `
    SELECT id, prompt_text
    FROM user_prompts
    WHERE length(prompt_text) > ?
      OR ${markerChecks}
  `;
}

function normalizeLegacyPromptRows(db: Database): number {
  const rows = db.prepare(buildPromptCandidateQuery()).all(
    MAX_STORED_PROMPT_CHARS,
    ...STORED_PROMPT_NORMALIZATION_MARKERS
  ) as PromptRow[];
  if (rows.length === 0) return 0;

  const updateStmt = db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE id = ?');
  let normalizedPromptRows = 0;

  for (const row of rows) {
    const normalizedPrompt = normalizeStoredPromptText(row.prompt_text);
    if (normalizedPrompt === row.prompt_text) continue;
    updateStmt.run(normalizedPrompt, row.id);
    normalizedPromptRows += 1;
  }

  return normalizedPromptRows;
}

function clearDuplicateCompletedSessionPrompts(db: Database): number {
  const result = db.prepare(`
    UPDATE sdk_sessions
    SET user_prompt = NULL
    WHERE user_prompt IS NOT NULL
      AND status IN ('completed', 'failed')
      AND EXISTS (
        SELECT 1
        FROM user_prompts up
        WHERE up.session_db_id = sdk_sessions.id
          AND up.prompt_number = 1
      )
  `).run();

  return Number(result.changes ?? 0);
}

function reclaimPromptCleanupPages(
  db: Database,
  changedRows: number,
  minFreeBytes: number
): PromptBloatCompactionResult {
  try {
    db.run('PRAGMA wal_checkpoint(PASSIVE)');
  } catch (error) {
    logger.debug('DB', 'Legacy prompt bloat cleanup could not checkpoint WAL before compaction', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const pageSize = getPragmaNumber(db, 'page_size');
  const freelistCountBefore = getPragmaNumber(db, 'freelist_count');
  const freeBytesBefore = pageSize * freelistCountBefore;
  const autoVacuumMode = getPragmaNumber(db, 'auto_vacuum');

  if (changedRows === 0 || freeBytesBefore < minFreeBytes) {
    return {
      autoVacuumMode,
      freeBytesAfter: freeBytesBefore,
      freeBytesBefore,
      freelistCountAfter: freelistCountBefore,
      freelistCountBefore,
      mode: 'skipped',
      pageSize,
      thresholdBytes: minFreeBytes,
    };
  }

  try {
    if (autoVacuumMode === 2) {
      db.run(`PRAGMA incremental_vacuum(${freelistCountBefore})`);
    } else {
      db.run('VACUUM');
    }
  } catch (error) {
    const compactionError = error instanceof Error ? error : new Error(String(error));
    logger.warn('DB', 'Legacy prompt bloat cleanup could not reclaim free pages', {
      autoVacuumMode,
      freeBytesBefore,
      freelistCountBefore,
    }, compactionError);
    return {
      autoVacuumMode,
      error: compactionError.message,
      freeBytesAfter: freeBytesBefore,
      freeBytesBefore,
      freelistCountAfter: freelistCountBefore,
      freelistCountBefore,
      mode: 'failed',
      pageSize,
      thresholdBytes: minFreeBytes,
    };
  }

  const freelistCountAfter = getPragmaNumber(db, 'freelist_count');
  return {
    autoVacuumMode,
    freeBytesAfter: pageSize * freelistCountAfter,
    freeBytesBefore,
    freelistCountAfter,
    freelistCountBefore,
    mode: autoVacuumMode === 2 ? 'incremental_vacuum' : 'vacuum',
    pageSize,
    thresholdBytes: minFreeBytes,
  };
}

export function applyLegacyPromptBloatMaintenance(
  db: Database,
  minFreeBytes: number = LEGACY_PROMPT_BLOAT_RECLAIM_MIN_BYTES
): PromptBloatMaintenanceResult {
  const applied = db.prepare('SELECT 1 FROM schema_versions WHERE version = ?').get(
    LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION
  );

  if (applied) {
    return {
      clearedSessionPrompts: 0,
      compaction: reclaimPromptCleanupPages(db, 0, minFreeBytes),
      normalizedPromptRows: 0,
      versionApplied: false,
    };
  }

  let normalizedPromptRows = 0;
  let clearedSessionPrompts = 0;
  db.run('BEGIN TRANSACTION');
  try {
    normalizedPromptRows = normalizeLegacyPromptRows(db);
    clearedSessionPrompts = clearDuplicateCompletedSessionPrompts(db);
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
      LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION,
      new Date().toISOString()
    );
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }

  const compaction = reclaimPromptCleanupPages(
    db,
    normalizedPromptRows + clearedSessionPrompts,
    minFreeBytes
  );

  if (normalizedPromptRows > 0 || clearedSessionPrompts > 0) {
    logger.info('DB', 'Applied legacy prompt bloat maintenance', {
      normalizedPromptRows,
      clearedSessionPrompts,
      compactionMode: compaction.mode,
      freeBytesBefore: compaction.freeBytesBefore,
      freeBytesAfter: compaction.freeBytesAfter,
    });
  }

  return {
    clearedSessionPrompts,
    compaction,
    normalizedPromptRows,
    versionApplied: true,
  };
}
