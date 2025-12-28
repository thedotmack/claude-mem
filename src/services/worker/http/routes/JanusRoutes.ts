/**
 * ABOUTME: Janus Context Routes - Exposes janus-context files via HTTP API
 * ABOUTME: Enables cross-device/cross-model access to decisions, sessions, and focus
 */

import express, { Request, Response } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';

interface Decision {
  id: string;
  date: string;
  topic: string;
  decision: string;
  rationale: string;
  madeBy: string;
  confidence: number;
  alternatives: string[];
}

interface Session {
  id: string;
  started: string;
  ended?: string;
  summary: string;
}

interface CurrentFocus {
  objective: string;
  phase: string;
  blockers: string[];
  nextActions: string[];
  lastUpdated: string;
}

export class JanusRoutes extends BaseRouteHandler {
  private contextPath: string;

  constructor(contextPath?: string) {
    super();
    this.contextPath = contextPath || process.env.JANUS_CONTEXT_PATH || './janus-context';
  }

  setupRoutes(app: express.Application): void {
    // Decision endpoints
    app.get('/api/janus/decisions', this.handleListDecisions.bind(this));
    app.get('/api/janus/decisions/search', this.handleSearchDecisions.bind(this));
    app.get('/api/janus/decisions/:id', this.handleGetDecision.bind(this));

    // Session endpoints
    app.get('/api/janus/sessions', this.handleListSessions.bind(this));
    app.get('/api/janus/sessions/:id', this.handleGetSession.bind(this));

    // Focus endpoint
    app.get('/api/janus/focus', this.handleGetFocus.bind(this));

    // Unified context endpoint (combines relevant data for injection)
    app.get('/api/janus/context', this.handleGetContext.bind(this));

    logger.info('JANUS', 'Janus routes registered', { contextPath: this.contextPath });
  }

  /**
   * List all decisions
   * GET /api/janus/decisions?limit=20
   */
  private handleListDecisions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limit = parseInt(req.query.limit as string) || 20;
    const decisionsDir = path.join(this.contextPath, 'decisions');

    try {
      const files = await fs.readdir(decisionsDir);
      const mdFiles = files.filter(f => f.endsWith('.md')).slice(0, limit);

      const decisions: Decision[] = [];
      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(decisionsDir, file), 'utf-8');
        const decision = this.parseDecisionMarkdown(content, file);
        decisions.push(decision);
      }

      // Sort by date descending
      decisions.sort((a, b) => b.date.localeCompare(a.date));

      res.json({
        content: [{
          type: 'text',
          text: JSON.stringify({ decisions, count: decisions.length }, null, 2)
        }]
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ content: [{ type: 'text', text: JSON.stringify({ decisions: [], count: 0 }) }] });
      } else {
        throw error;
      }
    }
  });

  /**
   * Search decisions by query
   * GET /api/janus/decisions/search?query=architecture
   */
  private handleSearchDecisions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const query = (req.query.query as string || '').toLowerCase();
    const limit = parseInt(req.query.limit as string) || 10;
    const decisionsDir = path.join(this.contextPath, 'decisions');

    try {
      const files = await fs.readdir(decisionsDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      const matches: Decision[] = [];
      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(decisionsDir, file), 'utf-8');

        // Simple text search
        if (content.toLowerCase().includes(query)) {
          const decision = this.parseDecisionMarkdown(content, file);
          matches.push(decision);
        }

        if (matches.length >= limit) break;
      }

      res.json({
        content: [{
          type: 'text',
          text: JSON.stringify({ decisions: matches, query, count: matches.length }, null, 2)
        }]
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ content: [{ type: 'text', text: JSON.stringify({ decisions: [], query, count: 0 }) }] });
      } else {
        throw error;
      }
    }
  });

  /**
   * Get single decision by ID
   * GET /api/janus/decisions/:id
   */
  private handleGetDecision = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    const decisionsDir = path.join(this.contextPath, 'decisions');
    const filePath = path.join(decisionsDir, `${id}.md`);

    const content = await fs.readFile(filePath, 'utf-8');
    const decision = this.parseDecisionMarkdown(content, `${id}.md`);

    res.json({
      content: [{
        type: 'text',
        text: JSON.stringify(decision, null, 2)
      }]
    });
  });

  /**
   * List sessions
   * GET /api/janus/sessions?limit=10
   */
  private handleListSessions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limit = parseInt(req.query.limit as string) || 10;
    const sessionsDir = path.join(this.contextPath, 'sessions');

    try {
      const files = await fs.readdir(sessionsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).slice(0, limit);

      const sessions: Session[] = [];
      for (const file of jsonFiles) {
        const content = await fs.readFile(path.join(sessionsDir, file), 'utf-8');
        const session = JSON.parse(content) as Session;
        sessions.push(session);
      }

      // Sort by started date descending
      sessions.sort((a, b) => b.started.localeCompare(a.started));

      res.json({
        content: [{
          type: 'text',
          text: JSON.stringify({ sessions, count: sessions.length }, null, 2)
        }]
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ content: [{ type: 'text', text: JSON.stringify({ sessions: [], count: 0 }) }] });
      } else {
        throw error;
      }
    }
  });

  /**
   * Get single session
   * GET /api/janus/sessions/:id
   */
  private handleGetSession = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    const sessionsDir = path.join(this.contextPath, 'sessions');
    const filePath = path.join(sessionsDir, `${id}.json`);

    const content = await fs.readFile(filePath, 'utf-8');
    const session = JSON.parse(content);

    res.json({
      content: [{
        type: 'text',
        text: JSON.stringify(session, null, 2)
      }]
    });
  });

  /**
   * Get current focus
   * GET /api/janus/focus
   */
  private handleGetFocus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const focusPath = path.join(this.contextPath, 'state', 'current-focus.json');

    try {
      const content = await fs.readFile(focusPath, 'utf-8');
      const focus = JSON.parse(content) as CurrentFocus;

      res.json({
        content: [{
          type: 'text',
          text: JSON.stringify(focus, null, 2)
        }]
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({
          content: [{
            type: 'text',
            text: JSON.stringify({ objective: '', phase: '', blockers: [], nextActions: [], lastUpdated: '' }, null, 2)
          }]
        });
      } else {
        throw error;
      }
    }
  });

  /**
   * Get unified context for injection into model calls
   * GET /api/janus/context?limit=5
   */
  private handleGetContext = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limit = parseInt(req.query.limit as string) || 5;

    // Gather context from multiple sources
    const context: {
      focus: CurrentFocus | null;
      recentDecisions: Decision[];
      recentSessions: Session[];
    } = {
      focus: null,
      recentDecisions: [],
      recentSessions: []
    };

    // Get current focus
    try {
      const focusPath = path.join(this.contextPath, 'state', 'current-focus.json');
      const focusContent = await fs.readFile(focusPath, 'utf-8');
      context.focus = JSON.parse(focusContent);
    } catch { /* ignore */ }

    // Get recent decisions
    try {
      const decisionsDir = path.join(this.contextPath, 'decisions');
      const files = await fs.readdir(decisionsDir);
      const mdFiles = files.filter(f => f.endsWith('.md')).slice(0, limit);

      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(decisionsDir, file), 'utf-8');
        context.recentDecisions.push(this.parseDecisionMarkdown(content, file));
      }
      context.recentDecisions.sort((a, b) => b.date.localeCompare(a.date));
    } catch { /* ignore */ }

    // Get recent sessions
    try {
      const sessionsDir = path.join(this.contextPath, 'sessions');
      const files = await fs.readdir(sessionsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).slice(0, limit);

      for (const file of jsonFiles) {
        const content = await fs.readFile(path.join(sessionsDir, file), 'utf-8');
        context.recentSessions.push(JSON.parse(content));
      }
      context.recentSessions.sort((a, b) => b.started.localeCompare(a.started));
    } catch { /* ignore */ }

    res.json({
      content: [{
        type: 'text',
        text: JSON.stringify(context, null, 2)
      }]
    });
  });

  /**
   * Parse decision markdown file into structured data
   */
  private parseDecisionMarkdown(content: string, filename: string): Decision {
    const parts = filename.replace('.md', '').split('-');
    const date = parts.slice(0, 3).join('-');
    const topic = parts.slice(3).join('-').replace(/-/g, ' ');

    const decisionMatch = content.match(/## Decision\n\n([\s\S]*?)\n## Rationale/);
    const rationaleMatch = content.match(/## Rationale\n\n([\s\S]*?)\n## Alternatives/);
    const alternativesMatch = content.match(/## Alternatives Considered\n\n([\s\S]*?)$/);
    const madeByMatch = content.match(/\*\*Made By:\*\*\s*(\w+)/);
    const confidenceMatch = content.match(/\*\*Confidence:\*\*\s*(\d+)/);

    return {
      id: filename.replace('.md', ''),
      date,
      topic,
      decision: decisionMatch ? decisionMatch[1].trim() : '',
      rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
      madeBy: madeByMatch ? madeByMatch[1] : 'human',
      confidence: confidenceMatch ? parseInt(confidenceMatch[1], 10) : 80,
      alternatives: alternativesMatch
        ? alternativesMatch[1]
            .split('\n')
            .filter(l => l.trim().startsWith('-'))
            .map(l => l.replace(/^-\s*/, '').trim())
        : []
    };
  }
}
