/**
 * Memory Routes
 *
 * Handles manual memory/observation saving.
 * POST /api/memory/save - Save a manual memory observation
 */

import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

// Plan 06 Phase 3 — per-route Zod schema.
//
// `metadata` is an arbitrary JSON object the caller can use to attach
// integration-specific provenance (e.g. obsidian_note, claude_mem_version,
// custom_key). It is stored verbatim in the observations.metadata column
// (migration 30) — no schema enforcement on its keys (#2116).
//
// `metadata.project`, when present and the top-level `project` is omitted,
// is honored as the project assignment. This lets integrating plugins file
// observations under a project other than their own without having to know
// the top-level field name.
const saveMemorySchema = z.object({
  text: z.string().trim().min(1),
  title: z.string().optional(),
  project: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', validateBody(saveMemorySchema), this.handleSaveMemory.bind(this));
  }

  /**
   * POST /api/memory/save - Save a manual memory/observation
   * Body: {
   *   text: string,
   *   title?: string,
   *   project?: string,
   *   metadata?: Record<string, unknown>  // arbitrary JSON, persisted verbatim (#2116)
   * }
   *
   * Project resolution order: top-level `project` → `metadata.project` (string)
   * → this.defaultProject. Unknown top-level fields are now rejected (400) —
   * `.strict()` replaced `.passthrough()` so silent drops can't recur.
   */
  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project, metadata } = req.body as z.infer<typeof saveMemorySchema>;
    const metadataProject = typeof metadata?.project === 'string' && metadata.project.trim()
      ? metadata.project.trim()
      : undefined;
    const targetProject = project || metadataProject || this.defaultProject;

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    // 1. Get or create manual session for project
    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    // 2. Build observation
    const observation = {
      type: 'discovery',  // Use existing valid type
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: 'Manual memory',
      facts: [] as string[],
      narrative: text,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[],
      // Stringify here so the storage layer doesn't need to know about JSON shape.
      // Preserved verbatim, including nested objects.
      metadata: metadata ? JSON.stringify(metadata) : null,
    };

    // 3. Store to SQLite
    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   // discoveryTokens
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title
    });

    // 4. Sync to ChromaDB (async, fire-and-forget)
    if (!chromaSync) {
      logger.debug('CHROMA', 'ChromaDB sync skipped (chromaSync not available)', { id: result.id });
      res.json({
        success: true,
        id: result.id,
        title: observation.title,
        project: targetProject,
        message: `Memory saved as observation #${result.id}`
      });
      return;
    }
    chromaSync.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('CHROMA', 'ChromaDB sync failed', { id: result.id }, err as Error);
    });

    // 5. Return success
    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      message: `Memory saved as observation #${result.id}`
    });
  });
}
