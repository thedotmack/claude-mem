import express, { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { logger } from '../../../../utils/logger.js';
import { loadContextConfig } from '../../../context/ContextConfigLoader.js';
import { renderAgentTableRow } from '../../../context/formatters/AgentFormatter.js';
import { formatTime } from '../../../../shared/timeline-formatting.js';
import { MY_RULES_FILE_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import type { ContextReadWorkerClient } from '../../../context/ContextReadWorkerClient.js';
import { workViewLoopbackOnly } from './WorkViewRoutes.js';
import { projectMemoryContent } from '../../../../shared/progressive-search.js';
import { ENDLESS_TIMELINE_ROW_FORMATS, type EndlessTimelineRowFormat } from '../../../../shared/endless-timeline-row-format.js';
import type { ToolUseObservationRow } from '../../../sqlite/tool-uses.js';

/** At most this many ids per lookup: the gateway asks about one conversation's results at a time. */
const MAX_TOOL_USE_IDS_PER_LOOKUP = 500;

const toolObservationsSchema = z.object({
  platformSource: z.string().trim().min(1),
  contentSessionId: z.string().trim().min(1),
  toolUseIds: z.array(z.string().min(1)).max(MAX_TOOL_USE_IDS_PER_LOOKUP),
  /** How `row` is rendered (CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT); an unknown format is a 400. */
  rowFormat: z.enum(ENDLESS_TIMELINE_ROW_FORMATS).default('timeline'),
}).strict();

/**
 * Routes the wire gateway (src/services/wire-gateway/) calls on the worker.
 * POST /api/wire/tool-observations: which of a session's tool uses already
 * have an observation (one row per observation of the batch it was
 * summarized in), and that observation's title, narrative and facts, for
 * Endless Mode (plan Phase 11 task 1), with the observation's one-line
 * timeline entry and its timeline row in the asked `rowFormat`. Unlike POST
 * /api/tool-uses/batch it never sends the tools' bodies back.
 * GET /api/wire/header?cwd=<abs>: MY-RULES.md as written on disk, narrowed to
 * that checkout's projects, and its sha256, for the gateway's durable header.
 * Read from the file rather than re-rendered from the rule rows, so the hash
 * changes only when the file does.
 */
export class WireRoutes extends BaseRouteHandler {
  private rulesFilePath: string;
  private contextReader: Pick<ContextReadWorkerClient, 'projectsForCwd'> | null;

  /**
   * `rulesFilePath`: the MY-RULES.md WorkViewRoutes writes. `contextReader`:
   * resolves a cwd's projects off the main thread (it runs git); without one
   * they are resolved inline, as SearchRoutes does.
   */
  constructor(
    private dbManager: DatabaseManager,
    options: { rulesFilePath?: string; contextReader?: Pick<ContextReadWorkerClient, 'projectsForCwd'> | null } = {},
  ) {
    super();
    this.rulesFilePath = options.rulesFilePath ?? MY_RULES_FILE_PATH;
    this.contextReader = options.contextReader ?? null;
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/wire/tool-observations', validateBody(toolObservationsSchema), this.handleToolObservations.bind(this));
    // The owner's rules are private: only this computer may read them, and never a browser page on it.
    app.get('/api/wire/header', workViewLoopbackOnly, refuseBrowserPages, this.handleHeader.bind(this));
  }

  private handleToolObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { platformSource, contentSessionId, toolUseIds, rowFormat } = req.body as z.infer<typeof toolObservationsSchema>;
    const rows = this.dbManager.getSessionStore().getToolUseObservations({ contentSessionId, platformSource, toolUseIds });
    logger.debug('HTTP', 'Wire gateway tool observation lookup', { asked: toolUseIds.length, found: rows.length });
    // The session-start timeline's row renderer and config, always with the time
    // shown: the timeline prints `"` for a minute repeated from the row above,
    // which means nothing out of that context, so this line is that row with
    // its time filled in.
    const contextConfig = loadContextConfig();
    res.json({
      observations: rows.map(row => {
        const timelineLine = renderAgentTableRow(
          { id: row.observation_id, type: row.type, title: row.title },
          formatTime(row.created_at_epoch),
          contextConfig,
        );
        return {
          toolUseId: row.tool_use_id,
          observationId: row.observation_id,
          title: row.title ?? '',
          narrative: row.narrative ?? '',
          facts: factsOf(row.facts),
          timelineLine,
          row: timelineRowOf(row, timelineLine, rowFormat),
        };
      }),
    });
  });

  // Rules are not memory: an excluded project (CLAUDE_MEM_EXCLUDED_PROJECTS) gets
  // no context injected, but still gets the owner's rules, as Claude Code loads
  // MY-RULES.md everywhere.
  private handleHeader = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!isAbsolute(cwd)) {
      this.badRequest(res, 'cwd must be an absolute path');
      return;
    }
    let rulesFile: string;
    try {
      rulesFile = readFileSync(this.rulesFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      res.json({ text: null, hash: sha256('') });
      return;
    }
    // The projects the context hook reads for this checkout (SearchRoutes handleContextInject).
    const projects = this.contextReader ? await this.contextReader.projectsForCwd(cwd) : getProjectContext(cwd).allProjects;
    const text = rulesForProjects(rulesFile, new Set(projects));
    res.json({ text, hash: sha256(text ?? '') });
  });
}

/**
 * 403 for any browser request: a page on this computer could otherwise read
 * the rules through CORS. The gateway calls this route server-side, with no
 * Origin header.
 */
function refuseBrowserPages(req: Request, res: Response, next: NextFunction): void {
  if (req.header('origin') !== undefined || req.header('sec-fetch-site') === 'cross-site') {
    res.status(403).json({ error: 'The wire header is not served to browser pages.' });
    return;
  }
  next();
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * MY-RULES.md (renderRulesFile in work-view/my-rules.mjs) with its top lines,
 * `## Everywhere`, `## Situation: ...` sections, and `## In <project>` only for
 * `projects`. Only `## In <X>` headings are project sections.
 * The kept text is the file's own bytes, unchanged. Null when no section is kept.
 */
function rulesForProjects(rulesFile: string, projects: Set<string>): string | null {
  // Each chunk is the top lines or one "## " section; joining with "\n" restores the file.
  const chunks = rulesFile.split(/\n(?=## )/);
  const kept = chunks.filter(chunk => {
    if (!chunk.startsWith('## ')) return true;
    const project = /^## In (.+)$/.exec(chunk.split('\n', 1)[0])?.[1];
    return project === undefined || projects.has(project);
  });
  return kept.some(chunk => chunk.startsWith('## ')) ? kept.join('\n') : null;
}

/**
 * An observation as an Endless Mode timeline row: its one-line timeline
 * entry, then for the fuller formats the observation as get_observations
 * shows its content (projectMemoryContent: subtitle, narrative, facts,
 * files), the narrative only for `observation-with-narrative`. A detail that
 * renderer shortened says so, as get_observations does.
 */
function timelineRowOf(row: ToolUseObservationRow, timelineLine: string, rowFormat: EndlessTimelineRowFormat): string {
  if (rowFormat === 'timeline') return timelineLine;
  const projected = projectMemoryContent({
    subtitle: row.subtitle,
    ...(rowFormat === 'observation-with-narrative' ? { narrative: row.narrative } : {}),
    facts: row.facts,
    files_modified: row.files_modified,
    files_read: row.files_read,
  });
  return [timelineLine, projected.text, projected.truncated ? '[Detail shortened to fit the memory budget.]' : '']
    .filter(text => text !== '').join('\n');
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
