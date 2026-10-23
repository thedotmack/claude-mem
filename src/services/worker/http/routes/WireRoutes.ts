import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { logger } from '../../../../utils/logger.js';

/** At most this many ids per lookup: the gateway asks about one conversation's results at a time. */
const MAX_TOOL_USE_IDS_PER_LOOKUP = 500;

const toolObservationsSchema = z.object({
  platformSource: z.string().trim().min(1),
  contentSessionId: z.string().trim().min(1),
  toolUseIds: z.array(z.string().min(1)).max(MAX_TOOL_USE_IDS_PER_LOOKUP),
}).strict();

/**
 * Routes the wire gateway (src/services/wire-gateway/) calls on the worker.
 * POST /api/wire/tool-observations: which of a session's tool uses already
 * have an observation, and that observation's title, narrative and facts,
 * for Endless Mode (plan Phase 11 task 1). Unlike POST /api/tool-uses/batch
 * it never sends the tools' bodies back.
 */
export class WireRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/wire/tool-observations', validateBody(toolObservationsSchema), this.handleToolObservations.bind(this));
  }

  private handleToolObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { platformSource, contentSessionId, toolUseIds } = req.body as z.infer<typeof toolObservationsSchema>;
    const rows = this.dbManager.getSessionStore().getToolUseObservations({ contentSessionId, platformSource, toolUseIds });
    logger.debug('HTTP', 'Wire gateway tool observation lookup', { asked: toolUseIds.length, found: rows.length });
    res.json({
      observations: rows.map(row => ({
        toolUseId: row.tool_use_id,
        observationId: row.observation_id,
        title: row.title ?? '',
        narrative: row.narrative ?? '',
        facts: factsOf(row.facts),
      })),
    });
  });
}

function factsOf(facts: string | null): string[] {
  if (!facts) return [];
  try {
    const parsed = JSON.parse(facts) as unknown;
    return Array.isArray(parsed) ? parsed.filter((fact): fact is string => typeof fact === 'string' && fact !== '') : [];
  } catch {
    return [facts];
  }
}
